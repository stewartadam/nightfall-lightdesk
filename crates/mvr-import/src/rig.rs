// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reading an MVR file into the parts an import needs.
//!
//! Reading happens off the engine thread: it unzips the archive, parses the scene, copies
//! out every GDTF file the fixtures name and reads each one's make, model and modes, and
//! turns the models of trusses, supports and other scenery into GLB files. The result
//! holds no reference to the archive, so the engine can keep it while the user looks at
//! the preview.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use nightfall_fixture_library::GdtfMetadata;
use nightfall_fixtures::prelude::FixturePlacement;
use nightfall_mvr::prelude::*;
use nightfall_object_library::ObjectMetadata;
use nightfall_object_library::manager::write_object_bundle;
use tempfile::TempDir;
use uuid::Uuid;

use crate::geometry::{GeometryCache, Mesh};
use crate::placement::{convert_transform, split_transform};

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

/// What kind of scenery an imported scene object stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[typeshare::typeshare]
pub enum RigSceneryKind {
    /// A truss section, imported as its own object.
    Truss,
    /// A support such as a motor or a ground support tower, imported as its own object.
    Support,
    /// Every other object of a layer with a model (set pieces, the venue, video screens and
    /// projectors), merged into one object per layer.
    Layer,
}

/// A model built from the archive, written as a scene object bundle in the rig's working
/// folder.
#[derive(Debug, Clone)]
pub struct RigModel {
    /// Where the `.robj` bundle is.
    pub path: PathBuf,
    /// Content fingerprint of the GLB file.
    pub revision: String,
    /// Number of triangles in the model.
    pub triangles: usize,
}

/// A truss, support or layer of scenery from the rig, converted to Nightfall space.
#[derive(Debug, Clone)]
pub struct RigScenery {
    /// MVR UUID of the object, or of the layer for merged scenery; it becomes the scene
    /// object's UID.
    pub uid: Uuid,
    /// Name in the file.
    pub name: String,
    /// What the object stands for.
    pub kind: RigSceneryKind,
    /// Name of the layer the object is on.
    pub layer: String,
    /// Placement in Nightfall space. The model already holds the object's scale.
    pub placement: FixturePlacement,
    /// The object's model, or `None` when the file has no readable geometry for it.
    pub model: Option<RigModel>,
    /// Things about the object the import leaves out or adjusts.
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
    /// Trusses and supports in file order, then one merged entry per layer with other
    /// scenery.
    pub scenery: Vec<RigScenery>,
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
/// with a warning, because their position depends on the parent's model. Scenery models
/// are converted to GLB here, so the engine never parses geometry.
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

    let scene = archive.scene().clone();
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
    let scenery = read_scenery(
        &mut archive,
        &scene,
        workdir.path(),
        file_name,
        &mut warnings,
    )?;

    Ok(RigFile {
        file_name: file_name.to_string(),
        provider,
        fixture_types,
        fixtures,
        scenery,
        warnings,
        _workdir: workdir,
    })
}

/// Builds the models of the scene's trusses, supports and other scenery.
///
/// Each truss and support becomes its own entry, placed where the file puts it with its
/// model drawn around its own origin. Every other object with geometry (scene objects,
/// video screens, projectors) is merged into one entry per layer, drawn in world space,
/// because venues are often made of thousands of small pieces.
fn read_scenery<R: Read + Seek>(
    archive: &mut MvrArchive<R>,
    scene: &Scene,
    workdir: &Path,
    file_name: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<RigScenery>, RigReadError> {
    let symdefs = scene
        .symdefs()
        .map(|symdef| (symdef.uuid, symdef))
        .collect();
    let mut cache = GeometryCache::new(archive, symdefs);
    let mut scenery = Vec::new();
    let mut layers: Vec<(Uuid, String, Mesh, Vec<String>)> = Vec::new();
    for placed in scene.placed_objects() {
        let (object, kind) = match placed.node {
            SceneNode::Truss(object) => (object, RigSceneryKind::Truss),
            SceneNode::Support(object) => (object, RigSceneryKind::Support),
            SceneNode::SceneObject(object)
            | SceneNode::VideoScreen(object)
            | SceneNode::Projector(object) => (object, RigSceneryKind::Layer),
            _ => continue,
        };
        if object.geometries.nodes.is_empty() {
            if kind != RigSceneryKind::Layer {
                warnings.push(format!(
                    "Skipped {} {}: it has no model in the file",
                    if kind == RigSceneryKind::Truss {
                        "truss"
                    } else {
                        "support"
                    },
                    if object.name.trim().is_empty() {
                        "without a name"
                    } else {
                        object.name.trim()
                    },
                ));
            }
            continue;
        }
        if kind == RigSceneryKind::Layer {
            let index = match layers
                .iter()
                .position(|(uid, ..)| *uid == placed.layer.uuid)
            {
                Some(index) => index,
                None => {
                    layers.push((
                        placed.layer.uuid,
                        placed.layer.name.clone(),
                        Mesh::default(),
                        Vec::new(),
                    ));
                    layers.len() - 1
                }
            };
            let (_, _, mesh, layer_warnings) = &mut layers[index];
            cache.add(&object.geometries, &placed.world, mesh, layer_warnings);
            continue;
        }
        let (placement, local) = split_transform(&placed.world);
        let mut mesh = Mesh::default();
        let mut object_warnings = Vec::new();
        cache.add(&object.geometries, &local, &mut mesh, &mut object_warnings);
        let model = write_model(&mesh, workdir, object.uuid, &object.name, file_name)?;
        scenery.push(RigScenery {
            uid: object.uuid,
            name: object.name.clone(),
            kind,
            layer: placed.layer.name.clone(),
            placement,
            model,
            warnings: object_warnings,
        });
    }
    for (uid, name, mesh, layer_warnings) in layers {
        let model = write_model(&mesh, workdir, uid, &name, file_name)?;
        if model.is_none() {
            warnings.push(format!("Layer {name} has no readable scenery models"));
            warnings.extend(layer_warnings);
            continue;
        }
        scenery.push(RigScenery {
            uid,
            name: name.clone(),
            kind: RigSceneryKind::Layer,
            layer: name,
            placement: FixturePlacement::default(),
            model,
            warnings: layer_warnings,
        });
    }
    Ok(scenery)
}

/// Writes a model as a `.robj` scene object bundle named after the object, ready to copy
/// into a show, or returns `None` for an empty model.
///
/// The bundle is built here, off the engine thread, so committing the import only copies
/// files.
fn write_model(
    mesh: &Mesh,
    workdir: &Path,
    uid: Uuid,
    name: &str,
    file_name: &str,
) -> Result<Option<RigModel>, RigReadError> {
    if mesh.is_empty() {
        return Ok(None);
    }
    let glb = mesh.to_glb();
    let revision = nightfall_fixture_model::prelude::fixture_asset_etag(&glb);
    let path = workdir.join(format!("scenery-{}.robj", uid.simple()));
    let metadata = ObjectMetadata {
        name: if name.trim().is_empty() {
            "MVR scenery".to_string()
        } else {
            name.trim().to_string()
        },
        category: "Imported".to_string(),
        description: format!("Imported from {file_name}"),
        scale: 1.0,
        author: String::new(),
        license: String::new(),
        tags: vec!["mvr".to_string()],
    };
    write_object_bundle(&path, &metadata, &glb)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(Some(RigModel {
        path,
        revision,
        triangles: mesh.triangle_count(),
    }))
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
