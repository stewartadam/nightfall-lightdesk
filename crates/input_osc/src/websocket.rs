// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for OSC input.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::command::{OscCommand, OscExternalEval, OscLastEvent, OscListenerStatus, OscMapping};
use crate::mapping::OscMappings;
use crate::{LastOscEvent, OscRuntimeStatus, OscSources};

/// OSC source info for UI display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct OscSource {
    /// Source socket address (`ip:port`).
    pub address: String,
}

/// Websocket messages emitted by the OSC plugin.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[allow(clippy::enum_variant_names)]
pub enum OscWsMessage<'a> {
    /// Known source list.
    OscSources(&'a [OscSource]),
    /// Configured mappings.
    OscMappings(&'a [OscMapping]),
    /// Per-row validation failures; null entries remain eligible for dispatch.
    OscMappingDiagnostics(Vec<Option<CommandError>>),
    /// Last observed OSC event.
    OscLastEvent(&'a OscLastEvent),
    /// Listener bind status.
    OscListenerStatus(&'a OscListenerStatus),
    /// External eval metadata for CommandLine source tagging.
    OscExternalEval(&'a OscExternalEval),
}

/// Deserialize and dispatch `OscCommand` from JSON.
pub fn deserialize_osc_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: OscCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse OscCommand: {e}"))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

    Ok(())
}

/// Send OSC state on resync.
pub fn handle_resync_state(
    world: &World,
    mut events: MessageReader<ResyncRequested>,
    sources: Res<OscSources>,
    mappings: Res<OscMappings>,
    registry: Res<nightfall_actions::ActionRegistry>,
    last_event: Res<LastOscEvent>,
    status: Res<OscRuntimeStatus>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_sources(&sources, &broadcaster);
    send_mappings(
        &mappings,
        mappings.target_validation_errors(world, &registry, &mappings.validation_errors(&registry)),
        &broadcaster,
    );
    send_listener_status(&status, &broadcaster);
    if let Some(ref event) = last_event.0 {
        send_last_event(event, &broadcaster);
    }
}

/// Send OSC state updates when resources change.
pub fn send_osc_state(
    world: &World,
    mut contract_errors: Local<Option<Vec<Option<CommandError>>>>,
    mut published_errors: Local<Option<Vec<Option<CommandError>>>>,
    sources: Res<OscSources>,
    mappings: Res<OscMappings>,
    registry: Res<nightfall_actions::ActionRegistry>,
    last_event: Res<LastOscEvent>,
    status: Res<OscRuntimeStatus>,
    broadcaster: Res<ClientEventSink>,
) {
    if sources.is_changed() {
        send_sources(&sources, &broadcaster);
    }
    if contract_errors.is_none() || mappings.is_changed() || registry.is_changed() {
        *contract_errors = Some(mappings.validation_errors(&registry));
    }
    let errors = mappings.target_validation_errors(
        world,
        &registry,
        contract_errors.as_deref().unwrap_or_default(),
    );
    if mappings.is_changed() || published_errors.as_ref() != Some(&errors) {
        send_mappings(&mappings, errors.clone(), &broadcaster);
        *published_errors = Some(errors);
    }
    if status.is_changed() {
        send_listener_status(&status, &broadcaster);
    }
    if last_event.is_changed()
        && let Some(ref event) = last_event.0
    {
        send_last_event(event, &broadcaster);
    }
}

/// Broadcast external eval metadata for command-line source tags.
pub fn send_external_evals(
    mut events: MessageReader<OscExternalEval>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscExternalEval(event),
        );
    }
}

fn send_sources(sources: &OscSources, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscSources(&sources.0),
    );
}

fn send_mappings(
    mappings: &OscMappings,
    diagnostics: Vec<Option<CommandError>>,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscMappings(mappings.mappings()),
    );
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscMappingDiagnostics(diagnostics),
    );
}

fn send_last_event(event: &OscLastEvent, broadcaster: &ClientEventSink) {
    broadcaster.publish(DISCRIMINATOR_DROPPABLE, &OscWsMessage::OscLastEvent(event));
}

fn send_listener_status(status: &OscRuntimeStatus, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscListenerStatus(&status.0),
    );
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;

    /// Target deletion and restoration publish diagnostics without changing the saved binding.
    #[test]
    fn target_diagnostics_follow_domain_changes_without_repeated_broadcasts() {
        use nightfall_actions::{
            ActionDescriptor, ActionId, ActionInputKind, ActionRegistry, ActionSurface,
            InvocationDispatch, InvocationError,
        };
        #[derive(Resource)]
        struct TargetAvailable;
        #[derive(serde::Deserialize)]
        #[serde(tag = "type", content = "data")]
        enum Snapshot {
            OscMappings(Vec<OscMapping>),
        }

        let (sender, receiver) = async_channel::unbounded();
        let mut app = bevy_app::App::new();
        app.insert_resource(ClientEventSink::new(sender));
        app.init_resource::<OscSources>();
        app.insert_resource(OscRuntimeStatus(OscListenerStatus {
            is_listening: false,
            bind_address: "127.0.0.1".into(),
            port: 0,
        }));
        app.init_resource::<LastOscEvent>();
        app.init_resource::<ActionRegistry>();
        app.insert_resource(TargetAvailable);
        let mapping = OscMapping {
            id: uuid::Uuid::new_v4(),
            source: None,
            address: "/button".into(),
            arg_index: Some(0),
            arg_value: None,
            input: crate::command::OscBindingInput::Press,
            action: nightfall_actions::ActionReference::new("test.target", serde_json::json!({})),
        };
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![mapping.clone()]);
        app.insert_resource(mappings);
        let mut registry = app.world_mut().resource_mut::<ActionRegistry>();
        registry.register::<Value, _>(
            ActionDescriptor {
                id: ActionId::new("test.target"),
                label: "Test target".into(),
                allowed_surfaces: vec![ActionSurface::Osc],
                input_kind: ActionInputKind::Trigger,
                argument_schema: serde_json::json!({}),
                capabilities: vec![],
            },
            |_, _, _| Ok(InvocationDispatch::succeeded()),
        );
        registry.register_target_validator::<Value, _>("test.target", |world, _| {
            if world.contains_resource::<TargetAvailable>() {
                Ok(())
            } else {
                Err(InvocationError::new(
                    "test.target_missing",
                    "Target was deleted",
                ))
            }
        });
        app.add_message::<ResyncRequested>();
        app.add_systems(
            bevy_app::Update,
            (send_osc_state, handle_resync_state).chain(),
        );
        app.update();
        while receiver.try_recv().is_ok() {}
        app.update();
        assert!(receiver.try_recv().is_err());

        for available in [false, true] {
            if available {
                app.world_mut().insert_resource(TargetAvailable);
            } else {
                app.world_mut().remove_resource::<TargetAvailable>();
            }
            app.update();
            let bytes = receiver.try_recv().unwrap();
            let Snapshot::OscMappings(snapshot) = minicbor_serde::from_slice(&bytes[1..]).unwrap();
            assert_eq!(snapshot, vec![mapping.clone()]);
            let bytes = receiver.try_recv().unwrap();
            assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
            let diagnostic: Value = minicbor_serde::from_slice(&bytes[1..]).unwrap();
            assert_eq!(diagnostic["type"], "OscMappingDiagnostics");
            if available {
                assert!(diagnostic["data"][0].is_null());
            } else {
                assert_eq!(diagnostic["data"][0]["code"], "test.target_missing");
            }
            assert_eq!(
                app.world().resource::<OscMappings>().mappings(),
                &[mapping.clone()]
            );
            app.update();
            assert!(receiver.try_recv().is_err());
            app.world_mut()
                .write_message(ResyncRequested { command_id: None });
            app.update();
            let resynced: Vec<Value> = std::iter::from_fn(|| receiver.try_recv().ok())
                .filter_map(|bytes| minicbor_serde::from_slice::<Value>(&bytes[1..]).ok())
                .filter(|message| message["type"] == "OscMappingDiagnostics")
                .collect();
            assert_eq!(resynced, vec![diagnostic]);
        }
    }

    /// Loaded unavailable actions retain their row and publish a reliable diagnostic alongside it.
    #[test]
    fn mapping_snapshot_includes_validation_diagnostics() {
        let (sender, receiver) = async_channel::unbounded();
        let sink = ClientEventSink::new(sender);
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            id: uuid::Uuid::new_v4(),
            source: None,
            address: "/button".into(),
            arg_index: Some(0),
            arg_value: None,
            input: crate::command::OscBindingInput::Press,
            action: nightfall_actions::ActionReference::new(
                "missing.action",
                serde_json::json!({}),
            ),
        }]);
        send_mappings(
            &mappings,
            mappings.validation_errors(&nightfall_actions::ActionRegistry::default()),
            &sink,
        );
        assert_eq!(receiver.try_recv().unwrap()[0], DISCRIMINATOR_NON_DROPPABLE);
        let bytes = receiver.try_recv().unwrap();
        assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
        let diagnostic: Value = minicbor_serde::from_slice(&bytes[1..]).unwrap();
        assert_eq!(diagnostic["type"], "OscMappingDiagnostics");
        assert_eq!(diagnostic["data"][0]["code"], "action.not_registered");
        assert_eq!(mappings.mappings().len(), 1);
    }

    #[test]
    fn deserialize_osc_command_writes_semantic_envelope() {
        let mut world = World::new();
        world.insert_resource(Messages::<CommandEnvelope<OscCommand>>::default());

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_osc_command(
            &mut world,
            serde_json::json!({
                "type": "DeleteMapping",
                "data": 4
            }),
            command_id,
            undo_id,
        )
        .expect("osc command should deserialize");

        let messages: Vec<_> = world
            .resource_mut::<Messages<CommandEnvelope<OscCommand>>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert!(matches!(messages[0].command, OscCommand::DeleteMapping(4)));
    }
}
