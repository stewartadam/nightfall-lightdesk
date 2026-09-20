// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::{
    prelude::*,
    system::{RunSystemOnce, SystemParam},
};
use nightfall::prelude::*;
use nightfall_clips::Clip;
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
    ShowfileSnapshot,
    contributors::{
        ClipsSaveContributor, ColorPathsSaveContributor, CueStructureSaveContributor,
        DeskStateSaveContributor, FixturesPatchSaveContributor, FlowsSaveContributor,
        FxSaveContributor, SceneObjectsSaveContributor, ShowfileSaveContributor,
        TimecodesTimelinesSaveContributor, collect_save_contributions,
    },
};

/// Bevy system parameters needed to serialize canonical showfile state.
#[derive(SystemParam)]
pub struct ShowfileSaveState<'w, 's> {
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    scene_object_provider: Res<'w, SceneObjectDataProvider>,
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    seq_data_provider: Res<'w, DataProvider<Sequence>>,
    group_data_provider: Res<'w, DataProvider<Group>>,
    master_data_provider: Res<'w, DataProvider<Master>>,
    blueprint_data_provider: Res<'w, DataProvider<Blueprint>>,
    color_path_data_provider: Res<'w, DataProvider<ColorPath>>,
    fx_data_provider: Res<'w, DataProvider<Fx>>,
    fx_module_data_provider: Res<'w, DataProvider<StoredFxModule>>,
    step_fx_query: Query<'w, 's, &'static StepFx>,
    flow_data_provider: Res<'w, DataProvider<FlowDefinition>>,
    timecode_data_provider: Res<'w, DataProvider<Timecode>>,
    timeline_data_provider: Res<'w, DataProvider<Timeline>>,
    input_bindings: Res<'w, InputBindings>,
    output_bindings: Res<'w, OutputBindings>,
    disabled_bindings: Res<'w, DisabledBindings>,
    #[cfg(feature = "midi")]
    midi_mappings: Res<'w, MidiMappings>,
    #[cfg(feature = "osc")]
    osc_mappings: Res<'w, OscMappings>,
    clip_query: Query<'w, 's, &'static Clip>,
    global_variables: Res<'w, GlobalVariables>,
    controls: Res<'w, Controls>,
    /// Mutable desk settings allow the native save workflow to apply save-time UI state first.
    pub desk_settings: ResMut<'w, DeskSettings>,
    io_settings: Res<'w, IoRuntimeSettings>,
}

/// Convert runtime resources into the canonical, flat showfile snapshot.
pub fn snapshot_from_save_state(
    showfile_save_state: &ShowfileSaveState<'_, '_>,
) -> ShowfileSnapshot {
    let desk_state_contributor = DeskStateSaveContributor::new(
        showfile_save_state.global_variables.as_ref(),
        &showfile_save_state.controls,
        &showfile_save_state.desk_settings,
        &showfile_save_state.io_settings,
    );
    let fixtures_patch_contributor = FixturesPatchSaveContributor::new(
        &showfile_save_state.fixture_data_provider,
        &showfile_save_state.input_bindings,
        &showfile_save_state.output_bindings,
        &showfile_save_state.disabled_bindings,
        #[cfg(feature = "midi")]
        &showfile_save_state.midi_mappings,
        #[cfg(feature = "osc")]
        &showfile_save_state.osc_mappings,
    );
    let scene_objects_contributor =
        SceneObjectsSaveContributor::new(&showfile_save_state.scene_object_provider);
    let cue_structure_contributor = CueStructureSaveContributor::new(
        &showfile_save_state.cue_data_provider,
        &showfile_save_state.seq_data_provider,
        &showfile_save_state.group_data_provider,
        &showfile_save_state.master_data_provider,
        &showfile_save_state.blueprint_data_provider,
    );
    let color_paths_contributor = ColorPathsSaveContributor::new(
        &showfile_save_state.color_path_data_provider,
        &showfile_save_state.fixture_data_provider,
    );
    let fx_contributor = FxSaveContributor::new(
        &showfile_save_state.fx_data_provider,
        &showfile_save_state.fx_module_data_provider,
        &showfile_save_state.step_fx_query,
    );
    let flows_contributor = FlowsSaveContributor::new(&showfile_save_state.flow_data_provider);
    let clips_contributor = ClipsSaveContributor::new(&showfile_save_state.clip_query);
    let timecodes_timelines_contributor = TimecodesTimelinesSaveContributor::new(
        &showfile_save_state.timecode_data_provider,
        &showfile_save_state.timeline_data_provider,
    );

    collect_save_contributions(&[
        &desk_state_contributor as &dyn ShowfileSaveContributor,
        &fixtures_patch_contributor,
        &scene_objects_contributor,
        &cue_structure_contributor,
        &color_paths_contributor,
        &fx_contributor,
        &flows_contributor,
        &clips_contributor,
        &timecodes_timelines_contributor,
    ])
}

/// Serialize a standalone ECS world through the same contributor path used by native saves.
pub fn snapshot_from_world(world: &mut World) -> Result<ShowfileSnapshot, String> {
    world
        .run_system_once(|showfile_save_state: ShowfileSaveState| {
            snapshot_from_save_state(&showfile_save_state)
        })
        .map_err(|error| format!("failed to collect showfile snapshot: {error}"))
}
