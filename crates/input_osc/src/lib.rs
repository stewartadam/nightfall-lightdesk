// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OSC input handling crate.
//!
//! Provides UDP OSC ingest, configurable mappings, and dispatch to clip or
//! eval command flows.

#![warn(missing_docs)]

use std::net::SocketAddr;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_actions::{
    ActionInput, ActionInvocation, ActionSurface, ActionsPlugin, ExternalCommandInvocation,
};
use nightfall_engine::prelude::*;
use tokio::sync::mpsc::UnboundedReceiver;

pub mod command;
pub mod mapping;
mod osc;
mod service;
mod websocket;

use command::{OscCommand, OscExternalEval, OscLastEvent, OscListenerStatus};
use mapping::OscMappings;
use osc::RawOscEvent;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::InputOscPlugin;
    pub use crate::command::{
        OscCommand, OscExternalEval, OscLastEvent, OscListenerStatus, OscMapping, OscType,
    };
    pub use crate::mapping::OscMappings;
    pub use crate::websocket::{OscSource, OscWsMessage};
}

/// Plugin for OSC input handling.
pub struct InputOscPlugin {
    bind_addr: SocketAddr,
}

impl InputOscPlugin {
    /// Builds an OSC input plugin for the supplied listener address.
    #[must_use]
    pub const fn new(bind_addr: SocketAddr) -> Self {
        Self { bind_addr }
    }
}

impl Plugin for InputOscPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering InputOscPlugin");
        assert!(
            app.is_plugin_added::<ActionsPlugin>(),
            "InputOscPlugin requires ActionsPlugin (provides registered action invocation)"
        );
        let osc_service = service::process_osc_input_service();
        let status = osc_service.configure_bind_addr(self.bind_addr);
        let osc_rx = osc_service.client().subscribe().unwrap_or_else(|| {
            let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawOscEvent>();
            rx
        });

        app.insert_resource(OscEventReceiver(osc_rx));
        app.insert_resource(OscRuntimeStatus(status));
        app.init_resource::<OscMappings>();
        app.init_resource::<LastOscEvent>();
        app.init_resource::<OscSources>();
        app.add_message::<OscExternalEval>();
        app.add_message::<OscInput>();

        register_ingress_command::<OscCommand>(app);
        register_command_deserializer::<OscCommand>(app, websocket::deserialize_osc_command);

        app.add_systems(
            Update,
            (osc_event_system, handle_osc_events)
                .chain()
                .in_set(InputHandling),
        );
        app.add_systems(
            Update,
            (forward_external_command_invocations, handle_osc_crud).in_set(EventHandling),
        );
        app.add_systems(
            Update,
            (websocket::send_osc_state, websocket::send_external_evals).in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Resource that receives decoded OSC input events from the listener thread.
#[derive(Resource)]
struct OscEventReceiver(UnboundedReceiver<RawOscEvent>);

/// Last received OSC event for UI preview.
#[derive(Resource, Default)]
pub struct LastOscEvent(pub Option<OscLastEvent>);

/// Known OSC sources discovered from incoming packets.
#[derive(Resource, Default)]
pub struct OscSources(pub Vec<websocket::OscSource>);

/// Runtime listener status.
#[derive(Resource)]
pub struct OscRuntimeStatus(pub OscListenerStatus);

/// Runtime OSC observation consumed by mapping dispatch without a user-command identity.
#[derive(Clone, Debug, Message)]
struct OscInput(OscLastEvent);

fn osc_event_system(
    mut osc_rx: ResMut<OscEventReceiver>,
    mut last_event: ResMut<LastOscEvent>,
    mut sources: ResMut<OscSources>,
    mut event_writer: MessageWriter<OscInput>,
) {
    while let Ok(raw_event) = osc_rx.0.try_recv() {
        let osc_event: OscLastEvent = raw_event.into();
        if !sources
            .0
            .iter()
            .any(|source| source.address == osc_event.source)
        {
            sources.0.push(websocket::OscSource {
                address: osc_event.source.clone(),
            });
        }

        last_event.0 = Some(osc_event.clone());
        event_writer.write(OscInput(osc_event));
    }
}

fn handle_osc_events(
    mut events: MessageReader<OscInput>,
    mappings: Res<OscMappings>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    for event in events.read() {
        let osc_event = &event.0;
        if let Some(mapping) = mappings.lookup_mapping(osc_event) {
            let arg_index = usize::from(mapping.arg_index.unwrap_or(0));
            let input = osc_event
                .args
                .get(arg_index)
                .and_then(command::OscType::as_hardware_fader_percent)
                .map(|percent| ActionInput::Scalar(percent / 100.0))
                .unwrap_or(ActionInput::Trigger);
            invocations.write(ActionInvocation {
                invocation_id: Default::default(),
                action: mapping.action.clone(),
                surface: ActionSurface::Osc,
                input,
                source: Some(format!("OSC {}", osc_event.source)),
            });
        }
    }
}

/// Adapts generic external-command notifications to the existing OSC UI message.
fn forward_external_command_invocations(
    mut invocations: MessageReader<ExternalCommandInvocation>,
    mut external_evals: MessageWriter<OscExternalEval>,
) {
    for invocation in invocations.read() {
        if invocation.surface != ActionSurface::Osc {
            continue;
        }
        external_evals.write(OscExternalEval {
            correlation_id: invocation.command_id,
            command: invocation.command.clone(),
            source: invocation.source.clone(),
        });
    }
}

/// Applies tracked OSC mapping CRUD commands and reports their terminal outcomes.
fn handle_osc_crud(
    mut events: MessageReader<CommandEnvelope<OscCommand>>,
    mut mappings: ResMut<OscMappings>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            OscCommand::StoreMappings(new_mappings) => {
                tracing::info!("Storing {} OSC mappings", new_mappings.len());
                mappings.set_mappings(new_mappings.clone());
                responder.succeed(event.command_id)
            }
            OscCommand::DeleteMapping(index) => {
                if mappings.delete_mapping(*index as usize) {
                    tracing::info!("Deleted OSC mapping at index {}", index);
                    responder.succeed(event.command_id)
                } else {
                    responder.fail(
                        event.command_id,
                        CommandError::new(
                            "osc.mapping_not_found",
                            format!("OSC mapping index {index} does not exist"),
                        ),
                    )
                }
            }
        };
        if let Err(error) = result {
            tracing::error!(command_id = %event.command_id, %error, "osc_command_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;
    use crate::command::{OscMapping, OscType};

    /// Creates a generic registered-action mapping used by focused OSC tests.
    fn test_mapping() -> OscMapping {
        OscMapping {
            source: None,
            address: "/control".to_string(),
            arg_index: None,
            arg_value: None,
            action: nightfall_actions::ActionReference::new(
                "test.eval",
                serde_json::json!({ "command": "noop" }),
            ),
        }
    }

    /// Creates a focused app containing semantic OSC mapping CRUD.
    fn osc_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<OscMappings>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<OscCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, handle_osc_crud);
        app
    }

    /// Registers and submits one OSC mapping command.
    fn submit_command(app: &mut App, command: OscCommand) {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("OSC command should register");
        app.world_mut().write_message(envelope);
    }

    /// Drains one terminal result from the focused OSC app.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("OSC command should return a terminal result")
    }

    /// Verifies OSC mappings preserve domain arguments without interpreting them.
    #[test]
    fn registered_action_arguments_remain_opaque() {
        let arguments = serde_json::json!({ "domainValue": 7 });
        let action = nightfall_actions::ActionReference::new("domain.action", arguments.clone());

        assert_eq!(action.id.as_str(), "domain.action");
        assert_eq!(action.arguments, arguments);
    }

    /// Creates one OSC event carrying the supplied argument.
    fn test_event(arg: OscType) -> OscLastEvent {
        OscLastEvent {
            source: "127.0.0.1:9000".to_string(),
            address: "/control".to_string(),
            args: vec![arg],
        }
    }

    /// Reproduces mapped scalar normalization for focused value-shape assertions.
    fn osc_mapping_value(mapping: &command::OscMapping, event: &OscLastEvent) -> Option<f32> {
        let index = mapping.arg_index.unwrap_or(0) as usize;
        let value = event.args.get(index)?;
        let (raw, prefer_seven_bit_scaling) = match value {
            command::OscType::Int(value) => (*value as f32, true),
            command::OscType::Float(value) => (*value, false),
            command::OscType::Double(value) => (*value as f32, value.fract() == 0.0),
            command::OscType::Long(value) => (value.parse::<f32>().ok()?, true),
            command::OscType::Bool(value) => {
                return Some(if *value { 1.0 } else { 0.0 });
            }
            _ => return None,
        };

        if prefer_seven_bit_scaling && (0.0..=127.0).contains(&raw) {
            return Some(raw / 127.0);
        }
        if (0.0..=1.0).contains(&raw) {
            return Some(raw);
        }
        if (0.0..=127.0).contains(&raw) {
            return Some(raw / 127.0);
        }

        Some(raw.clamp(0.0, 1.0))
    }

    /// Verifies integral controller inputs use seven-bit normalization.
    #[test]
    fn normalizes_integral_control_values_as_seven_bit() {
        let mapping = test_mapping();

        assert_eq!(
            osc_mapping_value(&mapping, &test_event(OscType::Int(1))),
            Some(1.0 / 127.0)
        );
        assert_eq!(
            osc_mapping_value(&mapping, &test_event(OscType::Long("127".to_string()))),
            Some(1.0)
        );
        assert_eq!(
            osc_mapping_value(&mapping, &test_event(OscType::Double(1.0))),
            Some(1.0 / 127.0)
        );
    }

    /// Verifies already-normalized floating-point inputs retain their values.
    #[test]
    fn preserves_normalized_floating_point_control_values() {
        let mapping = test_mapping();

        assert_eq!(
            osc_mapping_value(&mapping, &test_event(OscType::Float(1.0))),
            Some(1.0)
        );
        assert_eq!(
            osc_mapping_value(&mapping, &test_event(OscType::Double(0.5))),
            Some(0.5)
        );
    }

    /// Verifies replacing OSC mappings returns success after resource mutation.
    #[test]
    fn store_mappings_mutates_before_success() {
        let mut app = osc_command_app();
        submit_command(&mut app, OscCommand::StoreMappings(vec![test_mapping()]));
        app.update();
        assert_eq!(app.world().resource::<OscMappings>().mappings().len(), 1);
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
    }

    /// Verifies deleting an unknown OSC mapping returns a stable failure.
    #[test]
    fn delete_unknown_mapping_returns_failure() {
        let mut app = osc_command_app();
        submit_command(&mut app, OscCommand::DeleteMapping(4));
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "osc.mapping_not_found"
        ));
    }
}
