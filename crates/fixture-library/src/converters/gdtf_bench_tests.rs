// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Curated GDTF bench: real manufacturer archives with committed expectations.
//!
//! The archives cannot be redistributed with the repository, so these tests
//! are ignored by default and run with
//! `NIGHTFALL_GDTF_BENCH_DIR=<dir> npm run test:gdtf-bench`. Once requested,
//! a missing directory, missing archive or changed hash fails the run instead
//! of skipping.
//!
//! Expectations live in `tests/gdtf-bench/`:
//! - `manifest.json` pins each archive's SHA-256, provenance and exact modes.
//! - `expectations/<id>.json` holds per-mode channel charts for representative
//!   modes, the exact invariant violations currently known per mode, and the
//!   channels whose geometry lies outside their mode's geometry tree.
//!   Regenerate with `NIGHTFALL_GDTF_BENCH_UPDATE=1` and review the diff; an
//!   archive with a placement disagreement is never rewritten. A
//!   chart is only trustworthy once checked against the manufacturer's
//!   documentation for the pinned revision.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nightfall_fixtures::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::gdtf::{convert_gdtf_mode, map_gdtf_attribute_to_nightfall};
use crate::GdtfMetadata;
use crate::testing::invariants::check_invariants;
use crate::testing::reference::{ReferenceChannel, reference_mode_channels};

/// Pinned bench archive.
#[derive(Debug, Deserialize)]
struct BenchArchive {
    /// Short identifier used for expectation files.
    id: String,
    /// Archive file name inside the bench directory.
    file: String,
    /// Lowercase hex SHA-256 of the archive.
    sha256: String,
    /// Exact DMX mode names, including significant whitespace.
    modes: Vec<String>,
    /// Modes whose channel charts are committed.
    chart_modes: Vec<String>,
}

/// Bench manifest.
#[derive(Debug, Deserialize)]
struct BenchManifest {
    archives: Vec<BenchArchive>,
}

/// Committed expectations for one archive.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct BenchExpectations {
    /// Invariant violations currently produced per mode, as debug strings.
    /// Modes without violations are omitted.
    #[serde(default)]
    known_violations: BTreeMap<String, Vec<String>>,
    /// Channel charts per chart mode: one `element · attribute · break · slots` row per parameter.
    #[serde(default)]
    charts: BTreeMap<String, Vec<String>>,
    /// Channels per mode whose geometry lies outside the mode's geometry
    /// tree, as `geometry · attribute · break · slots` rows. The archive is
    /// defective there and the converter drops them, so they are pinned for
    /// review instead of being compared. Modes without any are omitted.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    unreachable_channels: BTreeMap<String, Vec<String>>,
}

/// Returns the directory holding the bench manifest and expectations.
fn bench_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/gdtf-bench")
}

/// Loads the manifest and the archive directory, failing when the directory is not configured.
fn bench() -> (BenchManifest, PathBuf) {
    let dir = std::env::var_os("NIGHTFALL_GDTF_BENCH_DIR")
        .map(PathBuf::from)
        .expect("NIGHTFALL_GDTF_BENCH_DIR must point at the curated GDTF archives");
    let manifest: BenchManifest = serde_json::from_str(
        &std::fs::read_to_string(bench_root().join("manifest.json")).expect("bench manifest"),
    )
    .expect("valid bench manifest");
    (manifest, dir)
}

/// Returns whether expectation files should be rewritten from current output.
fn updating() -> bool {
    std::env::var_os("NIGHTFALL_GDTF_BENCH_UPDATE").is_some()
}

/// Renders a converted mode as one chart row per parameter.
fn chart(fixture: &Fixture) -> Vec<String> {
    fixture
        .elements
        .iter()
        .flat_map(|element| {
            element.parameters.iter().map(move |parameter| {
                let placement = match &parameter.dmx_slots {
                    DmxSlots::Explicit { dmx_break, offsets } => format!(
                        "b{dmx_break} · {}",
                        offsets
                            .iter()
                            .map(u16::to_string)
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    DmxSlots::Virtual => "virtual".to_string(),
                    DmxSlots::Sequential => "sequential".to_string(),
                };
                format!(
                    "{} · {:?} · {placement}",
                    element.label, parameter.attribute
                )
            })
        })
        .collect()
}

/// Verifies every pinned archive is present with the expected hash and exact mode names.
#[test]
#[ignore = "requires NIGHTFALL_GDTF_BENCH_DIR"]
fn gdtf_bench_archives_match_manifest() {
    let (manifest, dir) = bench();
    for archive in &manifest.archives {
        let path = dir.join(&archive.file);
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("{}: missing bench archive ({error})", archive.id));
        let digest = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(
            digest, archive.sha256,
            "{}: archive hash changed",
            archive.id
        );
        let metadata = GdtfMetadata::from_file(&path).expect("bench archive parses");
        assert_eq!(
            metadata.modes, archive.modes,
            "{}: modes changed",
            archive.id
        );
    }
}

/// Verifies every mode converts, invariants hold except for known narrow
/// violations, the reference decoder agrees on placement, and charts match.
#[test]
#[ignore = "requires NIGHTFALL_GDTF_BENCH_DIR"]
fn gdtf_bench_modes_meet_expectations() {
    let (manifest, dir) = bench();
    let mut failures = Vec::new();
    for archive in &manifest.archives {
        let path = dir.join(&archive.file);
        let metadata = GdtfMetadata::from_file(&path).expect("bench archive parses");
        let expectations_path = bench_root()
            .join("expectations")
            .join(format!("{}.json", archive.id));
        let expected: BenchExpectations = std::fs::read_to_string(&expectations_path)
            .ok()
            .map(|text| serde_json::from_str(&text).expect("valid bench expectations"))
            .unwrap_or_default();

        let mut actual = BenchExpectations::default();
        let failures_before = failures.len();
        for mode in &archive.modes {
            let mut gdtf = metadata.reparse().expect("reparse");
            let converted =
                convert_gdtf_mode(&mut gdtf, &metadata, mode, 1).unwrap_or_else(|error| {
                    panic!("{}/{mode}: conversion failed: {error}", archive.id)
                });
            let violations: Vec<String> =
                check_invariants(&converted.fixture, converted.geometry.as_ref())
                    .iter()
                    .map(|violation| format!("{violation:?}"))
                    .collect();
            if !violations.is_empty() {
                actual.known_violations.insert(mode.clone(), violations);
            }
            if archive.chart_modes.contains(mode) {
                actual
                    .charts
                    .insert(mode.clone(), chart(&converted.fixture));
            }
            let disagreement = mode_references(&gdtf, mode).and_then(|references| {
                let unreachable: Vec<String> = references
                    .iter()
                    .filter(|reference| !reference.in_mode_tree)
                    .map(unreachable_row)
                    .collect();
                if !unreachable.is_empty() {
                    actual
                        .unreachable_channels
                        .insert(mode.clone(), unreachable);
                }
                reference_disagreement(&references, &converted.fixture).map_or(Ok(()), Err)
            });
            if let Err(message) = disagreement {
                failures.push(format!("{}/{mode}: {message}", archive.id));
            }
        }

        if updating() {
            // A placement disagreement means this conversion is wrong, so its
            // output must not become the committed baseline.
            if failures.len() > failures_before {
                continue;
            }
            std::fs::create_dir_all(expectations_path.parent().unwrap()).unwrap();
            std::fs::write(
                &expectations_path,
                serde_json::to_string_pretty(&actual).unwrap() + "\n",
            )
            .unwrap();
        } else if actual != expected {
            failures.push(format!(
                "{}: expectations differ from {} (rerun with NIGHTFALL_GDTF_BENCH_UPDATE=1 and review the diff)",
                archive.id,
                expectations_path.display()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Renders a reference channel outside its mode's geometry tree in the chart row format.
fn unreachable_row(reference: &ReferenceChannel) -> String {
    let placement = if reference.slots.is_empty() {
        "virtual".to_string()
    } else {
        let slots = reference
            .slots
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(",");
        match reference.dmx_break {
            Some(dmx_break) => format!("b{dmx_break} · {slots}"),
            None => format!("overwrite · {slots}"),
        }
    };
    format!(
        "{} · {} · {placement}",
        reference.geometry, reference.attribute
    )
}

/// Lists a mode's channels as the independent reference decoder places them.
fn mode_references(gdtf: &gdtf::GdtfFile, mode: &str) -> Result<Vec<ReferenceChannel>, String> {
    let fixture_type = gdtf
        .description
        .fixture_types
        .first()
        .ok_or("archive has no fixture type")?;
    let dmx_mode = fixture_type
        .dmx_modes
        .iter()
        .find(|candidate| candidate.name.as_ref().map(|name| name.as_ref()) == Some(mode))
        .ok_or("mode missing from archive")?;
    Ok(reference_mode_channels(fixture_type, dmx_mode))
}

/// Compares converted placement with the independent reference decoder's.
///
/// Parameters are paired with reference channels in the mode's geometry
/// tree by element and ordinal within the element, as the wire tests do.
/// Every such channel must have a converted parameter with the same
/// attribute, the same break and slots on any break, or a virtual placement
/// when the reference has no slots; every converted parameter must have a
/// reference channel. Returns a description of the first disagreement.
fn reference_disagreement(references: &[ReferenceChannel], fixture: &Fixture) -> Option<String> {
    let references: Vec<&ReferenceChannel> = references
        .iter()
        .filter(|reference| reference.in_mode_tree)
        .collect();

    for reference in &references {
        let element = fixture
            .elements
            .iter()
            .find(|element| element.label == reference.geometry);
        let Some(parameter) = element.and_then(|element| element.parameters.get(reference.ordinal))
        else {
            let converted = match element {
                Some(element) => format!("element has {} parameters", element.parameters.len()),
                None => format!(
                    "no such element among {:?}",
                    fixture
                        .elements
                        .iter()
                        .map(|element| element.label.as_str())
                        .collect::<Vec<_>>()
                ),
            };
            return Some(format!(
                "{}#{} {} has no converted parameter ({converted})",
                reference.geometry, reference.ordinal, reference.attribute
            ));
        };
        let attribute = map_gdtf_attribute_to_nightfall(&reference.attribute);
        if attribute.as_ref() != Some(&parameter.attribute) {
            return Some(format!(
                "{}#{} expected attribute {} ({attribute:?}), converted {:?}",
                reference.geometry, reference.ordinal, reference.attribute, parameter.attribute
            ));
        }
        let placed = match &parameter.dmx_slots {
            DmxSlots::Explicit { dmx_break, offsets } if !reference.slots.is_empty() => {
                offsets == &reference.slots
                    && reference
                        .dmx_break
                        .is_none_or(|expected| i32::from(*dmx_break) == expected)
            }
            DmxSlots::Virtual => reference.slots.is_empty(),
            _ => false,
        };
        if !placed {
            return Some(format!(
                "{}#{} {} expected break {:?} slots {:?}, converted {:?}",
                reference.geometry,
                reference.ordinal,
                reference.attribute,
                reference.dmx_break,
                reference.slots,
                parameter.dmx_slots
            ));
        }
    }

    for element in &fixture.elements {
        let referenced = references
            .iter()
            .filter(|reference| reference.geometry == element.label)
            .count();
        if element.parameters.len() > referenced {
            return Some(format!(
                "{} has {} converted parameters but {referenced} reference channels",
                element.label,
                element.parameters.len()
            ));
        }
    }
    None
}
