// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Dispatches transport-neutral client ingress into domain registrations.
//!
//! This module processes incoming client commands via JSON: discriminated-union JSON
//! envelopes are dispatched to plugin-registered deserializers via
//! [`CommandDeserializerRegistry`]. Plugins handle their own event sending
//! and undo capture.

use std::collections::HashSet;

use async_channel::Receiver;
#[cfg(test)]
use async_channel::Sender;
use bevy_ecs::prelude::*;

use crate::prelude::*;

/// Error code of a client command refused because the engine is read-only.
pub const READ_ONLY_COMMAND_ERROR: &str = "ingress.read_only";

/// Decides which client commands and updates the engine accepts while it is read-only.
///
/// A backup that mirrors another engine sets a read-only reason, so its clients can watch the
/// show but cannot change it. Commands and updates that only ask for state stay accepted; their
/// owning domains mark them with [`allow_command_while_read_only`] and
/// [`allow_update_while_read_only`].
#[derive(Resource, Debug, Default)]
pub struct ClientIngressGate {
    read_only_reason: Option<String>,
    query_commands: HashSet<(String, String)>,
    query_updates: HashSet<String>,
}

impl ClientIngressGate {
    /// Makes client ingress read-only with the reason clients see, or writable again with `None`.
    pub fn set_read_only(&mut self, reason: Option<String>) {
        self.read_only_reason = reason;
    }

    /// Returns why client ingress is read-only, or `None` while it accepts changes.
    pub fn read_only_reason(&self) -> Option<&str> {
        self.read_only_reason.as_deref()
    }

    /// Returns whether a client command is accepted, judged by its module and `type` tag.
    pub fn admits_command(&self, module: &str, command: &serde_json::Value) -> bool {
        if self.read_only_reason.is_none() {
            return true;
        }
        let command_type = command
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        self.query_commands
            .contains(&(module.to_string(), command_type.to_string()))
    }

    /// Returns whether a client update from `module` is accepted.
    pub fn admits_update(&self, module: &str) -> bool {
        self.read_only_reason.is_none() || self.query_updates.contains(module)
    }
}

/// Marks a command that only reads state, so clients may still send it while the engine is
/// read-only.
pub fn allow_command_while_read_only(
    app: &mut bevy_app::App,
    module: &'static str,
    command_type: &'static str,
) {
    app.world_mut()
        .get_resource_or_init::<ClientIngressGate>()
        .query_commands
        .insert((module.to_string(), command_type.to_string()));
}

/// Marks an update that only subscribes to or requests state, so clients may still send it while
/// the engine is read-only.
pub fn allow_update_while_read_only(app: &mut bevy_app::App, module: &'static str) {
    app.world_mut()
        .get_resource_or_init::<ClientIngressGate>()
        .query_updates
        .insert(module.to_string());
}

/// Wraps a channel receiver for command JSON envelopes.
///
/// Commands arrive as discriminated-union JSON and are dispatched to
/// plugin-registered deserializers.
#[derive(Resource)]
pub struct CommandJsonEnvelopeReceiver(pub Receiver<CommandJsonEnvelope>);

/// Channel receiver for high-frequency updates that intentionally have no command lifecycle.
#[derive(Resource)]
pub struct UpdateJsonEnvelopeReceiver(pub Receiver<UpdateJsonEnvelope>);

/// Dispatches untracked updates through domain registrations without creating command state.
pub fn process_update_json_envelopes(world: &mut World) {
    let envelopes = {
        let Some(receiver) = world.get_resource_mut::<UpdateJsonEnvelopeReceiver>() else {
            return;
        };
        let mut envelopes = Vec::new();
        while let Ok(envelope) = receiver.0.try_recv() {
            envelopes.push(envelope);
        }
        envelopes
    };

    for envelope in envelopes {
        let module = envelope.module;
        let update = envelope.update;
        let sender = envelope.sender;
        let registered = world
            .resource::<UpdateDeserializerRegistry>()
            .contains(&module);
        if !registered {
            tracing::warn!(%module, "no_update_deserializer_registered");
            continue;
        }
        if world
            .get_resource::<ClientIngressGate>()
            .is_some_and(|gate| !gate.admits_update(&module))
        {
            tracing::trace!(%module, "read_only_update_dropped");
            continue;
        }
        world.resource_scope(|world, registry: Mut<UpdateDeserializerRegistry>| {
            let Some(deserializer) = registry.get(&module) else {
                return;
            };
            if let Err(error) = deserializer(world, update, sender) {
                tracing::warn!(%module, %error, "update_deserialize_failed");
            }
        });
    }
}

/// Processes command JSON envelopes via the registry-based dispatch path.
///
/// This system receives discriminated-union JSON commands, looks up the
/// appropriate deserializer from the registry, and dispatches to the plugin.
/// Plugins are responsible for sending typed events and handling undo capture.
///
/// Commands with a usable identity are lifecycle-tracked before domain
/// deserialization. Unknown modules and invalid domain payloads emit a correlated
/// failure instead of being dropped.
pub fn process_json_envelopes(world: &mut World) {
    // Drain the receiver into a local buffer to avoid holding the resource borrow
    let envelopes: Vec<CommandJsonEnvelope> = {
        let Some(rx) = world.get_resource_mut::<CommandJsonEnvelopeReceiver>() else {
            // CommandJsonEnvelopeReceiver not yet set up - skip silently during startup
            return;
        };
        let mut buf = Vec::new();
        while let Ok(envelope) = rx.0.try_recv() {
            buf.push(envelope);
        }
        buf
    };

    if envelopes.is_empty() {
        return;
    }

    tracing::trace!(count = envelopes.len(), "commands_received");

    // Process each envelope through the registry
    for envelope in envelopes {
        let module = envelope.module.clone();
        let command_id = envelope.command_id;
        let undo_id = envelope.effective_undo_id();
        let command_json = envelope.command;

        let registration = world.resource_mut::<CommandTracker>().register_context(
            command_id,
            undo_id,
            CommandOrigin::WebUi,
            envelope.reply_target,
        );
        if let Err(error) = registration {
            tracing::warn!(
                command_id = %command_id,
                module = %module,
                error = %error,
                "duplicate_command_rejected"
            );
            continue;
        }

        let read_only_refusal = world
            .get_resource::<ClientIngressGate>()
            .filter(|gate| !gate.admits_command(&module, &command_json))
            .and_then(|gate| gate.read_only_reason().map(str::to_string));
        if let Some(reason) = read_only_refusal {
            tracing::debug!(
                command_id = %command_id,
                module = %module,
                command_type = ?command_json.get("type"),
                "read_only_command_refused"
            );
            finish_command_in_world(
                world,
                command_id,
                CommandOutcome::failed(CommandError::new(READ_ONLY_COMMAND_ERROR, reason)),
            )
            .expect("newly registered read-only command should finish once");
            continue;
        }

        // Look up the deserializer - we need to get it from the registry while
        // we have immutable world access, then call it with mutable access
        let deserializer_result = {
            let registry = world.resource::<CommandDeserializerRegistry>();
            if registry.contains(&module) {
                Some(module.clone())
            } else {
                None
            }
        };

        match deserializer_result {
            Some(module_name) => {
                // Re-fetch registry and call deserializer with mutable world
                // This is safe because we're the only system running during this exclusive access
                world.resource_scope(|world, registry: Mut<CommandDeserializerRegistry>| {
                    if let Some(deserializer) = registry.get(&module_name) {
                        if let Err(e) =
                            deserializer(world, command_json.clone(), command_id, undo_id)
                        {
                            tracing::error!(
                                command_id = %command_id,
                                module = %module_name,
                                error = %e,
                                "command_deserialize_failed"
                            );
                            tracing::debug!("JSON envelope that failed: {}", &command_json);
                            finish_command_in_world(
                                world,
                                command_id,
                                CommandOutcome::failed(CommandError::new(
                                    "ingress.invalid_command_payload",
                                    format!("Unable to deserialize {} command: {}", module_name, e),
                                )),
                            )
                            .expect("newly registered invalid command should finish once");
                        } else {
                            tracing::trace!(
                                command_id = %command_id,
                                undo_id = %undo_id,
                                module = %module_name,
                                "command_dispatched"
                            );
                        }
                    }
                });
            }
            None => {
                tracing::warn!(
                    command_id = %command_id,
                    module = %module,
                    "no_deserializer_registered"
                );
                finish_command_in_world(
                    world,
                    command_id,
                    CommandOutcome::failed(CommandError::new(
                        "ingress.unknown_command_module",
                        format!("No command handler is registered for module {}", module),
                    )),
                )
                .expect("newly registered unroutable command should finish once");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates a world containing only the resources required by inbound dispatch tests.
    fn inbound_world() -> (World, Sender<CommandJsonEnvelope>) {
        let mut world = World::new();
        world.init_resource::<CommandDeserializerRegistry>();
        world.init_resource::<CommandTracker>();
        world.init_resource::<Messages<CommandResult>>();
        world.init_resource::<Messages<CommandReply>>();
        world.init_resource::<Messages<FinishedCommand>>();
        let (sender, receiver) = async_channel::unbounded();
        world.insert_resource(CommandJsonEnvelopeReceiver(receiver));
        (world, sender)
    }

    /// Verifies update ingress dispatches without registering a command lifecycle and hands the
    /// domain the session that sent the update.
    #[test]
    fn update_ingress_dispatches_without_command_tracking() {
        let mut world = World::new();
        world.init_resource::<UpdateDeserializerRegistry>();
        world.init_resource::<CommandTracker>();
        world.init_resource::<Messages<TestUpdate>>();
        world.resource_mut::<UpdateDeserializerRegistry>().register(
            "TestUpdate",
            |world, value, sender| {
                let value =
                    serde_json::from_value::<u32>(value).map_err(|error| error.to_string())?;
                world.write_message(TestUpdate(value, sender));
                Ok(())
            },
        );
        let (sender, receiver) = async_channel::unbounded();
        world.insert_resource(UpdateJsonEnvelopeReceiver(receiver));
        sender
            .try_send(UpdateJsonEnvelope {
                module: "TestUpdate".to_string(),
                update: serde_json::json!(42),
                sender: Audience::Client(ClientId(9)),
            })
            .unwrap();

        process_update_json_envelopes(&mut world);

        assert_eq!(world.resource::<CommandTracker>().active_count(), 0);
        let updates = world
            .resource_mut::<Messages<TestUpdate>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(updates, vec![TestUpdate(42, Audience::Client(ClientId(9)))]);
    }

    /// Focused update message proving domain deserializer dispatch and sender identity.
    #[derive(Clone, Debug, Message, PartialEq, Eq)]
    struct TestUpdate(u32, Audience);

    /// Creates an inbound command envelope with a deterministic module and identity.
    fn envelope(module: &str, command: serde_json::Value) -> CommandJsonEnvelope {
        CommandJsonEnvelope {
            command_id: CommandId::new(),
            undo_id: None,
            module: module.to_string(),
            command,
            reply_target: ReplyTarget::ClientBroadcast,
        }
    }

    /// Drains terminal results written during one inbound processing pass.
    fn drain_results(world: &mut World) -> Vec<CommandResult> {
        world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect()
    }

    /// Verifies that an unknown module returns a correlated failure and remains tracked for forwarding.
    #[test]
    fn unknown_module_returns_failure() {
        let (mut world, sender) = inbound_world();
        let envelope = envelope("MissingCommand", serde_json::json!({}));
        let command_id = envelope.command_id;
        sender.try_send(envelope).unwrap();

        process_json_envelopes(&mut world);

        assert!(!world.resource::<CommandTracker>().is_active(command_id));
        let results = drain_results(&mut world);
        assert_eq!(results.len(), 1);
        assert!(matches!(
            &results[0].outcome,
            CommandOutcome::Failed(error) if error.code == "ingress.unknown_command_module"
        ));
    }

    /// Verifies that domain deserialization failures return a correlated terminal failure.
    #[test]
    fn deserializer_failure_returns_failure() {
        let (mut world, sender) = inbound_world();
        world
            .resource_mut::<CommandDeserializerRegistry>()
            .register("BrokenCommand", |_world, _json, _command_id, _undo_id| {
                Err("invalid shape".to_string())
            });
        let envelope = envelope("BrokenCommand", serde_json::json!({ "bad": true }));
        let command_id = envelope.command_id;
        sender.try_send(envelope).unwrap();

        process_json_envelopes(&mut world);

        let results = drain_results(&mut world);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command_id);
        assert!(matches!(
            &results[0].outcome,
            CommandOutcome::Failed(error) if error.message.contains("invalid shape")
        ));
    }

    /// Verifies that duplicate command identity is not dispatched or given a second result.
    #[test]
    fn duplicate_command_identity_is_rejected() {
        let (mut world, sender) = inbound_world();
        world
            .resource_mut::<CommandDeserializerRegistry>()
            .register(
                "ValidCommand",
                |_world, _json, _command_id, _undo_id| Ok(()),
            );
        let envelope = envelope("ValidCommand", serde_json::json!({}));
        sender.try_send(envelope.clone()).unwrap();
        sender.try_send(envelope).unwrap();

        process_json_envelopes(&mut world);

        assert!(drain_results(&mut world).is_empty());
        assert_eq!(world.resource::<CommandTracker>().active_count(), 1);
    }

    /// Verifies a read-only engine refuses changes with the gate's reason before any domain sees
    /// them, still dispatches commands marked as queries, and accepts everything once writable.
    #[test]
    fn read_only_gate_refuses_changes_and_admits_queries() {
        let (mut world, sender) = inbound_world();
        world.init_resource::<Messages<TestUpdate>>();
        world
            .resource_mut::<CommandDeserializerRegistry>()
            .register("ShowCommand", |world, json, _command_id, _undo_id| {
                let value = json["data"].as_u64().unwrap_or_default() as u32;
                world.write_message(TestUpdate(value, Audience::All));
                Ok(())
            });
        let mut gate = ClientIngressGate::default();
        gate.query_commands
            .insert(("ShowCommand".to_string(), "Read".to_string()));
        gate.set_read_only(Some("Tracking the primary".to_string()));
        world.insert_resource(gate);

        let change = envelope(
            "ShowCommand",
            serde_json::json!({ "type": "Change", "data": 1 }),
        );
        let change_id = change.command_id;
        sender.try_send(change).unwrap();
        sender
            .try_send(envelope(
                "ShowCommand",
                serde_json::json!({ "type": "Read", "data": 2 }),
            ))
            .unwrap();
        process_json_envelopes(&mut world);

        let results = drain_results(&mut world);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, change_id);
        assert!(matches!(
            &results[0].outcome,
            CommandOutcome::Failed(error)
                if error.code == READ_ONLY_COMMAND_ERROR && error.message == "Tracking the primary"
        ));
        let dispatched = world
            .resource_mut::<Messages<TestUpdate>>()
            .drain()
            .map(|update| update.0)
            .collect::<Vec<_>>();
        assert_eq!(dispatched, vec![2]);

        world
            .resource_mut::<ClientIngressGate>()
            .set_read_only(None);
        sender
            .try_send(envelope(
                "ShowCommand",
                serde_json::json!({ "type": "Change", "data": 3 }),
            ))
            .unwrap();
        process_json_envelopes(&mut world);
        let dispatched = world
            .resource_mut::<Messages<TestUpdate>>()
            .drain()
            .map(|update| update.0)
            .collect::<Vec<_>>();
        assert_eq!(dispatched, vec![3]);
    }

    /// Verifies a read-only engine drops updates that change state but still dispatches updates
    /// marked as requests for state.
    #[test]
    fn read_only_gate_drops_changing_updates() {
        let mut world = World::new();
        world.init_resource::<UpdateDeserializerRegistry>();
        world.init_resource::<Messages<TestUpdate>>();
        for module in ["FaderMove", "Subscribe"] {
            world.resource_mut::<UpdateDeserializerRegistry>().register(
                module,
                |world, value, sender| {
                    let value =
                        serde_json::from_value::<u32>(value).map_err(|error| error.to_string())?;
                    world.write_message(TestUpdate(value, sender));
                    Ok(())
                },
            );
        }
        let mut gate = ClientIngressGate::default();
        gate.query_updates.insert("Subscribe".to_string());
        gate.set_read_only(Some("Tracking the primary".to_string()));
        world.insert_resource(gate);
        let (sender, receiver) = async_channel::unbounded();
        world.insert_resource(UpdateJsonEnvelopeReceiver(receiver));
        for (module, value) in [("FaderMove", 1), ("Subscribe", 2)] {
            sender
                .try_send(UpdateJsonEnvelope {
                    module: module.to_string(),
                    update: serde_json::json!(value),
                    sender: Audience::All,
                })
                .unwrap();
        }

        process_update_json_envelopes(&mut world);

        let dispatched = world
            .resource_mut::<Messages<TestUpdate>>()
            .drain()
            .map(|update| update.0)
            .collect::<Vec<_>>();
        assert_eq!(dispatched, vec![2]);
    }
}
