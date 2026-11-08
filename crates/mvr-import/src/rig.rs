// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reading an MVR file into the parts an import needs.
//!
//! Reading happens off the engine thread: it unzips the archive, parses the scene, copies
//! out every GDTF file the fixtures name and reads each one's make, model and modes. The
//! result holds no reference to the archive, so the engine can keep it while the user looks
//! at the preview.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use nightfall_fixture_library::GdtfMetadata;
use nightfall_fixtures::prelude::FixturePlacement;
use nightfall_mvr::prelude::*;
use tempfile::TempDir;
use uuid::Uuid;

use crate::placement::convert_transform;

/// Why an MVR file could not be read for import.
#[derive(Debug, thiserror::Error)]
pub enum RigReadError {
    /// The archive or its scene description is unreadable.
    #[error(transparent)]
    Mvr(#[from] MvrError),
    /// Writing the extracted fixture types failed.
    #[error("could not extract the fixture types: {0}")]
    Io(#[from] std::io::Error),
}

/// A fixture type named by the rig's fixtures, with the GDTF file the archive holds for it.
#[derive(Debug, Clone)]
pub struct RigFixtureType {
    /// The `GDTFSpec` exactly as the fixtures name it, which identifies the type here.
    pub spec: String,
    /// What the archive holds for the type.
    pub source: RigTypeSource,
}

/// What the archive holds for a fixture type.
#[derive(Debug, Clone)]
pub enum RigTypeSource {
    /// A readable GDTF file, copied out of the archive.
    Embedded(EmbeddedGdtf),
    /// The archive has no file of that name.
    Missing,
    /// The archive has the file, but it is not a readable GDTF.
    Unreadable(String),
}

/// A GDTF file copied out of the archive, with the details the library indexes it by.
#[derive(Debug, Clone)]
pub struct EmbeddedGdtf {
    /// File name inside the archive.
    pub file_name: String,
    /// Where the copy is, inside the rig's working folder.
    pub path: PathBuf,
    /// Manufacturer, as the library reads it.
    pub make: String,
    /// Model, as the library reads it.
    pub model: String,
    /// Mode names in file order.
    pub modes: Vec<String>,
    /// Content fingerprint the library uses as the revision.
    pub revision: String,
}

/// One break of a fixture's DMX patch, in Nightfall break numbering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RigPatch {
    /// DMX break, starting at 1.
    pub dmx_break: u16,
    /// Console universe, starting at 1.
    pub universe: u16,
    /// Start address within the universe, from 1 to 512.
    pub address: u16,
}

/// A fixture from the rig, converted to Nightfall units and numbering.
#[derive(Debug, Clone)]
pub struct RigFixture {
    /// MVR UUID, which becomes the Nightfall fixture UID.
    pub uid: Uuid,
    /// Name in the file.
    pub name: String,
    /// `GDTFSpec` naming the fixture type, if any.
    pub spec: Option<String>,
    /// `GDTFMode`, if any.
    pub mode: Option<String>,
    /// Fixture ID from the file.
    pub file_id: Option<u32>,
    /// Patched breaks, in break order.
    pub patch: Vec<RigPatch>,
    /// Placement in Nightfall space.
    pub placement: FixturePlacement,
    /// Name of the layer the fixture is on.
    pub layer: String,
    /// Name of the hanging position the fixture belongs to, if any.
    pub hanging_position: Option<String>,
    /// Name of the class the fixture is in, if any.
    pub class: Option<String>,
    /// Things about the fixture the import leaves out or adjusts.
    pub warnings: Vec<String>,
}

/// An MVR file read for import.
#[derive(Debug)]
pub struct RigFile {
    /// Name of the uploaded file.
    pub file_name: String,
    /// Application that wrote the file, if it says.
    pub provider: Option<String>,
    /// Fixture types in the order the fixtures first name them.
    pub fixture_types: Vec<RigFixtureType>,
    /// Fixtures in file order.
    pub fixtures: Vec<RigFixture>,
    /// Problems with the file as a whole.
    pub warnings: Vec<String>,
    /// Folder holding the extracted GDTF files; removed when the rig is dropped.
    _workdir: TempDir,
}

impl RigFile {
    /// Returns the fixture type a fixture names, if it names one.
    pub fn fixture_type(&self, spec: &str) -> Option<&RigFixtureType> {
        self.fixture_types.iter().find(|ty| ty.spec == spec)
    }
}

/// Reads an MVR file from disk.
pub fn read_rig_file(path: &Path, file_name: &str) -> Result<RigFile, RigReadError> {
    read_rig(File::open(path)?, file_name)
}

/// Reads an MVR archive: its fixtures, their types and placements.
///
/// Fixtures nested inside other fixtures (accessories attached to a geometry) are skipped
/// with a warning, because their position depends on the parent's model.
pub fn read_rig<R: Read + Seek>(reader: R, file_name: &str) -> Result<RigFile, RigReadError> {
    let mut archive = MvrArchive::open(reader)?;
    let workdir = tempfile::Builder::new()
        .prefix("nightfall-rig-")
        .tempdir()?;
    let mut warnings: Vec<String> = archive
        .warnings()
        .iter()
        .map(|warning| format!("{warning:?}"))
        .collect();
    let description = archive.description();
    let provider = description.provider_name().map(str::to_string);
    if description.ver_minor > 6 {
        warnings.push(format!(
            "The file uses MVR 1.{}, newer than this reader knows; new details are skipped",
            description.ver_minor
        ));
    }

    let scene = archive.scene();
    let positions: BTreeMap<Uuid, String> = scene
        .positions()
        .map(|position| (position.uuid, position.name.clone()))
        .collect();
    let classes: BTreeMap<Uuid, String> = scene
        .classes()
        .map(|class| (class.uuid, class.name.clone()))
        .collect();
    let mut specs: Vec<String> = Vec::new();
    let mut fixtures = Vec::new();
    for placed in scene.placed_fixtures() {
        let fixture = placed.fixture().expect("placed_fixtures yields fixtures");
        if let Some(parent) = placed.parent_fixture() {
            warnings.push(format!(
                "Skipped {}: it is attached to fixture {}, which is not supported yet",
                fixture.name, parent.name
            ));
            continue;
        }
        if let Some(spec) = &fixture.gdtf_spec
            && !specs.contains(spec)
        {
            specs.push(spec.clone());
        }
        fixtures.push(rig_fixture(fixture, &placed, &positions, &classes));
    }

    let fixture_types = specs
        .into_iter()
        .map(|spec| {
            let source = extract_type(&mut archive, &spec, workdir.path());
            RigFixtureType { spec, source }
        })
        .collect();

    Ok(RigFile {
        file_name: file_name.to_string(),
        provider,
        fixture_types,
        fixtures,
        warnings,
        _workdir: workdir,
    })
}

/// Converts one MVR fixture, noting what the import cannot carry over.
fn rig_fixture(
    fixture: &Fixture,
    placed: &PlacedObject<'_>,
    positions: &BTreeMap<Uuid, String>,
    classes: &BTreeMap<Uuid, String>,
) -> RigFixture {
    let mut warnings = Vec::new();
    let converted = convert_transform(&placed.world);
    if let Some(warning) = converted.warning {
        warnings.push(format!("Placement {warning}"));
    }

    let mut patch = Vec::new();
    for address in fixture.addresses() {
        match address {
            Ok(FixtureAddress {
                address: Some(address),
                dmx_break,
            }) => match rig_patch(dmx_break, address) {
                Some(entry) => patch.push(entry),
                None => warnings.push(format!(
                    "Break {} at {}.{} is out of range and was left unpatched",
                    dmx_break + 1,
                    address.universe,
                    address.channel
                )),
            },
            Ok(_) => {}
            Err(text) => warnings.push(format!("Unreadable DMX address {text:?}")),
        }
    }
    patch.sort_by_key(|entry| entry.dmx_break);

    if fixture.multipatch.is_some() {
        warnings
            .push("Part of a multipatch group; it is imported as a separate fixture".to_string());
    }
    for feature in fixture.unmodelled_features() {
        warnings.push(format!("{feature} are not imported yet"));
    }
    if fixture.dmx_invert_pan == Some(true) || fixture.dmx_invert_tilt == Some(true) {
        warnings.push("Pan or tilt inversion is not imported yet".to_string());
    }

    RigFixture {
        uid: fixture.uuid,
        name: fixture.name.clone(),
        spec: fixture.gdtf_spec.clone(),
        mode: fixture.gdtf_mode.clone(),
        file_id: fixture.numeric_id(),
        patch,
        placement: converted.placement,
        layer: placed.layer.name.clone(),
        hanging_position: fixture
            .position
            .and_then(|uuid| positions.get(&uuid).cloned()),
        class: fixture.class.and_then(|uuid| classes.get(&uuid).cloned()),
        warnings,
    }
}

/// Converts an MVR break and address into a Nightfall patch entry, or `None` when it does
/// not fit Nightfall's numbering. MVR counts breaks from 0, Nightfall from 1.
fn rig_patch(dmx_break: u32, address: DmxAddress) -> Option<RigPatch> {
    Some(RigPatch {
        dmx_break: u16::try_from(dmx_break.checked_add(1)?).ok()?,
        universe: u16::try_from(address.universe).ok()?,
        address: address.channel,
    })
}

/// Copies a fixture type's GDTF out of the archive and reads its details.
fn extract_type<R: Read + Seek>(
    archive: &mut MvrArchive<R>,
    spec: &str,
    workdir: &Path,
) -> RigTypeSource {
    let Some(file_name) = archive.find_gdtf(spec).map(str::to_string) else {
        return RigTypeSource::Missing;
    };
    let bytes = match archive.read_file(&file_name) {
        Ok(bytes) => bytes,
        Err(error) => return RigTypeSource::Unreadable(error.to_string()),
    };
    let revision = nightfall_fixture_model::prelude::fixture_asset_etag(&bytes);
    let path = workdir.join(extracted_name(&file_name, &revision));
    if let Err(error) = std::fs::write(&path, &bytes) {
        return RigTypeSource::Unreadable(error.to_string());
    }
    match GdtfMetadata::from_file(&path) {
        Ok(metadata) => RigTypeSource::Embedded(EmbeddedGdtf {
            file_name,
            path,
            make: metadata.manufacturer,
            model: metadata.model,
            modes: metadata.modes,
            revision,
        }),
        Err(error) => RigTypeSource::Unreadable(error.to_string()),
    }
}

/// Names an extracted GDTF after the file in the archive and its content fingerprint, so
/// different revisions of a type never share a name once copied into a library folder.
fn extracted_name(file_name: &str, revision: &str) -> String {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let stem = if base.to_ascii_lowercase().ends_with(".gdtf") {
        &base[..base.len() - ".gdtf".len()]
    } else {
        base
    };
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim_matches(['.', ' ']);
    let stem = if stem.is_empty() { "fixture" } else { stem };
    format!("{stem}-{revision}.gdtf")
}
