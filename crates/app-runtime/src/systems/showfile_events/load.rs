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
    /// Show stores and settings the shared showfile apply step fills.
    pub(in crate::systems::showfile_events) apply: ShowfileApplyState<'w>,
    pub(in crate::systems::showfile_events) active_fx_module_ids:
        Option<ResMut<'w, ActiveFxModuleIds>>,
    pub(in crate::systems::showfile_events) all_entities:
        Query<'w, 's, Entity, ShowfileEntityFilter>,
    pub(in crate::systems::showfile_events) resolved_input_routes:
        Option<ResMut<'w, ResolvedInputRoutes>>,
    pub(in crate::systems::showfile_events) console_dmx_addresses:
        Option<ResMut<'w, ConsoleDmxAddresses>>,
    pub(in crate::systems::showfile_events) console_dmx_universes:
        Option<ResMut<'w, ConsoleDmxUniverses>>,
    pub(in crate::systems::showfile_events) input_dmx_universes:
        Option<ResMut<'w, InputDmxUniverses>>,
    pub(in crate::systems::showfile_events) output_routing: Option<ResMut<'w, OutputRouting>>,
    pub(in crate::systems::showfile_events) instance_index: Option<ResMut<'w, InstanceIndex>>,
    pub(in crate::systems::showfile_events) final_layer_attributed_assertions:
        Option<ResMut<'w, FinalLayerAttributedAssertions>>,
    pub(in crate::systems::showfile_events) pending_commands: ResMut<'w, PendingCommandBuffer>,
    pub(in crate::systems::showfile_events) scheduled_commands:
        Option<ResMut<'w, DelayedCommandQueue>>,
    pub(in crate::systems::showfile_events) undo_manager: Option<ResMut<'w, UndoManager>>,
    pub(in crate::systems::showfile_events) programmer: Option<ResMut<'w, Programmer>>,
    pub(in crate::systems::showfile_events) controller_mapping_mode:
        Option<ResMut<'w, nightfall_actions::ControllerMappingMode>>,
    pub(in crate::systems::showfile_events) macro_runs:
        Option<ResMut<'w, nightfall_macros::prelude::MacroRuns>>,
}

/// Clears the current show from the world, then applies `showfile_snapshot` through the shared
/// showfile apply step. Fails without touching the world when the snapshot's asset versions are
/// unsupported.
pub(super) fn load_showfile_in_place(
    showfile_snapshot: ShowfileSnapshot,
    state: &mut ShowfileLoadState<'_, '_>,
    commands: &mut Commands,
) -> Result<(), String> {
    validate_showfile_asset_versions(&showfile_snapshot)?;

    tracing::trace!("Clearing existing state");
    reset_showfile_state(state, commands);

    tracing::trace!("Applying state loaded from showfile");
    apply_showfile_snapshot(showfile_snapshot, &mut state.apply, commands)
}

/// Replaces current runtime state using resources borrowed from a showfile load state. Ends
/// controller mapping mode and running macros first, since the show they target goes away.
pub(super) fn load_showfile_snapshot_from_state(
    showfile_snapshot: ShowfileSnapshot,
    showfile_load_state: &mut ShowfileLoadState<'_, '_>,
    commands: &mut Commands,
) -> Result<(), String> {
    // Reject an unloadable show before ending anything that belongs to the current one.
    validate_showfile_asset_versions(&showfile_snapshot)?;

    // A loaded show replaces every target a client may be about to bind, so mapping mode
    // ends for everyone instead of letting a pending bind land on the new show.
    if let Some(mode) = showfile_load_state.controller_mapping_mode.as_deref_mut() {
        if mode.is_active() {
            tracing::info!("controller_mapping_mode_released_on_show_load");
        }
        mode.end_for_show_load();
    }
    if let Some(runs) = showfile_load_state.macro_runs.as_deref_mut() {
        runs.end_all_for_show_load();
    }

    load_showfile_in_place(showfile_snapshot, showfile_load_state, commands)
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
