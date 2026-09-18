// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Domain-owned registrations for desk automation capabilities.

use bevy_app::App;
use bevy_ecs::prelude::Messages;
use nightfall::prelude::IdExpr;
use nightfall_actions::{
    ActionDescriptor, ActionId, ActionInput, ActionInvocation, ActionReference, ActionRegistry,
    ActionSurface, ExternalCommandInvocation, InvocationDispatch, InvocationError,
};
use nightfall_engine::prelude::*;
use nightfall_playback_planner::{
    PlannedPlaybackInterventionKind, TimelinePlaybackActionOperation, TimelinePlaybackActionPlan,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::clips::{Clip, ClipAction};
use crate::controls::ControlUpdate;
use crate::desk_command::DeskCommand;

/// Stable action ID for starting a clip.
pub const CLIP_START_ACTION_ID: &str = "clip.start";

/// Stable action ID for stopping a clip.
pub const CLIP_STOP_ACTION_ID: &str = "clip.stop";

/// Stable action ID for advancing a clip.
pub const CLIP_GO_ACTION_ID: &str = "clip.go";

/// Stable action ID for setting a control from external hardware input.
pub const CONTROL_SET_ACTION_ID: &str = "control.set-external";

/// Stable action ID for evaluating a desk command.
pub const DESK_EVAL_ACTION_ID: &str = "desk.eval";

/// Persisted clip target interpreted by desk-owned action registrations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ClipTarget {
    /// User-facing numeric clip identifier.
    Id(u32),
    /// Persistent clip UID.
    Uid(Uuid),
}

/// Persisted arguments shared by clip lifecycle actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipActionArguments {
    /// Clip addressed by the action.
    pub target: ClipTarget,
}

/// Persisted arguments for externally-driven control actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ControlActionArguments {
    /// One-based control index in the backend-owned control bank.
    pub control_index: u32,
}

/// Persisted arguments for desk command evaluation actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DeskEvalActionArguments {
    /// Command text evaluated by the desk command parser.
    pub command: String,
}

/// Creates a persisted start-clip action reference.
pub fn start_clip_action(target: ClipTarget) -> ActionReference {
    clip_action_reference(CLIP_START_ACTION_ID, target)
}

/// Creates a persisted stop-clip action reference.
pub fn stop_clip_action(target: ClipTarget) -> ActionReference {
    clip_action_reference(CLIP_STOP_ACTION_ID, target)
}

/// Creates a persisted go-clip action reference.
pub fn go_clip_action(target: ClipTarget) -> ActionReference {
    clip_action_reference(CLIP_GO_ACTION_ID, target)
}

/// Creates a persisted external control action reference.
pub fn set_control_action(control_index: u32) -> ActionReference {
    ActionReference::with_arguments(
        CONTROL_SET_ACTION_ID,
        &ControlActionArguments { control_index },
    )
    .expect("control action arguments should serialize")
}

/// Creates a persisted desk-eval action reference.
pub fn desk_eval_action(command: impl Into<String>) -> ActionReference {
    ActionReference::with_arguments(
        DESK_EVAL_ACTION_ID,
        &DeskEvalActionArguments {
            command: command.into(),
        },
    )
    .expect("desk eval action arguments should serialize")
}

/// Decodes a clip target only when a reference matches the expected desk action.
pub fn clip_target_for_action(
    action: &ActionReference,
    expected_action_id: &str,
) -> Option<ClipTarget> {
    if action.id.as_str() != expected_action_id {
        return None;
    }
    serde_json::from_value::<ClipActionArguments>(action.arguments.clone())
        .ok()
        .map(|arguments| arguments.target)
}

/// Decodes command text only when a reference identifies the desk eval capability.
pub fn desk_eval_command_for_action(action: &ActionReference) -> Option<&str> {
    if action.id.as_str() != DESK_EVAL_ACTION_ID {
        return None;
    }
    action.arguments.get("command")?.as_str()
}

/// Registers every automation capability owned by the desk domain.
pub fn register_desk_actions(app: &mut App) {
    let mut registry = app.world_mut().resource_mut::<ActionRegistry>();
    register_clip_action(
        &mut registry,
        CLIP_START_ACTION_ID,
        "Start clip",
        ClipAction::Start,
        TimelinePlaybackActionOperation::Start,
    );
    register_clip_action(
        &mut registry,
        CLIP_STOP_ACTION_ID,
        "Stop clip",
        ClipAction::Stop,
        TimelinePlaybackActionOperation::Stop,
    );
    register_clip_action(
        &mut registry,
        CLIP_GO_ACTION_ID,
        "Go clip",
        ClipAction::Go,
        TimelinePlaybackActionOperation::Intervene(PlannedPlaybackInterventionKind::SequenceGo),
    );
    registry.register::<ControlActionArguments, _>(
        descriptor(
            CONTROL_SET_ACTION_ID,
            "Set control",
            vec![ActionSurface::Midi, ActionSurface::Osc],
            object_schema("control_index", "integer"),
        ),
        invoke_control,
    );
    registry.register::<DeskEvalActionArguments, _>(
        descriptor(
            DESK_EVAL_ACTION_ID,
            "Evaluate command",
            vec![ActionSurface::Osc, ActionSurface::Timeline],
            object_schema("command", "string"),
        ),
        invoke_desk_eval,
    );
}

/// Creates a clip action reference for one stable action ID.
fn clip_action_reference(action_id: &str, target: ClipTarget) -> ActionReference {
    ActionReference::with_arguments(action_id, &ClipActionArguments { target })
        .expect("clip action arguments should serialize")
}

/// Registers one clip lifecycle capability with shared typed argument handling.
fn register_clip_action(
    registry: &mut ActionRegistry,
    action_id: &'static str,
    label: &'static str,
    action: fn(IdExpr) -> ClipAction,
    timeline_operation: TimelinePlaybackActionOperation,
) {
    registry.register::<ClipActionArguments, _>(
        descriptor(
            action_id,
            label,
            vec![
                ActionSurface::Midi,
                ActionSurface::Osc,
                ActionSurface::Timeline,
            ],
            json!({
                "type": "object",
                "required": ["target"],
                "properties": { "target": { "type": "object" } }
            }),
        ),
        move |world, arguments, _invocation| {
            let id = resolve_clip_id(world, arguments.target)?;
            let Some(mut messages) =
                world.get_resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
            else {
                return Err(InvocationError::new(
                    "clip.dispatch_unavailable",
                    "Clip action dispatch is unavailable",
                ));
            };
            messages.write(EngineActionEnvelope::detached(action(IdExpr::Single(id))));
            Ok(InvocationDispatch::Accepted)
        },
    );
    registry.register_capability::<ClipActionArguments, TimelinePlaybackActionPlan, _>(
        action_id,
        move |arguments| {
            let ClipTarget::Uid(owner_uid) = arguments.target else {
                return Err(InvocationError::new(
                    "timeline.stable_target_required",
                    "Deterministic timeline planning requires a clip UID",
                ));
            };
            Ok(TimelinePlaybackActionPlan {
                owner_uid,
                operation: timeline_operation,
            })
        },
    );
}

/// Resolves a persisted clip target to the numeric ID used by runtime commands.
fn resolve_clip_id(
    world: &bevy_ecs::prelude::World,
    target: ClipTarget,
) -> Result<u32, InvocationError> {
    match target {
        ClipTarget::Id(id) => Ok(id),
        ClipTarget::Uid(uid) => world
            .get_resource::<DataProvider<Clip>>()
            .ok_or_else(|| {
                InvocationError::new("clip.registry_unavailable", "Clip storage is unavailable")
            })?
            .get(uid)
            .map(|clip| clip.identifiers.id)
            .map_err(|_| {
                InvocationError::new(
                    "clip.not_found",
                    format!("Clip with UID {uid} does not exist"),
                )
            }),
    }
}

/// Applies normalized automation input to a desk-owned control update.
fn invoke_control(
    world: &mut bevy_ecs::prelude::World,
    arguments: ControlActionArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let ActionInput::Scalar(value) = invocation.input else {
        return Err(InvocationError::new(
            "control.scalar_required",
            "Control actions require a scalar input value",
        ));
    };
    let Some(mut messages) = world.get_resource_mut::<Messages<ControlUpdate>>() else {
        return Err(InvocationError::new(
            "control.dispatch_unavailable",
            "Control dispatch is unavailable",
        ));
    };
    messages.write(ControlUpdate::SetExternalHardwareValue {
        control_index: arguments.control_index,
        value: value * 100.0,
    });
    Ok(InvocationDispatch::Accepted)
}

/// Starts a tracked desk eval command when an automation capability requests one.
fn invoke_desk_eval(
    world: &mut bevy_ecs::prelude::World,
    arguments: DeskEvalActionArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let eval = CommandEnvelope::new(
        DeskCommand::Eval(arguments.command.clone()),
        CommandOrigin::Remote(format!("{:?}", invocation.surface)),
        ReplyTarget::ClientBroadcast,
    );
    world
        .get_resource_mut::<CommandTracker>()
        .ok_or_else(|| {
            InvocationError::new(
                "desk.command_tracker_unavailable",
                "Command tracking is unavailable",
            )
        })?
        .register(&eval)
        .map_err(|error| {
            InvocationError::new(
                "desk.command_registration_failed",
                format!("Unable to register command: {error}"),
            )
        })?;

    let source = invocation
        .source
        .clone()
        .unwrap_or_else(|| format!("{:?}", invocation.surface));
    world.write_message(ExternalCommandInvocation {
        invocation_id: invocation.invocation_id,
        command_id: eval.command_id.into(),
        command: arguments.command,
        surface: invocation.surface,
        source,
    });
    world.write_message(eval);
    Ok(InvocationDispatch::Accepted)
}

/// Creates one action descriptor with a stable ID and domain schema.
fn descriptor(
    id: &str,
    label: &str,
    allowed_surfaces: Vec<ActionSurface>,
    argument_schema: Value,
) -> ActionDescriptor {
    ActionDescriptor {
        id: ActionId::new(id),
        label: label.to_string(),
        allowed_surfaces,
        argument_schema,
    }
}

/// Creates a compact JSON Schema for one required object property.
fn object_schema(property: &str, property_type: &str) -> Value {
    let mut properties = serde_json::Map::new();
    properties.insert(property.to_string(), json!({ "type": property_type }));
    json!({
        "type": "object",
        "required": [property],
        "properties": properties
    })
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use nightfall_actions::{ActionsPlugin, InvocationOutcome, InvocationResult};

    use super::*;

    /// Creates a focused app containing registry dispatch and desk-owned action registrations.
    fn desk_action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.add_message::<ControlUpdate>();
        app.add_message::<CommandEnvelope<DeskCommand>>();
        app.init_resource::<DataProvider<Clip>>();
        app.init_resource::<CommandTracker>();
        register_desk_actions(&mut app);
        app
    }

    /// Drains the immediate result emitted by the generic invocation stage.
    fn take_invocation_result(app: &mut App) -> InvocationResult {
        app.world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("registered action should emit an invocation result")
    }

    /// Verifies clip action arguments are interpreted only by the desk registration.
    #[test]
    fn clip_action_invoker_dispatches_runtime_action() {
        let mut app = desk_action_app();
        app.world_mut().write_message(ActionInvocation::trigger(
            start_clip_action(ClipTarget::Id(7)),
            ActionSurface::Midi,
        ));

        app.update();

        let actions = app
            .world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            actions.as_slice(),
            [EngineActionEnvelope {
                action: ClipAction::Start(IdExpr::Single(7)),
                ..
            }]
        ));
        assert!(matches!(
            take_invocation_result(&mut app).outcome,
            InvocationOutcome::Accepted
        ));
    }

    /// Verifies normalized action input is converted to the desk control percentage scale.
    #[test]
    fn control_invoker_dispatches_normalized_update() {
        let mut app = desk_action_app();
        app.world_mut().write_message(ActionInvocation::scalar(
            set_control_action(3),
            ActionSurface::Osc,
            0.25,
        ));

        app.update();

        let updates = app
            .world_mut()
            .resource_mut::<Messages<ControlUpdate>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            updates.as_slice(),
            [ControlUpdate::SetExternalHardwareValue {
                control_index: 3,
                value,
            }] if (*value - 25.0).abs() < f32::EPSILON
        ));
        assert!(matches!(
            take_invocation_result(&mut app).outcome,
            InvocationOutcome::Accepted
        ));
    }

    /// Verifies discrete eval invocations explicitly create tracked command lifecycles.
    #[test]
    fn desk_eval_invoker_registers_command_and_source_notification() {
        let mut app = desk_action_app();
        app.world_mut().write_message(
            ActionInvocation::trigger(desk_eval_action("clip 1 go"), ActionSurface::Osc)
                .with_source("OSC 127.0.0.1:9000"),
        );

        app.update();

        let commands = app
            .world_mut()
            .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
            .drain()
            .collect::<Vec<_>>();
        let [command] = commands.as_slice() else {
            panic!("eval invocation should dispatch one desk command");
        };
        assert!(matches!(
            command.command,
            DeskCommand::Eval(ref value) if value == "clip 1 go"
        ));
        assert!(
            app.world()
                .resource::<CommandTracker>()
                .is_active(command.command_id)
        );
        let notifications = app
            .world_mut()
            .resource_mut::<Messages<ExternalCommandInvocation>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(notifications.len(), 1);
        assert_eq!(
            notifications[0].command_id,
            uuid::Uuid::from(command.command_id)
        );
        assert_eq!(notifications[0].source, "OSC 127.0.0.1:9000");
        assert!(matches!(
            take_invocation_result(&mut app).outcome,
            InvocationOutcome::Accepted
        ));
    }
}
