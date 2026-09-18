// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_state::app::StatesPlugin;
use bevy_state::prelude::*;
use nightfall_cmd_parse::prelude::*;

use crate::prelude::*;

mod client;
pub mod client_bridge;
pub mod client_ingress;
pub mod command_lifecycle;
pub mod command_traits;
pub mod data_provider;
pub mod object_registry;
#[cfg(not(target_arch = "wasm32"))]
pub mod process_shutdown;
pub mod protocol;
pub mod runtime_capabilities;

/// Backend lifecycle state for process initialization and showfile readiness.
#[derive(
    States, Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[typeshare::typeshare]
pub enum AppState {
    /// Process startup while plugins register and process-lifetime devices are probed.
    #[default]
    Initializing,
    /// Initial setup is done and no showfile is loaded.
    Initialized,
    /// A showfile world is being built and swapped into place.
    ShowLoading,
    /// Showfile data is loaded and the backend may process showfile commands.
    Ready,
}

/// Tracks startup frames to let initial plugin setup settle before initialization completes.
#[derive(Resource)]
pub struct StartupFrameCounter {
    frames_to_wait: u32,
    current_frame: u32,
}

impl Default for StartupFrameCounter {
    fn default() -> Self {
        Self {
            // Wait 2 frames:
            // Frame 1: Process spawned entities, populate indices
            // Frame 2: All systems run with complete data
            frames_to_wait: 2,
            current_frame: 0,
        }
    }
}

pub mod prelude {
    pub use nightfall_engine_derive::EnginePayload;

    pub use crate::EnginePlugin;
    pub use crate::client_bridge::{
        ClientBridgeHost, ClientBridgePlugin, ClientEventSink, CommandDeserializerRegistry,
        CommandJsonEnvelope, DISCRIMINATOR_DROPPABLE, DISCRIMINATOR_NON_DROPPABLE,
        EncodedClientMessage, UpdateDeserializerRegistry, UpdateJsonEnvelope,
    };
    pub use crate::client_ingress::{CommandJsonEnvelopeReceiver, UpdateJsonEnvelopeReceiver};
    pub use crate::command_lifecycle::{
        ActiveCommand, CommandLifecycleError, CommandRegistrationError, CommandReply,
        CommandResponder, CommandTracker, FinishedCommand, finish_command_in_world,
    };
    pub use crate::command_traits::CliCommand;
    pub use crate::data_provider::{DataProvider, DataStoreError};
    pub use crate::parse_command_string;
    #[cfg(not(target_arch = "wasm32"))]
    pub use crate::process_shutdown::{
        DebugPanicTarget, debug_panic_target_names, init_process_shutdown,
        is_process_shutdown_requested, maybe_trigger_debug_worker_panic, parse_debug_panic_target,
        process_shutdown_grace_period, process_shutdown_reason, request_debug_worker_panic,
        request_process_shutdown, subscribe_process_shutdown,
    };
    pub use crate::protocol::client::EngineClientMessage;
    pub use crate::protocol::dispatch::{CommandIngressRouter, EngineActionRouter};
    pub use crate::protocol::dispatch_ast::{AstConvert, DispatchError};
    pub use crate::protocol::engine_command::{
        CommandEnvelope, CommandId, CommandOrigin, EngineAction, EngineActionEnvelope,
        EngineIngressMeta, EnginePayload, EventEnvelope, IngressCommand, NotificationEnvelope,
        OperationId, OperationResult, ReplyTarget, RequestEnvelope, UndoId,
    };
    pub use crate::protocol::erased::{
        DelayedCommandQueue, DynEngineAction, DynEngineActionEnvelope, DynEnginePayload,
        PayloadEnvelope, PendingCommandBuffer, PendingEngineActionBuffer,
    };
    pub use crate::protocol::results::{
        CommandError, CommandNotice, CommandOutcome, CommandOutput, CommandResult, NoticeLevel,
    };
    pub use crate::register_command_deserializer;
    pub use crate::register_ingress_command;
    pub use crate::register_update_deserializer;
    pub use crate::runtime_capabilities::{
        FxModuleCapability, LibraryCapability, PersistenceCapability, RuntimeCapabilities,
        RuntimeMode, TimelineAudioCapability,
    };
    pub use crate::{
        AppState, ClientOutput, ClockUpdate, Compositing, DmxOutput, EventHandling, InputHandling,
        LayerGeneration, ResyncHandling, StartupFrameCounter, VdimProcessing,
    };
    pub use crate::{EngineCommand, ResyncRequested, register_engine_action};
}

/// Plugin for fixtures
pub struct EnginePlugin;
impl Plugin for EnginePlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering EnginePlugin");
        // Add StatesPlugin to enable state transitions
        app.add_plugins(StatesPlugin);

        // Initialize app state
        app.init_state::<AppState>();
        app.init_resource::<StartupFrameCounter>();
        app.init_resource::<RuntimeCapabilities>();
        app.configure_sets(
            Update,
            (
                InputHandling,
                EventHandling.after(InputHandling),
                ClockUpdate.after(EventHandling),
                LayerGeneration.after(ClockUpdate),
                Compositing.after(LayerGeneration),
                VdimProcessing.after(Compositing),
                ClientOutput.after(VdimProcessing),
                DmxOutput.after(VdimProcessing),
            ),
        );
        app.init_resource::<CommandDeserializerRegistry>();
        app.init_resource::<UpdateDeserializerRegistry>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<CommandIngressRouter>();
        app.init_resource::<EngineActionRouter>();
        app.add_message::<CommandResult>();
        app.add_message::<command_lifecycle::CommandReply>();
        app.add_message::<command_lifecycle::FinishedCommand>();
        app.add_message::<CommandNotice>();
        // Add startup transition system
        app.add_systems(
            Update,
            check_startup_complete
                .run_if(in_state(AppState::Initializing))
                .in_set(InputHandling),
        );

        // Add resync completion system that runs after all plugin resync handlers
        app.add_systems(
            Update,
            (
                broadcast_app_state_on_resync.before(ResyncHandling),
                send_runtime_capabilities_on_resync.before(ResyncHandling),
                send_attribute_metadata_on_resync.before(ResyncHandling),
                broadcast_app_state_on_change.in_set(ClientOutput),
                send_resync_complete
                    .after(ResyncHandling)
                    .in_set(ClientOutput),
            ),
        );

        register_ingress_command::<EngineCommand>(app);
        app.add_message::<ResyncRequested>();
        register_command_deserializer::<EngineCommand>(
            app,
            crate::client::deserialize_engine_commands,
        );
        app.add_systems(Update, begin_resync.in_set(InputHandling));
    }
}

/// System set for ingesting external commands and input messages.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct InputHandling;

/// System set for turning ingested events into engine actions.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct EventHandling;

/// System set for advancing clocks before producing frame layers.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClockUpdate;

/// System set for producing layer outputs before compositing.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct LayerGeneration;

/// System set for combining generated layers into fixture output values.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct Compositing;

/// System set for applying virtual dimmer processing after compositing.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct VdimProcessing;

/// System set for publishing engine state changes to attached clients.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClientOutput;

/// System set for plugin state resend handlers during a resync.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ResyncHandling;

/// System set for sending finalized DMX frames to output transports.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct DmxOutput;

/// Registers one user-facing command for semantic envelope dispatch.
pub fn register_ingress_command<T: IngressCommand + Clone>(app: &mut App) {
    app.add_message::<CommandEnvelope<T>>();
    app.world_mut()
        .resource_mut::<CommandIngressRouter>()
        .register_ingress::<T>();
}

/// Registers a domain-owned engine action for erased queue and typed message dispatch.
pub fn register_engine_action<T: EngineAction + Clone>(app: &mut App) {
    app.add_message::<EngineActionEnvelope<T>>();
    app.world_mut()
        .resource_mut::<EngineActionRouter>()
        .register::<T>();
}

/// Register a command deserializer helper for a typed command `T`.
///
/// The module name is determined by `T::COMMAND_MODULE` from the
/// [`EngineIngressMeta`] trait, which defaults to the type name when
/// using `#[derive(EnginePayload)]`.
pub fn register_command_deserializer<T: EnginePayload + EngineIngressMeta + Clone>(
    app: &mut App,
    deserializer: fn(&mut World, serde_json::Value, CommandId, UndoId) -> Result<(), String>,
) {
    app.world_mut()
        .resource_mut::<CommandDeserializerRegistry>()
        .register(T::COMMAND_MODULE, deserializer);
}

/// Registers an untracked, domain-owned update deserializer.
pub fn register_update_deserializer(
    app: &mut App,
    module: &'static str,
    deserializer: fn(&mut World, serde_json::Value) -> Result<(), String>,
) {
    app.world_mut()
        .resource_mut::<UpdateDeserializerRegistry>()
        .register(module, deserializer);
}

/// User-facing commands owned by engine infrastructure.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[serde(deny_unknown_fields)]
pub enum EngineCommand {
    /// Request that all plugins resend their full state
    ResyncState,
    /// Set the FPS upper-bound
    SetFps(u32),
}

impl EnginePayload for EngineCommand {}

impl IngressCommand for EngineCommand {}

impl EngineIngressMeta for EngineCommand {
    const COMMAND_MODULE: &'static str = "EngineCommand";
}

/// Fact published when an external command or internal transition requests a state resync.
#[derive(Clone, Debug, Message)]
pub struct ResyncRequested {
    /// User command awaiting completion after the resync, when externally requested.
    pub command_id: Option<CommandId>,
}

/// Converts semantic resync commands into the event consumed across domain crates.
fn begin_resync(
    mut commands: MessageReader<CommandEnvelope<EngineCommand>>,
    mut resync_requests: MessageWriter<ResyncRequested>,
) {
    for command in commands.read() {
        if matches!(command.command, EngineCommand::ResyncState) {
            resync_requests.write(ResyncRequested {
                command_id: Some(command.command_id),
            });
        }
    }
}

/// This parses top-level command expressions using AST-based dispatch.
/// The AST is converted to engine commands via registered domain-specific converters.
pub fn parse_command_string(cmd_str: &str) -> Result<Vec<DynEnginePayload>, ParseError> {
    // Parse AST and dispatch via registered converters in domain crates
    let ast = nightfall_cmd_parse::generate_ast(cmd_str)
        .map_err(|e| ParseError::Failure(format!("Parsing command to AST failed: {}", e)))?;

    tracing::trace!(?ast, "Generated AST");

    let events = crate::protocol::dispatch_ast::dispatch_ast(&ast);
    tracing::trace!(?events, "Generated events");

    events.map_err(|e| ParseError::Failure(format!("Command dispatch failed: {}", e)))
}

/// System that checks if initial setup is complete and transitions to Initialized state.
fn check_startup_complete(
    mut counter: ResMut<StartupFrameCounter>,
    mut next_state: ResMut<NextState<AppState>>,
) {
    counter.current_frame += 1;

    if counter.current_frame >= counter.frames_to_wait {
        tracing::info!("Startup complete, transitioning to Initialized state");
        next_state.set(AppState::Initialized);
    } else {
        tracing::debug!(
            "Initializing: frame {}/{}",
            counter.current_frame,
            counter.frames_to_wait
        );
    }
}

/// System that broadcasts the current backend lifecycle state during a full resync.
fn broadcast_app_state_on_resync(
    mut events: MessageReader<ResyncRequested>,
    app_state: Res<State<AppState>>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::AppState(app_state.get()),
    );
}

/// System that broadcasts backend lifecycle transitions as they happen.
fn broadcast_app_state_on_change(
    app_state: Res<State<AppState>>,
    broadcaster: Res<ClientEventSink>,
) {
    if !app_state.is_changed() {
        return;
    }

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::AppState(app_state.get()),
    );
}

/// System that sends static attribute metadata before plugin resync handlers.
fn send_attribute_metadata_on_resync(
    mut events: MessageReader<ResyncRequested>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    let attribute_metadata = nightfall_dmx::prelude::standard_attribute_metadata();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::AttributeMetadata(&attribute_metadata),
    );
}

/// System that sends the host-authored runtime capability snapshot on resync.
fn send_runtime_capabilities_on_resync(
    mut events: MessageReader<ResyncRequested>,
    capabilities: Res<RuntimeCapabilities>,
    broadcaster: Res<ClientEventSink>,
) {
    if events.read().next().is_none() {
        return;
    }

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::RuntimeCapabilities(&capabilities),
    );
}

/// System that sends ResyncComplete after all plugin resync handlers have run.
fn send_resync_complete(
    mut events: MessageReader<ResyncRequested>,
    broadcaster: Res<ClientEventSink>,
    mut responder: CommandResponder,
) {
    let requests = events.read().cloned().collect::<Vec<_>>();
    if requests.is_empty() {
        return;
    }

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::ResyncComplete,
    );
    for request in requests {
        let Some(command_id) = request.command_id else {
            continue;
        };
        if let Err(error) = responder.succeed(command_id) {
            tracing::error!(%command_id, %error, "resync_command_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use async_channel::unbounded;
    use bevy_state::app::StatesPlugin;
    use bevy_state::prelude::State;

    use super::*;

    /// Verifies initial setup settles into Initialized rather than Ready.
    #[test]
    fn startup_frame_gate_transitions_to_initialized() {
        let mut app = App::new();
        app.add_plugins(StatesPlugin);
        app.init_state::<AppState>();
        app.init_resource::<StartupFrameCounter>();
        app.add_systems(
            Update,
            check_startup_complete.run_if(in_state(AppState::Initializing)),
        );

        assert_eq!(
            *app.world().resource::<State<AppState>>().get(),
            AppState::Initializing
        );

        app.update();
        app.update();
        app.update();

        assert_eq!(
            *app.world().resource::<State<AppState>>().get(),
            AppState::Initialized
        );
    }

    /// Verifies that resync fans out as an event and completes only at the finalizer.
    #[test]
    fn resync_command_completes_after_resync_event_is_processed() {
        let mut app = App::new();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<EngineCommand>>();
        app.add_message::<ResyncRequested>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        let (sender, receiver) = unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(Update, (begin_resync, send_resync_complete).chain());
        let command = CommandEnvelope::new(
            EngineCommand::ResyncState,
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        );
        let command_id = command.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&command)
            .unwrap();
        app.world_mut().write_message(command);

        app.update();

        assert!(
            !app.world()
                .resource::<CommandTracker>()
                .is_active(command_id)
        );
        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("resync should publish one terminal result");
        assert_eq!(result.command_id, command_id);
        assert_eq!(result.outcome, CommandOutcome::succeeded());
        let notification = receiver
            .try_recv()
            .expect("resync should publish its completion notification");
        let decoded: serde_json::Value = minicbor_serde::from_slice(&notification[1..]).unwrap();
        assert_eq!(decoded["type"], "ResyncComplete");
    }
}
