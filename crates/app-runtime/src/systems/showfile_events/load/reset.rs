// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime cleanup performed before applying a replacement showfile snapshot.

use std::collections::HashSet;

use super::super::*;
use super::ShowfileEntityFilter;

/// Clears world and runtime resources that are rebuilt by showfile load.
#[allow(clippy::too_many_arguments)]
pub(super) fn reset_showfile_state(
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
    all_entities: &Query<Entity, ShowfileEntityFilter>,
    resolved_input_bindings: Option<&mut ResolvedInputBindings>,
    console_dmx_addresses: Option<&mut ConsoleDmxAddresses>,
    console_dmx_universes: Option<&mut ConsoleDmxUniverses>,
    input_dmx_universes: Option<&mut InputDmxUniverses>,
    output_routing: Option<&mut OutputRouting>,
    instance_index: Option<&mut InstanceIndex>,
    final_layer_attributed_assertions: Option<&mut FinalLayerAttributedAssertions>,
    pending_commands: &mut PendingCommandBuffer,
    scheduled_commands: Option<&mut DelayedCommandQueue>,
    undo_manager: Option<&mut UndoManager>,
    programmer: Option<&mut Programmer>,
    global_variables: &GlobalVariables,
    commands: &mut Commands,
) {
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
    if let Some(active_fx_module_ids) = active_fx_module_ids {
        active_fx_module_ids.0.clear();
    }

    input_bindings.bindings.clear();
    output_bindings.bindings.clear();
    disabled_bindings.bindings.clear();
    if let Some(resolved_input_bindings) = resolved_input_bindings {
        resolved_input_bindings.bindings.clear();
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
