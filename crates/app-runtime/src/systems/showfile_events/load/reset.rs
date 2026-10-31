// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime cleanup performed before applying a replacement showfile snapshot.

use std::collections::HashSet;

use super::super::*;
use super::ShowfileLoadState;

/// Clears world and runtime resources that are rebuilt by showfile load.
pub(super) fn reset_showfile_state(state: &mut ShowfileLoadState<'_, '_>, commands: &mut Commands) {
    let ShowfileLoadState {
        apply:
            ShowfileApplyState {
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
                board_data_provider,
                macro_data_provider,
                input_routes,
                output_routes,
                disabled_routes,
                global_variables,
                // Listed so a new apply field fails to compile here until reset decides on it.
                #[cfg(feature = "midi")]
                    midi_mappings: _,
                #[cfg(feature = "osc")]
                    osc_mappings: _,
                desk_settings: _,
                io_settings: _,
            },
        active_fx_module_ids,
        all_entities,
        resolved_input_routes,
        console_dmx_addresses,
        console_dmx_universes,
        input_dmx_universes,
        output_routing,
        instance_index,
        final_layer_attributed_assertions,
        pending_commands,
        scheduled_commands,
        undo_manager,
        programmer,
        ..
    } = state;
    let parameter_entities: HashSet<Entity> = fixture_data_provider
        .clear_all()
        .into_iter()
        .map(|parameter| parameter.entity())
        .collect();
    let entities_to_reset: Vec<Entity> = all_entities.iter().collect();
    commands.queue(move |world: &mut World| {
        let reset_entities: HashSet<Entity> = entities_to_reset.iter().copied().collect();
        for entity in entities_to_reset
            .iter()
            .copied()
            .filter(|entity| !parameter_entities.contains(entity))
            .chain(parameter_entities.iter().copied())
        {
            let parent_in_reset = world
                .get::<ChildOf>(entity)
                .is_some_and(|child_of| reset_entities.contains(&child_of.parent()));
            if parent_in_reset {
                continue;
            }
            let _ = world.try_despawn(entity);
        }
        nightfall_fixtures::compositor::spawn_assertion_layer_entities_in_world(world);
    });

    scene_object_provider.clear();
    cue_data_provider.clear();
    seq_data_provider.clear();
    group_data_provider.clear();
    master_data_provider.clear();
    blueprint_data_provider.clear();
    color_path_data_provider.clear();
    color_path_data_provider.extend(builtin_color_paths());
    fx_data_provider.clear();
    fx_module_data_provider.clear();
    flow_data_provider.clear();
    timecode_data_provider.clear();
    timeline_data_provider.clear();
    board_data_provider.clear();
    macro_data_provider.clear();
    if let Some(active_fx_module_ids) = active_fx_module_ids {
        active_fx_module_ids.0.clear();
    }

    input_routes.routes.clear();
    output_routes.routes.clear();
    disabled_routes.routes.clear();
    if let Some(resolved_input_routes) = resolved_input_routes {
        resolved_input_routes.routes.clear();
    }
    if let Some(console_dmx_addresses) = console_dmx_addresses {
        console_dmx_addresses.clear();
    }
    if let Some(console_dmx_universes) = console_dmx_universes {
        console_dmx_universes.clear();
    }
    if let Some(input_dmx_universes) = input_dmx_universes {
        input_dmx_universes.clear();
    }
    if let Some(output_routing) = output_routing {
        output_routing.clear();
    }

    global_variables.clear();

    let _ = pending_commands.drain();
    if let Some(scheduled_commands) = scheduled_commands {
        scheduled_commands.clear();
    }
    if let Some(instance_index) = instance_index {
        instance_index.0.clear();
    }
    if let Some(final_layer_attributed_assertions) = final_layer_attributed_assertions {
        final_layer_attributed_assertions.0 = AttributedAssertionsLayer::default();
    }
    if let Some(undo_manager) = undo_manager {
        undo_manager.clear();
    }
    if let Some(programmer) = programmer {
        programmer.clear();
    }
}
