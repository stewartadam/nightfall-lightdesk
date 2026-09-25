// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bindable actions: named, described entry points that automation surfaces invoke.
//!
//! Domain plugins register actions with [`ActionAppExt`]. Discrete actions lower to tracked
//! ingress commands and continuous actions lower to untracked update messages, so an action
//! never introduces a second execution path next to commands, updates, and engine operations.

mod command;
mod descriptor;
mod eval;
mod failures;
mod flash;
mod invocation;
mod lowering;
mod registry;
mod source;
pub mod websocket;

use bevy_app::{App, Plugin, PostUpdate, Update};
use bevy_ecs::{
    prelude::{MessageReader, Messages, SystemSet, World},
    schedule::IntoScheduleConfigs,
    system::SystemState,
};
pub use command::ActionCommand;
pub use descriptor::{
    ActionCatalogEntry, ActionDescriptor, ActionId, ActionInputKind, ActionParameter,
    ActionParameterKind, ActionSurface,
};
pub use eval::{DESK_EVAL_ACTION_ID, DeskEvalActionArguments, desk_eval_action};
pub use failures::{FAILURE_REPEAT_WINDOW, InvocationFailureThrottle};
pub use invocation::{
    ActionInput, ActionInvocation, ActionInvocationFailure, ActionReference,
    ClientActionInvocation, ExternalCommandInvocation, InvocationDispatch, InvocationError,
    InvocationId, InvocationOutcome, InvocationResult,
};
pub use lowering::{ActionAppExt, submit_command};
use nightfall_engine::prelude::{
    ClientFeedback, CommandDeserializerRegistry, CommandIngressRouter, EventHandling,
    InputHandling, PendingCommandExpansion, ResyncHandling, ResyncRequested,
    register_command_deserializer, register_ingress_command,
};
pub use registry::{ActionRegistry, CLIENT_ACTION_PREFIX, is_client_action};
pub use source::{BindingTarget, ControlBehavior, SourceEdgeStates, SourceSignal};

/// Plugin that installs the generic registered-action invocation stage.
pub struct ActionsPlugin;

/// System set that resolves action invocations before domain event handling.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActionInvocationHandling;

impl Plugin for ActionsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ActionRegistry>();
        app.init_resource::<SourceEdgeStates>();
        app.init_resource::<InvocationFailureThrottle>();
        app.add_message::<ActionInvocation>();
        app.add_message::<InvocationResult>();
        app.add_message::<ActionInvocationFailure>();
        app.add_message::<ExternalCommandInvocation>();
        app.add_message::<ClientActionInvocation>();
        app.add_message::<ResyncRequested>();
        app.configure_sets(
            Update,
            ActionInvocationHandling
                .after(InputHandling)
                .before(PendingCommandExpansion),
        );
        app.add_systems(
            Update,
            dispatch_action_invocations.in_set(ActionInvocationHandling),
        );
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
        // Client publications run in ClientFeedback so they pause while a staged world is swapped in.
        app.add_systems(
            PostUpdate,
            (
                websocket::send_action_catalog_on_change,
                websocket::send_client_action_invocations,
                websocket::send_action_invocation_failures,
            )
                .in_set(ClientFeedback),
        );
        // Client invoke commands need the engine's command routing, which focused test apps
        // without the engine and client bridge plugins do not have.
        if app.world().contains_resource::<CommandIngressRouter>()
            && app
                .world()
                .contains_resource::<CommandDeserializerRegistry>()
        {
            register_ingress_command::<ActionCommand>(app);
            register_command_deserializer::<ActionCommand>(
                app,
                command::deserialize_action_command,
            );
            app.add_systems(
                Update,
                command::handle_action_commands.in_set(EventHandling),
            );
        }
    }
}

/// Dispatches queued invocations and publishes their immediate outcome.
///
/// Failures admitted by the [`InvocationFailureThrottle`] are also written as
/// [`ActionInvocationFailure`] messages for clients, and invocations requested by a client
/// command finish that command with their outcome.
pub fn dispatch_action_invocations(
    world: &mut World,
    state: &mut SystemState<MessageReader<ActionInvocation>>,
) {
    let invocations = {
        let mut reader = state
            .get_mut(world)
            .expect("action invocation reader should be available");
        reader.read().cloned().collect::<Vec<_>>()
    };
    if invocations.is_empty() {
        return;
    }
    let now = web_time::Instant::now();
    for invocation in invocations {
        let outcome: InvocationOutcome = world
            .resource_scope(
                |world, registry: bevy_ecs::change_detection::Mut<ActionRegistry>| {
                    registry.invoke(world, &invocation)
                },
            )
            .into();
        let publish =
            world
                .resource_mut::<InvocationFailureThrottle>()
                .admit(&invocation, &outcome, now);
        if let InvocationOutcome::Failed(error) = &outcome {
            report_failure(world, &invocation, error, publish);
        }
        if let Some(command_id) = invocation.completes_command {
            command::complete_invoke_command(world, command_id, &outcome);
        }
        world
            .resource_mut::<Messages<InvocationResult>>()
            .write(InvocationResult {
                invocation_id: invocation.invocation_id,
                action_id: invocation.action.id,
                surface: invocation.surface,
                outcome,
            });
    }
}

/// Logs one invocation failure and, when admitted, writes it for client publication.
///
/// Failures suppressed by the throttle are logged at debug level so repeated fader input
/// neither floods clients nor the log.
fn report_failure(
    world: &mut World,
    invocation: &ActionInvocation,
    error: &InvocationError,
    publish: bool,
) {
    if !publish {
        tracing::debug!(
            action_id = invocation.action.id.as_str(),
            surface = ?invocation.surface,
            code = %error.code,
            "action_invocation_failure_suppressed"
        );
        return;
    }
    tracing::warn!(
        action_id = invocation.action.id.as_str(),
        surface = ?invocation.surface,
        code = %error.code,
        message = %error.message,
        "action_invocation_failed"
    );
    world.write_message(ActionInvocationFailure {
        invocation_id: invocation.invocation_id,
        action: invocation.action.clone(),
        surface: invocation.surface,
        source: invocation.source_label(),
        input: invocation.input,
        error: error.clone(),
        command_id: invocation.completes_command,
    });
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::Message;
    use nightfall_engine::prelude::{
        CommandError, CommandId, CommandOrigin, CommandOutcome, CommandOutput, CommandReply,
        CommandResult, CommandTracker, EnginePayload, FinishedCommand, IngressCommand,
        PendingCommandBuffer, ReplyTarget, UndoId,
    };
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    /// Arguments decoded only by the test action registrations.
    #[derive(Deserialize)]
    struct TestArguments {
        value: u32,
    }

    /// Deterministic interpretation exposed independently of live invocation.
    #[derive(Debug, PartialEq, Eq)]
    struct TestCapability(u32);

    /// Message proving a registered invoker or update lowering reached domain-owned behavior.
    #[derive(Clone, Debug, Message, PartialEq)]
    struct TestApplied(f32);

    /// Ingress command produced by the test command lowering.
    #[derive(Clone, Debug, PartialEq)]
    struct TestCommand(u32);

    impl EnginePayload for TestCommand {}
    impl IngressCommand for TestCommand {}

    /// Creates an app with the invocation stage and lowering prerequisites.
    fn action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.add_message::<TestApplied>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
        app
    }

    /// Registers a direct trigger action with a deterministic capability.
    fn register_trigger_action(app: &mut App) {
        app.register_action::<TestArguments, _>(
            ActionDescriptor::new("test.apply", "Apply test action", "Tests"),
            |world, arguments, _invocation| {
                world.write_message(TestApplied(arguments.value as f32));
                Ok(InvocationDispatch::succeeded())
            },
        )
        .register_action_capability::<TestArguments, TestCapability, _>(
            "test.apply",
            "test.capability",
            |arguments| Ok(TestCapability(arguments.value)),
        );
    }

    /// Writes one invocation, runs a frame, and returns the published outcome.
    fn invoke(app: &mut App, invocation: ActionInvocation) -> InvocationOutcome {
        app.world_mut().write_message(invocation);
        app.update();
        app.world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("invocation should publish a result")
            .outcome
    }

    /// Drains test domain messages written by invokers and update lowerings.
    fn applied(app: &mut App) -> Vec<TestApplied> {
        app.world_mut()
            .resource_mut::<Messages<TestApplied>>()
            .drain()
            .collect()
    }

    /// Verifies deterministic capability resolution does not invoke live domain behavior.
    #[test]
    fn registered_capability_resolves_without_live_invocation() {
        let mut app = action_app();
        register_trigger_action(&mut app);
        let action = ActionReference::new("test.apply", json!({ "value": 42 }));

        let capability = app
            .world()
            .resource::<ActionRegistry>()
            .resolve_capability::<TestCapability>(&action)
            .expect("valid arguments should resolve")
            .expect("test action should expose its deterministic capability");

        assert_eq!(capability, TestCapability(42));
        assert!(applied(&mut app).is_empty());
    }

    /// Verifies the catalog publishes descriptors with their capability names.
    #[test]
    fn catalog_lists_descriptor_capabilities() {
        let mut app = action_app();
        register_trigger_action(&mut app);

        let catalog = app.world().resource::<ActionRegistry>().catalog();

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].descriptor.id.as_str(), "test.apply");
        assert_eq!(catalog[0].capabilities, vec!["test.capability".to_string()]);
    }

    /// Verifies a surface invokes registered domain behavior through opaque arguments.
    #[test]
    fn registered_action_dispatches_to_owning_domain() {
        let mut app = action_app();
        register_trigger_action(&mut app);

        let outcome = invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.apply", json!({ "value": 42 })),
                ActionSurface::Midi,
            ),
        );

        assert_eq!(applied(&mut app), vec![TestApplied(42.0)]);
        assert_eq!(outcome, InvocationOutcome::Succeeded { output: None });
    }

    /// Verifies a button press fires a trigger action and its release is ignored.
    #[test]
    fn trigger_action_fires_on_press_and_ignores_release() {
        let mut app = action_app();
        register_trigger_action(&mut app);
        let action = ActionReference::new("test.apply", json!({ "value": 1 }));

        let pressed = invoke(
            &mut app,
            ActionInvocation::new(action.clone(), ActionSurface::Midi, ActionInput::Press),
        );
        let released = invoke(
            &mut app,
            ActionInvocation::new(action, ActionSurface::Midi, ActionInput::Release),
        );

        assert_eq!(pressed, InvocationOutcome::Succeeded { output: None });
        assert_eq!(released, InvocationOutcome::Ignored);
        assert_eq!(applied(&mut app), vec![TestApplied(1.0)]);
    }

    /// Verifies continuous input cannot drive a trigger action.
    #[test]
    fn trigger_action_rejects_scalar_input() {
        let mut app = action_app();
        register_trigger_action(&mut app);

        let outcome = invoke(
            &mut app,
            ActionInvocation::scalar(
                ActionReference::new("test.apply", json!({ "value": 1 })),
                ActionSurface::Osc,
                0.5,
            ),
        );

        assert!(matches!(
            outcome,
            InvocationOutcome::Failed(InvocationError { ref code, .. })
                if code == "action.input_mismatch"
        ));
        assert!(applied(&mut app).is_empty());
    }

    /// Verifies malformed domain arguments produce a structured registry failure.
    #[test]
    fn registered_action_rejects_invalid_arguments() {
        let mut app = action_app();
        register_trigger_action(&mut app);

        let outcome = invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.apply", json!({ "wrong": true })),
                ActionSurface::Midi,
            ),
        );

        assert!(matches!(
            outcome,
            InvocationOutcome::Failed(InvocationError { ref code, .. })
                if code == "action.invalid_arguments"
        ));
    }

    /// Verifies command actions submit tracked commands under an automation origin.
    #[test]
    fn command_action_submits_tracked_command() {
        let mut app = action_app();
        app.register_command_action::<TestArguments, TestCommand, _>(
            ActionDescriptor::new("test.command", "Test command", "Tests"),
            |_world, arguments| Ok(TestCommand(arguments.value)),
        );

        let outcome = invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.command", json!({ "value": 7 })),
                ActionSurface::Osc,
            )
            .with_source("OSC 127.0.0.1:9000"),
        );

        let InvocationOutcome::Submitted { command_id } = outcome else {
            panic!("command action should report its submitted command, got {outcome:?}");
        };
        let pending = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain();
        let [envelope] = pending.as_slice() else {
            panic!("command action should queue exactly one command");
        };
        assert_eq!(envelope.command_id, command_id);
        assert_eq!(
            envelope.payload.as_any().downcast_ref::<TestCommand>(),
            Some(&TestCommand(7))
        );
        let tracker = app.world().resource::<CommandTracker>();
        let active = tracker
            .active_command(command_id)
            .expect("submitted command should be tracked");
        assert_eq!(
            active.origin,
            CommandOrigin::Automation {
                surface: "OSC".to_string(),
                source: Some("OSC 127.0.0.1:9000".to_string()),
            }
        );
    }

    /// Level read back by the test flash registration.
    #[derive(bevy_ecs::prelude::Resource)]
    struct TestLevel(f32);

    /// Verifies flashing pushes an absolute action to full and restores the level read on press.
    #[test]
    fn flash_pushes_to_full_and_restores_on_release() {
        let mut app = action_app();
        app.insert_resource(TestLevel(0.4));
        app.register_update_action::<TestArguments, TestApplied, _>(
            ActionDescriptor::new("test.level", "Test level", "Tests")
                .with_input(ActionInputKind::Absolute),
            |_world, _arguments, value| Ok(TestApplied(value)),
        )
        .register_flash_level::<TestArguments, _>("test.level", |world, _arguments| {
            Ok(Some(world.resource::<TestLevel>().0))
        });
        let action = ActionReference::new("test.level", json!({ "value": 1 }));

        for input in [ActionInput::Press, ActionInput::Release] {
            invoke(
                &mut app,
                ActionInvocation::new(action.clone(), ActionSurface::Midi, input),
            );
        }

        assert_eq!(applied(&mut app), vec![TestApplied(1.0), TestApplied(0.4)]);
        let registry = app.world().resource::<ActionRegistry>();
        assert_eq!(
            registry.behaviors(&ActionId::new("test.level")),
            vec![ControlBehavior::Press, ControlBehavior::Flash]
        );
    }

    /// Verifies triggers with a release counterpart support Hold and resolve the counterpart.
    #[test]
    fn hold_release_counterpart_keeps_the_bound_arguments() {
        let mut app = action_app();
        for (id, release) in [("test.start", Some("test.stop")), ("test.stop", None)] {
            let mut descriptor = ActionDescriptor::new(id, id, "Tests");
            if let Some(release) = release {
                descriptor = descriptor.with_hold_release(release);
            }
            app.register_command_action::<TestArguments, TestCommand, _>(
                descriptor,
                |_world, arguments| Ok(TestCommand(arguments.value)),
            );
        }
        let registry = app.world().resource::<ActionRegistry>();
        let start = ActionReference::new("test.start", json!({ "value": 3 }));

        assert_eq!(
            registry.hold_release_action(&start),
            Some(ActionReference::new("test.stop", json!({ "value": 3 })))
        );
        assert_eq!(
            registry.behaviors(&start.id),
            vec![
                ControlBehavior::Press,
                ControlBehavior::Release,
                ControlBehavior::Hold
            ]
        );
        assert_eq!(
            registry.behaviors(&ActionId::new("test.stop")),
            vec![ControlBehavior::Press, ControlBehavior::Release]
        );
    }

    /// Verifies update actions write untracked updates carrying the clamped normalized value.
    #[test]
    fn update_action_writes_untracked_update() {
        let mut app = action_app();
        app.register_update_action::<TestArguments, TestApplied, _>(
            ActionDescriptor::new("test.level", "Test level", "Tests")
                .with_input(ActionInputKind::Absolute),
            |_world, arguments, value| Ok(TestApplied(arguments.value as f32 * value)),
        );

        let outcome = invoke(
            &mut app,
            ActionInvocation::scalar(
                ActionReference::new("test.level", json!({ "value": 200 })),
                ActionSurface::Midi,
                1.5,
            ),
        );

        assert_eq!(outcome, InvocationOutcome::Succeeded { output: None });
        assert_eq!(applied(&mut app), vec![TestApplied(200.0)]);
        assert!(app.world().resource::<PendingCommandBuffer>().is_empty());
    }

    /// Verifies unknown actions are reported instead of silently dropped.
    #[test]
    fn unknown_action_reports_not_registered() {
        let mut app = action_app();

        let outcome = invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.missing", json!({})),
                ActionSurface::Keyboard,
            ),
        );

        assert!(matches!(
            outcome,
            InvocationOutcome::Failed(InvocationError { ref code, .. })
                if code == "action.not_registered"
        ));
    }

    /// Verifies client-hosted actions are forwarded to clients once per press.
    #[test]
    fn client_actions_forward_presses_to_clients() {
        let mut app = action_app();
        let action = ActionReference::new("ui.panel-Masters", json!({}));

        let pressed = invoke(
            &mut app,
            ActionInvocation::new(action.clone(), ActionSurface::Midi, ActionInput::Press),
        );
        let released = invoke(
            &mut app,
            ActionInvocation::new(action, ActionSurface::Midi, ActionInput::Release),
        );

        assert_eq!(pressed, InvocationOutcome::Accepted);
        assert_eq!(released, InvocationOutcome::Ignored);
        let forwarded = app
            .world_mut()
            .resource_mut::<Messages<ClientActionInvocation>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(forwarded.len(), 1);
        assert_eq!(forwarded[0].action.id.as_str(), "ui.panel-Masters");
        assert_eq!(forwarded[0].input, ActionInput::Trigger);
    }

    /// Registers a trigger action restricted to the timeline surface.
    fn register_timeline_only_action(app: &mut App) {
        app.register_action::<TestArguments, _>(
            ActionDescriptor::new("test.timeline", "Timeline-only test", "Tests")
                .with_surfaces([ActionSurface::Timeline]),
            |world, arguments, _invocation| {
                world.write_message(TestApplied(arguments.value as f32));
                Ok(InvocationDispatch::succeeded())
            },
        );
    }

    /// Verifies a surface-restricted action runs from its allowed surface and is rejected,
    /// without reaching the domain, from every other surface.
    #[test]
    fn restricted_action_rejects_disallowed_surfaces() {
        let mut app = action_app();
        register_timeline_only_action(&mut app);
        let action = ActionReference::new("test.timeline", json!({ "value": 3 }));

        let allowed = invoke(
            &mut app,
            ActionInvocation::trigger(action.clone(), ActionSurface::Timeline),
        );
        assert_eq!(allowed, InvocationOutcome::Succeeded { output: None });
        assert_eq!(applied(&mut app), vec![TestApplied(3.0)]);

        for surface in ActionSurface::ALL
            .into_iter()
            .filter(|surface| *surface != ActionSurface::Timeline)
        {
            let outcome = invoke(&mut app, ActionInvocation::trigger(action.clone(), surface));
            assert!(
                matches!(
                    outcome,
                    InvocationOutcome::Failed(InvocationError { ref code, .. })
                        if code == "action.surface_not_allowed"
                ),
                "{surface:?} should be rejected, got {outcome:?}"
            );
        }
        assert!(applied(&mut app).is_empty());
    }

    /// Verifies binding validation rejects surfaces an action does not allow.
    #[test]
    fn binding_validation_rejects_disallowed_surfaces() {
        let mut app = action_app();
        register_trigger_action(&mut app);
        register_timeline_only_action(&mut app);
        let registry = app.world().resource::<ActionRegistry>();
        let restricted = ActionReference::new("test.timeline", json!({ "value": 1 }));
        let unrestricted = ActionReference::new("test.apply", json!({ "value": 1 }));

        let error = registry
            .validate_binding(&restricted, ActionSurface::Midi, |_| true)
            .expect_err("MIDI binding should be rejected");
        assert_eq!(error.code, "action.surface_not_allowed");
        assert!(
            registry
                .validate_binding(&restricted, ActionSurface::Timeline, |_| true)
                .is_ok()
        );
        assert!(
            registry
                .validate_binding(&unrestricted, ActionSurface::Osc, |_| true)
                .is_ok()
        );
    }

    /// Verifies the catalog publishes each action's allowed surfaces, defaulting to all.
    #[test]
    fn catalog_lists_allowed_surfaces() {
        let mut app = action_app();
        register_trigger_action(&mut app);
        register_timeline_only_action(&mut app);

        let catalog = app.world().resource::<ActionRegistry>().catalog();
        let surfaces = |id: &str| {
            catalog
                .iter()
                .find(|entry| entry.descriptor.id.as_str() == id)
                .map(|entry| entry.descriptor.surfaces.clone())
        };

        assert_eq!(surfaces("test.apply"), Some(ActionSurface::ALL.to_vec()));
        assert_eq!(
            surfaces("test.timeline"),
            Some(vec![ActionSurface::Timeline])
        );
    }

    /// Registers a trigger action and an absolute action that both fail with details.
    fn register_failing_actions(app: &mut App) {
        app.register_action::<TestArguments, _>(
            ActionDescriptor::new("test.missing_target", "Missing target", "Tests"),
            |_world, arguments, _invocation| {
                Err(
                    InvocationError::new("test.not_found", "Target does not exist")
                        .with_details(json!({ "target": arguments.value })),
                )
            },
        )
        .register_update_action::<TestArguments, TestApplied, _>(
            ActionDescriptor::new("test.missing_level", "Missing level", "Tests")
                .with_input(ActionInputKind::Absolute),
            |_world, arguments, _value| {
                Err(
                    InvocationError::new("test.not_found", "Target does not exist")
                        .with_details(json!({ "target": arguments.value })),
                )
            },
        );
    }

    /// Drains failures written for client publication.
    fn published_failures(app: &mut App) -> Vec<ActionInvocationFailure> {
        app.world_mut()
            .resource_mut::<Messages<ActionInvocationFailure>>()
            .drain()
            .collect()
    }

    /// Verifies every discrete failure is published with its source and structured details.
    #[test]
    fn discrete_failures_publish_with_details() {
        let mut app = action_app();
        register_failing_actions(&mut app);
        let action = ActionReference::new("test.missing_target", json!({ "value": 9 }));

        for _ in 0..2 {
            invoke(
                &mut app,
                ActionInvocation::trigger(action.clone(), ActionSurface::Osc)
                    .with_source("OSC 127.0.0.1:9000"),
            );
        }

        let failures = published_failures(&mut app);
        assert_eq!(failures.len(), 2);
        let failure = &failures[0];
        assert_eq!(failure.action, action);
        assert_eq!(failure.surface, ActionSurface::Osc);
        assert_eq!(failure.source, "OSC 127.0.0.1:9000");
        assert_eq!(failure.error.code, "test.not_found");
        assert_eq!(failure.error.details, Some(json!({ "target": 9 })));
        assert_eq!(failure.command_id, None);
    }

    /// Verifies a fader driving a missing target publishes one failure, not one per movement.
    #[test]
    fn repeated_scalar_failures_publish_once() {
        let mut app = action_app();
        register_failing_actions(&mut app);
        let action = ActionReference::new("test.missing_level", json!({ "value": 4 }));

        let mut failures = Vec::new();
        for value in [0.1, 0.2, 0.3] {
            let outcome = invoke(
                &mut app,
                ActionInvocation::scalar(action.clone(), ActionSurface::Midi, value),
            );
            assert!(matches!(outcome, InvocationOutcome::Failed(_)));
            failures.extend(published_failures(&mut app));
        }

        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].input, ActionInput::Scalar(0.1));
    }

    /// Verifies successful invocations are not published as failures.
    #[test]
    fn successful_invocations_are_not_published() {
        let mut app = action_app();
        register_trigger_action(&mut app);

        invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.apply", json!({ "value": 1 })),
                ActionSurface::Keyboard,
            ),
        );

        assert!(published_failures(&mut app).is_empty());
    }

    /// Creates an action app that records terminal command results and an active client
    /// command for an invocation to finish.
    fn app_with_client_command() -> (App, CommandId) {
        let mut app = action_app();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        let command_id = CommandId::new();
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                UndoId::from(command_id),
                CommandOrigin::WebUi,
                ReplyTarget::ClientBroadcast,
            )
            .expect("client command should register");
        (app, command_id)
    }

    /// Drains the terminal command results published by the dispatcher.
    fn command_results(app: &mut App) -> Vec<CommandResult> {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect()
    }

    /// Verifies a rejected invocation fails the client command that requested it with the
    /// invocation's code, message, and details.
    #[test]
    fn rejected_invocation_fails_requesting_command() {
        let (mut app, command_id) = app_with_client_command();
        register_failing_actions(&mut app);

        invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.missing_target", json!({ "value": 5 })),
                ActionSurface::Keyboard,
            )
            .completing(command_id),
        );

        let results = command_results(&mut app);
        let [result] = results.as_slice() else {
            panic!("invoke command should finish exactly once, got {results:?}");
        };
        assert_eq!(result.command_id, command_id);
        assert_eq!(
            result.outcome,
            CommandOutcome::failed(
                CommandError::new("test.not_found", "Target does not exist")
                    .with_details(json!({ "target": 5 }))
            )
        );
        assert_eq!(published_failures(&mut app)[0].command_id, Some(command_id));
        assert!(
            !app.world()
                .resource::<CommandTracker>()
                .is_active(command_id)
        );
    }

    /// Verifies a successful invocation succeeds the requesting command with its outcome.
    #[test]
    fn successful_invocation_succeeds_requesting_command() {
        let (mut app, command_id) = app_with_client_command();
        register_trigger_action(&mut app);

        invoke(
            &mut app,
            ActionInvocation::trigger(
                ActionReference::new("test.apply", json!({ "value": 2 })),
                ActionSurface::Keyboard,
            )
            .completing(command_id),
        );

        let results = command_results(&mut app);
        assert_eq!(
            results[0].outcome,
            CommandOutcome::with_output(
                CommandOutput::from_serializable(InvocationOutcome::Succeeded { output: None })
                    .unwrap()
            )
        );
        assert_eq!(applied(&mut app), vec![TestApplied(2.0)]);
    }

    /// Verifies invocation errors serialize details only when present.
    #[test]
    fn invocation_error_serializes_optional_details() {
        assert_eq!(
            serde_json::to_value(InvocationError::new("a.b", "Nope")).unwrap(),
            json!({ "code": "a.b", "message": "Nope" })
        );
        assert_eq!(
            serde_json::to_value(
                InvocationError::new("a.b", "Nope").with_details(json!({ "clip": 1 }))
            )
            .unwrap(),
            json!({ "code": "a.b", "message": "Nope", "details": { "clip": 1 } })
        );
    }

    /// Verifies two domains cannot silently replace one another's stable action ID.
    #[test]
    #[should_panic(expected = "action 'test.apply' is already registered")]
    fn duplicate_action_registration_panics() {
        let mut app = action_app();
        register_trigger_action(&mut app);
        register_trigger_action(&mut app);
    }
}
