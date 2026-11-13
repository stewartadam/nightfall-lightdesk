// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Deciding what an import does: fixture types, IDs, labels and statuses.
//!
//! The preview and the commit both run [`plan_import`], so the IDs and statuses the user
//! sees are exactly what the import applies.

use std::collections::HashSet;
use std::path::PathBuf;

use uuid::Uuid;

use crate::preview::{
    FixtureImportStatus, FixtureNumbering, FixturePreview, FixtureTypePreview, FixtureTypeStatus,
    PatchPreview, RigImportOptions, RigImportPreview,
};
use crate::rig::{RigFile, RigTypeSource};

/// The fixture library as the planner sees it.
pub trait LibraryLookup {
    /// Returns the mode names of a library fixture revision (the default revision when
    /// `revision` is `None`), or `None` when the library does not have it.
    fn modes(&self, make: &str, model: &str, revision: Option<&str>) -> Option<Vec<String>>;
}

impl LibraryLookup for nightfall_fixture_library::FixtureLibraryManager {
    /// Looks the revision up in the library's index and lists its modes.
    fn modes(&self, make: &str, model: &str, revision: Option<&str>) -> Option<Vec<String>> {
        self.find_revision(make, model, revision)
            .map(|profile| profile.mode_names())
    }
}

/// The fixtures already in the show, as the planner sees them.
#[derive(Debug, Clone, Default)]
pub struct ShowFixtures {
    /// Fixture IDs in use.
    pub ids: HashSet<u32>,
    /// Fixture UIDs in use.
    pub uids: HashSet<Uuid>,
}

/// The library fixture a resolved type is created from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeSource {
    /// Library manufacturer.
    pub make: String,
    /// Library model.
    pub model: String,
    /// Library revision, or the default one when `None`.
    pub revision: Option<String>,
    /// GDTF to add to the show before creating fixtures, when the library lacks it.
    pub install: Option<PathBuf>,
    /// Mode every fixture of the type uses, when a mapping sets one.
    pub forced_mode: Option<String>,
    /// Modes the type offers.
    pub modes: Vec<String>,
}

/// A fixture the import adds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFixture {
    /// Index into the rig's fixtures.
    pub index: usize,
    /// Nightfall fixture ID.
    pub id: u32,
    /// Nightfall label.
    pub label: String,
    /// Library fixture to create it from.
    pub source: TypeSource,
    /// Mode to create it in.
    pub mode: String,
}

/// What an import would do.
#[derive(Debug, Clone)]
pub struct ImportPlan {
    /// Preview to show the user.
    pub preview: RigImportPreview,
    /// Fixtures to add, in file order.
    pub fixtures: Vec<PlannedFixture>,
}

/// Plans an import of `rig` into a show that already holds `show`.
pub fn plan_import(
    session: Uuid,
    rig: &RigFile,
    library: &impl LibraryLookup,
    show: &ShowFixtures,
    options: &RigImportOptions,
) -> ImportPlan {
    let mut warnings = rig.warnings.clone();
    let mut type_previews = Vec::new();
    let mut sources: Vec<(String, Option<TypeSource>)> = Vec::new();
    for fixture_type in &rig.fixture_types {
        let count = rig
            .fixtures
            .iter()
            .filter(|fixture| fixture.spec.as_deref() == Some(fixture_type.spec.as_str()))
            .count() as u32;
        let (preview, source) = resolve_type(
            &fixture_type.spec,
            &fixture_type.source,
            library,
            options,
            &mut warnings,
        );
        type_previews.push(FixtureTypePreview {
            fixture_count: count,
            ..preview
        });
        sources.push((fixture_type.spec.clone(), source));
    }

    let mut previews = Vec::with_capacity(rig.fixtures.len());
    let mut importable = Vec::new();
    let mut seen = HashSet::new();
    for (index, fixture) in rig.fixtures.iter().enumerate() {
        let mut fixture_warnings = fixture.warnings.clone();
        let repeated = !seen.insert(fixture.uid);
        if let (FixtureNumbering::Offset { by }, Some(file_id)) =
            (options.numbering, fixture.file_id)
            && file_id.checked_add(by).is_none()
        {
            fixture_warnings.push(format!(
                "ID {file_id} plus {by} is too large, so it is numbered after the highest ID"
            ));
        }
        let source = fixture.spec.as_deref().and_then(|spec| {
            sources
                .iter()
                .find(|(candidate, _)| candidate == spec)
                .and_then(|(_, source)| source.clone())
        });
        let mode = source.as_ref().and_then(|source| {
            resolve_mode(source, fixture.mode.as_deref(), &mut fixture_warnings)
        });
        let status = if show.uids.contains(&fixture.uid) {
            FixtureImportStatus::AlreadyInShow
        } else if repeated {
            FixtureImportStatus::RepeatedInFile
        } else if source.is_none() {
            FixtureImportStatus::NeedsFixtureType
        } else if mode.is_none() {
            FixtureImportStatus::NeedsMode
        } else {
            FixtureImportStatus::New
        };
        let label = label_for(&fixture.name, fixture.spec.as_deref(), source.as_ref());
        if status == FixtureImportStatus::New {
            importable.push((index, source.clone().expect("new fixtures have a type")));
        }
        previews.push(FixturePreview {
            uid: fixture.uid,
            name: fixture.name.clone(),
            spec: fixture.spec.clone(),
            mode,
            file_id: fixture.file_id,
            fixture_id: None,
            label,
            patch: fixture
                .patch
                .iter()
                .map(|patch| PatchPreview {
                    dmx_break: patch.dmx_break,
                    universe: patch.universe,
                    address: patch.address,
                })
                .collect(),
            placement: fixture.placement.clone(),
            layer: fixture.layer.clone(),
            hanging_position: fixture.hanging_position.clone(),
            status,
            warnings: fixture_warnings,
        });
    }

    let wanted: Vec<Option<u32>> = importable
        .iter()
        .map(|(index, _)| rig.fixtures[*index].file_id)
        .collect();
    let ids = assign_ids(&wanted, &show.ids, options.numbering);
    let mut fixtures = Vec::with_capacity(importable.len());
    for ((index, source), id) in importable.into_iter().zip(ids) {
        let preview = &mut previews[index];
        preview.fixture_id = Some(id);
        fixtures.push(PlannedFixture {
            index,
            id,
            label: preview.label.clone(),
            mode: preview.mode.clone().expect("new fixtures have a mode"),
            source,
        });
    }

    ImportPlan {
        preview: RigImportPreview {
            session,
            file_name: rig.file_name.clone(),
            provider: rig.provider.clone(),
            fixture_types: type_previews,
            new_fixtures: fixtures.len() as u32,
            fixtures: previews,
            warnings,
        },
        fixtures,
    }
}

/// Decides where a fixture type's definition comes from: a mapping in the options, the
/// same GDTF already in the library, or the GDTF in the file.
fn resolve_type(
    spec: &str,
    source: &RigTypeSource,
    library: &impl LibraryLookup,
    options: &RigImportOptions,
    warnings: &mut Vec<String>,
) -> (FixtureTypePreview, Option<TypeSource>) {
    if let Some(mapping) = options
        .type_mappings
        .iter()
        .find(|mapping| mapping.spec == spec)
    {
        let revision = mapping.revision.clone().filter(|value| !value.is_empty());
        match library.modes(&mapping.make, &mapping.model, revision.as_deref()) {
            Some(modes) if modes.contains(&mapping.mode) => {
                let preview = FixtureTypePreview {
                    spec: spec.to_string(),
                    make: Some(mapping.make.clone()),
                    model: Some(mapping.model.clone()),
                    modes: modes.clone(),
                    status: FixtureTypeStatus::Mapped,
                    fixture_count: 0,
                };
                return (
                    preview,
                    Some(TypeSource {
                        make: mapping.make.clone(),
                        model: mapping.model.clone(),
                        revision,
                        install: None,
                        forced_mode: Some(mapping.mode.clone()),
                        modes,
                    }),
                );
            }
            Some(_) => warnings.push(format!(
                "{} {} has no mode {:?}, so it cannot stand in for {spec}",
                mapping.make, mapping.model, mapping.mode
            )),
            None => warnings.push(format!(
                "{} {} is not in the fixture library, so it cannot stand in for {spec}",
                mapping.make, mapping.model
            )),
        }
    }

    match source {
        RigTypeSource::Embedded(gdtf) => {
            let in_library = library
                .modes(&gdtf.make, &gdtf.model, Some(&gdtf.revision))
                .is_some();
            let preview = FixtureTypePreview {
                spec: spec.to_string(),
                make: Some(gdtf.make.clone()),
                model: Some(gdtf.model.clone()),
                modes: gdtf.modes.clone(),
                status: if in_library {
                    FixtureTypeStatus::InLibrary
                } else {
                    FixtureTypeStatus::Embedded
                },
                fixture_count: 0,
            };
            let source = TypeSource {
                make: gdtf.make.clone(),
                model: gdtf.model.clone(),
                revision: Some(gdtf.revision.clone()),
                install: (!in_library).then(|| gdtf.path.clone()),
                forced_mode: None,
                modes: gdtf.modes.clone(),
            };
            (preview, Some(source))
        }
        RigTypeSource::Missing => (unresolved(spec, FixtureTypeStatus::Missing), None),
        RigTypeSource::Unreadable(reason) => (
            unresolved(
                spec,
                FixtureTypeStatus::Unreadable {
                    reason: reason.clone(),
                },
            ),
            None,
        ),
    }
}

/// Builds the preview row of a fixture type with no usable definition.
fn unresolved(spec: &str, status: FixtureTypeStatus) -> FixtureTypePreview {
    FixtureTypePreview {
        spec: spec.to_string(),
        make: None,
        model: None,
        modes: Vec::new(),
        status,
        fixture_count: 0,
    }
}

/// Picks a fixture's mode: the mapping's, the file's when the type has it, or the type's
/// first mode when the file names none. Returns `None` when the file names a mode the type
/// lacks.
fn resolve_mode(
    source: &TypeSource,
    file_mode: Option<&str>,
    warnings: &mut Vec<String>,
) -> Option<String> {
    if let Some(mode) = &source.forced_mode {
        return Some(mode.clone());
    }
    match file_mode {
        Some(mode) => {
            if let Some(found) = find_mode(&source.modes, mode) {
                return Some(found.to_string());
            }
            warnings.push(format!("The fixture type has no mode {mode:?}"));
            None
        }
        None => {
            let first = source.modes.first().cloned();
            if let Some(first) = &first {
                warnings.push(format!("No mode in the file; using {first:?}"));
            }
            first
        }
    }
}

/// Finds the GDTF mode an MVR file means by `name`.
///
/// The exact name wins. Otherwise names are compared after turning every character GDTF
/// does not allow in names into `_`, ignoring case: GDTF writers replace characters such as
/// brackets that way, and Capture writes the mode name as it was before
/// ("Standard [Lamp Dmx]" for the GDTF mode "Standard _Lamp Dmx_").
fn find_mode<'a>(modes: &'a [String], name: &str) -> Option<&'a str> {
    if let Some(exact) = modes.iter().find(|mode| *mode == name) {
        return Some(exact);
    }
    let wanted = gdtf_name_key(name);
    modes
        .iter()
        .find(|mode| gdtf_name_key(mode) == wanted)
        .map(String::as_str)
}

/// Normalizes a name for [`find_mode`]: characters outside GDTF's name set become `_` and
/// letters are lowercased.
fn gdtf_name_key(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || " .-_=+%#&@,/'".contains(c) {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// Returns the label for a fixture: its name, or nothing when the name only repeats the
/// fixture type so the patch shows the type instead.
fn label_for(name: &str, spec: Option<&str>, source: Option<&TypeSource>) -> String {
    let name = name.trim();
    let repeats = |other: &str| name.eq_ignore_ascii_case(other.trim());
    let spec_stem = spec.map(|spec| spec.strip_suffix(".gdtf").unwrap_or(spec));
    if spec_stem.is_some_and(repeats) || source.is_some_and(|source| repeats(&source.model)) {
        String::new()
    } else {
        name.to_string()
    }
}

/// Assigns a fixture ID to each imported fixture, in order.
///
/// `wanted` holds each fixture's ID from the file. IDs in `taken` and IDs given to an
/// earlier fixture are never reused; fixtures left without an ID are numbered after the
/// highest ID in use.
pub fn assign_ids(
    wanted: &[Option<u32>],
    taken: &HashSet<u32>,
    numbering: FixtureNumbering,
) -> Vec<u32> {
    let wanted: Vec<Option<u32>> = match numbering {
        FixtureNumbering::FromFile => wanted.to_vec(),
        FixtureNumbering::Offset { by } => wanted
            .iter()
            .map(|id| id.and_then(|id| id.checked_add(by)))
            .collect(),
        FixtureNumbering::Sequential { .. } => vec![None; wanted.len()],
    };
    let mut used = taken.clone();
    let mut ids: Vec<Option<u32>> = wanted
        .iter()
        .map(|id| id.filter(|id| *id > 0 && used.insert(*id)))
        .collect();
    let mut next = match numbering {
        FixtureNumbering::Sequential { start } => start.max(1),
        _ => used
            .iter()
            .max()
            .map_or(1, |max| max.checked_add(1).unwrap_or(1)),
    };
    for id in ids.iter_mut().filter(|id| id.is_none()) {
        // Wrap to 1 past the top; the loop ends because fewer IDs are used than exist.
        while next == 0 || used.contains(&next) {
            next = next.checked_add(1).unwrap_or(1);
        }
        used.insert(next);
        *id = Some(next);
    }
    ids.into_iter()
        .map(|id| id.expect("every fixture is numbered"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns a set of taken IDs.
    fn taken(ids: &[u32]) -> HashSet<u32> {
        ids.iter().copied().collect()
    }

    /// File IDs are kept; missing, repeated and taken ones go after the highest ID.
    #[test]
    fn from_file_keeps_free_ids() {
        let ids = assign_ids(
            &[Some(11), None, Some(12), Some(11), Some(5)],
            &taken(&[5]),
            FixtureNumbering::FromFile,
        );
        assert_eq!(ids, [11, 13, 12, 14, 15]);
    }

    /// An offset moves every file ID, and fixtures without one still get a free ID.
    #[test]
    fn offset_moves_file_ids() {
        let ids = assign_ids(
            &[Some(1), Some(2), None],
            &taken(&[]),
            FixtureNumbering::Offset { by: 100 },
        );
        assert_eq!(ids, [101, 102, 103]);
    }

    /// Sequential numbering ignores file IDs and skips taken ones.
    #[test]
    fn sequential_skips_taken_ids() {
        let ids = assign_ids(
            &[Some(50), None, None],
            &taken(&[201]),
            FixtureNumbering::Sequential { start: 200 },
        );
        assert_eq!(ids, [200, 202, 203]);
    }

    /// Numbering past the largest ID wraps to the lowest free one instead of looping.
    #[test]
    fn numbering_wraps_past_the_largest_id() {
        let ids = assign_ids(
            &[Some(u32::MAX), None, Some(u32::MAX)],
            &taken(&[1]),
            FixtureNumbering::FromFile,
        );
        assert_eq!(ids, [u32::MAX, 2, 3]);
    }

    /// Mode names written with characters GDTF replaces still find their mode.
    #[test]
    fn finds_modes_written_with_brackets() {
        let modes = vec![
            "Standard _Lamp Dmx_ _Color Mixing=Cmy_".to_string(),
            "Basic".to_string(),
        ];
        assert_eq!(
            find_mode(&modes, "Standard [Lamp Dmx] [Color Mixing=Cmy]"),
            Some("Standard _Lamp Dmx_ _Color Mixing=Cmy_")
        );
        assert_eq!(find_mode(&modes, "basic"), Some("Basic"));
        assert_eq!(find_mode(&modes, "Extended"), None);
    }

    /// Names that only repeat the fixture type leave the label empty.
    #[test]
    fn labels_skip_type_names() {
        let source = TypeSource {
            make: "Robe".into(),
            model: "Robin Esprite".into(),
            revision: None,
            install: None,
            forced_mode: None,
            modes: vec![],
        };
        assert_eq!(label_for("Robin Esprite", None, Some(&source)), "");
        assert_eq!(label_for("Spot", Some("Spot.gdtf"), None), "");
        assert_eq!(label_for("SL 1", Some("Spot.gdtf"), Some(&source)), "SL 1");
    }
}
