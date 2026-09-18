// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Event handlers for fixture commands.

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_engine::prelude::*;

use crate::FixtureCommand;
use crate::prelude::*;

/// Handle SetDmxChannels commands to directly set raw DMX channel values.
pub fn handle_set_dmx_channels(
    mut events: MessageReader<CommandEnvelope<FixtureCommand>>,
    mut universes: ResMut<ConsoleDmxUniverses>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        if let FixtureCommand::SetDmxChannels { channels, value } = &event.command {
            let dmx_value = *value;
            let expanded_channels = channels.expand();

            tracing::debug!("Setting DMX channels {} to value {}", channels, dmx_value);

            // Step 1: Set the raw DMX values
            for ch in &expanded_channels {
                universes.set_value(
                    ch.universe,
                    ch.address,
                    dmx_value,
                    ConsoleChannelOrigin::ManualCommand,
                );
                tracing::trace!(
                    "Set universe {} address {} to {}",
                    ch.universe,
                    ch.address,
                    dmx_value
                );
            }
            if let Err(error) = responder.succeed(event.command_id) {
                tracing::error!(command_id = %event.command_id, %error, "fixture_dmx_command_finish_failed");
            }
        }
    }
}

/// Handle RestoreFixtureSnapshot commands to recreate a deleted fixture.
pub fn handle_restore_fixture_snapshot(
    mut commands: Commands,
    mut events: MessageReader<EngineActionEnvelope<crate::undo::RestoreFixtureSnapshot>>,
    mut data_provider: ResMut<FixtureDataProviderExt>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let snapshot = &event.action.0;
        let fixture = snapshot.fixture.clone();
        let fixture_uid = fixture.identifiers.uid;
        tracing::debug!(
            "Restoring fixture snapshot for fixture {}",
            fixture.identifiers.id
        );

        if let Ok((_fixture, parameter_entities)) = data_provider.remove_fixture(&fixture_uid) {
            for parameter_entity in parameter_entities {
                commands.entity(parameter_entity.entity()).despawn();
            }
        }

        if let Err(err) = data_provider.inner.add(fixture) {
            tracing::warn!("Failed to restore fixture snapshot: {}", err);
            fail_action(
                &mut responder,
                event.command_id,
                "fixtures.restore_fixture_failed",
                err.to_string(),
            );
            continue;
        }

        for parameter_snapshot in &snapshot.parameters {
            let element_ref = FixtureRef {
                fixture_uid,
                index: Some(parameter_snapshot.element_index),
            };
            let parameter_cmds = commands.spawn_instance(Parameter {
                metadata: parameter_snapshot.metadata.clone(),
                values: parameter_snapshot.values.clone(),
            });
            let parameter_entity = parameter_cmds.instance();

            tracing::trace!(
                ?parameter_entity,
                ?element_ref,
                attribute = ?parameter_snapshot.metadata.attribute,
                "Spawning restored parameter entity"
            );

            data_provider.add_parameter(
                element_ref,
                parameter_snapshot.metadata.attribute.clone(),
                parameter_entity,
            );
        }

        for default in &snapshot.color_path_defaults {
            data_provider
                .set_color_path_default(default.fixture.clone(), Some(default.color_path_id));
        }
        succeed_action(&mut responder, event.command_id);
    }
}

fn output_binding_matches_fixture(binding: &OutputBinding, uid: uuid::Uuid) -> bool {
    match &binding.source {
        OutputSource::Fixture { uids, .. } => uids.contains(&uid),
        _ => false,
    }
}

fn disabled_binding_matches_fixture(binding: &DisabledBinding, uid: uuid::Uuid) -> bool {
    match binding {
        DisabledBinding::Output {
            source: OutputSource::Fixture { uids, .. },
            ..
        } => uids.contains(&uid),
        _ => false,
    }
}

/// Handle RestoreBindingSnapshot commands to restore fixture binding configuration.
pub fn handle_restore_binding_snapshot(
    mut events: MessageReader<EngineActionEnvelope<crate::undo::RestoreBindingSnapshot>>,
    data_provider: Res<FixtureDataProviderExt>,
    mut output_bindings: ResMut<OutputBindings>,
    mut disabled_bindings: ResMut<DisabledBindings>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let snapshot = &event.action.0;
        tracing::debug!(
            "Restoring binding snapshot for fixture {}",
            snapshot.fixture_id
        );

        let fixture_uid = match data_provider.inner.from_id(snapshot.fixture_id) {
            Ok(fixture) => fixture.identifiers.uid,
            Err(_) => {
                tracing::warn!(
                    "Failed to restore bindings: fixture {} not found",
                    snapshot.fixture_id
                );
                fail_action(
                    &mut responder,
                    event.command_id,
                    "fixtures.restore_binding_failed",
                    format!("Fixture {} was not found", snapshot.fixture_id),
                );
                continue;
            }
        };

        output_bindings
            .bindings
            .retain(|binding| !output_binding_matches_fixture(binding, fixture_uid));
        disabled_bindings
            .bindings
            .retain(|binding| !disabled_binding_matches_fixture(binding, fixture_uid));

        output_bindings
            .bindings
            .extend(snapshot.output_bindings.clone());
        disabled_bindings
            .bindings
            .extend(snapshot.disabled_bindings.clone());
        succeed_action(&mut responder, event.command_id);
    }
}

/// Handle RestorePatchBindingsSnapshot commands to restore all patch bindings.
pub fn handle_restore_patch_bindings_snapshot(
    mut events: MessageReader<EngineActionEnvelope<crate::undo::RestorePatchBindingsSnapshot>>,
    mut input_bindings: ResMut<InputBindings>,
    mut output_bindings: ResMut<OutputBindings>,
    mut disabled_bindings: ResMut<DisabledBindings>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let snapshot = &event.action.0;
        tracing::debug!("Restoring patch bindings snapshot");

        input_bindings.bindings = snapshot.input_bindings.clone();
        output_bindings.bindings = snapshot.output_bindings.clone();
        disabled_bindings.bindings = snapshot.disabled_bindings.clone();
        succeed_action(&mut responder, event.command_id);
    }
}

/// Handle RestoreOffsetSnapshot commands to restore fixture parameter offset.
pub fn handle_restore_offset_snapshot(
    mut events: MessageReader<EngineActionEnvelope<crate::undo::RestoreOffsetSnapshot>>,
    mut data_provider: ResMut<FixtureDataProviderExt>,
    mut parameter_query: Query<InstanceMut<Parameter>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let snapshot = &event.action.0;
        tracing::debug!(
            fixture_id = snapshot.fixture_id,
            attribute = ?snapshot.attribute,
            "Restoring offset snapshot"
        );

        // Build a map from element_index to offset for quick lookup
        let offset_map: std::collections::HashMap<u32, _> = snapshot
            .offsets
            .iter()
            .map(|(idx, offset)| (*idx, *offset))
            .collect();

        // Update the fixture data in DataProvider
        let maybe_fixture = data_provider
            .inner
            .from_id(snapshot.fixture_id)
            .map(|fixture| fixture.clone());

        if let Ok(mut fixture) = maybe_fixture {
            // Update offset in fixture definition per-element
            for (idx, element) in fixture.elements.iter_mut().enumerate() {
                let element_index = idx as u32 + 1;
                if let Some(offset) = offset_map.get(&element_index) {
                    for param in &mut element.parameters {
                        if param.attribute == snapshot.attribute {
                            param.offset = *offset;
                        }
                    }
                }
            }

            let uid = fixture.identifiers.uid;
            if let Err(error) = data_provider.inner.add(fixture) {
                fail_action(
                    &mut responder,
                    event.command_id,
                    "fixtures.restore_offset_failed",
                    error.to_string(),
                );
                continue;
            }

            // Update the ECS Parameter components per-element
            let param_attr_map = data_provider.parameter_attribute_map.read().unwrap();
            for (element_index, offset) in &snapshot.offsets {
                let fixture_ref = FixtureRef {
                    fixture_uid: uid,
                    index: Some(*element_index),
                };

                if let Some(param_instance) =
                    param_attr_map.get_by_left(&(fixture_ref, snapshot.attribute.clone()))
                {
                    if let Ok(mut param) = parameter_query.get_mut(param_instance.entity()) {
                        tracing::trace!(
                            element_index,
                            attribute = ?snapshot.attribute,
                            offset = %offset,
                            "Restoring offset for element"
                        );
                        param.metadata.offset = *offset;
                    }
                }
            }
            succeed_action(&mut responder, event.command_id);
        } else {
            tracing::warn!(
                "Failed to restore offset: fixture {} not found",
                snapshot.fixture_id
            );
            fail_action(
                &mut responder,
                event.command_id,
                "fixtures.restore_offset_failed",
                format!("Fixture {} was not found", snapshot.fixture_id),
            );
        }
    }
}

/// Handle ClearDmxChannels commands to clear manual DMX override.
///
/// Resets affected parameters to their default values.
pub fn handle_clear_dmx_channels(
    mut events: MessageReader<EngineActionEnvelope<crate::undo::ClearDmxChannels>>,
    mut universes: ResMut<ConsoleDmxUniverses>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let snapshot = &event.action.0;
        let expanded_channels = snapshot.channels.expand();

        tracing::debug!(
            "Clearing DMX channels {} (manual override)",
            snapshot.channels
        );

        // Step 1: Set DMX values to 0
        for ch in &expanded_channels {
            universes.set_value(ch.universe, ch.address, 0, ConsoleChannelOrigin::System);
        }
        succeed_action(&mut responder, event.command_id);
    }
}

/// Handle RestoreColorPathDefaultsSnapshot commands to restore fixture default assignments.
pub fn handle_restore_color_path_defaults_snapshot(
    mut events: MessageReader<EngineActionEnvelope<crate::undo::RestoreColorPathDefaultsSnapshot>>,
    mut data_provider: ResMut<FixtureDataProviderExt>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        data_provider.replace_color_path_defaults(event.action.0.defaults.clone());
        succeed_action(&mut responder, event.command_id);
    }
}

/// Reports successful completion for a lifecycle-managed fixture action.
fn succeed_action(responder: &mut CommandResponder, command_id: Option<CommandId>) {
    let Some(command_id) = command_id else {
        return;
    };
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%command_id, %error, "fixture_action_completion_failed");
    }
}

/// Reports structured failure for a lifecycle-managed fixture action.
fn fail_action(
    responder: &mut CommandResponder,
    command_id: Option<CommandId>,
    code: &'static str,
    message: impl Into<String>,
) {
    let Some(command_id) = command_id else {
        return;
    };
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%command_id, %error, "fixture_action_failure_failed");
    }
}
