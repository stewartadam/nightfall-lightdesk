// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile replacement pipeline and world-level load entry points.

use super::*;

mod reset;

use reset::reset_showfile_state;

/// Selects show-owned entities while preserving observers, resources, and registered systems.
pub(super) type ShowfileEntityFilter = (
    Without<Observer>,
    Without<IsResource>,
    Without<bevy::ecs::system::SystemIdMarker>,
);

/// Bevy system parameters mutated while replacing runtime state from a showfile.
#[derive(bevy::ecs::system::SystemParam)]
pub(crate) struct ShowfileLoadState<'w, 's> {
    pub(in crate::systems::showfile_events) fixture_data_provider:
        ResMut<'w, FixtureDataProviderExt>,
    pub(in crate::systems::showfile_events) scene_object_provider:
        ResMut<'w, SceneObjectDataProvider>,
    pub(in crate::systems::showfile_events) cue_data_provider: ResMut<'w, DataProvider<Cue>>,
    pub(in crate::systems::showfile_events) seq_data_provider: ResMut<'w, DataProvider<Sequence>>,
    pub(in crate::systems::showfile_events) group_data_provider: ResMut<'w, DataProvider<Group>>,
    pub(in crate::systems::showfile_events) master_data_provider: ResMut<'w, DataProvider<Master>>,
    pub(in crate::systems::showfile_events) blueprint_data_provider:
        ResMut<'w, DataProvider<Blueprint>>,
    pub(in crate::systems::showfile_events) color_path_data_provider:
        ResMut<'w, DataProvider<ColorPath>>,
    pub(in crate::systems::showfile_events) fx_data_provider: ResMut<'w, DataProvider<Fx>>,
    pub(in crate::systems::showfile_events) fx_module_data_provider:
        ResMut<'w, DataProvider<StoredFxModule>>,
    pub(in crate::systems::showfile_events) flow_data_provider:
        ResMut<'w, DataProvider<FlowDefinition>>,
    pub(in crate::systems::showfile_events) timecode_data_provider:
        ResMut<'w, DataProvider<Timecode>>,
    pub(in crate::systems::showfile_events) timeline_data_provider:
        ResMut<'w, DataProvider<Timeline>>,
    pub(in crate::systems::showfile_events) active_fx_module_ids:
        Option<ResMut<'w, ActiveFxModuleIds>>,
    pub(in crate::systems::showfile_events) input_bindings: ResMut<'w, InputBindings>,
    pub(in crate::systems::showfile_events) output_bindings: ResMut<'w, OutputBindings>,
    pub(in crate::systems::showfile_events) disabled_bindings: ResMut<'w, DisabledBindings>,
    #[cfg(feature = "midi")]
    pub(in crate::systems::showfile_events) midi_mappings: ResMut<'w, MidiMappings>,
    #[cfg(feature = "osc")]
    pub(in crate::systems::showfile_events) osc_mappings: ResMut<'w, OscMappings>,
    pub(in crate::systems::showfile_events) all_entities:
        Query<'w, 's, Entity, ShowfileEntityFilter>,
    pub(in crate::systems::showfile_events) resolved_input_bindings:
        Option<ResMut<'w, ResolvedInputBindings>>,
    pub(in crate::systems::showfile_events) console_dmx_addresses:
        Option<ResMut<'w, ConsoleDmxAddresses>>,
    pub(in crate::systems::showfile_events) console_dmx_universes:
        Option<ResMut<'w, ConsoleDmxUniverses>>,
    pub(in crate::systems::showfile_events) input_dmx_universes:
        Option<ResMut<'w, InputDmxUniverses>>,
    pub(in crate::systems::showfile_events) universe_transport_map:
        Option<ResMut<'w, UniverseTransportMap>>,
    pub(in crate::systems::showfile_events) instance_index: Option<ResMut<'w, InstanceIndex>>,
    pub(in crate::systems::showfile_events) final_layer_attributed_assertions:
        Option<ResMut<'w, FinalLayerAttributedAssertions>>,
    pub(in crate::systems::showfile_events) pending_commands: ResMut<'w, PendingCommandBuffer>,
    pub(in crate::systems::showfile_events) scheduled_commands:
        Option<ResMut<'w, DelayedCommandQueue>>,
    pub(in crate::systems::showfile_events) undo_manager: Option<ResMut<'w, UndoManager>>,
    pub(in crate::systems::showfile_events) programmer: Option<ResMut<'w, Programmer>>,
    pub(in crate::systems::showfile_events) global_variables: Res<'w, GlobalVariables>,
    pub(in crate::systems::showfile_events) desk_settings: ResMut<'w, DeskSettings>,
    pub(in crate::systems::showfile_events) io_settings: ResMut<'w, IoRuntimeSettings>,
}

/// Replaces current runtime showfile state with a provided snapshot.
#[allow(clippy::too_many_arguments)]
pub(super) fn load_showfile_in_place(
    showfile_snapshot: ShowfileSnapshot,
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
    active_fx_module_ids: Option<&mut ActiveFxModuleIds>,
    input_bindings: &mut InputBindings,
    output_bindings: &mut OutputBindings,
    disabled_bindings: &mut DisabledBindings,
    #[cfg(feature = "midi")] midi_mappings: &mut MidiMappings,
    #[cfg(feature = "osc")] osc_mappings: &mut OscMappings,
    all_entities: &Query<Entity, ShowfileEntityFilter>,
    resolved_input_bindings: Option<&mut ResolvedInputBindings>,
    console_dmx_addresses: Option<&mut ConsoleDmxAddresses>,
    console_dmx_universes: Option<&mut ConsoleDmxUniverses>,
    input_dmx_universes: Option<&mut InputDmxUniverses>,
    universe_transport_map: Option<&mut UniverseTransportMap>,
    instance_index: Option<&mut InstanceIndex>,
    final_layer_attributed_assertions: Option<&mut FinalLayerAttributedAssertions>,
    pending_commands: &mut PendingCommandBuffer,
    scheduled_commands: Option<&mut DelayedCommandQueue>,
    undo_manager: Option<&mut UndoManager>,
    programmer: Option<&mut Programmer>,
    global_variables: &GlobalVariables,
    desk_settings: &mut DeskSettings,
    io_settings: &mut IoRuntimeSettings,
    commands: &mut Commands,
) -> Result<(), String> {
    validate_showfile_asset_versions(&showfile_snapshot)?;

    tracing::trace!("Clearing existing state");
    reset_showfile_state(
        fixture_data_provider,
        scene_object_provider,
        cue_data_provider,
        seq_data_provider,
        group_data_provider,
        master_data_provider,
        blueprint_data_provider,
        color_path_data_provider,
        fx_data_provider,
        fx_module_data_provider,
        flow_data_provider,
        timecode_data_provider,
        timeline_data_provider,
        active_fx_module_ids,
        input_bindings,
        output_bindings,
        disabled_bindings,
        all_entities,
        resolved_input_bindings,
        console_dmx_addresses,
        console_dmx_universes,
        input_dmx_universes,
        universe_transport_map,
        instance_index,
        final_layer_attributed_assertions,
        pending_commands,
        scheduled_commands,
        undo_manager,
        programmer,
        global_variables,
        commands,
    );

    tracing::trace!("Applying state loaded from showfile");
    apply_showfile_snapshot(
        showfile_snapshot,
        fixture_data_provider,
        scene_object_provider,
        cue_data_provider,
        seq_data_provider,
        group_data_provider,
        master_data_provider,
        blueprint_data_provider,
        color_path_data_provider,
        fx_data_provider,
        fx_module_data_provider,
        flow_data_provider,
        timecode_data_provider,
        timeline_data_provider,
        input_bindings,
        output_bindings,
        disabled_bindings,
        #[cfg(feature = "midi")]
        midi_mappings,
        #[cfg(feature = "osc")]
        osc_mappings,
        desk_settings,
        io_settings,
        commands,
        global_variables,
    )
}

/// Replaces current runtime state using resources borrowed from a showfile load state.
pub(super) fn load_showfile_snapshot_from_state(
    showfile_snapshot: ShowfileSnapshot,
    showfile_load_state: &mut ShowfileLoadState<'_, '_>,
    commands: &mut Commands,
) -> Result<(), String> {
    let ShowfileLoadState {
        fixture_data_provider,
        scene_object_provider,
        cue_data_provider,
        seq_data_provider,
        group_data_provider,
        master_data_provider,
        blueprint_data_provider,
        color_path_data_provider,
        fx_data_provider,
        fx_module_data_provider,
        flow_data_provider,
        timecode_data_provider,
        timeline_data_provider,
        active_fx_module_ids,
        input_bindings,
        output_bindings,
        disabled_bindings,
        #[cfg(feature = "midi")]
        midi_mappings,
        #[cfg(feature = "osc")]
        osc_mappings,
        all_entities,
        resolved_input_bindings,
        console_dmx_addresses,
        console_dmx_universes,
        input_dmx_universes,
        universe_transport_map,
        instance_index,
        final_layer_attributed_assertions,
        pending_commands,
        scheduled_commands,
        undo_manager,
        programmer,
        global_variables,
        desk_settings,
        io_settings,
    } = showfile_load_state;

    load_showfile_in_place(
        showfile_snapshot,
        fixture_data_provider.as_mut(),
        scene_object_provider.as_mut(),
        cue_data_provider.as_mut(),
        seq_data_provider.as_mut(),
        group_data_provider.as_mut(),
        master_data_provider.as_mut(),
        blueprint_data_provider.as_mut(),
        color_path_data_provider.as_mut(),
        fx_data_provider.as_mut(),
        fx_module_data_provider.as_mut(),
        flow_data_provider.as_mut(),
        timecode_data_provider.as_mut(),
        timeline_data_provider.as_mut(),
        active_fx_module_ids.as_deref_mut(),
        input_bindings.as_mut(),
        output_bindings.as_mut(),
        disabled_bindings.as_mut(),
        #[cfg(feature = "midi")]
        midi_mappings.as_mut(),
        #[cfg(feature = "osc")]
        osc_mappings.as_mut(),
        &*all_entities,
        resolved_input_bindings.as_deref_mut(),
        console_dmx_addresses.as_deref_mut(),
        console_dmx_universes.as_deref_mut(),
        input_dmx_universes.as_deref_mut(),
        universe_transport_map.as_deref_mut(),
        instance_index.as_deref_mut(),
        final_layer_attributed_assertions.as_deref_mut(),
        pending_commands.as_mut(),
        scheduled_commands.as_deref_mut(),
        undo_manager.as_deref_mut(),
        programmer.as_deref_mut(),
        global_variables.as_ref(),
        desk_settings.as_mut(),
        io_settings.as_mut(),
        commands,
    )
}

/// Loads showfile data into an existing world by running the load system once.
pub fn load_showfile_into_world(
    world: &mut World,
    showfile_name: Option<&str>,
    source: std::path::PathBuf,
) -> Result<(), String> {
    let showfile_name = showfile_name.map(str::to_string);
    let loaded_showfile_name = showfile_name.clone();
    let snapshot = prepare_showfile_session(&source, showfile_name.as_deref())?;
    #[cfg(feature = "fixture-library")]
    if let Some(mut library) =
        world.get_resource_mut::<nightfall_fixture_library::manager::FixtureLibraryManager>()
    {
        library
            .set_showfile_directory(nightfall::active_show_data_dir())
            .map_err(|error| error.to_string())?;
    }
    let load_result = world
        .run_system_once(
            move |mut showfile_load_state: ShowfileLoadState, mut commands: Commands| {
                load_showfile_snapshot_from_state(
                    snapshot.clone(),
                    &mut showfile_load_state,
                    &mut commands,
                )
            },
        )
        .map_err(|error| format!("failed to run showfile load system: {}", error))?;
    load_result?;

    if let Some(mut current_showfile) = world.get_resource_mut::<CurrentShowfile>() {
        current_showfile.set_name(loaded_showfile_name.as_deref())?;
    } else {
        world.insert_resource(CurrentShowfile {
            name: current_showfile_name(loaded_showfile_name.as_deref())?,
        });
    }

    Ok(())
}
