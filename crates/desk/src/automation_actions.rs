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

use crate::clips::{Clip, ClipCommand};
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

/// Activates the assignment currently occupying a control slot.
pub const CONTROL_GO_ACTION_ID: &str = "control.go";

/// Sets a specific master's level using its persistent UID.
pub const MASTER_SET_ACTION_ID: &str = "master.set-level";

/// A direct master binding retains this identity across renumbering and panel closure.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MasterActionArguments {
    /// Persistent identity; deletion never retargets a reused numeric ID.
    pub master_uid: Uuid,
}

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
    registry.register::<MasterActionArguments, _>(
        descriptor(
            MASTER_SET_ACTION_ID,
            "Set master level",
            nightfall_actions::ActionInputKind::Scalar,
            vec![ActionSurface::Midi, ActionSurface::Osc],
            object_schema("master_uid", "string"),
        ),
        invoke_master,
    );
    registry.register_target_validator::<MasterActionArguments, _>(
        MASTER_SET_ACTION_ID,
        |world, arguments| {
            let masters = world
                .get_resource::<DataProvider<crate::masters::Master>>()
                .ok_or_else(|| {
                    InvocationError::new("master.unavailable", "Master storage is unavailable")
                })?;
            masters.get(arguments.master_uid).map(|_| ()).map_err(|_| {
                InvocationError::new("master.not_found", "The mapped master no longer exists")
            })
        },
    );
    registry.register::<ControlActionArguments, _>(
        descriptor(
            CONTROL_GO_ACTION_ID,
            "Go control",
            nightfall_actions::ActionInputKind::Trigger,
            vec![
                ActionSurface::Midi,
                ActionSurface::Osc,
                ActionSurface::Websocket,
            ],
            object_schema("control_index", "integer"),
        ),
        |world, arguments, invocation| {
            nightfall_engine::action_commands::invoke_action_command(
                world,
                invocation,
                crate::controls::ControlCommand::Go {
                    control_index: arguments.control_index,
                },
            )
        },
    );
    register_clip_action(
        &mut registry,
        CLIP_START_ACTION_ID,
        "Start clip",
        ClipCommand::StartClip,
        TimelinePlaybackActionOperation::Start,
    );
    register_clip_action(
        &mut registry,
        CLIP_STOP_ACTION_ID,
        "Stop clip",
        ClipCommand::StopClip,
        TimelinePlaybackActionOperation::Stop,
    );
    register_clip_action(
        &mut registry,
        CLIP_GO_ACTION_ID,
        "Go clip",
        ClipCommand::GoClip,
        TimelinePlaybackActionOperation::Intervene(PlannedPlaybackInterventionKind::SequenceGo),
    );
    registry.register::<ControlActionArguments, _>(
        descriptor(
            CONTROL_SET_ACTION_ID,
            "Set control",
            nightfall_actions::ActionInputKind::Scalar,
            vec![ActionSurface::Midi, ActionSurface::Osc],
            object_schema("control_index", "integer"),
        ),
        invoke_control,
    );
    for action_id in [CONTROL_GO_ACTION_ID, CONTROL_SET_ACTION_ID] {
        registry.register_target_validator::<ControlActionArguments, _>(
            action_id,
            |world, arguments| {
                let controls = world
                    .get_resource::<crate::controls::Controls>()
                    .ok_or_else(|| {
                        InvocationError::new(
                            "control.unavailable",
                            "Control storage is unavailable",
                        )
                    })?;
                if controls.contains_slot(arguments.control_index) {
                    Ok(())
                } else {
                    Err(InvocationError::new(
                        "control.not_found",
                        format!("Control {} does not exist", arguments.control_index),
                    ))
                }
            },
        );
    }
    registry.register::<DeskEvalActionArguments, _>(
        descriptor(
            DESK_EVAL_ACTION_ID,
            "Evaluate command",
            nightfall_actions::ActionInputKind::Trigger,
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
    command: fn(IdExpr) -> ClipCommand,
    timeline_operation: TimelinePlaybackActionOperation,
) {
    registry.register::<ClipActionArguments, _>(
        descriptor(
            action_id,
            label,
            nightfall_actions::ActionInputKind::Trigger,
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
        move |world, arguments, invocation| {
            let id = resolve_clip_id(world, arguments.target)?;
            nightfall_engine::action_commands::invoke_action_command(
                world,
                invocation,
                command(IdExpr::Single(id)),
            )
        },
    );
    registry.register_target_validator::<ClipActionArguments, _>(action_id, |world, arguments| {
        resolve_clip_id(world, arguments.target).map(|_| ())
    });
    registry.register_capability::<ClipActionArguments, TimelinePlaybackActionPlan, _>(
        action_id,
        nightfall_playback_planner::TIMELINE_PLAYBACK_CAPABILITY_ID,
        ActionSurface::Timeline,
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
        ClipTarget::Uid(uid) => {
            let missing = || {
                InvocationError::new(
                    "clip.not_found",
                    format!("Clip with UID {uid} does not exist"),
                )
            };
            let mut query = world.try_query::<&Clip>().ok_or_else(missing)?;
            let mut matches = query.iter(world).filter(|clip| clip.identifiers.uid == uid);
            let clip = matches.next().ok_or_else(missing)?;
            if matches.next().is_some() {
                return Err(InvocationError::new(
                    "clip.ambiguous",
                    "Multiple clips have the mapped UID",
                ));
            }
            Ok(clip.identifiers.id)
        }
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

/// Applies an absolute hardware value immediately without per-sample commands or undo entries.
fn invoke_master(
    world: &mut bevy_ecs::prelude::World,
    arguments: MasterActionArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    use crate::masters::Master;
    let ActionInput::Scalar(value) = invocation.input else {
        return Err(InvocationError::new(
            "master.scalar_required",
            "Master level requires a scalar input",
        ));
    };
    let mut masters = world
        .get_resource_mut::<DataProvider<Master>>()
        .ok_or_else(|| {
            InvocationError::new("master.unavailable", "Master storage is unavailable")
        })?;
    let mut master = masters
        .get(arguments.master_uid)
        .map(|master| master.clone())
        .map_err(|_| {
            InvocationError::new("master.not_found", "The mapped master no longer exists")
        })?;
    master.level_percent = Master::level_percent_from_control(master.kind, value * 100.0);
    masters
        .add(master)
        .map_err(|error| InvocationError::new("master.update_failed", error.to_string()))?;
    Ok(InvocationDispatch::succeeded())
}

/// Starts a tracked desk eval command when an automation capability requests one.
fn invoke_desk_eval(
    world: &mut bevy_ecs::prelude::World,
    arguments: DeskEvalActionArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let command_id = nightfall_engine::action_commands::enqueue_action_command(
        world,
        invocation,
        DeskCommand::Eval(arguments.command.clone()),
        ReplyTarget::ClientBroadcast,
    )?;

    let source = invocation
        .source
        .clone()
        .unwrap_or_else(|| format!("{:?}", invocation.surface));
    world.write_message(ExternalCommandInvocation {
        invocation_id: invocation.invocation_id,
        command_id: command_id.into(),
        command: arguments.command,
        surface: invocation.surface,
        source,
    });
    Ok(InvocationDispatch::Accepted)
}

/// Creates one action descriptor with a stable ID and domain schema.
fn descriptor(
    id: &str,
    label: &str,
    input_kind: nightfall_actions::ActionInputKind,
    allowed_surfaces: Vec<ActionSurface>,
    argument_schema: Value,
) -> ActionDescriptor {
    ActionDescriptor {
        capabilities: Vec::new(),
        id: ActionId::new(id),
        label: label.to_string(),
        allowed_surfaces,
        input_kind,
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
        app.add_message::<CommandEnvelope<ClipCommand>>();
        app.init_resource::<PendingCommandBuffer>();
        app.add_message::<ControlUpdate>();
        app.add_message::<CommandEnvelope<DeskCommand>>();
        app.init_resource::<crate::controls::Controls>();
        app.init_resource::<CommandTracker>();
        register_desk_actions(&mut app);
        app
    }

    /// Deterministic clip plans require stable targets and cannot bypass capability surface permissions.
    #[test]
    fn deterministic_clip_capability_requires_uid_and_timeline_surface() {
        let app = desk_action_app();
        let registry = app.world().resource::<ActionRegistry>();
        let uid = Uuid::new_v4();
        let action = go_clip_action(ClipTarget::Uid(uid));
        let plan = registry
            .resolve_capability::<TimelinePlaybackActionPlan>(&action, ActionSurface::Timeline)
            .unwrap()
            .unwrap();
        assert_eq!(plan.owner_uid, uid);
        assert!(
            registry
                .resolve_capability::<TimelinePlaybackActionPlan>(&action, ActionSurface::Midi)
                .is_err()
        );
        assert!(
            registry
                .resolve_capability::<TimelinePlaybackActionPlan>(
                    &go_clip_action(ClipTarget::Id(1)),
                    ActionSurface::Timeline
                )
                .is_err()
        );
        let dynamic = ActionReference::new(CONTROL_GO_ACTION_ID, json!({"control_index":1}));
        assert!(
            registry
                .resolve_capability::<TimelinePlaybackActionPlan>(&dynamic, ActionSurface::Timeline)
                .is_err()
        );
        assert!(registry.get(&dynamic.id).unwrap().capabilities.is_empty());
    }

    /// Clip actions resolve ECS identities without a legacy storage resource or ambiguous targets.
    #[test]
    fn clip_uid_validation_uses_persistent_entities_and_rejects_duplicates() {
        let mut app = desk_action_app();
        let mut clip = Clip::default();
        clip.identifiers.id = 7;
        let uid = clip.identifiers.uid;
        let action = go_clip_action(ClipTarget::Uid(uid));
        let entity = app.world_mut().spawn(clip.clone()).id();
        assert_eq!(
            resolve_clip_id(app.world(), ClipTarget::Uid(uid)).unwrap(),
            7
        );
        assert!(
            app.world()
                .resource::<ActionRegistry>()
                .validate_target(app.world(), &action)
                .is_ok()
        );
        let duplicate = app.world_mut().spawn(clip).id();
        assert_eq!(
            resolve_clip_id(app.world(), ClipTarget::Uid(uid))
                .unwrap_err()
                .code,
            "clip.ambiguous"
        );
        app.world_mut().despawn(duplicate);
        app.world_mut().despawn(entity);
        assert_eq!(
            resolve_clip_id(app.world(), ClipTarget::Uid(uid))
                .unwrap_err()
                .code,
            "clip.not_found"
        );
    }

    /// Empty slots remain mappable while invalid one-based indices are rejected.
    #[test]
    fn control_binding_validates_slot_without_requiring_assignment() {
        let app = desk_action_app();
        let registry = app.world().resource::<ActionRegistry>();
        for action_id in [CONTROL_GO_ACTION_ID, CONTROL_SET_ACTION_ID] {
            for index in [1, crate::controls::DEFAULT_CONTROL_COUNT as u32] {
                let action = ActionReference::new(action_id, json!({"control_index": index}));
                assert!(registry.validate_target(app.world(), &action).is_ok());
            }
            for index in [
                0,
                crate::controls::DEFAULT_CONTROL_COUNT as u32 + 1,
                u32::MAX,
            ] {
                let action = ActionReference::new(action_id, json!({"control_index": index}));
                assert_eq!(
                    registry
                        .validate_target(app.world(), &action)
                        .unwrap_err()
                        .code,
                    "control.not_found"
                );
            }
        }
    }

    /// Direct master bindings apply domain units and cannot follow a reused numeric ID.
    #[test]
    fn master_binding_scales_by_kind_and_retains_uid_identity() {
        use crate::masters::{Master, MasterKind};
        let mut app = desk_action_app();
        app.init_resource::<DataProvider<Master>>();
        let uid = Uuid::new_v4();
        let mut master = Master::default();
        master.identifiers.uid = uid;
        master.identifiers.id = 7;
        master.kind = MasterKind::PlaybackRate;
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(master.clone())
            .unwrap();
        let action = ActionReference::with_arguments(
            MASTER_SET_ACTION_ID,
            &MasterActionArguments { master_uid: uid },
        )
        .unwrap();
        app.world_mut().write_message(ActionInvocation::scalar(
            action.clone(),
            ActionSurface::Osc,
            0.75,
        ));
        app.update();
        assert_eq!(
            app.world()
                .resource::<DataProvider<Master>>()
                .get(uid)
                .unwrap()
                .level_percent,
            150.0
        );
        assert!(matches!(
            take_invocation_result(&mut app).outcome,
            InvocationOutcome::Succeeded { .. }
        ));
        master.kind = MasterKind::InhibitiveIntensity;
        master.identifiers.id = 8;
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(master.clone())
            .unwrap();
        app.world_mut().write_message(ActionInvocation::scalar(
            action.clone(),
            ActionSurface::Midi,
            0.75,
        ));
        app.update();
        assert_eq!(
            app.world()
                .resource::<DataProvider<Master>>()
                .get(uid)
                .unwrap()
                .level_percent,
            75.0
        );
        take_invocation_result(&mut app);
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .remove(&uid)
            .unwrap();
        master.identifiers.uid = Uuid::new_v4();
        let replacement_uid = master.identifiers.uid;
        master.level_percent = 25.0;
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(master)
            .unwrap();
        app.world_mut()
            .write_message(ActionInvocation::scalar(action, ActionSurface::Osc, 1.0));
        app.update();
        assert!(
            matches!(take_invocation_result(&mut app).outcome, InvocationOutcome::Failed(error) if error.code == "master.not_found")
        );
        assert_eq!(
            app.world()
                .resource::<DataProvider<Master>>()
                .get(replacement_uid)
                .unwrap()
                .level_percent,
            25.0
        );
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
    fn clip_action_invoker_dispatches_tracked_command() {
        let mut app = desk_action_app();
        app.world_mut().write_message(ActionInvocation::trigger(
            start_clip_action(ClipTarget::Id(7)),
            ActionSurface::Midi,
        ));

        app.update();

        let actions = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions[0].payload.as_any().downcast_ref::<ClipCommand>(),
            Some(ClipCommand::StartClip(IdExpr::Single(7)))
        ));
        assert_eq!(actions[0].undo_id, actions[0].command_id.into());
        assert!(
            app.world()
                .resource::<CommandTracker>()
                .is_active(actions[0].command_id)
        );
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
            .resource_mut::<PendingCommandBuffer>()
            .drain()
            .into_iter()
            .collect::<Vec<_>>();
        let [command] = commands.as_slice() else {
            panic!("eval invocation should dispatch one desk command");
        };
        assert!(matches!(
            command.payload.as_any().downcast_ref::<DeskCommand>(),
            Some(DeskCommand::Eval(value)) if value == "clip 1 go"
        ));
        assert_eq!(command.undo_id, command.command_id.into());
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
