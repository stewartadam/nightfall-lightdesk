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
mod undo;
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
        undo::install(app);
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
struct OscInput(OscLastEvent, web_time::Instant);

fn osc_event_system(
    mut osc_rx: ResMut<OscEventReceiver>,
    mut last_event: ResMut<LastOscEvent>,
    mut sources: ResMut<OscSources>,
    mut event_writer: MessageWriter<OscInput>,
) {
    while let Ok(raw_event) = osc_rx.0.try_recv() {
        let received_at = raw_event.received_at;
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
        event_writer.write(OscInput(osc_event, received_at));
    }
}

fn handle_osc_events(
    mut events: MessageReader<OscInput>,
    mut learning: ResMut<nightfall_engine::controller_learning::ControllerLearning>,
    mappings: Res<OscMappings>,
    registry: Res<nightfall_actions::ActionRegistry>,
    mut eligibility: Local<Option<Vec<bool>>>,
    mut pressed: Local<
        nightfall_engine::controller_input::ControllerEdgeHistory<(String, String, usize)>,
    >,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    if eligibility.is_none() || mappings.is_changed() || registry.is_changed() {
        *eligibility = Some(
            mappings
                .validation_errors(&registry)
                .iter()
                .map(Option::is_none)
                .collect(),
        );
    }
    for event in events.read() {
        use nightfall_engine::controller_learning::ControllerInputRoute;
        let mut route = ControllerInputRoute::Dispatch;
        let osc_event = &event.0;
        let previous: Vec<_> = osc_event
            .args
            .iter()
            .enumerate()
            .map(|(index, arg)| {
                arg.control_value().and_then(|value| {
                    pressed.observe(
                        (osc_event.source.clone(), osc_event.address.clone(), index),
                        value != 0.0,
                    )
                })
            })
            .collect();
        if let Some(mut source) = learned_source(osc_event) {
            if previous.first() == Some(&Some(true))
                && osc_event
                    .args
                    .first()
                    .and_then(command::OscType::control_value)
                    == Some(0.0)
            {
                source.gesture = nightfall_engine::controller_learning::LearnedGesture::Release;
            }
            let numeric_active = osc_event.args.first().and_then(|value| {
                if matches!(value, command::OscType::Bool(_)) {
                    None
                } else {
                    value.control_value().map(|value| value != 0.0)
                }
            });
            route = learning.route_received_input(source, event.1, numeric_active);
            if route == ControllerInputRoute::SuppressAll {
                continue;
            }
        } else if learning.reject_unsupported_input(
            ActionSurface::Osc,
            &serde_json::json!({ "address": osc_event.address, "arg_index": 0 }),
            event.1,
            "This OSC message cannot be learned. Use a finite numeric or boolean first argument, or a message without arguments.",
        ) {
            continue;
        }
        if let Some(mapping) = mappings.lookup_mapping(osc_event) {
            let index = mappings
                .mappings()
                .iter()
                .position(|candidate| std::ptr::eq(candidate, mapping))
                .expect("lookup returns a retained mapping");
            if !eligibility.as_ref().is_some_and(|eligible| eligible[index]) {
                continue;
            }
            if route == ControllerInputRoute::SuppressTriggers
                && !matches!(mapping.input, command::OscBindingInput::Continuous { .. })
            {
                continue;
            }
            let arg_index = usize::from(mapping.arg_index.unwrap_or(0));
            let value = osc_event
                .args
                .get(arg_index)
                .and_then(command::OscType::control_value);
            let old = previous.get(arg_index).copied().flatten();
            let input = match mapping.input {
                command::OscBindingInput::Pulse => ActionInput::Trigger,
                command::OscBindingInput::Press
                    if value.is_some_and(|value| value != 0.0) && old != Some(true) =>
                {
                    ActionInput::Trigger
                }
                command::OscBindingInput::Release if value == Some(0.0) && old != Some(false) => {
                    ActionInput::Trigger
                }
                command::OscBindingInput::Continuous { minimum, maximum } => {
                    let Some(value) = value else {
                        continue;
                    };
                    if !minimum.is_finite() || !maximum.is_finite() || maximum <= minimum {
                        continue;
                    }
                    ActionInput::Scalar(((value - minimum) / (maximum - minimum)).clamp(0.0, 1.0))
                }
                _ => continue,
            };
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

/// Recognizes usable controls without pinning a binding to a sender's temporary UDP port.
fn learned_source(
    event: &OscLastEvent,
) -> Option<nightfall_engine::controller_learning::LearnedControllerSource> {
    use nightfall_engine::controller_learning::{LearnedControllerSource, LearnedGesture};
    let gesture = match event.args.first() {
        None => LearnedGesture::Pulse,
        Some(command::OscType::Bool(true)) => LearnedGesture::Press,
        Some(command::OscType::Bool(false)) => LearnedGesture::Release,
        Some(value) if value.control_value().is_some() => LearnedGesture::Continuous,
        _ => return None,
    };
    Some(LearnedControllerSource {
        surface: ActionSurface::Osc,
        selector: serde_json::json!({ "address": event.address, "arg_index": 0 }),
        label: event.address.clone(),
        gesture,
    })
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
#[derive(bevy_ecs::system::SystemParam)]
struct OscMappingCommands<'w, 's> {
    events: MessageReader<'w, 's, CommandEnvelope<OscCommand>>,
    mappings: ResMut<'w, OscMappings>,
    learning: ResMut<'w, nightfall_engine::controller_learning::ControllerLearning>,
    registry: Res<'w, nightfall_actions::ActionRegistry>,
    responder: CommandResponder<'w>,
    undo_manager: Option<ResMut<'w, nightfall_undo::prelude::UndoManager>>,
}

/// Validates domain targets against read-only world state before committing mapping changes.
fn handle_osc_crud(mut state: ParamSet<(&World, OscMappingCommands)>) {
    let events: Vec<_> = state.p1().events.read().cloned().collect();
    for event in &events {
        let validation = {
            let world = state.p0();
            let registry = world.resource::<nightfall_actions::ActionRegistry>();
            match &event.command {
                OscCommand::StoreMapping { mapping, .. } => {
                    registry.validate_target(world, &mapping.action)
                }
                OscCommand::BindLearned { action, .. } => registry.validate_target(world, action),
                OscCommand::StoreMappings(mappings) => mappings
                    .iter()
                    .try_for_each(|mapping| registry.validate_target(world, &mapping.action)),
                _ => Ok(()),
            }
        };
        let OscMappingCommands {
            mut mappings,
            mut learning,
            registry,
            mut responder,
            mut undo_manager,
            ..
        } = state.p1();
        if let Err(error) = validation {
            if let Err(error) = responder.fail(
                event.command_id,
                CommandError::new(error.code, error.message),
            ) {
                tracing::error!(command_id = %event.command_id, %error, "mapping_validation_completion_failed");
            }
            continue;
        }
        let result = match &event.command {
            OscCommand::StoreMapping { expected, mapping } => {
                match mappings.store_mapping(expected.as_ref(), mapping.clone(), &registry) {
                    Ok(()) => {
                        if let Some(manager) = undo_manager.as_deref_mut() {
                            undo::record(
                                manager,
                                event.command_id,
                                event.undo_id,
                                expected.clone(),
                                Some(mapping.clone()),
                            );
                        }
                        responder.succeed(event.command_id)
                    }
                    Err(error) => responder.fail(event.command_id, error),
                }
            }
            OscCommand::BindLearned {
                session_id,
                action,
                replace,
                arg_index,
                input,
            } => {
                let connection = responder.client_connection(event.command_id);
                match learning
                    .authorize_client(connection.as_ref())
                    .and_then(|()| {
                        learning.complete_with_binding(*session_id, ActionSurface::Osc, |source| {
                            mappings.bind_learned(
                                source,
                                action.clone(),
                                replace.as_ref(),
                                *arg_index,
                                input.clone(),
                                &registry,
                            )
                        })
                    }) {
                    Ok(mapping) => {
                        if let Some(manager) = undo_manager.as_deref_mut() {
                            undo::record(
                                manager,
                                event.command_id,
                                event.undo_id,
                                replace.clone(),
                                Some(mapping.clone()),
                            );
                        }
                        responder.succeed_with_output(event.command_id, mapping)
                    }
                    Err(error) => responder.fail(event.command_id, error),
                }
            }
            OscCommand::RemoveMapping { expected } => match mappings.remove_expected(expected) {
                Ok(()) => {
                    if let Some(manager) = undo_manager.as_deref_mut() {
                        undo::record(
                            manager,
                            event.command_id,
                            event.undo_id,
                            Some(expected.clone()),
                            None,
                        );
                    }
                    responder.succeed(event.command_id)
                }
                Err(error) => responder.fail(event.command_id, error),
            },
            OscCommand::StoreMappings(new_mappings) => {
                match OscMappings::validate_all(new_mappings, &registry) {
                    Ok(()) => {
                        mappings.set_mappings(new_mappings.clone());
                        responder.succeed(event.command_id)
                    }
                    Err(error) => responder.fail(event.command_id, error),
                }
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

    /// Loaded invalid entries cannot execute or disable unrelated valid OSC mappings.
    #[test]
    fn loaded_invalid_bindings_are_retained_but_ineligible() {
        let mut app = App::new();
        app.init_resource::<nightfall_engine::controller_learning::ControllerLearning>();
        let valid = test_mapping();
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![valid.clone()]);
        app.insert_resource(mappings);
        register_input_test_actions(&mut app);
        let mut unknown = valid.clone();
        unknown.id = uuid::Uuid::new_v4();
        unknown.action.id = nightfall_actions::ActionId::new("missing.action");
        unknown.address = "/unknown".into();
        let mut duplicate = valid.clone();
        duplicate.id = uuid::Uuid::new_v4();
        duplicate.address = "/duplicate".into();
        let mut duplicate_two = duplicate.clone();
        duplicate_two.id = uuid::Uuid::new_v4();
        app.world_mut()
            .resource_mut::<OscMappings>()
            .set_mappings(vec![valid, unknown, duplicate, duplicate_two]);
        let errors = app
            .world()
            .resource::<OscMappings>()
            .validation_errors(app.world().resource::<nightfall_actions::ActionRegistry>());
        assert!(errors[0].is_none());
        assert_eq!(errors[1].as_ref().unwrap().code, "action.not_registered");
        assert_eq!(errors[2].as_ref().unwrap().code, "osc.mapping_conflict");
        assert_eq!(errors[3].as_ref().unwrap().code, "osc.mapping_conflict");
        app.add_message::<OscInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_osc_events);
        for address in ["/control", "/unknown", "/duplicate"] {
            let mut event = test_event(OscType::Int(1));
            event.address = address.into();
            app.world_mut()
                .write_message(OscInput(event, web_time::Instant::now()));
        }
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<ActionInvocation>>()
                .drain()
                .count(),
            1
        );
        assert_eq!(app.world().resource::<OscMappings>().mappings().len(), 4);
        app.world_mut()
            .resource_scope(|world, mut mappings: Mut<OscMappings>| {
                let expected = mappings.mappings()[1].clone();
                let mut repaired = expected.clone();
                repaired.action = mappings.mappings()[0].action.clone();
                mappings
                    .store_mapping(
                        Some(&expected),
                        repaired,
                        world.resource::<nightfall_actions::ActionRegistry>(),
                    )
                    .unwrap();
            });
        app.world_mut()
            .resource_mut::<OscMappings>()
            .delete_mapping(3);
        let errors = app
            .world()
            .resource::<OscMappings>()
            .validation_errors(app.world().resource::<nightfall_actions::ActionRegistry>());
        assert!(errors[2].is_none());
    }

    /// Supplies independent action contracts for transport-only input tests.
    fn register_input_test_actions(app: &mut App) {
        use nightfall_actions::{
            ActionDescriptor, ActionInputKind, ActionRegistry, InvocationDispatch,
        };
        let mappings = app.world().resource::<OscMappings>().mappings().to_vec();
        app.init_resource::<ActionRegistry>();
        for mapping in mappings {
            let kind = if matches!(mapping.input, command::OscBindingInput::Continuous { .. }) {
                ActionInputKind::Scalar
            } else {
                ActionInputKind::Trigger
            };
            if app
                .world()
                .resource::<ActionRegistry>()
                .get(&mapping.action.id)
                .is_none()
            {
                app.world_mut()
                    .resource_mut::<ActionRegistry>()
                    .register::<serde_json::Value, _>(
                        ActionDescriptor {
                            id: mapping.action.id,
                            label: "Input test".into(),
                            capabilities: vec![],
                            allowed_surfaces: vec![ActionSurface::Osc],
                            input_kind: kind,
                            argument_schema: serde_json::json!({}),
                        },
                        |_, _, _| Ok(InvocationDispatch::succeeded()),
                    );
            }
        }
    }
    use crate::command::{OscMapping, OscType};

    /// Packet receipt time survives the ECS bridge and preserves held-before-learning intent.
    #[test]
    fn raw_queue_preserves_learning_start_boundary() {
        use nightfall_engine::controller_learning::{
            ControllerLearning, ControllerLearningCommand, LearnedGesture,
        };
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        app.init_resource::<OscMappings>();
        app.init_resource::<LastOscEvent>();
        app.init_resource::<OscSources>();
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        app.insert_resource(OscEventReceiver(receiver));
        app.add_message::<OscInput>();
        app.add_message::<ActionInvocation>();
        register_input_test_actions(&mut app);
        app.add_systems(
            Update,
            (osc_event_system, handle_osc_events)
                .chain()
                .in_set(InputHandling),
        );
        sender
            .send(RawOscEvent {
                received_at: web_time::Instant::now() - std::time::Duration::from_secs(1),
                source: "127.0.0.1:9000".into(),
                address: "/button".into(),
                args: vec![OscType::Int(1)],
            })
            .unwrap();
        let session_id = uuid::Uuid::new_v4();
        let begin = CommandEnvelope::new(
            ControllerLearningCommand::Begin {
                session_id,
                surface: ActionSurface::Osc,
            },
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&begin)
            .unwrap();
        app.world_mut().write_message(begin);
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Osc)
                .unwrap_err()
                .code,
            "mapping.source_required"
        );
        sender
            .send(RawOscEvent {
                received_at: web_time::Instant::now(),
                source: "127.0.0.1:9000".into(),
                address: "/button".into(),
                args: vec![OscType::Int(0)],
            })
            .unwrap();
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Osc)
                .unwrap()
                .gesture,
            LearnedGesture::Release
        );
    }

    /// Creates a generic registered-action mapping used by focused OSC tests.
    fn test_mapping() -> OscMapping {
        OscMapping {
            source: None,
            address: "/control".to_string(),
            id: uuid::Uuid::new_v4(),
            input: crate::command::OscBindingInput::Pulse,
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
        app.init_resource::<nightfall_actions::ActionRegistry>();
        app.world_mut()
            .resource_mut::<nightfall_actions::ActionRegistry>()
            .register::<serde_json::Value, _>(
                nightfall_actions::ActionDescriptor {
                    id: nightfall_actions::ActionId::new("test.eval"),
                    capabilities: Vec::new(),
                    label: "Test action".into(),
                    allowed_surfaces: vec![ActionSurface::Osc],
                    input_kind: nightfall_actions::ActionInputKind::Trigger,
                    argument_schema: serde_json::json!({ "type": "object" }),
                },
                |_, _, _| Ok(nightfall_actions::InvocationDispatch::succeeded()),
            );
        app.init_resource::<nightfall_engine::controller_learning::ControllerLearning>();
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

    /// Exercises the real input system without opening a UDP listener.
    fn dispatch_inputs(input: command::OscBindingInput, values: Vec<OscType>) -> Vec<ActionInput> {
        dispatch_events(input, values.into_iter().map(test_event).collect())
    }

    /// Dispatches a sequence of independently addressed packets through the real input system.
    fn dispatch_events(
        input: command::OscBindingInput,
        events: Vec<OscLastEvent>,
    ) -> Vec<ActionInput> {
        let mut app = App::new();
        let mut mapping = test_mapping();
        mapping.input = input;
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![mapping]);
        app.insert_resource(mappings);
        app.init_resource::<nightfall_engine::controller_learning::ControllerLearning>();
        app.add_message::<OscInput>();
        app.add_message::<ActionInvocation>();
        register_input_test_actions(&mut app);
        app.add_systems(Update, handle_osc_events);
        for event in events {
            app.world_mut()
                .write_message(OscInput(event, web_time::Instant::now()));
        }
        app.update();
        app.world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| invocation.input)
            .collect()
    }

    /// A numeric learning gesture cannot release-trigger an action afterward, but faders resume at zero.
    #[test]
    fn numeric_learning_tail_filters_triggers_only() {
        use nightfall_engine::controller_learning::{
            ControllerLearning, ControllerLearningCommand,
        };
        for input in [
            command::OscBindingInput::Release,
            command::OscBindingInput::Continuous {
                minimum: 0.0,
                maximum: 1.0,
            },
        ] {
            let mut app = App::new();
            app.add_plugins(EnginePlugin);
            app.init_resource::<PendingCommandBuffer>();
            app.add_plugins(ClientBridgePlugin);
            let mut mappings = OscMappings::new();
            let mut mapping = test_mapping();
            mapping.input = input.clone();
            mappings.set_mappings(vec![mapping]);
            app.insert_resource(mappings);
            app.add_message::<OscInput>();
            app.add_message::<ActionInvocation>();
            register_input_test_actions(&mut app);
            app.add_systems(Update, handle_osc_events);
            let session_id = uuid::Uuid::new_v4();
            let begin = CommandEnvelope::new(
                ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Osc,
                },
                CommandOrigin::WebUi,
                ReplyTarget::Detached,
            );
            app.world_mut()
                .resource_mut::<CommandTracker>()
                .register(&begin)
                .unwrap();
            app.world_mut().write_message(begin);
            app.update();
            app.world_mut().write_message(OscInput(
                test_event(OscType::Int(1)),
                web_time::Instant::now(),
            ));
            app.update();
            assert!(
                app.world_mut()
                    .resource_mut::<Messages<ActionInvocation>>()
                    .drain()
                    .next()
                    .is_none()
            );
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .complete_with_binding(session_id, ActionSurface::Osc, |_| Ok(()))
                .unwrap();
            for (value, trigger_count) in [(0, 0), (1, 0), (0, 1)] {
                app.world_mut().write_message(OscInput(
                    test_event(OscType::Int(value)),
                    web_time::Instant::now(),
                ));
                app.update();
                let inputs: Vec<_> = app
                    .world_mut()
                    .resource_mut::<Messages<ActionInvocation>>()
                    .drain()
                    .map(|invocation| invocation.input)
                    .collect();
                if matches!(input, command::OscBindingInput::Continuous { .. }) {
                    assert_eq!(inputs, vec![ActionInput::Scalar(value as f32)]);
                } else {
                    assert_eq!(inputs.len(), trigger_count);
                }
            }
        }
    }

    /// Numeric encodings use the saved range consistently and reject nonfinite samples.
    #[test]
    fn scalar_dispatch_uses_explicit_range() {
        let values = dispatch_inputs(
            command::OscBindingInput::Continuous {
                minimum: 0.0,
                maximum: 127.0,
            },
            vec![
                OscType::Int(1),
                OscType::Double(1.0),
                OscType::Float(127.0),
                OscType::Long("254".into()),
                OscType::Float(f32::NAN),
            ],
        );
        assert_eq!(
            values,
            vec![
                ActionInput::Scalar(1.0 / 127.0),
                ActionInput::Scalar(1.0 / 127.0),
                ActionInput::Scalar(1.0),
                ActionInput::Scalar(1.0)
            ]
        );
    }

    /// Unsupported samples cannot occupy the learn slot ahead of a usable control.
    #[test]
    fn learning_recognizes_only_usable_controls() {
        use nightfall_engine::controller_learning::LearnedGesture;

        for value in [
            OscType::String("status".into()),
            OscType::Float(f32::NAN),
            OscType::Double(f64::INFINITY),
            OscType::Long("invalid".into()),
        ] {
            assert!(learned_source(&test_event(value)).is_none());
        }
        for (value, gesture) in [
            (OscType::Int(1), LearnedGesture::Continuous),
            (OscType::Float(0.25), LearnedGesture::Continuous),
            (OscType::Bool(true), LearnedGesture::Press),
            (OscType::Bool(false), LearnedGesture::Release),
        ] {
            assert_eq!(learned_source(&test_event(value)).unwrap().gesture, gesture);
        }
        let mut pulse = test_event(OscType::Int(0));
        pulse.args.clear();
        assert_eq!(
            learned_source(&pulse).unwrap().gesture,
            LearnedGesture::Pulse
        );
    }

    /// Existing explicit pulse bindings can still use nonnumeric OSC messages.
    #[test]
    fn pulse_dispatch_accepts_nonlearnable_arguments() {
        assert_eq!(
            dispatch_inputs(
                command::OscBindingInput::Pulse,
                vec![OscType::String("go".into())],
            ),
            vec![ActionInput::Trigger]
        );
    }

    /// A manually mapped string pulse is consumed while learning awaits a usable source.
    #[test]
    fn unsupported_learning_input_does_not_dispatch_existing_pulse() {
        use nightfall_engine::controller_learning::{
            ControllerLearning, ControllerLearningCommand,
        };
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        let mut mappings = OscMappings::new();
        let mut mapping = test_mapping();
        mapping.input = command::OscBindingInput::Pulse;
        mappings.set_mappings(vec![mapping]);
        app.insert_resource(mappings);
        app.add_message::<OscInput>();
        app.add_message::<ActionInvocation>();
        register_input_test_actions(&mut app);
        app.add_systems(Update, handle_osc_events);
        let session_id = uuid::Uuid::new_v4();
        let begin = CommandEnvelope::new(
            ControllerLearningCommand::Begin {
                session_id,
                surface: ActionSurface::Osc,
            },
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&begin)
            .unwrap();
        app.world_mut().write_message(begin);
        app.update();
        app.world_mut().write_message(OscInput(
            test_event(OscType::String("go".into())),
            web_time::Instant::now(),
        ));
        app.update();
        assert!(
            app.world_mut()
                .resource_mut::<Messages<ActionInvocation>>()
                .drain()
                .next()
                .is_none()
        );
        assert!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Osc)
                .is_err()
        );
        app.world_mut().write_message(OscInput(
            test_event(OscType::Int(1)),
            web_time::Instant::now(),
        ));
        app.update();
        assert!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .captured(session_id, ActionSurface::Osc)
                .is_ok()
        );
        assert!(
            app.world_mut()
                .resource_mut::<Messages<ActionInvocation>>()
                .drain()
                .next()
                .is_none()
        );
    }

    /// Repeated button packets and opposite edges do not cause duplicate triggers.
    #[test]
    fn button_dispatch_retains_only_selected_edges() {
        for input in [
            command::OscBindingInput::Press,
            command::OscBindingInput::Release,
        ] {
            let values = dispatch_inputs(
                input,
                vec![
                    OscType::Bool(true),
                    OscType::Bool(true),
                    OscType::Bool(false),
                    OscType::Bool(false),
                    OscType::Bool(true),
                    OscType::Bool(false),
                ],
            );
            assert_eq!(values, vec![ActionInput::Trigger, ActionInput::Trigger]);
        }
    }

    /// Wildcard bindings accept each sender's edges independently, including interleaved packets.
    #[test]
    fn button_history_is_scoped_to_sender() {
        for input in [
            command::OscBindingInput::Press,
            command::OscBindingInput::Release,
        ] {
            let events = [
                (9000, true),
                (9001, true),
                (9000, false),
                (9001, true),
                (9001, false),
                (9000, false),
            ]
            .into_iter()
            .map(|(port, active)| {
                let mut event = test_event(OscType::Bool(active));
                event.source = format!("127.0.0.1:{port}");
                event
            })
            .collect();
            assert_eq!(
                dispatch_events(input, events),
                vec![ActionInput::Trigger, ActionInput::Trigger]
            );
        }
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

    /// A deleted domain target rejects edits atomically but does not prevent removing the binding.
    #[test]
    fn unavailable_domain_target_rejects_save_without_changing_mapping() {
        let mut app = osc_command_app();
        let original = test_mapping();
        submit_command(
            &mut app,
            OscCommand::StoreMapping {
                expected: None,
                mapping: original.clone(),
            },
        );
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        app.world_mut()
            .resource_mut::<nightfall_actions::ActionRegistry>()
            .register_target_validator::<serde_json::Value, _>("test.eval", |_, _| {
                Err(nightfall_actions::InvocationError::new(
                    "test.target_missing",
                    "Target was deleted",
                ))
            });
        let mut edited = original.clone();
        edited.address = "/changed".into();
        submit_command(
            &mut app,
            OscCommand::StoreMapping {
                expected: Some(original.clone()),
                mapping: edited,
            },
        );
        app.update();
        assert!(matches!(take_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "test.target_missing"));
        assert_eq!(
            app.world().resource::<OscMappings>().mappings(),
            &[original.clone()]
        );
        submit_command(&mut app, OscCommand::RemoveMapping { expected: original });
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        assert!(app.world().resource::<OscMappings>().mappings().is_empty());
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
