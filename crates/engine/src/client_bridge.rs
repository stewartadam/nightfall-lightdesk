// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Transport-neutral bridge between engine clients and the Bevy world.
//!
//! Domain plugins publish encoded client events through [`ClientEventSink`]. A
//! host adapter submits JSON command and update envelopes through
//! [`ClientBridgeHost`] and owns the corresponding encoded output receiver.
//!
//! # Architecture
//!
//! [`ClientBridgePlugin`] owns registry dispatch and command lifecycle forwarding.
//! Native WebSocket and embedded browser hosts attach outside this crate.
//!
//! # Usage
//!
//! Plugins serialize their domain types using CBOR and send bytes with a discriminator:
//!
//! ```ignore
//! fn forward_my_commands(
//!     mut events: MessageReader<CommandEnvelope<MyCommand>>,
//!     client_events: Res<ClientEventSink>,
//! ) {
//!     for event in events.read() {
//!         client_events.publish(MY_DISCRIMINATOR, &event.payload);
//!     }
//! }
//! ```

use async_channel::{Receiver, Sender};
use bevy_app::{App, Plugin, Update};
use bevy_ecs::prelude::*;
use serde::Serialize;

use crate::{
    EnginePlugin, InputHandling,
    client_ingress::{
        CommandJsonEnvelopeReceiver, UpdateJsonEnvelopeReceiver, process_json_envelopes,
        process_update_json_envelopes,
    },
    prelude::{
        CommandNotice, CommandReply, EngineClientMessage, PendingCommandBuffer, ReplyTarget,
    },
};

/// Message types that must be delivered in order and should not be dropped.
pub const DISCRIMINATOR_NON_DROPPABLE: u8 = 0;
/// Snapshot-like message types that may be coalesced or dropped under load.
pub const DISCRIMINATOR_DROPPABLE: u8 = 1;

/// Pre-encoded client message ready for transport delivery.
///
/// Contains a discriminator byte followed by CBOR-encoded payload.
#[derive(Debug, Clone)]
pub struct EncodedClientMessage {
    /// The discriminator byte identifying the message type
    pub discriminator: u8,
    /// The CBOR-encoded payload (NOT including discriminator)
    pub payload: Vec<u8>,
}

impl EncodedClientMessage {
    /// Create a new encoded message from a discriminator and serializable payload.
    ///
    /// Returns `None` if CBOR serialization fails.
    pub fn new<T: Serialize>(discriminator: u8, payload: &T) -> Option<Self> {
        minicbor_serde::to_vec(payload).ok().map(|cbor_data| Self {
            discriminator,
            payload: cbor_data,
        })
    }

    /// Create from raw bytes (discriminator + payload already combined).
    pub fn from_raw(data: Vec<u8>) -> Option<Self> {
        if data.is_empty() {
            return None;
        }
        Some(Self {
            discriminator: data[0],
            payload: data[1..].to_vec(),
        })
    }

    /// Convert to bytes ready for transport delivery.
    ///
    /// Format: [discriminator byte][CBOR payload]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(1 + self.payload.len());
        encoded.push(self.discriminator);
        encoded.extend(&self.payload);
        encoded
    }
}

/// Byte-oriented client event sink for domain plugins.
///
/// This resource lets plugins publish pre-serialized messages without depending
/// on a concrete transport or browser host.
#[derive(Resource, Clone)]
pub struct ClientEventSink {
    /// Sender for raw byte messages
    tx: Sender<Vec<u8>>,
}

impl ClientEventSink {
    /// Create a new client event sink from a bytes sender.
    pub fn new(tx: Sender<Vec<u8>>) -> Self {
        Self { tx }
    }

    /// Send a pre-encoded message to the attached host adapter.
    pub fn send(&self, message: EncodedClientMessage) {
        let bytes = message.to_bytes();
        if let Err(e) = self.tx.try_send(bytes) {
            tracing::warn!("Failed to publish client message: {}", e);
        }
    }

    /// Serialize and publish a value to the attached host adapter.
    ///
    /// This serializes the value directly to CBOR, prepends the discriminator,
    /// and publishes it.
    pub fn publish<T: Serialize>(&self, discriminator: u8, command: &T) {
        if let Some(message) = EncodedClientMessage::new(discriminator, command) {
            self.send(message);
        } else {
            tracing::warn!("Failed to serialize client message");
        }
    }

    /// Check whether the host adapter still owns its output receiver.
    pub fn is_connected(&self) -> bool {
        !self.tx.is_closed()
    }
}

/// Host-owned handles for submitting ingress and receiving encoded engine events.
#[derive(Resource)]
pub struct ClientBridgeHost {
    command_tx: Sender<CommandJsonEnvelope>,
    update_tx: Sender<UpdateJsonEnvelope>,
    output_rx: Option<Receiver<Vec<u8>>>,
}

impl ClientBridgeHost {
    /// Clone the sender used to submit lifecycle-tracked commands.
    pub fn command_sender(&self) -> Sender<CommandJsonEnvelope> {
        self.command_tx.clone()
    }

    /// Clone the sender used to submit high-frequency untracked updates.
    pub fn update_sender(&self) -> Sender<UpdateJsonEnvelope> {
        self.update_tx.clone()
    }

    /// Take exclusive ownership of the encoded engine event receiver.
    pub fn take_output_receiver(&mut self) -> Option<Receiver<Vec<u8>>> {
        self.output_rx.take()
    }
}

/// Installs transport-neutral command ingress and encoded client event egress.
pub struct ClientBridgePlugin;

impl Plugin for ClientBridgePlugin {
    /// Create bridge channels and register their engine-side processing systems.
    fn build(&self, app: &mut App) {
        assert!(
            app.is_plugin_added::<EnginePlugin>(),
            "ClientBridgePlugin requires EnginePlugin"
        );
        assert!(
            app.world().contains_resource::<PendingCommandBuffer>(),
            "ClientBridgePlugin requires an initialized PendingCommandBuffer"
        );

        let (command_tx, command_rx) = async_channel::unbounded();
        let (update_tx, update_rx) = async_channel::unbounded();
        let (output_tx, output_rx) = async_channel::unbounded();

        app.insert_resource(ClientEventSink::new(output_tx));
        app.insert_resource(CommandJsonEnvelopeReceiver(command_rx));
        app.insert_resource(UpdateJsonEnvelopeReceiver(update_rx));
        app.insert_resource(ClientBridgeHost {
            command_tx,
            update_tx,
            output_rx: Some(output_rx),
        });
        app.add_systems(
            Update,
            (
                process_json_envelopes,
                process_update_json_envelopes,
                forward_command_notices,
                forward_command_results,
            )
                .chain()
                .in_set(InputHandling),
        );
    }
}

/// Forward admitted terminal results without owning command lifecycle state.
fn forward_command_results(
    mut events: MessageReader<CommandReply>,
    client_events: Res<ClientEventSink>,
) {
    for reply in events.read() {
        if reply.reply_target != ReplyTarget::ClientBroadcast {
            continue;
        }
        let result = &reply.result;
        tracing::trace!(
            command_id = %result.command_id,
            outcome = ?result.outcome,
            "command_result_sent"
        );
        client_events.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::CommandResult(result),
        );
    }
}

/// Forward non-terminal command feedback without changing lifecycle state.
fn forward_command_notices(
    mut events: MessageReader<CommandNotice>,
    client_events: Res<ClientEventSink>,
) {
    for event in events.read() {
        client_events.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::CommandNotice(event),
        );
    }
}

// ============================================================================
// Command Deserializer Registry
// ============================================================================

use std::collections::HashMap;

use serde_json::Value;

use crate::prelude::{CommandId, UndoId};

/// Type alias for command deserializer functions.
///
/// Deserializers receive the raw JSON command and semantic lifecycle identities, and are
/// responsible for deserializing the command and sending it as a typed event.
/// Returns `Ok(())` on success, or an error message on failure.
pub type CommandDeserializerFn =
    Box<dyn Fn(&mut World, Value, CommandId, UndoId) -> Result<(), String> + Send + Sync>;

/// Registry for command deserializers.
///
/// Plugins register deserializers for their command types at app startup.
/// The client ingress pipeline looks up deserializers by command module name
/// and dispatches to the appropriate plugin.
///
/// # Self-Registration
///
/// Each plugin registers its own deserializer in its `build()` method:
///
/// ```ignore
/// impl Plugin for MyPlugin {
///     fn build(&self, app: &mut App) {
///         // Register deserializer
///         app.world_mut()
///             .resource_mut::<CommandDeserializerRegistry>()
///             .register("MyCommand", my_deserializer_fn);
///     }
/// }
/// ```
#[derive(Resource, Default)]
pub struct CommandDeserializerRegistry {
    deserializers: HashMap<String, CommandDeserializerFn>,
}

impl CommandDeserializerRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            deserializers: HashMap::new(),
        }
    }

    /// Register a deserializer for a command module.
    ///
    /// The `module_name` should match the discriminator tag value used in the
    /// JSON command envelope (e.g., "CueCommand", "GroupCommand").
    pub fn register<F>(&mut self, module_name: impl Into<String>, deserializer: F)
    where
        F: Fn(&mut World, Value, CommandId, UndoId) -> Result<(), String> + Send + Sync + 'static,
    {
        let name = module_name.into();
        tracing::trace!("Registering command deserializer for module '{}'", name);
        self.deserializers.insert(name, Box::new(deserializer));
    }

    /// Look up a deserializer by module name.
    pub fn get(&self, module_name: &str) -> Option<&CommandDeserializerFn> {
        self.deserializers.get(module_name)
    }

    /// Check if a deserializer is registered for a module.
    pub fn contains(&self, module_name: &str) -> bool {
        self.deserializers.contains_key(module_name)
    }

    /// Get the list of registered module names.
    pub fn registered_modules(&self) -> impl Iterator<Item = &str> {
        self.deserializers.keys().map(|s| s.as_str())
    }
}

/// Envelope for incoming commands from the UI.
///
/// This struct represents the discriminated union format expected from the UI:
/// ```json
/// {
///   "command_id": "uuid",
///   "undo_id": "uuid",  // optional, defaults to command_id
///   "module": "CueCommand",
///   "command": { ... }
/// }
/// ```
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CommandJsonEnvelope {
    /// Identity used to track the command through its terminal result.
    pub command_id: CommandId,
    /// Undo group owned by this command, defaulting to its command identity.
    #[serde(default)]
    pub undo_id: Option<UndoId>,
    /// The command module discriminator (e.g., "CueCommand")
    pub module: String,
    /// The raw command JSON to be deserialized by the plugin
    pub command: Value,
}

impl CommandJsonEnvelope {
    /// Returns the undo identity, defaulting to this command's identity.
    pub fn effective_undo_id(&self) -> UndoId {
        self.undo_id.unwrap_or_else(|| self.command_id.into())
    }
}

/// Type alias for untracked update deserializer functions.
pub type UpdateDeserializerFn = Box<dyn Fn(&mut World, Value) -> Result<(), String> + Send + Sync>;

/// Registry for high-frequency update deserializers owned by domain plugins.
#[derive(Resource, Default)]
pub struct UpdateDeserializerRegistry {
    deserializers: HashMap<String, UpdateDeserializerFn>,
}

impl UpdateDeserializerRegistry {
    /// Registers one domain-owned update deserializer under a stable module name.
    pub fn register<F>(&mut self, module_name: impl Into<String>, deserializer: F)
    where
        F: Fn(&mut World, Value) -> Result<(), String> + Send + Sync + 'static,
    {
        let name = module_name.into();
        tracing::trace!(module = %name, "Registering update deserializer");
        self.deserializers.insert(name, Box::new(deserializer));
    }

    /// Looks up the deserializer registered for one update module.
    pub fn get(&self, module_name: &str) -> Option<&UpdateDeserializerFn> {
        self.deserializers.get(module_name)
    }

    /// Returns whether a domain registered the supplied update module.
    pub fn contains(&self, module_name: &str) -> bool {
        self.deserializers.contains_key(module_name)
    }
}

/// Untracked client input carrying a domain update without command or undo identity.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct UpdateJsonEnvelope {
    /// Stable module name used to resolve the domain deserializer.
    pub module: String,
    /// Raw domain update payload.
    pub update: Value,
}

#[cfg(test)]
mod command_json_envelope_tests {
    use super::*;

    /// Verifies that omitted undo identity defaults to the independently submitted command.
    #[test]
    fn omitted_undo_id_defaults_to_command_id() {
        let command_id = CommandId::new();
        let envelope: CommandJsonEnvelope = serde_json::from_value(serde_json::json!({
            "command_id": command_id.to_string(),
            "module": "DeskCommand",
            "command": { "type": "Eval", "data": "store cue 1.1" }
        }))
        .unwrap();

        assert_eq!(envelope.command_id, command_id);
        assert_eq!(envelope.effective_undo_id(), UndoId::from(command_id));
    }

    /// Verifies that callers may explicitly assign a shared undo identity when required.
    #[test]
    fn explicit_undo_id_is_preserved() {
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let envelope: CommandJsonEnvelope = serde_json::from_value(serde_json::json!({
            "command_id": command_id.to_string(),
            "undo_id": undo_id.to_string(),
            "module": "TimelineCommand",
            "command": { "type": "DeleteTimeline", "data": 2 }
        }))
        .unwrap();

        assert_eq!(envelope.command_id, command_id);
        assert_eq!(envelope.effective_undo_id(), undo_id);
    }
}

#[cfg(test)]
mod client_bridge_tests {
    use bevy_app::App;

    use super::*;
    use crate::prelude::{
        CommandId, CommandOutcome, CommandResult, CommandTracker, FinishedCommand, NoticeLevel,
    };

    /// Creates a minimal engine app and returns its host-owned output receiver.
    fn bridge_app() -> (App, Receiver<Vec<u8>>) {
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        let output = app
            .world_mut()
            .resource_mut::<ClientBridgeHost>()
            .take_output_receiver()
            .expect("new bridge should expose one output receiver");
        app.update();
        while output.try_recv().is_ok() {}
        (app, output)
    }

    /// Decodes one discriminator-prefixed client payload into its JSON representation.
    fn decode_message(bytes: &[u8]) -> serde_json::Value {
        assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
        minicbor_serde::from_slice(&bytes[1..]).unwrap()
    }

    /// Pins the legacy discriminator-plus-CBOR bytes for a resync completion event.
    #[test]
    fn resync_complete_wire_bytes_remain_stable() {
        let message = EncodedClientMessage::new(
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::ResyncComplete,
        )
        .unwrap();

        assert_eq!(
            message.to_bytes(),
            vec![
                0, 161, 100, 116, 121, 112, 101, 110, 82, 101, 115, 121, 110, 99, 67, 111, 109,
                112, 108, 101, 116, 101,
            ]
        );
    }

    /// Verifies notices preserve ordering ahead of same-frame terminal results.
    #[test]
    fn notice_precedes_same_frame_terminal_result() {
        let (mut app, output) = bridge_app();
        let command_id = CommandId::new();
        app.world_mut().write_message(CommandNotice {
            command_id,
            level: NoticeLevel::Info,
            message: "Storing cue".to_string(),
        });
        app.world_mut().write_message(CommandReply {
            result: CommandResult {
                command_id,
                outcome: CommandOutcome::succeeded(),
            },
            reply_target: ReplyTarget::ClientBroadcast,
        });

        app.update();

        assert_eq!(
            decode_message(&output.try_recv().unwrap())["type"],
            "CommandNotice"
        );
        assert_eq!(
            decode_message(&output.try_recv().unwrap())["type"],
            "CommandResult"
        );
    }

    /// Verifies the bridge ignores command results addressed to a local interface.
    #[test]
    fn non_client_reply_is_not_published() {
        let (mut app, output) = bridge_app();
        app.world_mut().write_message(CommandReply {
            result: CommandResult {
                command_id: CommandId::new(),
                outcome: CommandOutcome::succeeded(),
            },
            reply_target: ReplyTarget::Cli,
        });

        app.update();

        assert!(output.try_recv().is_err());
    }

    /// Verifies host-submitted invalid commands receive correlated client failures.
    #[test]
    fn host_ingress_and_result_egress_do_not_require_websocket() {
        let (mut app, output) = bridge_app();
        let command_id = CommandId::new();
        let sender = app.world().resource::<ClientBridgeHost>().command_sender();
        sender
            .try_send(CommandJsonEnvelope {
                command_id,
                undo_id: None,
                module: "MissingCommand".to_string(),
                command: serde_json::json!({}),
            })
            .unwrap();

        app.update();

        let message = decode_message(&output.try_recv().unwrap());
        assert_eq!(message["type"], "CommandResult");
        assert_eq!(
            message["data"]["command_id"],
            command_id.to_string().replace('-', "")
        );
        assert_eq!(
            message["data"]["outcome"]["data"]["code"],
            "ingress.unknown_command_module"
        );
        assert!(
            !app.world()
                .resource::<CommandTracker>()
                .is_active(command_id)
        );
        assert_eq!(app.world().resource::<Messages<FinishedCommand>>().len(), 1);
    }
}
