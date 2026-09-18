// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall_compositor::prelude::Layer;
use nightfall_engine::prelude::{CommandEnvelope, CommandResponder};
use nightfall_fixtures::prelude::{
    ConsoleDmxUniverses, InputDmxUniverses, TransportInputAssertionOwners, TransportInputLayer,
    clear_stale_parameter_assertions,
};
use nightfall_io::{InputSignalLossPolicy, IoRuntimeSettings, sanitize_input_signal_loss_timeout};
use web_time::Instant;

use crate::DeskCommand;

/// Clears stale transport-owned input channels and parameter assertions based on IO settings.
pub fn clear_stale_input_channels(
    settings: Res<IoRuntimeSettings>,
    input_universes: Res<InputDmxUniverses>,
    mut universes: ResMut<ConsoleDmxUniverses>,
    mut release_events: MessageReader<CommandEnvelope<DeskCommand>>,
    mut responder: CommandResponder,
    mut input_layer_query: Query<
        (&mut Layer, &mut TransportInputAssertionOwners),
        With<TransportInputLayer>,
    >,
) {
    let now = Instant::now();
    let configured_timeout = sanitize_input_signal_loss_timeout(settings.input_signal_loss_timeout);
    let scheduled_timeout = match settings.input_signal_loss_policy {
        InputSignalLossPolicy::Hold => None,
        InputSignalLossPolicy::ClearAfterTimeout {} => Some(configured_timeout),
    };
    let forced_release_commands = release_events
        .read()
        .filter_map(|event| {
            matches!(event.command, DeskCommand::ReleaseStaleInputs).then_some(event.command_id)
        })
        .collect::<Vec<_>>();

    if let Some(timeout) = scheduled_timeout {
        clear_stale_input_state(
            &input_universes,
            &mut universes,
            &mut input_layer_query,
            now,
            timeout,
        );
    }

    if !forced_release_commands.is_empty() {
        let timeout = scheduled_timeout.unwrap_or(configured_timeout);
        clear_stale_input_state(
            &input_universes,
            &mut universes,
            &mut input_layer_query,
            now,
            timeout,
        );
        for command_id in forced_release_commands {
            if let Err(error) = responder.succeed(command_id) {
                tracing::error!(%command_id, %error, "release_stale_inputs_completion_failed");
            }
        }
    }
}

/// Clears stale console channel owners and transport assertion layer entries.
fn clear_stale_input_state(
    input_universes: &InputDmxUniverses,
    universes: &mut ConsoleDmxUniverses,
    input_layer_query: &mut Query<
        (&mut Layer, &mut TransportInputAssertionOwners),
        With<TransportInputLayer>,
    >,
    now: Instant,
    timeout: std::time::Duration,
) {
    universes.clear_stale_input_channels(input_universes, now, timeout);

    if let Ok((mut layer, mut owners)) = input_layer_query.single_mut() {
        clear_stale_parameter_assertions(&mut layer, &mut owners, input_universes, now, timeout);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy_app::{App, Update};
    use moonshine_kind::prelude::Instance;
    use nightfall_dmx::prelude::ParameterValue;
    use nightfall_engine::prelude::{
        CommandNotice, CommandOrigin, CommandReply, CommandResult, CommandTracker, FinishedCommand,
        ReplyTarget,
    };
    use nightfall_fixtures::prelude::TRANSPORT_INPUT_LAYER_PRIORITY;
    use nightfall_fixtures::prelude::{ConsoleChannelOrigin, Parameter, ParameterAssertionSource};
    use nightfall_io::BindingTransport;

    use super::*;
    /// Installs the command lifecycle resources required by the stale-input system.
    fn add_command_lifecycle(app: &mut App) {
        app.add_message::<CommandEnvelope<DeskCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.init_resource::<CommandTracker>();
    }

    #[test]
    fn hold_policy_keeps_stale_input_owned_values() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_systems(Update, clear_stale_input_channels);
        app.insert_resource(IoRuntimeSettings {
            input_signal_loss_policy: InputSignalLossPolicy::Hold,
            ..Default::default()
        });
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();

        let past = Instant::now() - Duration::from_millis(50);
        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(
                1,
                1,
                200,
                ConsoleChannelOrigin::InputTransport {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                },
            );
        }
        {
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, [0; 512], past);
        }

        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(1, 1), Some(200));
    }

    #[test]
    fn clear_policy_clears_stale_input_owned_values() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_systems(Update, clear_stale_input_channels);
        app.insert_resource(IoRuntimeSettings {
            input_signal_loss_policy: InputSignalLossPolicy::ClearAfterTimeout {},
            input_signal_loss_timeout: Duration::from_millis(1),
            ..Default::default()
        });
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();

        let past = Instant::now() - Duration::from_millis(50);
        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(
                7,
                9,
                111,
                ConsoleChannelOrigin::InputTransport {
                    transport: BindingTransport::ArtNet,
                    universe: 3,
                },
            );
        }
        {
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::ArtNet, 3, [0; 512], past);
        }

        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(7, 9), Some(0));
        assert_eq!(
            universes.get_origin(7, 9),
            Some(ConsoleChannelOrigin::System)
        );
    }

    #[test]
    fn clear_policy_clears_stale_transport_parameter_assertions() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_systems(Update, clear_stale_input_channels);
        app.insert_resource(IoRuntimeSettings {
            input_signal_loss_policy: InputSignalLossPolicy::ClearAfterTimeout {},
            input_signal_loss_timeout: Duration::from_millis(1),
            ..Default::default()
        });
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();

        let parameter = unsafe {
            Instance::<Parameter>::from_entity_unchecked(app.world_mut().spawn_empty().id())
        };
        let layer_entity = app
            .world_mut()
            .spawn((
                Layer::new(
                    "test transport input".to_string(),
                    TRANSPORT_INPUT_LAYER_PRIORITY,
                ),
                TransportInputLayer,
                TransportInputAssertionOwners::default(),
            ))
            .id();
        {
            let mut layer = app
                .world_mut()
                .get_mut::<Layer>(layer_entity)
                .expect("transport layer should exist");
            layer
                .absolute
                .insert(parameter, (ParameterValue::Absolute { value: 123.0 }, None));
        }
        {
            let mut owners = app
                .world_mut()
                .get_mut::<TransportInputAssertionOwners>(layer_entity)
                .expect("transport assertion owners should exist");
            owners.absolute.insert(
                parameter,
                ParameterAssertionSource {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                },
            );
        }
        {
            let past = Instant::now() - Duration::from_millis(50);
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, [0; 512], past);
        }

        app.update();

        let layer = app
            .world()
            .get::<Layer>(layer_entity)
            .expect("transport layer should still exist");
        let owners = app
            .world()
            .get::<TransportInputAssertionOwners>(layer_entity)
            .expect("transport assertion owners should still exist");
        assert!(!layer.absolute.contains_key(&parameter));
        assert!(!owners.absolute.contains_key(&parameter));
    }

    /// Verifies `release stale-inputs` clears stale input state while policy remains Hold.
    #[test]
    fn release_stale_inputs_command_clears_stale_values_under_hold_policy() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_systems(Update, clear_stale_input_channels);
        app.insert_resource(IoRuntimeSettings {
            input_signal_loss_policy: InputSignalLossPolicy::Hold,
            input_signal_loss_timeout: Duration::from_millis(500),
            ..Default::default()
        });
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();

        let parameter = unsafe {
            Instance::<Parameter>::from_entity_unchecked(app.world_mut().spawn_empty().id())
        };
        let layer_entity = app
            .world_mut()
            .spawn((
                Layer::new(
                    "test transport input".to_string(),
                    TRANSPORT_INPUT_LAYER_PRIORITY,
                ),
                TransportInputLayer,
                TransportInputAssertionOwners::default(),
            ))
            .id();
        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(
                1,
                1,
                200,
                ConsoleChannelOrigin::InputTransport {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                },
            );
        }
        {
            let mut layer = app
                .world_mut()
                .get_mut::<Layer>(layer_entity)
                .expect("transport layer should exist");
            layer
                .absolute
                .insert(parameter, (ParameterValue::Absolute { value: 123.0 }, None));
        }
        {
            let mut owners = app
                .world_mut()
                .get_mut::<TransportInputAssertionOwners>(layer_entity)
                .expect("transport assertion owners should exist");
            owners.absolute.insert(
                parameter,
                ParameterAssertionSource {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                },
            );
        }
        {
            let past = Instant::now() - Duration::from_millis(750);
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, [0; 512], past);
        }

        let command = CommandEnvelope::new(
            DeskCommand::ReleaseStaleInputs,
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("release stale-inputs command should register");
        app.world_mut().write_message(command);
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        let layer = app
            .world()
            .get::<Layer>(layer_entity)
            .expect("transport layer should still exist");
        let owners = app
            .world()
            .get::<TransportInputAssertionOwners>(layer_entity)
            .expect("transport assertion owners should still exist");
        assert_eq!(universes.get_value(1, 1), Some(0));
        assert!(!layer.absolute.contains_key(&parameter));
        assert!(!owners.absolute.contains_key(&parameter));
    }
}
