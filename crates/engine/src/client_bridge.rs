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
use bevy_app::{App, Plugin, PostUpdate, Update};
use bevy_ecs::message::MessageCursor;
use bevy_ecs::prelude::*;
use serde::Serialize;

use crate::{
    CommandFeedbackEgress, EnginePlugin, InputHandling,
    client_ingress::{
        CommandJsonEnvelopeReceiver, UpdateJsonEnvelopeReceiver, process_json_envelopes,
        process_update_json_envelopes,
    },
    command_lifecycle::CommandNoticeReply,
    frame_waker::FrameWaker,
    prelude::{ClientId, CommandReply, EngineClientMessage, PendingCommandBuffer, ReplyTarget},
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

/// Connected clients that should receive one outbound frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Audience {
    /// Every client attached to the host adapter.
    All,
    /// Only the identified client session; dropped when that session has disconnected.
    Client(ClientId),
}

impl Audience {
    /// Returns whether a frame for this audience should reach the identified session.
    pub fn includes(self, client: ClientId) -> bool {
        match self {
            Audience::All => true,
            Audience::Client(target) => target == client,
        }
    }
}

/// One encoded client message and the clients it is addressed to.
#[derive(Clone, Debug)]
pub struct OutboundFrame {
    /// Clients the host adapter delivers the frame to.
    pub audience: Audience,
    /// Discriminator byte followed by the CBOR payload.
    pub bytes: Vec<u8>,
}

/// Byte-oriented client event sink for domain plugins.
///
/// This resource lets plugins publish pre-serialized messages without depending
/// on a concrete transport or browser host.
#[derive(Resource, Clone)]
pub struct ClientEventSink {
    /// Sender for addressed byte frames
    tx: Sender<OutboundFrame>,
}

impl ClientEventSink {
    /// Create a new client event sink from an outbound frame sender.
    pub fn new(tx: Sender<OutboundFrame>) -> Self {
        Self { tx }
    }

    /// Send a pre-encoded message to every client of the attached host adapter.
    pub fn send(&self, message: EncodedClientMessage) {
        self.send_to(Audience::All, message);
    }

    /// Send a pre-encoded message to the given clients of the attached host adapter.
    pub fn send_to(&self, audience: Audience, message: EncodedClientMessage) {
        let frame = OutboundFrame {
            audience,
            bytes: message.to_bytes(),
        };
        if let Err(e) = self.tx.try_send(frame) {
            tracing::warn!("Failed to publish client message: {}", e);
        }
    }

    /// Serialize and publish a value to every client of the attached host adapter.
    ///
    /// This serializes the value directly to CBOR, prepends the discriminator,
    /// and publishes it. Use for anything describing shared show state.
    pub fn publish<T: Serialize>(&self, discriminator: u8, command: &T) {
        self.publish_to(Audience::All, discriminator, command);
    }

    /// Serialize and publish a value to the given clients of the attached host adapter.
    ///
    /// Use for messages that answer one client, such as command feedback, so other
    /// sessions never see replies to requests they did not make.
    pub fn publish_to<T: Serialize>(&self, audience: Audience, discriminator: u8, command: &T) {
        if let Some(message) = EncodedClientMessage::new(discriminator, command) {
            self.send_to(audience, message);
        } else {
            tracing::warn!("Failed to serialize client message");
        }
    }

    /// Check whether the host adapter still owns its output receiver.
    pub fn is_connected(&self) -> bool {
        !self.tx.is_closed()
    }
}

/// Submits lifecycle-tracked commands to the engine.
///
/// Every accepted command also wakes the frame limiter, so the engine starts processing it right
/// away instead of sleeping until the next frame tick.
#[derive(Clone)]
pub struct CommandSender {
    tx: Sender<CommandJsonEnvelope>,
    waker: FrameWaker,
}

impl CommandSender {
    /// Wraps a command channel so every submitted command also wakes `waker`.
    pub fn new(tx: Sender<CommandJsonEnvelope>, waker: FrameWaker) -> Self {
        Self { tx, waker }
    }

    /// Queues a command, waiting for capacity, then wakes the engine frame loop.
    pub async fn send(
        &self,
        envelope: CommandJsonEnvelope,
    ) -> Result<(), Box<async_channel::SendError<CommandJsonEnvelope>>> {
        self.tx.send(envelope).await.map_err(Box::new)?;
        self.waker.wake();
        Ok(())
    }

    /// Queues a command without waiting, then wakes the engine frame loop.
    pub fn try_send(
        &self,
        envelope: CommandJsonEnvelope,
    ) -> Result<(), Box<async_channel::TrySendError<CommandJsonEnvelope>>> {
        self.tx.try_send(envelope).map_err(Box::new)?;
        self.waker.wake();
        Ok(())
    }
}

/// Written once the last connected client session closes.
///
/// With no client left, nobody can save the show from a UI anymore, so the
/// backend reacts by protecting unsaved work itself.
#[derive(Message, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LastClientDisconnected;

/// Lets a host transport report that its last client session closed.
///
/// Every report also wakes the frame limiter, so the engine reacts on its next
/// frame instead of waiting for the next tick.
#[derive(Clone)]
pub struct ClientPresenceSender {
    tx: Sender<LastClientDisconnected>,
    waker: FrameWaker,
}

impl ClientPresenceSender {
    /// Wraps a presence channel so every report also wakes `waker`.
    pub fn new(tx: Sender<LastClientDisconnected>, waker: FrameWaker) -> Self {
        Self { tx, waker }
    }

    /// Reports that no client session remains connected to the host.
    pub fn last_client_disconnected(&self) {
        if let Err(error) = self.tx.try_send(LastClientDisconnected) {
            tracing::warn!(%error, "last_client_disconnected_report_failed");
            return;
        }
        self.waker.wake();
    }
}

/// Engine-side end of the host's client presence reports.
#[derive(Resource)]
struct ClientPresenceReceiver(Receiver<LastClientDisconnected>);

/// Turns host presence reports into [`LastClientDisconnected`] messages for this frame.
fn forward_client_presence(
    receiver: Res<ClientPresenceReceiver>,
    mut disconnected: MessageWriter<LastClientDisconnected>,
) {
    while let Ok(report) = receiver.0.try_recv() {
        disconnected.write(report);
    }
}

/// Host-owned handles for submitting ingress and receiving encoded engine events.
#[derive(Resource)]
pub struct ClientBridgeHost {
    command_tx: CommandSender,
    update_tx: Sender<UpdateJsonEnvelope>,
    presence_tx: ClientPresenceSender,
    output_rx: Option<Receiver<OutboundFrame>>,
}

impl ClientBridgeHost {
    /// Clone the sender used to submit lifecycle-tracked commands.
    pub fn command_sender(&self) -> CommandSender {
        self.command_tx.clone()
    }

    /// Clone the sender used to submit high-frequency untracked updates.
    pub fn update_sender(&self) -> Sender<UpdateJsonEnvelope> {
        self.update_tx.clone()
    }

    /// Clone the sender used to report that the last client session closed.
    pub fn presence_sender(&self) -> ClientPresenceSender {
        self.presence_tx.clone()
    }

    /// Take exclusive ownership of the encoded engine event receiver.
    pub fn take_output_receiver(&mut self) -> Option<Receiver<OutboundFrame>> {
        self.output_rx.take()
    }
}

/// Process-scoped bridge channels shared by every world a host builds.
///
/// Inserting this resource before [`ClientBridgePlugin`] builds makes the new
/// world publish to and receive from the same channels as earlier worlds, so a
/// host transport attached once keeps its clients across world replacement.
/// Without it the plugin creates channels private to one world. The frame
/// waker is shared the same way, so commands keep waking whichever world is
/// active.
#[derive(Resource, Clone)]
pub struct SharedClientBridge {
    command_tx: Sender<CommandJsonEnvelope>,
    command_rx: Receiver<CommandJsonEnvelope>,
    update_tx: Sender<UpdateJsonEnvelope>,
    update_rx: Receiver<UpdateJsonEnvelope>,
    presence_tx: Sender<LastClientDisconnected>,
    presence_rx: Receiver<LastClientDisconnected>,
    output_tx: Sender<OutboundFrame>,
    output_rx: Receiver<OutboundFrame>,
    frame_waker: FrameWaker,
}

impl SharedClientBridge {
    /// Create unbounded command, update, presence, and output channels and a fresh frame waker.
    pub fn new() -> Self {
        let (command_tx, command_rx) = async_channel::unbounded();
        let (update_tx, update_rx) = async_channel::unbounded();
        let (presence_tx, presence_rx) = async_channel::unbounded();
        let (output_tx, output_rx) = async_channel::unbounded();
        Self {
            command_tx,
            command_rx,
            update_tx,
            update_rx,
            presence_tx,
            presence_rx,
            output_tx,
            output_rx,
            frame_waker: FrameWaker::default(),
        }
    }
}

impl Default for SharedClientBridge {
    fn default() -> Self {
        Self::new()
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

        let SharedClientBridge {
            command_tx,
            command_rx,
            update_tx,
            update_rx,
            presence_tx,
            presence_rx,
            output_tx,
            output_rx,
            frame_waker,
        } = app
            .world()
            .get_resource::<SharedClientBridge>()
            .cloned()
            .unwrap_or_default();

        app.insert_resource(ClientEventSink::new(output_tx));
        app.insert_resource(CommandJsonEnvelopeReceiver(command_rx));
        app.insert_resource(UpdateJsonEnvelopeReceiver(update_rx));
        app.insert_resource(ClientPresenceReceiver(presence_rx));
        app.insert_resource(frame_waker.clone());
        app.insert_resource(ClientBridgeHost {
            command_tx: CommandSender::new(command_tx, frame_waker.clone()),
            update_tx,
            presence_tx: ClientPresenceSender::new(presence_tx, frame_waker),
            output_rx: Some(output_rx),
        });
        app.init_resource::<CommandFeedbackCursors>();
        app.add_message::<LastClientDisconnected>();
        app.add_systems(
            Update,
            (
                forward_client_presence,
                process_json_envelopes,
                process_update_json_envelopes,
                forward_command_feedback,
            )
                .chain()
                .in_set(InputHandling),
        );
        app.add_systems(
            PostUpdate,
            forward_command_feedback.in_set(CommandFeedbackEgress),
        );
    }
}

/// Read positions shared by every command feedback forwarding point.
///
/// Feedback is forwarded both while ingesting commands and at the end of each frame. A shared
/// cursor lets both points drain the same messages without publishing any of them twice.
#[derive(Resource, Default)]
struct CommandFeedbackCursors {
    notices: MessageCursor<CommandNoticeReply>,
    replies: MessageCursor<CommandReply>,
}

/// Forwards pending notices, then admitted terminal results, without owning lifecycle state.
///
/// Runs after ingress, so results finished outside `Update` are not held for a frame, and again
/// in [`CommandFeedbackEgress`] so results finished by this frame's handlers are published
/// before frame pacing sleeps. Notices precede results so a command's feedback arrives before
/// its terminal outcome.
///
/// Feedback for a client-submitted command goes only to that client. Results of commands no
/// client submitted are broadcast, and results for local interfaces are not published. Notices
/// of commands without a client stay visible to every client, since they report work an
/// operator may still need to see.
fn forward_command_feedback(
    mut cursors: ResMut<CommandFeedbackCursors>,
    notices: Res<Messages<CommandNoticeReply>>,
    replies: Res<Messages<CommandReply>>,
    client_events: Res<ClientEventSink>,
) {
    let CommandFeedbackCursors {
        notices: notice_cursor,
        replies: reply_cursor,
    } = &mut *cursors;
    for reply in notice_cursor.read(&notices) {
        let audience = match reply.reply_target {
            ReplyTarget::Client(client) => Audience::Client(client),
            ReplyTarget::ClientBroadcast | ReplyTarget::Cli | ReplyTarget::Detached => {
                Audience::All
            }
        };
        client_events.publish_to(
            audience,
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::CommandNotice(&reply.notice),
        );
    }
    for reply in reply_cursor.read(&replies) {
        let audience = match reply.reply_target {
            ReplyTarget::Client(client) => Audience::Client(client),
            ReplyTarget::ClientBroadcast => Audience::All,
            ReplyTarget::Cli | ReplyTarget::Detached => continue,
        };
        let result = &reply.result;
        tracing::trace!(
            command_id = %result.command_id,
            outcome = ?result.outcome,
            ?audience,
            "command_result_sent"
        );
        client_events.publish_to(
            audience,
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::CommandResult(result),
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
    /// Where the command's feedback goes, assigned by the host transport after parsing.
    ///
    /// Never read from the wire, so a client cannot address replies to another session. The
    /// websocket host sets the submitting session; adapters whose caller cannot receive a
    /// reply set [`ReplyTarget::Detached`]. Defaults to a broadcast.
    #[serde(skip)]
    pub reply_target: ReplyTarget,
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
    use crate::EventHandling;
    use crate::prelude::{
        CommandId, CommandNotice, CommandOutcome, CommandResult, CommandTracker, FinishedCommand,
        NoticeLevel,
    };

    /// Creates a minimal engine app and returns its host-owned output receiver.
    fn bridge_app() -> (App, Receiver<OutboundFrame>) {
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

    /// Decodes one discriminator-prefixed client frame into its JSON representation.
    fn decode_message(frame: &OutboundFrame) -> serde_json::Value {
        assert_eq!(frame.bytes[0], DISCRIMINATOR_NON_DROPPABLE);
        minicbor_serde::from_slice(&frame.bytes[1..]).unwrap()
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

    /// Verifies a host's last-client report surfaces as one engine message on the next frame.
    #[test]
    fn last_client_report_becomes_an_engine_message() {
        let (mut app, _output) = bridge_app();
        let presence = app.world().resource::<ClientBridgeHost>().presence_sender();

        presence.last_client_disconnected();
        app.update();

        let reports = app
            .world_mut()
            .resource_mut::<Messages<LastClientDisconnected>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(reports, vec![LastClientDisconnected]);
    }

    /// Verifies notices preserve ordering ahead of same-frame terminal results.
    #[test]
    fn notice_precedes_same_frame_terminal_result() {
        let (mut app, output) = bridge_app();
        let command_id = CommandId::new();
        app.world_mut().write_message(CommandNoticeReply {
            notice: CommandNotice {
                command_id,
                level: NoticeLevel::Info,
                message: "Storing cue".to_string(),
            },
            reply_target: ReplyTarget::ClientBroadcast,
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

    /// Verifies a result finished by a frame's event handlers is published in that same frame,
    /// exactly once, rather than waiting for the next frame's ingress.
    #[test]
    fn result_finished_during_update_is_published_before_frame_ends() {
        let (mut app, output) = bridge_app();
        let command_id = CommandId::new();
        app.insert_resource(PendingReply(Some(command_id)));
        app.add_systems(Update, finish_pending_reply.in_set(EventHandling));

        app.update();

        let results = drain_command_results(&output);
        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0]["data"]["command_id"],
            command_id.to_string().replace('-', "")
        );
        app.update();
        assert!(drain_command_results(&output).is_empty());
    }

    /// Drains every published client message and keeps only the command results.
    fn drain_command_results(output: &Receiver<OutboundFrame>) -> Vec<serde_json::Value> {
        std::iter::from_fn(|| output.try_recv().ok())
            .map(|frame| decode_message(&frame))
            .filter(|message| message["type"] == "CommandResult")
            .collect()
    }

    /// Command whose terminal result a test handler publishes on the next update.
    #[derive(Resource)]
    struct PendingReply(Option<CommandId>);

    /// Publishes the pending test result as an event handler would after domain work.
    fn finish_pending_reply(
        mut pending: ResMut<PendingReply>,
        mut replies: MessageWriter<CommandReply>,
    ) {
        if let Some(command_id) = pending.0.take() {
            replies.write(CommandReply {
                result: CommandResult {
                    command_id,
                    outcome: CommandOutcome::succeeded(),
                },
                reply_target: ReplyTarget::ClientBroadcast,
            });
        }
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
                reply_target: ReplyTarget::ClientBroadcast,
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

    /// Verifies a command submitted by one client session reports its result to that session
    /// only, a command without a submitting client is still broadcast, and a detached command
    /// publishes no result.
    #[test]
    fn client_submitted_result_is_addressed_to_its_client() {
        let (mut app, output) = bridge_app();
        let sender = app.world().resource::<ClientBridgeHost>().command_sender();
        for reply_target in [
            ReplyTarget::Client(ClientId(7)),
            ReplyTarget::Detached,
            ReplyTarget::ClientBroadcast,
        ] {
            sender
                .try_send(CommandJsonEnvelope {
                    command_id: CommandId::new(),
                    undo_id: None,
                    module: "MissingCommand".to_string(),
                    command: serde_json::json!({}),
                    reply_target,
                })
                .unwrap();
        }

        app.update();

        let audiences: Vec<_> = std::iter::from_fn(|| output.try_recv().ok())
            .map(|frame| frame.audience)
            .collect();
        assert_eq!(
            audiences,
            vec![Audience::Client(ClientId(7)), Audience::All]
        );
    }

    /// Verifies notices follow the reply target of their command, and that notices of commands
    /// without a submitting client stay visible to every client.
    #[test]
    fn notices_follow_their_command_reply_target() {
        let (mut app, output) = bridge_app();
        for reply_target in [
            ReplyTarget::Client(ClientId(3)),
            ReplyTarget::ClientBroadcast,
            ReplyTarget::Detached,
        ] {
            app.world_mut().write_message(CommandNoticeReply {
                notice: CommandNotice {
                    command_id: CommandId::new(),
                    level: NoticeLevel::Warning,
                    message: "Check this".to_string(),
                },
                reply_target,
            });
        }

        app.update();

        let audiences: Vec<_> = std::iter::from_fn(|| output.try_recv().ok())
            .map(|frame| frame.audience)
            .collect();
        assert_eq!(
            audiences,
            vec![Audience::Client(ClientId(3)), Audience::All, Audience::All]
        );
    }

    /// Verifies the serialized wire envelope cannot choose where its feedback is delivered.
    #[test]
    fn wire_envelope_ignores_reply_target() {
        let envelope: CommandJsonEnvelope = serde_json::from_value(serde_json::json!({
            "command_id": CommandId::new().to_string(),
            "module": "DeskCommand",
            "command": {},
            "reply_target": { "Client": 9 }
        }))
        .unwrap();

        assert_eq!(envelope.reply_target, ReplyTarget::ClientBroadcast);
    }
}
