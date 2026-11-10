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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use nightfall_fixture_model::prelude::fixture_name_key;
use nightfall_fixtures::prelude::FixturePlacement;
use uuid::Uuid;

use crate::preview::{
    FixtureImportStatus, FixtureNumbering, FixturePreview, FixtureTypePreview, FixtureTypeStatus,
    GroupPreview, PatchPreview, RigGroupSource, RigImportOptions, RigImportPreview,
};
use crate::rig::{RigFile, RigFixture, RigPatch, RigTypeSource};
use crate::scenery::{SceneryPlan, ShowScenery, plan_scenery};

/// How far, in metres, a fixture may be from its place in the file and still count as
/// unmoved.
const POSITION_TOLERANCE: f32 = 1e-3;

/// How far, in degrees, a fixture may be turned from its rotation in the file and still
/// count as unturned.
const ROTATION_TOLERANCE: f32 = 1e-2;

/// The fixture library as the planner sees it.
pub trait LibraryLookup {
    /// Returns the mode names of a library fixture revision (the default revision when
    /// `revision` is `None`), or `None` when the library does not have it.
    fn modes(&self, make: &str, model: &str, revision: Option<&str>) -> Option<Vec<String>>;

    /// Whether a library fixture revision is a GDTF without a 3D model mesh. Lookups that
    /// don't know say no, so nothing is flagged by mistake.
    fn missing_3d_model(&self, _make: &str, _model: &str, _revision: Option<&str>) -> bool {
        false
    }

    /// Finds the library fixture a `GDTFSpec` names when the file leaves the GDTF out, by
    /// manufacturer and fixture name, ignoring case, spacing and punctuation. Returns its
    /// make and model as the library spells them. Lookups that can't search say none.
    fn find_by_name(&self, _manufacturer: &str, _fixture: &str) -> Option<(String, String)> {
        None
    }
}

impl LibraryLookup for nightfall_fixture_library::FixtureLibraryManager {
    /// Looks the revision up in the library's index and lists its modes.
    fn modes(&self, make: &str, model: &str, revision: Option<&str>) -> Option<Vec<String>> {
        self.find_revision(make, model, revision)
            .map(|profile| profile.mode_names())
    }

    /// Scans the library's profiles for ones whose make and model match the names. When
    /// several spellings match, the alphabetically first wins, so every preview picks the same.
    fn find_by_name(&self, manufacturer: &str, fixture: &str) -> Option<(String, String)> {
        let (manufacturer, fixture) = (fixture_name_key(manufacturer), fixture_name_key(fixture));
        self.list_fixtures()
            .into_iter()
            .filter(|profile| {
                fixture_name_key(&profile.model) == fixture
                    && fixture_name_key(&profile.make) == manufacturer
            })
            .map(|profile| (profile.make.clone(), profile.model.clone()))
            .min()
    }

    /// Reads the 3D model check the library made when it scanned the GDTF.
    fn missing_3d_model(&self, make: &str, model: &str, revision: Option<&str>) -> bool {
        self.find_revision(make, model, revision)
            .is_some_and(|profile| {
                matches!(
                    &profile.source,
                    nightfall_fixture_library::FixtureSource::Gdtf(metadata) if !metadata.has_models
                )
            })
    }
}

/// Reads the manufacturer and fixture name from a `GDTFSpec` such as
/// `Clay Paky@Alpha Spot QWO 800@r3048.gdtf`: the file name's first two `@`-separated
/// parts, with `_` read as a space, as GDTF Share names its downloads. Returns `None` when
/// the spec doesn't follow that naming.
pub fn spec_names(spec: &str) -> Option<(String, String)> {
    let name = spec.rsplit(['/', '\\']).next().unwrap_or(spec);
    let name = if name.to_ascii_lowercase().ends_with(".gdtf") {
        &name[..name.len() - ".gdtf".len()]
    } else {
        name
    };
    let mut parts = name
        .split('@')
        .map(|part| part.replace('_', " ").trim().to_string());
    let manufacturer = parts.next().filter(|part| !part.is_empty())?;
    let fixture = parts.next().filter(|part| !part.is_empty())?;
    Some((manufacturer, fixture))
}

/// A fixture already in the show, as the planner compares it with the file.
#[derive(Debug, Clone)]
pub struct ShowFixture {
    /// Fixture ID.
    pub id: u32,
    /// Label.
    pub label: String,
    /// Library manufacturer.
    pub make: String,
    /// Library model.
    pub model: String,
    /// Mode.
    pub mode: String,
    /// Position and rotation.
    pub placement: FixturePlacement,
    /// Console patch, one entry per break, in break order.
    pub patch: Vec<RigPatch>,
    /// Whether the fixture shares a console route with other fixtures, which the import
    /// cannot move without moving them.
    pub shared_patch: bool,
}

/// A group already in the show.
#[derive(Debug, Clone)]
pub struct ShowGroup {
    /// Group ID.
    pub id: u32,
    /// Group UID.
    pub uid: Uuid,
    /// Group name.
    pub label: String,
    /// Member fixture UIDs when the group is a plain list of fixtures, the form the import
    /// writes; `None` for a group defined any other way, which the import leaves alone.
    pub members: Option<Vec<Uuid>>,
}

/// The show as the planner sees it.
#[derive(Debug, Clone, Default)]
pub struct ShowFixtures {
    /// Fixture IDs in use.
    pub ids: HashSet<u32>,
    /// Fixtures by UID.
    pub fixtures: HashMap<Uuid, ShowFixture>,
    /// Groups.
    pub groups: Vec<ShowGroup>,
    /// Scene objects.
    pub scenery: ShowScenery,
}

impl ShowFixtures {
    /// Records what a planned import adds, so a later import in the same frame is planned
    /// against the show as it will be.
    pub fn apply(&mut self, rig: &RigFile, plan: &ImportPlan) {
        for planned in &plan.fixtures {
            let fixture = &rig.fixtures[planned.index];
            self.ids.insert(planned.id);
            self.fixtures.insert(
                fixture.uid,
                ShowFixture {
                    id: planned.id,
                    label: planned.label.clone(),
                    make: planned.source.make.clone(),
                    model: planned.source.model.clone(),
                    mode: planned.mode.clone(),
                    placement: fixture.placement.clone(),
                    patch: fixture.patch.clone(),
                    shared_patch: false,
                },
            );
        }
        for update in &plan.updates {
            let fixture = &rig.fixtures[update.index];
            if let Some(show) = self.fixtures.get_mut(&fixture.uid) {
                if let Some(label) = &update.label {
                    show.label = label.clone();
                }
                if let Some(placement) = &update.placement {
                    show.placement = placement.clone();
                }
                if update.repatch {
                    show.patch = fixture.patch.clone();
                }
            }
        }
        for group in &plan.groups {
            match self.groups.iter_mut().find(|show| show.uid == group.uid) {
                Some(show) => show.members = Some(group.members.clone()),
                None => self.groups.push(ShowGroup {
                    id: group.id,
                    uid: group.uid,
                    label: group.name.clone(),
                    members: Some(group.members.clone()),
                }),
            }
        }
        self.scenery.apply(rig, &plan.scenery);
    }
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

/// A fixture already in the show that the import changes.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedUpdate {
    /// Index into the rig's fixtures.
    pub index: usize,
    /// Nightfall fixture ID.
    pub id: u32,
    /// New label, when it changes.
    pub label: Option<String>,
    /// New placement, when it changes.
    pub placement: Option<FixturePlacement>,
    /// Whether the patch is replaced by the file's.
    pub repatch: bool,
}

/// A group the import makes or refreshes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedGroup {
    /// Group name.
    pub name: String,
    /// Group ID.
    pub id: u32,
    /// Group UID: the existing group's, or a new one.
    pub uid: Uuid,
    /// UID of the group with this name already in the show, if there is one.
    pub existing: Option<Uuid>,
    /// Member fixture UIDs in fixture ID order.
    pub members: Vec<Uuid>,
}

/// What an import would do.
#[derive(Debug, Clone)]
pub struct ImportPlan {
    /// Preview to show the user.
    pub preview: RigImportPreview,
    /// Fixtures to add, in file order.
    pub fixtures: Vec<PlannedFixture>,
    /// Fixtures already in the show to change, in file order.
    pub updates: Vec<PlannedUpdate>,
    /// Groups to make or refresh.
    pub groups: Vec<PlannedGroup>,
    /// Scene objects to add or change for the rig's scenery.
    pub scenery: SceneryPlan,
}

impl ImportPlan {
    /// Whether committing the plan would change the show.
    pub fn is_empty(&self) -> bool {
        self.fixtures.is_empty()
            && self.updates.is_empty()
            && self.groups.is_empty()
            && self.scenery.objects.is_empty()
    }
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
    let mut updates = Vec::new();
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
        let label = label_for(&fixture.name, fixture.spec.as_deref(), source.as_ref());
        let existing = (!repeated)
            .then(|| show.fixtures.get(&fixture.uid))
            .flatten();
        let mut changes = Vec::new();
        let status = if repeated {
            FixtureImportStatus::RepeatedInFile
        } else if let Some(existing) = existing {
            let update = compare_existing(
                index,
                fixture,
                existing,
                &label,
                source.as_ref().zip(mode.as_deref()),
                &mut changes,
                &mut fixture_warnings,
            );
            match update {
                None => FixtureImportStatus::Unchanged,
                Some(update) if options.update_existing => {
                    updates.push(update);
                    FixtureImportStatus::Update
                }
                Some(_) => FixtureImportStatus::AlreadyInShow,
            }
        } else if source.is_none() {
            FixtureImportStatus::NeedsFixtureType
        } else if mode.is_none() {
            FixtureImportStatus::NeedsMode
        } else {
            FixtureImportStatus::New
        };
        if status == FixtureImportStatus::New {
            importable.push((index, source.clone().expect("new fixtures have a type")));
        }
        previews.push(FixturePreview {
            uid: fixture.uid,
            name: fixture.name.clone(),
            spec: fixture.spec.clone(),
            mode: existing.map(|existing| existing.mode.clone()).or(mode),
            file_id: fixture.file_id,
            fixture_id: existing.map(|existing| existing.id),
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
            class: fixture.class.clone(),
            status,
            changes,
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

    let group_source = resolve_group_source(rig, options.groups);
    let groups = plan_groups(rig, &previews, group_source, show, &mut warnings);
    let scenery = plan_scenery(rig, &show.scenery, options);

    ImportPlan {
        preview: RigImportPreview {
            session,
            file_name: rig.file_name.clone(),
            provider: rig.provider.clone(),
            fixture_types: type_previews,
            new_fixtures: fixtures.len() as u32,
            updated_fixtures: updates.len() as u32,
            group_source,
            groups: groups
                .iter()
                .map(|group| GroupPreview {
                    name: group.name.clone(),
                    group_id: group.id,
                    existing: group.existing.is_some(),
                    fixture_count: group.members.len() as u32,
                })
                .collect(),
            fixtures: previews,
            scenery_changes: scenery.objects.len() as u32,
            scenery: scenery.previews.clone(),
            warnings,
        },
        fixtures,
        updates,
        groups,
        scenery,
    }
}

/// Compares a fixture already in the show with the file and returns the update that makes
/// it match, or `None` when it already does.
///
/// Labels change only when the file names the fixture, and the patch only when the file
/// patches it. A shared patch is left alone with a warning, and a different fixture type or
/// mode is reported but kept, because changing it would drop the fixture's programming.
fn compare_existing(
    index: usize,
    fixture: &RigFixture,
    existing: &ShowFixture,
    label: &str,
    resolved: Option<(&TypeSource, &str)>,
    changes: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Option<PlannedUpdate> {
    let label = (!label.is_empty() && label != existing.label).then(|| label.to_string());
    if let Some(label) = &label {
        changes.push(format!("renamed to {label:?}"));
    }
    let placement = (!same_placement(&existing.placement, &fixture.placement))
        .then(|| fixture.placement.clone());
    if placement.is_some() {
        changes.push("moved".to_string());
    }
    let mut repatch = false;
    // Files that leave a fixture unpatched (Vectorworks writes address 0 for every fixture)
    // keep the patch made in the show rather than removing it.
    if !fixture.patch.is_empty() && existing.patch != fixture.patch {
        if existing.shared_patch {
            warnings.push(
                "The patch differs, but the fixture shares a patch route with others, so it is \
                 kept"
                    .to_string(),
            );
        } else {
            repatch = true;
            changes.push("repatched".to_string());
        }
    }
    if let Some((source, mode)) = resolved
        && (source.make != existing.make || source.model != existing.model || mode != existing.mode)
    {
        warnings.push(format!(
            "The file uses {} {} ({mode}); the show keeps {} {} ({})",
            source.make, source.model, existing.make, existing.model, existing.mode
        ));
    }
    (label.is_some() || placement.is_some() || repatch).then_some(PlannedUpdate {
        index,
        id: existing.id,
        label,
        placement,
        repatch,
    })
}

/// Whether two placements are the same within the tolerances.
pub(crate) fn same_placement(a: &FixturePlacement, b: &FixturePlacement) -> bool {
    let close = |x: f32, y: f32, tolerance: f32| (x - y).abs() <= tolerance;
    let turned = |x: f32, y: f32| {
        let difference = (x - y).rem_euclid(360.0);
        difference.min(360.0 - difference) <= ROTATION_TOLERANCE
    };
    close(a.position.x, b.position.x, POSITION_TOLERANCE)
        && close(a.position.y, b.position.y, POSITION_TOLERANCE)
        && close(a.position.z, b.position.z, POSITION_TOLERANCE)
        && turned(a.rotation.x, b.rotation.x)
        && turned(a.rotation.y, b.rotation.y)
        && turned(a.rotation.z, b.rotation.z)
}

/// Resolves `Auto` to hanging positions when any fixture has one, otherwise layers.
fn resolve_group_source(rig: &RigFile, source: RigGroupSource) -> RigGroupSource {
    match source {
        RigGroupSource::Auto => {
            if rig
                .fixtures
                .iter()
                .any(|fixture| fixture.hanging_position.is_some())
            {
                RigGroupSource::HangingPositions
            } else {
                RigGroupSource::Layers
            }
        }
        other => other,
    }
}

/// Plans one group per hanging position, layer or class, holding the fixtures that are in
/// the show after the import, in fixture ID order.
///
/// A group already in the show with the same name keeps its ID and gets the new members,
/// unless it already has exactly them or is not a plain list of fixtures (then it is left
/// alone with a warning). Other groups take the next free IDs.
fn plan_groups(
    rig: &RigFile,
    previews: &[FixturePreview],
    source: RigGroupSource,
    show: &ShowFixtures,
    warnings: &mut Vec<String>,
) -> Vec<PlannedGroup> {
    let key = |fixture: &RigFixture| -> Option<String> {
        match source {
            RigGroupSource::HangingPositions => fixture.hanging_position.clone(),
            RigGroupSource::Layers => Some(fixture.layer.clone()),
            RigGroupSource::Classes => fixture.class.clone(),
            RigGroupSource::Auto | RigGroupSource::None => None,
        }
        .filter(|name| !name.trim().is_empty())
    };
    let mut members: Vec<(String, Vec<(u32, Uuid)>)> = Vec::new();
    for (fixture, preview) in rig.fixtures.iter().zip(previews) {
        let in_show = matches!(
            preview.status,
            FixtureImportStatus::New
                | FixtureImportStatus::Update
                | FixtureImportStatus::Unchanged
                | FixtureImportStatus::AlreadyInShow
        );
        let (Some(name), Some(id), true) = (key(fixture), preview.fixture_id, in_show) else {
            continue;
        };
        match members.iter_mut().find(|(candidate, _)| *candidate == name) {
            Some((_, list)) => list.push((id, fixture.uid)),
            None => members.push((name, vec![(id, fixture.uid)])),
        }
    }

    let mut used: HashSet<u32> = show.groups.iter().map(|group| group.id).collect();
    let mut next = used.iter().max().map_or(1, |max| max.saturating_add(1));
    let mut planned = Vec::new();
    for (name, mut list) in members {
        list.sort_unstable_by_key(|(id, _)| *id);
        let members: Vec<Uuid> = list.into_iter().map(|(_, uid)| uid).collect();
        let existing = show.groups.iter().find(|group| group.label == name);
        let (id, uid) = match existing {
            Some(group) => match &group.members {
                Some(current) if *current == members => continue,
                Some(_) => (group.id, group.uid),
                None => {
                    warnings.push(format!(
                        "Group {name:?} is kept as it is because it is not a plain list of \
                         fixtures"
                    ));
                    continue;
                }
            },
            None => {
                while used.contains(&next) {
                    next = next.saturating_add(1);
                }
                used.insert(next);
                (next, Uuid::new_v4())
            }
        };
        planned.push(PlannedGroup {
            name,
            id,
            uid,
            existing: existing.map(|group| group.uid),
            members,
        });
    }
    planned
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
                    missing_3d_model: library.missing_3d_model(
                        &mapping.make,
                        &mapping.model,
                        revision.as_deref(),
                    ),
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
                missing_3d_model: !gdtf.has_models,
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
        RigTypeSource::Missing => {
            let names = spec_names(spec);
            let found = names.as_ref().and_then(|(manufacturer, fixture)| {
                let (make, model) = library.find_by_name(manufacturer, fixture)?;
                let modes = library.modes(&make, &model, None)?;
                Some((make, model, modes))
            });
            match found {
                Some((make, model, modes)) => {
                    let preview = FixtureTypePreview {
                        spec: spec.to_string(),
                        make: Some(make.clone()),
                        model: Some(model.clone()),
                        modes: modes.clone(),
                        status: FixtureTypeStatus::FoundInLibrary,
                        fixture_count: 0,
                        missing_3d_model: library.missing_3d_model(&make, &model, None),
                    };
                    let source = TypeSource {
                        make,
                        model,
                        revision: None,
                        install: None,
                        forced_mode: None,
                        modes,
                    };
                    (preview, Some(source))
                }
                // The names the spec gives let the review look the type up elsewhere,
                // such as on GDTF Share.
                None => {
                    let (make, model) = names.unzip();
                    (
                        FixtureTypePreview {
                            make,
                            model,
                            ..unresolved(spec, FixtureTypeStatus::Missing)
                        },
                        None,
                    )
                }
            }
        }
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
        missing_3d_model: false,
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

    /// A `GDTFSpec` gives its manufacturer and fixture name from the file name, with or
    /// without the revision, extension or a folder, and with `_` read as a space; specs
    /// without both names give none.
    #[test]
    fn spec_names_read_the_gdtf_file_name() {
        let names = |spec| spec_names(spec);
        let pair = |make: &str, model: &str| Some((make.to_string(), model.to_string()));
        assert_eq!(
            names("Clay Paky@Alpha Spot QWO 800@r3048.gdtf"),
            pair("Clay Paky", "Alpha Spot QWO 800")
        );
        assert_eq!(
            names("Robe_Lighting@Spiider.GDTF"),
            pair("Robe Lighting", "Spiider")
        );
        assert_eq!(names("fixtures/Acme@Wash"), pair("Acme", "Wash"));
        assert_eq!(names("Wash.gdtf"), None);
        assert_eq!(names("@Wash.gdtf"), None);
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
