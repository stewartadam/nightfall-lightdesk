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
    ActionInvocation, ActionRegistry, ActionSurface, ActionsPlugin, BindingDiagnostic,
    ControllerMappingMode, ExternalCommandInvocation, InvocationError, SourceEdgeStates,
    bindings_need_diagnosis, collect_binding_diagnostics,
};
use nightfall_engine::prelude::*;
use tokio::sync::mpsc::UnboundedReceiver;

pub mod command;
pub mod mapping;
mod osc;
mod service;
mod websocket;

use command::{OscCommand, OscExternalEval, OscLastEvent, OscListenerStatus, OscMapping};
use mapping::OscMappings;
use osc::RawOscEvent;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::command::{
        OscCommand, OscExternalEval, OscLastEvent, OscListenerStatus, OscMapping, OscType,
    };
    pub use crate::mapping::OscMappings;
    pub use crate::websocket::{OscSource, OscWsMessage};
    pub use crate::{InputOscPlugin, OscMappingDiagnostics};
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
        let waker = app.world().get_resource::<FrameWaker>().cloned();
        let osc_rx = osc_service.client().subscribe(waker).unwrap_or_else(|| {
            let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawOscEvent>();
            rx
        });

        app.insert_resource(OscEventReceiver(osc_rx));
        app.insert_resource(OscRuntimeStatus(status));
        app.init_resource::<OscMappings>();
        app.init_resource::<LastOscEvent>();
        app.init_resource::<OscSources>();
        app.init_resource::<OscControlTouches>();
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
        app.init_resource::<OscMappingDiagnostics>();
        app.add_systems(
            Render,
            (
                refresh_osc_mapping_diagnostics.run_if(bindings_need_diagnosis::<OscMappings>),
                websocket::send_osc_state,
            )
                .chain()
                .in_set(ClientOutput),
        );
        app.add_systems(
            PostUpdate,
            websocket::send_external_evals.in_set(ClientFeedback),
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

/// Most messages one frame reports as touches while controller mapping mode is active.
const MAX_TOUCHES_PER_FRAME: usize = 64;

/// Messages received this frame while controller mapping mode is active.
///
/// Published reliably so a mapping client can arm the touched address and learn its press
/// and release values even when the droppable last-event telemetry is coalesced or dropped
/// under load. A message repeating an address and first argument already recorded this
/// frame is omitted, so a fader sweep does not flood clients.
#[derive(Resource, Default, Debug)]
pub(crate) struct OscControlTouches(pub(crate) Vec<OscLastEvent>);

impl OscControlTouches {
    /// Records one message unless the same address and first argument was already recorded.
    fn record(&mut self, event: &OscLastEvent) {
        let repeated = self.0.iter().any(|touch| {
            touch.address == event.address && touch.args.first() == event.args.first()
        });
        if !repeated && self.0.len() < MAX_TOUCHES_PER_FRAME {
            self.0.push(event.clone());
        }
    }
}

/// Drains received OSC packets into telemetry, known sources, and mapping dispatch input.
///
/// While controller mapping mode is active, messages are also recorded as touches for
/// reliable delivery to mapping clients.
fn osc_event_system(
    mut osc_rx: ResMut<OscEventReceiver>,
    mut last_event: ResMut<LastOscEvent>,
    mut sources: ResMut<OscSources>,
    mapping_mode: Res<ControllerMappingMode>,
    mut touches: ResMut<OscControlTouches>,
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

        if mapping_mode.is_active() {
            touches.record(&osc_event);
        }
        last_event.0 = Some(osc_event.clone());
        event_writer.write(OscInput(osc_event));
    }
}

/// Invokes the action bound to each matching OSC message, adapted to its input kind and
/// behavior.
///
/// While controller mapping mode is active, input is suppressed as described by
/// [`SourceEdgeStates`]: nothing new fires, but releases completing live presses still do.
fn handle_osc_events(
    mut events: MessageReader<OscInput>,
    mappings: Res<OscMappings>,
    registry: Res<ActionRegistry>,
    mapping_mode: Res<ControllerMappingMode>,
    mut edges: ResMut<SourceEdgeStates>,
    mut invocations: MessageWriter<ActionInvocation>,
) {
    let suppressed = mapping_mode.is_active();
    for event in events.read() {
        let osc_event = &event.0;
        for mapping in mappings.lookup(osc_event) {
            let Some((action, input)) = edges.resolve(
                &registry,
                mapping.id,
                &mapping.action,
                mapping.behavior,
                mapping.signal(osc_event),
                suppressed,
            ) else {
                continue;
            };
            invocations.write(
                ActionInvocation::new(action, ActionSurface::Osc, input)
                    .with_source(format!("OSC {}", osc_event.source)),
            );
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
            correlation_id: invocation.command_id.into(),
            command: invocation.command.clone(),
            source: invocation.source.clone(),
        });
    }
}

/// Mappings that cannot currently invoke their action, in mapping order.
///
/// Invalid mappings stay stored; these diagnostics tell the operator which ones will fail.
#[derive(Resource, Default, Debug, PartialEq)]
pub struct OscMappingDiagnostics(pub Vec<BindingDiagnostic>);

/// Validates one stored OSC mapping against the registry and the current world.
///
/// Checks the action, its arguments, whether the mapping's source can drive the action and
/// its behavior, and that the action's targets exist.
fn diagnose_osc_mapping(
    registry: &ActionRegistry,
    world: &World,
    mapping: &OscMapping,
) -> Result<(), InvocationError> {
    registry
        .validate_binding(&mapping.action, ActionSurface::Osc, |kind| {
            mapping.can_drive(kind)
        })
        .and_then(|()| {
            registry.validate_behavior(&mapping.action, mapping.behavior, mapping.reports_release())
        })
        .and_then(|()| registry.validate_target(world, &mapping.action))
}

/// Recomputes OSC mapping diagnostics after mappings, registrations, or targets changed.
///
/// The diagnostics resource is only written when the result differs, so clients are
/// notified only when a mapping becomes invalid or recovers.
fn refresh_osc_mapping_diagnostics(world: &mut World) {
    let diagnostics = {
        let registry = world.resource::<ActionRegistry>();
        collect_binding_diagnostics(
            world
                .resource::<OscMappings>()
                .mappings()
                .iter()
                .map(|mapping| (mapping.id, diagnose_osc_mapping(registry, world, mapping))),
        )
    };
    world
        .resource_mut::<OscMappingDiagnostics>()
        .set_if_neq(OscMappingDiagnostics(diagnostics));
}

/// Applies tracked OSC mapping CRUD commands and reports their terminal outcomes.
fn handle_osc_crud(
    mut events: MessageReader<CommandEnvelope<OscCommand>>,
    mut mappings: ResMut<OscMappings>,
    registry: Res<ActionRegistry>,
    mut edges: ResMut<SourceEdgeStates>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            OscCommand::UpsertMapping(mapping) => {
                match registry
                    .validate_binding(&mapping.action, ActionSurface::Osc, |kind| {
                        mapping.can_drive(kind)
                    })
                    .and_then(|()| {
                        registry.validate_behavior(
                            &mapping.action,
                            mapping.behavior,
                            mapping.reports_release(),
                        )
                    }) {
                    Ok(()) => {
                        edges.forget(mapping.id);
                        let displaced = mappings
                            .upsert(mapping.clone(), |action| registry.input_kind(&action.id));
                        for id in &displaced {
                            edges.forget(*id);
                        }
                        responder.succeed_with_output(
                            event.command_id,
                            &serde_json::json!({ "replaced": displaced }),
                        )
                    }
                    Err(error) => responder.fail(event.command_id, error.into()),
                }
            }
            OscCommand::DeleteMapping(id) => {
                if mappings.delete(*id) {
                    edges.forget(*id);
                    responder.succeed(event.command_id)
                } else {
                    responder.fail(
                        event.command_id,
                        CommandError::new(
                            "osc.mapping_not_found",
                            format!("OSC mapping {id} does not exist"),
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
    use nightfall_actions::SourceSignal;
    use uuid::Uuid;

    use super::*;
    use crate::command::{OscMapping, OscType};

    /// Creates a generic registered-action mapping used by focused OSC tests.
    fn test_mapping() -> OscMapping {
        OscMapping {
            id: Uuid::nil(),
            source: None,
            address: "/control".to_string(),
            arg_index: None,
            arg_value: None,
            release_value: None,
            behavior: nightfall_actions::ControlBehavior::Press,
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
        app.init_resource::<SourceEdgeStates>();
        app.init_resource::<ControllerMappingMode>();
        app.init_resource::<OscControlTouches>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<ActionRegistry>();
        let mut registry = app.world_mut().resource_mut::<ActionRegistry>();
        registry.register::<serde::de::IgnoredAny, _>(
            nightfall_actions::ActionDescriptor::new("test.eval", "Test eval", "Tests"),
            |_world, _arguments, _invocation| Ok(nightfall_actions::InvocationDispatch::succeeded()),
        );
        registry.register::<serde::de::IgnoredAny, _>(
            nightfall_actions::ActionDescriptor::new("test.level", "Test level", "Tests")
                .with_input(nightfall_actions::ActionInputKind::Absolute),
            |_world, _arguments, _invocation| Ok(nightfall_actions::InvocationDispatch::succeeded()),
        );
        registry.register::<serde::de::IgnoredAny, _>(
            nightfall_actions::ActionDescriptor::new("test.timeline", "Timeline only", "Tests")
                .with_surfaces([ActionSurface::Timeline]),
            |_world, _arguments, _invocation| Ok(nightfall_actions::InvocationDispatch::succeeded()),
        );
        app.add_message::<CommandEnvelope<OscCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
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

    /// Verifies a selected numeric argument reads as a normalized level.
    #[test]
    fn selected_numeric_argument_is_a_level() {
        let mapping = OscMapping {
            arg_index: Some(0),
            ..test_mapping()
        };

        assert_eq!(
            mapping.signal(&test_event(OscType::Float(0.5))),
            SourceSignal::Level(0.5)
        );
        assert_eq!(
            mapping.signal(&test_event(OscType::Bool(true))),
            SourceSignal::Button(true)
        );
    }

    /// Verifies value-matching and argument-free mappings treat messages as pulses.
    #[test]
    fn value_filters_and_missing_arguments_are_pulses() {
        let filtered = OscMapping {
            arg_index: Some(0),
            arg_value: Some("1".to_string()),
            ..test_mapping()
        };

        assert_eq!(
            filtered.signal(&test_event(OscType::Int(1))),
            SourceSignal::Pulse
        );
        assert_eq!(
            test_mapping().signal(&test_event(OscType::Float(0.2))),
            SourceSignal::Pulse
        );
        assert!(!test_mapping().can_drive(nightfall_actions::ActionInputKind::Absolute));
    }

    /// Verifies upserting a valid mapping stores it before reporting success.
    #[test]
    fn upsert_mapping_mutates_before_success() {
        let mut app = osc_command_app();
        submit_command(&mut app, OscCommand::UpsertMapping(test_mapping()));
        app.update();
        assert_eq!(app.world().resource::<OscMappings>().mappings().len(), 1);
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Succeeded { .. }
        ));
    }

    /// Verifies loaded mappings that cannot run are kept and diagnosed with their failure.
    #[test]
    fn loaded_invalid_mappings_are_kept_and_diagnosed() {
        let mut app = osc_command_app();
        app.init_resource::<nightfall_actions::ActionTargets>();
        app.init_resource::<OscMappingDiagnostics>();
        app.add_systems(
            Update,
            refresh_osc_mapping_diagnostics.run_if(bindings_need_diagnosis::<OscMappings>),
        );
        let mapping = |id: u128, action: &str| OscMapping {
            id: Uuid::from_u128(id),
            address: format!("/control/{id}"),
            action: nightfall_actions::ActionReference::new(action, serde_json::json!({})),
            ..test_mapping()
        };
        app.world_mut()
            .resource_mut::<OscMappings>()
            .set_mappings(vec![
                mapping(1, "test.eval"),
                mapping(2, "test.timeline"),
                mapping(3, "test.level"),
            ]);

        app.update();

        assert_eq!(app.world().resource::<OscMappings>().mappings().len(), 3);
        let diagnostics = &app.world().resource::<OscMappingDiagnostics>().0;
        assert_eq!(
            diagnostics
                .iter()
                .map(|diagnostic| (diagnostic.binding_id, diagnostic.error.code.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (Uuid::from_u128(2), "action.surface_not_allowed"),
                (Uuid::from_u128(3), "action.input_incompatible"),
            ]
        );

        app.world_mut()
            .resource_mut::<OscMappings>()
            .delete(Uuid::from_u128(2));
        app.update();
        assert_eq!(app.world().resource::<OscMappingDiagnostics>().0.len(), 1);
    }

    /// Verifies an argument-free address cannot be bound to a fader-style action.
    #[test]
    fn upsert_rejects_pulse_source_for_absolute_action() {
        let mut app = osc_command_app();
        let mapping = OscMapping {
            action: nightfall_actions::ActionReference::new("test.level", serde_json::json!({})),
            ..test_mapping()
        };

        submit_command(&mut app, OscCommand::UpsertMapping(mapping));
        app.update();

        assert!(app.world().resource::<OscMappings>().mappings().is_empty());
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "action.input_incompatible"
        ));
    }

    /// Verifies an OSC address cannot be bound to an action restricted to other surfaces.
    #[test]
    fn upsert_rejects_action_disallowed_on_osc() {
        let mut app = osc_command_app();
        let mapping = OscMapping {
            action: nightfall_actions::ActionReference::new("test.timeline", serde_json::json!({})),
            ..test_mapping()
        };

        submit_command(&mut app, OscCommand::UpsertMapping(mapping));
        app.update();

        assert!(app.world().resource::<OscMappings>().mappings().is_empty());
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "action.surface_not_allowed"
        ));
    }

    /// Extends the OSC command app with event dispatch and the supplied mappings.
    fn osc_dispatch_app(mappings: Vec<OscMapping>) -> App {
        let mut app = osc_command_app();
        app.add_message::<OscInput>();
        app.add_message::<ActionInvocation>();
        app.add_systems(Update, handle_osc_events);
        let mut stored = app.world_mut().resource_mut::<OscMappings>();
        for mapping in mappings {
            let kind = if mapping.action.id.as_str() == "test.level" {
                nightfall_actions::ActionInputKind::Absolute
            } else {
                nightfall_actions::ActionInputKind::Trigger
            };
            stored.upsert(mapping, |_| Some(kind));
        }
        app
    }

    /// Sends messages to `/control` and returns the actions they invoked, in order.
    fn send(app: &mut App, args: &[OscType]) -> Vec<(String, nightfall_actions::ActionInput)> {
        for arg in args {
            app.world_mut()
                .write_message(OscInput(test_event(arg.clone())));
        }
        app.update();
        app.world_mut()
            .resource_mut::<Messages<ActionInvocation>>()
            .drain()
            .map(|invocation| (invocation.action.id.as_str().to_string(), invocation.input))
            .collect()
    }

    /// Sets whether one client holds controller mapping mode.
    fn set_mapping_mode(app: &mut App, active: bool) {
        let mut mode = app.world_mut().resource_mut::<ControllerMappingMode>();
        if active {
            mode.enter(ClientId(1));
        } else {
            mode.leave(ClientId(1));
        }
    }

    /// Verifies mapped OSC triggers and faders fire nothing while mapping mode is active.
    #[test]
    fn mapping_mode_suppresses_osc_actions() {
        let fader = OscMapping {
            id: Uuid::from_u128(2),
            arg_index: Some(0),
            action: nightfall_actions::ActionReference::new("test.level", serde_json::json!({})),
            ..test_mapping()
        };
        let mut app = osc_dispatch_app(vec![fader]);
        set_mapping_mode(&mut app, true);

        assert!(send(&mut app, &[OscType::Float(0.4), OscType::Float(0.8)]).is_empty());

        set_mapping_mode(&mut app, false);
        assert_eq!(
            send(&mut app, &[OscType::Float(0.3)]),
            vec![(
                "test.level".to_string(),
                nightfall_actions::ActionInput::Scalar(0.3)
            )]
        );
    }

    /// Verifies an OSC button pressed in mapping mode does not fire its release binding when
    /// released after mapping mode ends.
    #[test]
    fn osc_release_after_mapping_mode_is_swallowed() {
        let release = OscMapping {
            id: Uuid::from_u128(3),
            arg_index: Some(0),
            behavior: nightfall_actions::ControlBehavior::Release,
            ..test_mapping()
        };
        let mut app = osc_dispatch_app(vec![release]);
        set_mapping_mode(&mut app, true);
        assert!(send(&mut app, &[OscType::Float(1.0)]).is_empty());

        set_mapping_mode(&mut app, false);
        assert!(send(&mut app, &[OscType::Float(0.0)]).is_empty());
        assert_eq!(
            send(&mut app, &[OscType::Float(1.0), OscType::Float(0.0)]),
            vec![(
                "test.eval".to_string(),
                nightfall_actions::ActionInput::Trigger
            )]
        );
    }

    /// Verifies touches skip repeated values on an address but keep press and release.
    #[test]
    fn touches_keep_distinct_values_per_address() {
        let mut touches = OscControlTouches::default();
        for arg in [
            OscType::Float(1.0),
            OscType::Float(1.0),
            OscType::Float(0.0),
            OscType::Float(1.0),
        ] {
            touches.record(&test_event(arg));
        }

        assert_eq!(
            touches
                .0
                .iter()
                .map(|touch| touch.args[0].clone())
                .collect::<Vec<_>>(),
            vec![OscType::Float(1.0), OscType::Float(0.0)]
        );
    }

    /// Verifies deleting an unknown OSC mapping returns a stable failure.
    #[test]
    fn delete_unknown_mapping_returns_failure() {
        let mut app = osc_command_app();
        submit_command(
            &mut app,
            OscCommand::DeleteMapping(uuid::Uuid::from_u128(4)),
        );
        app.update();
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "osc.mapping_not_found"
        ));
    }
}
