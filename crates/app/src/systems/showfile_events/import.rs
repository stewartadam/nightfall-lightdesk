// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
};

use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_flow::prelude::*;
use nightfall_fx::prelude::*;
use serde::Serialize;
use uuid::Uuid;

use super::{BindingsSnapshot, ShowfileSnapshot, paths::*, stabilize_showfile_group_refs};

const FULL_IMPORT_POLICIES: &[ShowfileImportPolicy] = &[
    ShowfileImportPolicy::Skip,
    ShowfileImportPolicy::Merge,
    ShowfileImportPolicy::Replace,
    ShowfileImportPolicy::Overwrite,
];
const LIST_IMPORT_POLICIES: &[ShowfileImportPolicy] = &[
    ShowfileImportPolicy::Skip,
    ShowfileImportPolicy::Merge,
    ShowfileImportPolicy::Overwrite,
];
const REPLACE_ONLY_IMPORT_POLICIES: &[ShowfileImportPolicy] =
    &[ShowfileImportPolicy::Skip, ShowfileImportPolicy::Overwrite];

/// Resolves the showfile import source path from command options.
pub(super) fn import_showfile_path(options: &ShowfileImportOptions) -> Result<PathBuf, String> {
    match options
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => resolve_import_showfile_path(Path::new(path), &showfile_root_dir_path()?),
        None => showfile_path(None),
    }
}

/// Resolves an import path from the UI into an on-disk showfile path.
pub(super) fn resolve_import_showfile_path(
    path: &Path,
    showfile_root: &Path,
) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "invalid relative showfile import path {}",
            path.display()
        ));
    }

    Ok(showfile_root.join(path))
}

/// Merge two showfile snapshots according to per-object-type import policies.
pub(super) fn merge_showfile_snapshots(
    current: ShowfileSnapshot,
    incoming: ShowfileSnapshot,
    options: &ShowfileImportOptions,
) -> Result<ShowfileSnapshot, String> {
    validate_showfile_import_options(options)?;
    let incoming = retarget_incoming_fixture_references(&current.fixtures, incoming, options);
    let incoming = retarget_incoming_group_references(&current.groups, incoming, options);
    let incoming = retarget_incoming_blueprint_references(&current.blueprints, incoming, options);
    let color_paths = merge_identified_vec(
        "color paths",
        current.color_paths,
        incoming.color_paths,
        options.color_paths,
    )?;
    let color_path_defaults = prune_invalid_color_path_defaults(
        merge_color_path_defaults(
            current.color_path_defaults,
            incoming.color_path_defaults,
            options.fixtures,
        ),
        &color_paths,
    );
    let cues = prune_invalid_cue_color_path_assignments(
        merge_identified_vec("cues", current.cues, incoming.cues, options.cues)?,
        &color_paths,
    );

    let mut merged = ShowfileSnapshot {
        metadata: current.metadata,
        fixtures: merge_identified_vec(
            "fixtures",
            current.fixtures,
            incoming.fixtures,
            options.fixtures,
        )?,
        variables: merge_variables(current.variables, incoming.variables, options.variables),
        settings: merge_single(current.settings, incoming.settings, options.settings),
        io_settings: merge_single(current.io_settings, incoming.io_settings, options.settings),
        bindings: merge_bindings(current.bindings, incoming.bindings, options.bindings)?,
        #[cfg(feature = "midi")]
        midi_mappings: merge_plain_vec(
            "MIDI mappings",
            current.midi_mappings,
            incoming.midi_mappings,
            options.midi_mappings,
        )?,
        #[cfg(feature = "osc")]
        osc_mappings: merge_plain_vec(
            "OSC mappings",
            current.osc_mappings,
            incoming.osc_mappings,
            options.osc_mappings,
        )?,
        scene_objects: merge_identified_vec(
            "scene objects",
            current.scene_objects,
            incoming.scene_objects,
            options.scene_objects,
        )?,
        cues,
        sequences: merge_identified_vec(
            "sequences",
            current.sequences,
            incoming.sequences,
            options.sequences,
        )?,
        groups: merge_identified_vec("groups", current.groups, incoming.groups, options.groups)?,
        masters: merge_identified_vec(
            "masters",
            current.masters,
            incoming.masters,
            options.masters,
        )?,
        blueprints: merge_identified_vec(
            "blueprints",
            current.blueprints,
            incoming.blueprints,
            options.blueprints,
        )?,
        color_paths,
        color_path_defaults,
        fx: merge_identified_vec("fx", current.fx, incoming.fx, options.fx)?,
        fx_module: merge_identified_vec(
            "fx modules",
            current.fx_module,
            incoming.fx_module,
            options.fx_module,
        )?,
        step_fx: merge_step_fx_vec(
            "step fx",
            current.step_fx,
            incoming.step_fx,
            options.step_fx,
        )?,
        flows: merge_identified_vec("flows", current.flows, incoming.flows, options.flows)?,
        timecodes: merge_identified_vec(
            "timecodes",
            current.timecodes,
            incoming.timecodes,
            options.timecodes,
        )?,
        timelines: merge_identified_vec(
            "timelines",
            current.timelines,
            incoming.timelines,
            options.timelines,
        )?,
        clips: merge_identified_vec("clips", current.clips, incoming.clips, options.clips)?,
    };
    for warning in stabilize_showfile_group_refs(&mut merged) {
        tracing::warn!("{}", warning);
    }
    Ok(merged)
}

/// Validate that each import object type uses a policy that has clear semantics.
pub(super) fn validate_showfile_import_options(
    options: &ShowfileImportOptions,
) -> Result<(), String> {
    validate_import_policy("fixtures", options.fixtures, FULL_IMPORT_POLICIES)?;
    validate_import_policy("variables", options.variables, FULL_IMPORT_POLICIES)?;
    validate_import_policy("settings", options.settings, REPLACE_ONLY_IMPORT_POLICIES)?;
    validate_import_policy("bindings", options.bindings, LIST_IMPORT_POLICIES)?;
    validate_import_policy("MIDI mappings", options.midi_mappings, LIST_IMPORT_POLICIES)?;
    validate_import_policy("OSC mappings", options.osc_mappings, LIST_IMPORT_POLICIES)?;
    validate_import_policy("scene objects", options.scene_objects, FULL_IMPORT_POLICIES)?;
    validate_import_policy("cues", options.cues, FULL_IMPORT_POLICIES)?;
    validate_import_policy("sequences", options.sequences, FULL_IMPORT_POLICIES)?;
    validate_import_policy("groups", options.groups, FULL_IMPORT_POLICIES)?;
    validate_import_policy("masters", options.masters, FULL_IMPORT_POLICIES)?;
    validate_import_policy("blueprints", options.blueprints, FULL_IMPORT_POLICIES)?;
    validate_import_policy("color paths", options.color_paths, FULL_IMPORT_POLICIES)?;
    validate_import_policy("fx", options.fx, FULL_IMPORT_POLICIES)?;
    validate_import_policy(
        "fx modules",
        options.fx_module,
        REPLACE_ONLY_IMPORT_POLICIES,
    )?;
    validate_import_policy("step fx", options.step_fx, FULL_IMPORT_POLICIES)?;
    validate_import_policy("flows", options.flows, FULL_IMPORT_POLICIES)?;
    validate_import_policy("timecodes", options.timecodes, FULL_IMPORT_POLICIES)?;
    validate_import_policy("timelines", options.timelines, FULL_IMPORT_POLICIES)?;
    validate_import_policy("clips", options.clips, FULL_IMPORT_POLICIES)?;
    Ok(())
}

/// Retarget incoming resolved fixture references when fixture definitions are not imported.
fn retarget_incoming_fixture_references(
    current_fixtures: &[Fixture],
    mut incoming: ShowfileSnapshot,
    options: &ShowfileImportOptions,
) -> ShowfileSnapshot {
    if options.fixtures != ShowfileImportPolicy::Skip {
        return incoming;
    }

    let remap = fixture_uid_remap_by_id(current_fixtures, &incoming.fixtures);
    if remap.is_empty() {
        return incoming;
    }

    for cue in &mut incoming.cues {
        retarget_cue_fixture_refs(cue, &remap);
    }
    for sequence in &mut incoming.sequences {
        retarget_cue_fixture_refs(&mut sequence.setup_cue, &remap);
        retarget_cue_fixture_refs(&mut sequence.release_cue, &remap);
    }
    for group in &mut incoming.groups {
        retarget_spatial_selection(&mut group.selection, &remap);
    }
    for master in &mut incoming.masters {
        if let MasterTarget::Fixtures(FixtureMasterTarget::Selection(selection)) =
            &mut master.target
        {
            retarget_spatial_selection(selection, &remap);
        }
    }
    for fx in &mut incoming.fx {
        retarget_spatial_selection(&mut fx.selection, &remap);
    }
    for fx_module in &mut incoming.fx_module {
        retarget_spatial_selection(&mut fx_module.selection, &remap);
    }
    for step_fx in &mut incoming.step_fx {
        retarget_spatial_selection(&mut step_fx.selection, &remap);
    }
    for flow in &mut incoming.flows {
        retarget_flow_fixture_refs(flow, &remap);
    }

    incoming
}

/// Retarget incoming stable group references when group definitions are not imported.
fn retarget_incoming_group_references(
    current_groups: &[Group],
    mut incoming: ShowfileSnapshot,
    options: &ShowfileImportOptions,
) -> ShowfileSnapshot {
    if options.groups != ShowfileImportPolicy::Skip {
        return incoming;
    }

    let remap = group_uid_remap_by_id(current_groups, &incoming.groups);
    if remap.is_empty() {
        return incoming;
    }

    for cue in &mut incoming.cues {
        retarget_cue_group_refs(cue, &remap);
    }
    for sequence in &mut incoming.sequences {
        retarget_cue_group_refs(&mut sequence.setup_cue, &remap);
        retarget_cue_group_refs(&mut sequence.release_cue, &remap);
    }
    for group in &mut incoming.groups {
        retarget_spatial_selection_group_refs(&mut group.selection, &remap);
    }
    for master in &mut incoming.masters {
        if let MasterTarget::Fixtures(FixtureMasterTarget::Selection(selection)) =
            &mut master.target
        {
            retarget_spatial_selection_group_refs(selection, &remap);
        }
    }
    for fx in &mut incoming.fx {
        retarget_spatial_selection_group_refs(&mut fx.selection, &remap);
    }
    for fx_module in &mut incoming.fx_module {
        retarget_spatial_selection_group_refs(&mut fx_module.selection, &remap);
    }
    for step_fx in &mut incoming.step_fx {
        retarget_spatial_selection_group_refs(&mut step_fx.selection, &remap);
    }
    for flow in &mut incoming.flows {
        retarget_flow_group_refs(flow, &remap);
    }

    incoming
}

/// Retargets incoming Blueprint applications by numeric ID when definitions are skipped.
fn retarget_incoming_blueprint_references(
    current_blueprints: &[Blueprint],
    mut incoming: ShowfileSnapshot,
    options: &ShowfileImportOptions,
) -> ShowfileSnapshot {
    if options.blueprints != ShowfileImportPolicy::Skip {
        return incoming;
    }

    let remap = blueprint_uid_remap_by_id(current_blueprints, &incoming.blueprints);
    if remap.is_empty() {
        return incoming;
    }
    for cue in &mut incoming.cues {
        retarget_cue_blueprint_refs(cue, &remap);
    }
    for sequence in &mut incoming.sequences {
        retarget_cue_blueprint_refs(&mut sequence.setup_cue, &remap);
        retarget_cue_blueprint_refs(&mut sequence.release_cue, &remap);
    }
    for step_fx in &mut incoming.step_fx {
        step_fx.remap_blueprint_references(&remap);
    }
    incoming
}

/// Builds an incoming Blueprint UUID to current UUID map by operator-facing ID.
fn blueprint_uid_remap_by_id(
    current_blueprints: &[Blueprint],
    incoming_blueprints: &[Blueprint],
) -> HashMap<Uuid, Uuid> {
    let current_by_id = current_blueprints
        .iter()
        .map(|blueprint| (blueprint.identifiers.id, blueprint.identifiers.uid))
        .collect::<HashMap<_, _>>();
    incoming_blueprints
        .iter()
        .filter_map(|blueprint| {
            let current_uid = current_by_id.get(&blueprint.identifiers.id).copied()?;
            (current_uid != blueprint.identifiers.uid)
                .then_some((blueprint.identifiers.uid, current_uid))
        })
        .collect()
}

/// Retargets all live Blueprint applications stored in a cue and its parts.
fn retarget_cue_blueprint_refs(cue: &mut Cue, remap: &HashMap<Uuid, Uuid>) {
    for instruction in cue.instructions.iter_mut().chain(
        cue.parts
            .iter_mut()
            .flat_map(|part| part.instructions.iter_mut()),
    ) {
        let Some(application) = &mut instruction.cue_instruction.blueprint_application else {
            continue;
        };
        if let Some(current_uid) = remap.get(&application.blueprint_uid).copied() {
            application.blueprint_uid = current_uid;
        }
    }
}

/// Build an incoming group UID to current group UID map by numeric group ID.
fn group_uid_remap_by_id(
    current_groups: &[Group],
    incoming_groups: &[Group],
) -> HashMap<Uuid, Uuid> {
    let current_by_id = current_groups
        .iter()
        .map(|group| (group.identifiers.id, group.identifiers.uid))
        .collect::<HashMap<_, _>>();

    incoming_groups
        .iter()
        .filter_map(|group| {
            let current_uid = current_by_id.get(&group.identifiers.id).copied()?;
            (current_uid != group.identifiers.uid).then_some((group.identifiers.uid, current_uid))
        })
        .collect()
}

/// Build an incoming fixture UID to current fixture UID map by numeric fixture ID.
fn fixture_uid_remap_by_id(
    current_fixtures: &[Fixture],
    incoming_fixtures: &[Fixture],
) -> HashMap<Uuid, Uuid> {
    let current_by_id = current_fixtures
        .iter()
        .map(|fixture| (fixture.identifiers.id, fixture.identifiers.uid))
        .collect::<HashMap<_, _>>();

    incoming_fixtures
        .iter()
        .filter_map(|fixture| {
            let current_uid = current_by_id.get(&fixture.identifiers.id).copied()?;
            (current_uid != fixture.identifiers.uid)
                .then_some((fixture.identifiers.uid, current_uid))
        })
        .collect()
}

/// Retarget all fixture references stored directly on a cue.
fn retarget_cue_fixture_refs(cue: &mut Cue, remap: &HashMap<Uuid, Uuid>) {
    for instruction in &mut cue.instructions {
        retarget_bound_cue_instruction(instruction, remap);
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            retarget_bound_cue_instruction(instruction, remap);
        }
    }
}

/// Retarget stable group references stored directly on a cue.
fn retarget_cue_group_refs(cue: &mut Cue, remap: &HashMap<Uuid, Uuid>) {
    for instruction in &mut cue.instructions {
        retarget_spatial_selection_group_refs(&mut instruction.selection, remap);
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            retarget_spatial_selection_group_refs(&mut instruction.selection, remap);
        }
    }
}

/// Retarget a cue instruction selection and its per-fixture transition overrides.
fn retarget_bound_cue_instruction(
    instruction: &mut BoundCueInstruction,
    remap: &HashMap<Uuid, Uuid>,
) {
    retarget_spatial_selection(&mut instruction.selection, remap);
    for fixture_transition in &mut instruction.cue_instruction.transitions_by_fixture_attribute {
        retarget_fixture_ref(&mut fixture_transition.fixture, remap);
    }
}

/// Retarget resolved fixture references stored in flow port defaults.
fn retarget_flow_fixture_refs(flow: &mut FlowDefinition, remap: &HashMap<Uuid, Uuid>) {
    for node in &mut flow.nodes {
        for port in &mut node.ports {
            if let Some(FlowValue::Selection(selection)) = &mut port.default_value {
                retarget_spatial_selection(selection, remap);
            }
        }
    }
}

/// Retarget stable group references stored in flow port defaults.
fn retarget_flow_group_refs(flow: &mut FlowDefinition, remap: &HashMap<Uuid, Uuid>) {
    for node in &mut flow.nodes {
        for port in &mut node.ports {
            if let Some(FlowValue::Selection(selection)) = &mut port.default_value {
                retarget_spatial_selection_group_refs(selection, remap);
            }
        }
    }
}

/// Retarget resolved fixture references stored in a spatial selection.
fn retarget_spatial_selection(selection: &mut SpatialSelection, remap: &HashMap<Uuid, Uuid>) {
    retarget_selection_expr(&mut selection.source, remap);
    for branch in &mut selection.union {
        retarget_spatial_selection(branch, remap);
    }
}

/// Retarget stable group references stored in a spatial selection.
fn retarget_spatial_selection_group_refs(
    selection: &mut SpatialSelection,
    remap: &HashMap<Uuid, Uuid>,
) {
    retarget_selection_expr_group_refs(&mut selection.source, remap);
    for branch in &mut selection.union {
        retarget_spatial_selection_group_refs(branch, remap);
    }
}

/// Retarget resolved fixture references stored in a selection expression tree.
fn retarget_selection_expr(selection: &mut SelectionExpr, remap: &HashMap<Uuid, Uuid>) {
    match selection {
        SelectionExpr::Resolved(fixtures) => {
            for fixture_ref in fixtures {
                retarget_fixture_ref(fixture_ref, remap);
            }
        }
        SelectionExpr::Add { lhs, rhs } | SelectionExpr::Sub { lhs, rhs } => {
            retarget_selection_expr(lhs, remap);
            retarget_selection_expr(rhs, remap);
        }
        SelectionExpr::Span(inner) => retarget_selection_expr(inner, remap),
        SelectionExpr::Spatial(selection) => retarget_spatial_selection(selection, remap),
        SelectionExpr::Fixture(_)
        | SelectionExpr::FixtureRange { .. }
        | SelectionExpr::FixtureMap { .. }
        | SelectionExpr::Group(_) => {}
    }
}

/// Retarget stable group references stored in a selection expression tree.
fn retarget_selection_expr_group_refs(selection: &mut SelectionExpr, remap: &HashMap<Uuid, Uuid>) {
    match selection {
        SelectionExpr::Group(group_ref_expr) => retarget_group_ref_expr(group_ref_expr, remap),
        SelectionExpr::Add { lhs, rhs } | SelectionExpr::Sub { lhs, rhs } => {
            retarget_selection_expr_group_refs(lhs, remap);
            retarget_selection_expr_group_refs(rhs, remap);
        }
        SelectionExpr::Span(inner) => retarget_selection_expr_group_refs(inner, remap),
        SelectionExpr::Spatial(selection) => {
            retarget_spatial_selection_group_refs(selection, remap)
        }
        SelectionExpr::Fixture(_)
        | SelectionExpr::FixtureRange { .. }
        | SelectionExpr::FixtureMap { .. }
        | SelectionExpr::Resolved(_) => {}
    }
}

/// Retarget stable UID group refs while leaving dynamic refs unchanged.
fn retarget_group_ref_expr(group_ref_expr: &mut GroupRefExpr, remap: &HashMap<Uuid, Uuid>) {
    match group_ref_expr {
        GroupRefExpr::ByUid { uid } => {
            if let Some(current_uid) = remap.get(uid).copied() {
                *uid = current_uid;
            }
        }
        GroupRefExpr::Add { lhs, rhs } | GroupRefExpr::Sub { lhs, rhs } => {
            retarget_group_ref_expr(lhs, remap);
            retarget_group_ref_expr(rhs, remap);
        }
        GroupRefExpr::Span(inner) => retarget_group_ref_expr(inner, remap),
        GroupRefExpr::ById(_)
        | GroupRefExpr::ByLabel(_)
        | GroupRefExpr::RangeById { .. }
        | GroupRefExpr::MissingById(_)
        | GroupRefExpr::MissingByLabel(_) => {}
    }
}

/// Retarget one fixture reference if its fixture UID was remapped.
fn retarget_fixture_ref(fixture_ref: &mut FixtureRef, remap: &HashMap<Uuid, Uuid>) {
    if let Some(current_uid) = remap.get(&fixture_ref.fixture_uid).copied() {
        fixture_ref.fixture_uid = current_uid;
    }
}

/// Reject an import policy that is not supported for one object type.
fn validate_import_policy(
    label: &str,
    policy: ShowfileImportPolicy,
    allowed: &[ShowfileImportPolicy],
) -> Result<(), String> {
    if allowed.contains(&policy) {
        return Ok(());
    }

    let allowed = allowed
        .iter()
        .map(|policy| format!("{policy:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{label} import policy {policy:?} is not supported; choose one of: {allowed}"
    ))
}

/// Merge identified showfile objects, preserving existing UUID matches for merge.
fn merge_identified_vec<T>(
    label: &str,
    current: Vec<T>,
    incoming: Vec<T>,
    policy: ShowfileImportPolicy,
) -> Result<Vec<T>, String>
where
    T: HasIdentifiers,
{
    if policy == ShowfileImportPolicy::Skip {
        return Ok(current);
    }

    let merged = match policy {
        ShowfileImportPolicy::Skip => unreachable!("Skip is returned before merge validation"),
        ShowfileImportPolicy::Overwrite => incoming,
        ShowfileImportPolicy::Merge => {
            let mut merged = current;
            let mut existing_uids: HashSet<Uuid> =
                merged.iter().map(|item| item.identifiers().uid).collect();

            for item in incoming {
                let uid = item.identifiers().uid;
                if existing_uids.insert(uid) {
                    merged.push(item);
                }
            }
            merged
        }
        ShowfileImportPolicy::Replace => replace_identified_by_uid(current, incoming),
    };

    validate_unique_identifiers(label, &merged)?;
    Ok(merged)
}

/// Merge patch-scoped color path defaults by fixture reference.
fn merge_color_path_defaults(
    current: Vec<ColorPathDefault>,
    incoming: Vec<ColorPathDefault>,
    policy: ShowfileImportPolicy,
) -> Vec<ColorPathDefault> {
    match policy {
        ShowfileImportPolicy::Skip => current,
        ShowfileImportPolicy::Overwrite | ShowfileImportPolicy::Replace => incoming,
        ShowfileImportPolicy::Merge => {
            let mut by_fixture = current
                .into_iter()
                .map(|default| (default.fixture.clone(), default))
                .collect::<HashMap<_, _>>();
            for default in incoming {
                by_fixture.insert(default.fixture.clone(), default);
            }
            by_fixture.into_values().collect()
        }
    }
}

/// Drops fixture defaults that point at unavailable color paths.
fn prune_invalid_color_path_defaults(
    defaults: Vec<ColorPathDefault>,
    color_paths: &[ColorPath],
) -> Vec<ColorPathDefault> {
    let valid_path_ids = valid_color_path_ids(color_paths);

    defaults
        .into_iter()
        .filter(|default| valid_path_ids.contains(&default.color_path_id.0))
        .collect()
}

/// Returns color path IDs available after import, including built-ins.
fn valid_color_path_ids(color_paths: &[ColorPath]) -> HashSet<u32> {
    color_paths
        .iter()
        .map(|path| path.identifiers.id)
        .chain(
            builtin_color_paths()
                .into_iter()
                .map(|path| path.identifiers.id),
        )
        .collect()
}

/// Clears explicit cue assignments that point at unavailable color paths.
fn prune_invalid_cue_color_path_assignments(
    mut cues: Vec<Cue>,
    color_paths: &[ColorPath],
) -> Vec<Cue> {
    let valid_path_ids = valid_color_path_ids(color_paths);
    for cue in &mut cues {
        prune_invalid_instruction_color_path_assignments(&mut cue.instructions, &valid_path_ids);
        for part in &mut cue.parts {
            prune_invalid_instruction_color_path_assignments(
                &mut part.instructions,
                &valid_path_ids,
            );
        }
    }
    cues
}

/// Clears invalid color path assignments from a list of cue instructions.
fn prune_invalid_instruction_color_path_assignments(
    instructions: &mut [BoundCueInstruction],
    valid_path_ids: &HashSet<u32>,
) {
    for instruction in instructions {
        if let Some(color_path_id) = instruction.cue_instruction.color_path_id
            && !valid_path_ids.contains(&color_path_id.0)
        {
            instruction.cue_instruction.color_path_id = None;
        }
    }
}

/// Replace current identified objects with incoming objects that have the same UUID.
fn replace_identified_by_uid<T>(current: Vec<T>, incoming: Vec<T>) -> Vec<T>
where
    T: HasIdentifiers,
{
    let mut merged = current;
    let mut uid_indices = HashMap::new();
    for (index, item) in merged.iter().enumerate() {
        uid_indices.insert(item.identifiers().uid, index);
    }

    for item in incoming {
        let uid = item.identifiers().uid;
        if let Some(index) = uid_indices.get(&uid).copied() {
            merged[index] = item;
        } else {
            uid_indices.insert(uid, merged.len());
            merged.push(item);
        }
    }

    merged
}

/// Merge step FX definitions, preserving existing UUID matches for merge.
fn merge_step_fx_vec(
    label: &str,
    current: Vec<StepFx>,
    incoming: Vec<StepFx>,
    policy: ShowfileImportPolicy,
) -> Result<Vec<StepFx>, String> {
    if policy == ShowfileImportPolicy::Skip {
        return Ok(current);
    }

    let merged = match policy {
        ShowfileImportPolicy::Skip => unreachable!("Skip is returned before merge validation"),
        ShowfileImportPolicy::Overwrite => incoming,
        ShowfileImportPolicy::Merge => {
            let mut merged = current;
            let mut existing_uids: HashSet<Uuid> =
                merged.iter().map(|item| item.identifiers.uid).collect();

            for item in incoming {
                let uid = item.identifiers.uid;
                if existing_uids.insert(uid) {
                    merged.push(item);
                }
            }
            merged
        }
        ShowfileImportPolicy::Replace => replace_step_fx_by_uid(current, incoming),
    };

    validate_unique_step_fx_identifiers(label, &merged)?;
    Ok(merged)
}

/// Replace current step FX definitions with incoming definitions that have the same UUID.
fn replace_step_fx_by_uid(current: Vec<StepFx>, incoming: Vec<StepFx>) -> Vec<StepFx> {
    let mut merged = current;
    let mut uid_indices = HashMap::new();
    for (index, item) in merged.iter().enumerate() {
        uid_indices.insert(item.identifiers.uid, index);
    }

    for item in incoming {
        let uid = item.identifiers.uid;
        if let Some(index) = uid_indices.get(&uid).copied() {
            merged[index] = item;
        } else {
            uid_indices.insert(uid, merged.len());
            merged.push(item);
        }
    }

    merged
}

/// Reject imported object collections with duplicate numeric IDs across different UUIDs.
fn validate_unique_identifiers<T>(label: &str, items: &[T]) -> Result<(), String>
where
    T: HasIdentifiers,
{
    let mut ids = HashMap::new();
    for item in items {
        let identifiers = item.identifiers();
        if let Some(existing_uid) = ids.insert(identifiers.id, identifiers.uid) {
            if existing_uid != identifiers.uid {
                return Err(format!(
                    "cannot import {label}: ID {} is used by multiple objects",
                    identifiers.id
                ));
            }
        }
    }
    Ok(())
}

/// Reject imported step FX collections with duplicate numeric IDs across different UUIDs.
fn validate_unique_step_fx_identifiers(label: &str, items: &[StepFx]) -> Result<(), String> {
    let mut ids = HashMap::new();
    for item in items {
        if let Some(existing_uid) = ids.insert(item.identifiers.id, item.identifiers.uid) {
            if existing_uid != item.identifiers.uid {
                return Err(format!(
                    "cannot import {label}: ID {} is used by multiple objects",
                    item.identifiers.id
                ));
            }
        }
    }
    Ok(())
}

/// Merge a non-identified showfile list while preserving exact existing values.
fn merge_plain_vec<T>(
    label: &str,
    current: Vec<T>,
    incoming: Vec<T>,
    policy: ShowfileImportPolicy,
) -> Result<Vec<T>, String>
where
    T: Serialize,
{
    match policy {
        ShowfileImportPolicy::Skip => Ok(current),
        ShowfileImportPolicy::Overwrite => Ok(incoming),
        ShowfileImportPolicy::Merge => {
            let mut merged = current;
            let mut existing_values = HashSet::new();
            for item in &merged {
                existing_values.insert(serde_json::to_string(item).map_err(|error| {
                    format!("failed to compare {label} during import: {error}")
                })?);
            }

            for item in incoming {
                let value = serde_json::to_string(&item)
                    .map_err(|error| format!("failed to compare {label} during import: {error}"))?;
                if existing_values.insert(value) {
                    merged.push(item);
                }
            }

            Ok(merged)
        }
        ShowfileImportPolicy::Replace => Err(format!(
            "{label} import policy Replace is not supported; choose one of: Skip, Merge, Overwrite"
        )),
    }
}

/// Merge a single showfile value.
fn merge_single<T>(current: T, incoming: T, policy: ShowfileImportPolicy) -> T {
    match policy {
        ShowfileImportPolicy::Skip => current,
        ShowfileImportPolicy::Merge
        | ShowfileImportPolicy::Replace
        | ShowfileImportPolicy::Overwrite => incoming,
    }
}

/// Merge global variables by name according to the requested import policy.
fn merge_variables(
    current: HashMap<String, VariableValue>,
    incoming: HashMap<String, VariableValue>,
    policy: ShowfileImportPolicy,
) -> HashMap<String, VariableValue> {
    match policy {
        ShowfileImportPolicy::Skip => current,
        ShowfileImportPolicy::Overwrite => incoming,
        ShowfileImportPolicy::Merge => {
            let mut merged = current;
            for (key, value) in incoming {
                merged.entry(key).or_insert(value);
            }
            merged
        }
        ShowfileImportPolicy::Replace => {
            let mut merged = current;
            merged.extend(incoming);
            merged
        }
    }
}

/// Merge all binding collections under one import policy.
fn merge_bindings(
    current: BindingsSnapshot,
    incoming: BindingsSnapshot,
    policy: ShowfileImportPolicy,
) -> Result<BindingsSnapshot, String> {
    Ok(BindingsSnapshot {
        input: merge_plain_vec("input bindings", current.input, incoming.input, policy)?,
        output: merge_plain_vec("output bindings", current.output, incoming.output, policy)?,
        disabled: merge_plain_vec(
            "disabled bindings",
            current.disabled,
            incoming.disabled,
            policy,
        )?,
    })
}

#[cfg(test)]
mod blueprint_step_fx_tests {
    use nightfall_dmx::prelude::{Attribute, ParameterValue};

    use super::*;

    /// Verifies skipped Blueprint imports delegate Step FX reference remapping while preserving direct values.
    #[test]
    fn retargets_step_fx_blueprint_sources() {
        let incoming_uid = Uuid::from_u128(0xb001);
        let current_uid = Uuid::from_u128(0xb002);
        let step_fx = StepFx {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::from_u128(0xf001),
                label: "Imported".to_owned(),
            },
            lanes: vec![FxLane {
                attribute: Attribute::Pan,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::from_u128(0xf002),
                            target: ParameterValue::Absolute { value: 10.0 },
                            blueprint_uid: Some(incoming_uid),
                            width_beats: 0.5,
                            transition: 0.0.into(),
                            curve: CurveType::Linear(Linear {}),
                        },
                        FxStep {
                            uid: Uuid::from_u128(0xf003),
                            target: ParameterValue::Absolute { value: 25.0 },
                            blueprint_uid: None,
                            width_beats: 0.5,
                            transition: 0.0.into(),
                            curve: CurveType::Linear(Linear {}),
                        },
                    ],
                }),
                relative: None,
            }],
            ..Default::default()
        };

        let current_blueprint = Blueprint {
            identifiers: Identifiers {
                id: 1,
                uid: current_uid,
                label: "Current".into(),
            },
            ..Default::default()
        };
        let incoming_blueprint = Blueprint {
            identifiers: Identifiers {
                id: 1,
                uid: incoming_uid,
                label: "Incoming".into(),
            },
            ..Default::default()
        };
        let incoming = ShowfileSnapshot {
            blueprints: vec![incoming_blueprint],
            step_fx: vec![step_fx],
            ..Default::default()
        };
        let options = ShowfileImportOptions {
            blueprints: ShowfileImportPolicy::Skip,
            ..Default::default()
        };
        let imported =
            retarget_incoming_blueprint_references(&[current_blueprint], incoming, &options);
        let steps = &imported.step_fx[0].lanes[0]
            .absolute
            .as_ref()
            .unwrap()
            .steps;
        assert_eq!(steps[0].blueprint_uid, Some(current_uid));
        assert_eq!(steps[1].blueprint_uid, None);
        assert_eq!(steps[1].target, ParameterValue::Absolute { value: 25.0 });
    }
}
