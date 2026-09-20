// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Dependency-ordered application of persisted showfile domains.

use std::collections::HashSet;

use bevy_ecs::{
    prelude::*,
    system::{RunSystemOnce, SystemParam},
};
use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_flow::prelude::*;
use nightfall_fx::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
#[cfg(feature = "osc")]
use nightfall_input_osc::prelude::*;
use nightfall_io::IoRuntimeSettings;
use nightfall_scene_objects::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;

use crate::{
    ShowfileSnapshot, contributors::*, stabilize_showfile_group_refs,
    validate_showfile_asset_versions,
};

/// Ordered phases used to rebuild runtime state while loading a showfile.
#[derive(Debug, Clone, Copy)]
pub enum ShowfileLoadPhase {
    /// Import serialized definitions and plain resource state.
    ImportDefs,
    /// Resolve references that depend on definitions imported by other domains.
    ResolveLinks,
    /// Spawn runtime-only ECS entities derived from persisted definitions.
    MaterializeRuntime,
}

impl ShowfileLoadPhase {
    const ALL: [Self; 3] = [
        Self::ImportDefs,
        Self::ResolveLinks,
        Self::MaterializeRuntime,
    ];
}

/// Dependency domains used to group showfile load work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShowfileLoadDomain {
    /// Global variables and desk/runtime settings.
    DeskState,
    /// Fixture definitions, parameters, and patch bindings.
    FixturesPatch,
    /// Visualizer scene object definitions.
    SceneObjects,
    /// Cues, sequences, groups, masters, and blueprints.
    CueStructure,
    /// Custom and showfile-selected color interpolation paths.
    ColorPaths,
    /// Built-in, component, and step FX definitions.
    Fx,
    /// Flow graph definitions.
    Flows,
    /// Clip assignments that reference other showfile domains.
    Clips,
    /// Timecode generators and editable timelines.
    TimecodesTimelines,
}

impl ShowfileLoadDomain {
    const ALL: [Self; 9] = [
        Self::DeskState,
        Self::FixturesPatch,
        Self::SceneObjects,
        Self::CueStructure,
        Self::ColorPaths,
        Self::Fx,
        Self::Flows,
        Self::Clips,
        Self::TimecodesTimelines,
    ];

    /// Returns the domains that must be applied before this domain.
    const fn dependencies(self) -> &'static [Self] {
        match self {
            Self::DeskState => &[],
            Self::FixturesPatch => &[],
            Self::SceneObjects => &[],
            Self::CueStructure => &[],
            Self::ColorPaths => &[Self::FixturesPatch],
            Self::Fx => &[],
            Self::Flows => &[],
            Self::Clips => &[Self::CueStructure, Self::Fx, Self::Flows],
            Self::TimecodesTimelines => &[
                Self::SceneObjects,
                Self::CueStructure,
                Self::Fx,
                Self::Flows,
                Self::Clips,
            ],
        }
    }
}

/// Returns load domains in dependency-safe order.
pub fn ordered_showfile_load_domains() -> Result<Vec<ShowfileLoadDomain>, String> {
    /// Visits one dependency node while detecting cycles in the static domain graph.
    fn visit(
        domain: ShowfileLoadDomain,
        ordered: &mut Vec<ShowfileLoadDomain>,
        visiting: &mut HashSet<ShowfileLoadDomain>,
        visited: &mut HashSet<ShowfileLoadDomain>,
    ) -> Result<(), String> {
        if visited.contains(&domain) {
            return Ok(());
        }
        if !visiting.insert(domain) {
            return Err(format!(
                "cycle detected in showfile load domain graph: {:?}",
                domain
            ));
        }

        for dependency in domain.dependencies() {
            visit(*dependency, ordered, visiting, visited)?;
        }

        visiting.remove(&domain);
        visited.insert(domain);
        ordered.push(domain);
        Ok(())
    }

    let mut ordered = Vec::with_capacity(ShowfileLoadDomain::ALL.len());
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for domain in ShowfileLoadDomain::ALL {
        visit(domain, &mut ordered, &mut visiting, &mut visited)?;
    }

    Ok(ordered)
}

/// Applies a showfile snapshot to runtime resources in deterministic phase/domain order.
pub fn apply_showfile_snapshot(
    mut showfile_snapshot: ShowfileSnapshot,
    fixture_data_provider: &mut FixtureDataProviderExt,
    scene_object_provider: &mut SceneObjectDataProvider,
    cue_data_provider: &mut DataProvider<Cue>,
    seq_data_provider: &mut DataProvider<Sequence>,
    group_data_provider: &mut DataProvider<Group>,
    master_data_provider: &mut DataProvider<Master>,
    blueprint_data_provider: &mut DataProvider<Blueprint>,
    color_path_data_provider: &mut DataProvider<ColorPath>,
    fx_data_provider: &mut DataProvider<Fx>,
    fx_module_data_provider: &mut DataProvider<StoredFxModule>,
    flow_data_provider: &mut DataProvider<FlowDefinition>,
    timecode_data_provider: &mut DataProvider<Timecode>,
    timeline_data_provider: &mut DataProvider<Timeline>,
    input_bindings: &mut InputBindings,
    output_bindings: &mut OutputBindings,
    disabled_bindings: &mut DisabledBindings,
    #[cfg(feature = "midi")] midi_mappings: &mut MidiMappings,
    #[cfg(feature = "osc")] osc_mappings: &mut OscMappings,
    desk_settings: &mut DeskSettings,
    io_settings: &mut IoRuntimeSettings,
    commands: &mut Commands,
    global_variables: &GlobalVariables,
) -> Result<(), String> {
    validate_showfile_asset_versions(&showfile_snapshot)?;
    for warning in stabilize_showfile_group_refs(&mut showfile_snapshot) {
        tracing::warn!("{}", warning);
    }

    let load_domains = ordered_showfile_load_domains()?;
    let mut desk_state_contributor =
        DeskStateLoadContributor::new(global_variables, desk_settings, io_settings);
    let mut fixtures_patch_contributor = FixturesPatchLoadContributor::new(
        fixture_data_provider,
        input_bindings,
        output_bindings,
        disabled_bindings,
        #[cfg(feature = "midi")]
        midi_mappings,
        #[cfg(feature = "osc")]
        osc_mappings,
    );
    let mut scene_objects_contributor = SceneObjectsLoadContributor::new(scene_object_provider);
    let mut cue_structure_contributor = CueStructureLoadContributor::new(
        cue_data_provider,
        seq_data_provider,
        group_data_provider,
        master_data_provider,
        blueprint_data_provider,
    );
    let mut color_paths_contributor = ColorPathsLoadContributor::new(color_path_data_provider);
    let mut fx_contributor = FxLoadContributor::new(fx_data_provider, fx_module_data_provider);
    let mut flows_contributor = FlowsLoadContributor::new(flow_data_provider);
    let mut clips_contributor = ClipsLoadContributor::new();
    let mut timecodes_timelines_contributor =
        TimecodesTimelinesLoadContributor::new(timecode_data_provider, timeline_data_provider);
    let mut load_contributors: [&mut dyn ShowfileLoadContributor; 9] = [
        &mut desk_state_contributor,
        &mut fixtures_patch_contributor,
        &mut scene_objects_contributor,
        &mut cue_structure_contributor,
        &mut color_paths_contributor,
        &mut fx_contributor,
        &mut flows_contributor,
        &mut clips_contributor,
        &mut timecodes_timelines_contributor,
    ];

    // Deterministic phase barriers:
    // - Import/resolve phases are pure state updates and do not queue ECS spawns.
    // - Runtime entity creation is isolated to materialization phase.
    for phase in ShowfileLoadPhase::ALL {
        for domain in load_domains.iter().copied() {
            apply_load_contributors(
                phase,
                domain,
                &mut load_contributors,
                &showfile_snapshot,
                commands,
            )?;
        }
    }

    tracing::info!("Showfile loaded");

    Ok(())
}

/// Resource set required to apply canonical showfile domains to an initialized world.
#[derive(SystemParam)]
pub struct ShowfileApplyState<'w> {
    fixture_data_provider: ResMut<'w, FixtureDataProviderExt>,
    scene_object_provider: ResMut<'w, SceneObjectDataProvider>,
    cue_data_provider: ResMut<'w, DataProvider<Cue>>,
    seq_data_provider: ResMut<'w, DataProvider<Sequence>>,
    group_data_provider: ResMut<'w, DataProvider<Group>>,
    master_data_provider: ResMut<'w, DataProvider<Master>>,
    blueprint_data_provider: ResMut<'w, DataProvider<Blueprint>>,
    color_path_data_provider: ResMut<'w, DataProvider<ColorPath>>,
    fx_data_provider: ResMut<'w, DataProvider<Fx>>,
    fx_module_data_provider: ResMut<'w, DataProvider<StoredFxModule>>,
    flow_data_provider: ResMut<'w, DataProvider<FlowDefinition>>,
    timecode_data_provider: ResMut<'w, DataProvider<Timecode>>,
    timeline_data_provider: ResMut<'w, DataProvider<Timeline>>,
    input_bindings: ResMut<'w, InputBindings>,
    output_bindings: ResMut<'w, OutputBindings>,
    disabled_bindings: ResMut<'w, DisabledBindings>,
    #[cfg(feature = "midi")]
    midi_mappings: ResMut<'w, MidiMappings>,
    #[cfg(feature = "osc")]
    osc_mappings: ResMut<'w, OscMappings>,
    global_variables: Res<'w, GlobalVariables>,
    desk_settings: ResMut<'w, DeskSettings>,
    io_settings: ResMut<'w, IoRuntimeSettings>,
}

/// Apply a canonical snapshot to an initialized world through one deferred ECS system.
pub fn apply_showfile_snapshot_to_world(
    world: &mut World,
    snapshot: ShowfileSnapshot,
) -> Result<(), String> {
    initialize_showfile_resources(world);

    let mut snapshot = Some(snapshot);
    world
        .run_system_once(
            move |mut state: ShowfileApplyState, mut commands: Commands| {
                let snapshot = snapshot
                    .take()
                    .expect("showfile snapshot should be consumed exactly once");
                apply_showfile_snapshot(
                    snapshot,
                    &mut state.fixture_data_provider,
                    &mut state.scene_object_provider,
                    &mut state.cue_data_provider,
                    &mut state.seq_data_provider,
                    &mut state.group_data_provider,
                    &mut state.master_data_provider,
                    &mut state.blueprint_data_provider,
                    &mut state.color_path_data_provider,
                    &mut state.fx_data_provider,
                    &mut state.fx_module_data_provider,
                    &mut state.flow_data_provider,
                    &mut state.timecode_data_provider,
                    &mut state.timeline_data_provider,
                    &mut state.input_bindings,
                    &mut state.output_bindings,
                    &mut state.disabled_bindings,
                    #[cfg(feature = "midi")]
                    &mut state.midi_mappings,
                    #[cfg(feature = "osc")]
                    &mut state.osc_mappings,
                    &mut state.desk_settings,
                    &mut state.io_settings,
                    &mut commands,
                    &state.global_variables,
                )
            },
        )
        .map_err(|error| format!("failed to apply showfile snapshot: {error}"))?
}

/// Initialize plain-data resources required by portable showfile materialization.
pub fn initialize_showfile_resources(world: &mut World) {
    world.init_resource::<FixtureDataProviderExt>();
    world.init_resource::<SceneObjectDataProvider>();
    world.init_resource::<DataProvider<Cue>>();
    world.init_resource::<DataProvider<Sequence>>();
    world.init_resource::<DataProvider<Group>>();
    world.init_resource::<DataProvider<Master>>();
    world.init_resource::<DataProvider<Blueprint>>();
    world.init_resource::<DataProvider<ColorPath>>();
    world.init_resource::<DataProvider<Fx>>();
    world.init_resource::<DataProvider<StoredFxModule>>();
    world.init_resource::<DataProvider<FlowDefinition>>();
    world.init_resource::<DataProvider<Timecode>>();
    world.init_resource::<DataProvider<Timeline>>();
    world.init_resource::<InputBindings>();
    world.init_resource::<OutputBindings>();
    world.init_resource::<DisabledBindings>();
    #[cfg(feature = "midi")]
    world.init_resource::<MidiMappings>();
    #[cfg(feature = "osc")]
    world.init_resource::<OscMappings>();
    world.init_resource::<GlobalVariables>();
    world.init_resource::<DeskSettings>();
    world.init_resource::<Controls>();
    world.init_resource::<IoRuntimeSettings>();
}
