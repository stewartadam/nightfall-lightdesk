// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Domain-owned bindable actions for desk clips, controls, and command evaluation.

use bevy_app::App;
use bevy_ecs::prelude::World;
use nightfall::prelude::IdExpr;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionInputKind, ActionInvocation, ActionParameter,
    ActionParameterKind, ActionReference, ExternalCommandInvocation, InvocationDispatch,
    InvocationError, submit_command,
};
use nightfall_engine::prelude::*;
use nightfall_playback_planner::{
    PlannedPlaybackInterventionKind, TimelinePlaybackActionKind, TimelinePlaybackActionPlan,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::clips::{Clip, ClipCommand};
use crate::controls::{ControlCommand, ControlUpdate};
use crate::desk_command::DeskCommand;
use crate::masters::{Master, MasterCommand, MasterUpdate};

/// Stable action ID for starting a clip.
pub const CLIP_START_ACTION_ID: &str = "clip.start";

/// Stable action ID for stopping a clip.
pub const CLIP_STOP_ACTION_ID: &str = "clip.stop";

/// Stable action ID for advancing a clip.
pub const CLIP_GO_ACTION_ID: &str = "clip.go";

/// Stable action ID for driving a control slot's level from external hardware input.
pub const CONTROL_LEVEL_ACTION_ID: &str = "control.level";

/// Stable action ID for running a control slot's Go behavior.
pub const CONTROL_GO_ACTION_ID: &str = "control.go";

/// Stable action ID for driving a master's level.
pub const MASTER_LEVEL_ACTION_ID: &str = "master.level";

/// Stable action ID for toggling a toggle-mode master.
pub const MASTER_TOGGLE_ACTION_ID: &str = "master.toggle";

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

/// Persisted arguments for actions addressing one master.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MasterActionArguments {
    /// Persistent UID of the addressed master.
    #[typeshare(serialized_as = "String")]
    pub master: Uuid,
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

/// Creates a persisted control level action reference.
pub fn control_level_action(control_index: u32) -> ActionReference {
    control_action_reference(CONTROL_LEVEL_ACTION_ID, control_index)
}

/// Creates a persisted control Go action reference.
pub fn control_go_action(control_index: u32) -> ActionReference {
    control_action_reference(CONTROL_GO_ACTION_ID, control_index)
}

/// Creates a persisted master level action reference.
pub fn master_level_action(master: Uuid) -> ActionReference {
    master_action_reference(MASTER_LEVEL_ACTION_ID, master)
}

/// Creates a persisted master toggle action reference.
pub fn master_toggle_action(master: Uuid) -> ActionReference {
    master_action_reference(MASTER_TOGGLE_ACTION_ID, master)
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

/// Registers every bindable action owned by the desk domain.
pub fn register_desk_actions(app: &mut App) {
    register_clip_action(
        app,
        CLIP_START_ACTION_ID,
        "Start clip",
        ClipCommand::StartClip,
        TimelinePlaybackActionKind::Start,
    );
    register_clip_action(
        app,
        CLIP_STOP_ACTION_ID,
        "Stop clip",
        ClipCommand::StopClip,
        TimelinePlaybackActionKind::Stop,
    );
    register_clip_action(
        app,
        CLIP_GO_ACTION_ID,
        "Go clip",
        ClipCommand::GoClip,
        TimelinePlaybackActionKind::Intervene(PlannedPlaybackInterventionKind::SequenceGo),
    );
    app.register_update_action::<ControlActionArguments, ControlUpdate, _>(
        ActionDescriptor::new(CONTROL_LEVEL_ACTION_ID, "Control level", "Controls")
            .with_description("Drives a control fader from hardware with soft pickup")
            .with_input(ActionInputKind::Absolute)
            .with_parameter(control_parameter()),
        |_world, arguments, value| {
            Ok(ControlUpdate::SetExternalHardwareValue {
                control_index: arguments.control_index,
                value: value * 100.0,
            })
        },
    );
    app.register_command_action::<ControlActionArguments, ControlCommand, _>(
        ActionDescriptor::new(CONTROL_GO_ACTION_ID, "Control Go", "Controls")
            .with_description("Starts or advances the control's clip, or toggles its master")
            .with_parameter(control_parameter()),
        |_world, arguments| {
            Ok(ControlCommand::Go {
                control_index: arguments.control_index,
            })
        },
    );
    app.register_update_action::<MasterActionArguments, MasterUpdate, _>(
        ActionDescriptor::new(MASTER_LEVEL_ACTION_ID, "Master level", "Masters")
            .with_input(ActionInputKind::Absolute)
            .with_parameter(master_parameter()),
        |world, arguments, value| {
            let master = resolve_master(world, arguments.master)?;
            Ok(MasterUpdate::SetLevel {
                id: master.identifiers.id,
                level_percent: Master::level_percent_from_control(master.kind, value * 100.0),
            })
        },
    );
    app.register_command_action::<MasterActionArguments, MasterCommand, _>(
        ActionDescriptor::new(MASTER_TOGGLE_ACTION_ID, "Toggle master", "Masters")
            .with_parameter(master_parameter()),
        |world, arguments| {
            let master = resolve_master(world, arguments.master)?;
            Ok(MasterCommand::ToggleMaster {
                id: master.identifiers.id,
            })
        },
    );
    app.register_action::<DeskEvalActionArguments, _>(
        ActionDescriptor::new(DESK_EVAL_ACTION_ID, "Evaluate command", "Desk")
            .with_description("Runs a desk command line as if it were typed")
            .with_parameter(ActionParameter::required(
                "command",
                "Command",
                ActionParameterKind::Text,
            )),
        invoke_desk_eval,
    );
}

/// Creates a control action reference for one stable action ID.
fn control_action_reference(action_id: &str, control_index: u32) -> ActionReference {
    ActionReference::with_arguments(action_id, &ControlActionArguments { control_index })
        .expect("control action arguments should serialize")
}

/// Creates a master action reference for one stable action ID.
fn master_action_reference(action_id: &str, master: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &MasterActionArguments { master })
        .expect("master action arguments should serialize")
}

/// Describes the control slot argument shared by control actions.
fn control_parameter() -> ActionParameter {
    ActionParameter::required("control_index", "Control", ActionParameterKind::Control)
}

/// Describes the master argument shared by master actions.
fn master_parameter() -> ActionParameter {
    ActionParameter::required("master", "Master", ActionParameterKind::Master)
}

/// Resolves a persisted master UID to a copy of its current definition.
fn resolve_master(world: &World, uid: Uuid) -> Result<Master, InvocationError> {
    world
        .get_resource::<DataProvider<Master>>()
        .ok_or_else(|| {
            InvocationError::new(
                "master.registry_unavailable",
                "Master storage is unavailable",
            )
        })?
        .get(uid)
        .map(|master| master.clone())
        .map_err(|_| {
            InvocationError::new(
                "master.not_found",
                format!("Master with UID {uid} does not exist"),
            )
        })
}

/// Creates a clip action reference for one stable action ID.
fn clip_action_reference(action_id: &str, target: ClipTarget) -> ActionReference {
    ActionReference::with_arguments(action_id, &ClipActionArguments { target })
        .expect("clip action arguments should serialize")
}

/// Registers one clip lifecycle action lowering to its clip command and timeline plan.
fn register_clip_action(
    app: &mut App,
    action_id: &'static str,
    label: &'static str,
    command: fn(IdExpr) -> ClipCommand,
    timeline_kind: TimelinePlaybackActionKind,
) {
    app.register_command_action::<ClipActionArguments, ClipCommand, _>(
        ActionDescriptor::new(action_id, label, "Clips").with_parameter(ActionParameter::required(
            "target",
            "Clip",
            ActionParameterKind::Clip,
        )),
        move |world, arguments| {
            let id = resolve_clip_id(world, arguments.target)?;
            Ok(command(IdExpr::Single(id)))
        },
    )
    .register_action_capability::<ClipActionArguments, TimelinePlaybackActionPlan, _>(
        action_id,
        TimelinePlaybackActionPlan::CAPABILITY,
        move |arguments| {
            let ClipTarget::Uid(owner_uid) = arguments.target else {
                return Err(InvocationError::new(
                    "timeline.stable_target_required",
                    "Deterministic timeline planning requires a clip UID",
                ));
            };
            Ok(TimelinePlaybackActionPlan {
                owner_uid,
                kind: timeline_kind,
            })
        },
    );
}

/// Resolves a persisted clip target to the numeric ID used by runtime commands.
fn resolve_clip_id(world: &World, target: ClipTarget) -> Result<u32, InvocationError> {
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

/// Submits a tracked desk eval command and announces the command text to the invoking surface.
fn invoke_desk_eval(
    world: &mut World,
    arguments: DeskEvalActionArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let command_id = submit_command(
        world,
        invocation,
        DeskCommand::Eval(arguments.command.clone()),
    )?;
    world.write_message(ExternalCommandInvocation {
        invocation_id: invocation.invocation_id,
        command_id,
        command: arguments.command,
        surface: invocation.surface,
        source: invocation.source_label(),
    });
    Ok(InvocationDispatch::Submitted { command_id })
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use nightfall_actions::{ActionSurface, ActionsPlugin, InvocationOutcome, InvocationResult};

    use super::*;

    /// Creates a focused app containing registry dispatch and desk-owned action registrations.
    fn desk_action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.add_message::<ControlUpdate>();
        app.add_message::<MasterUpdate>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<DataProvider<Clip>>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
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

    /// Drains the commands queued for undo capture and ingress dispatch.
    fn take_pending_commands(app: &mut App) -> Vec<PayloadEnvelope> {
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain()
    }

    /// Verifies clip actions lower to tracked clip commands instead of runtime operations.
    #[test]
    fn clip_action_submits_tracked_clip_command() {
        let mut app = desk_action_app();
        app.world_mut().write_message(ActionInvocation::trigger(
            go_clip_action(ClipTarget::Id(7)),
            ActionSurface::Midi,
        ));

        app.update();

        let InvocationOutcome::Submitted { command_id } = take_invocation_result(&mut app).outcome
        else {
            panic!("clip action should submit a tracked command");
        };
        let pending = take_pending_commands(&mut app);
        let [envelope] = pending.as_slice() else {
            panic!("clip action should queue one command");
        };
        assert_eq!(envelope.command_id, command_id);
        assert!(matches!(
            envelope.payload.as_any().downcast_ref::<ClipCommand>(),
            Some(ClipCommand::GoClip(IdExpr::Single(7)))
        ));
    }

    /// Verifies clip actions expose deterministic timeline plans for stable targets only.
    #[test]
    fn clip_action_plans_timeline_playback_for_uid_targets() {
        let app = desk_action_app();
        let registry = app.world().resource::<nightfall_actions::ActionRegistry>();
        let uid = Uuid::new_v4();

        let plan = registry
            .resolve_capability::<TimelinePlaybackActionPlan>(&start_clip_action(ClipTarget::Uid(
                uid,
            )))
            .expect("uid targets should plan")
            .expect("clip actions should expose timeline planning");
        let numeric = registry.resolve_capability::<TimelinePlaybackActionPlan>(
            &start_clip_action(ClipTarget::Id(3)),
        );

        assert_eq!(
            plan,
            TimelinePlaybackActionPlan {
                owner_uid: uid,
                kind: TimelinePlaybackActionKind::Start,
            }
        );
        assert!(numeric.is_err());
    }

    /// Verifies normalized action input is converted to the desk control percentage scale.
    #[test]
    fn control_action_writes_normalized_update() {
        let mut app = desk_action_app();
        app.world_mut().write_message(ActionInvocation::scalar(
            control_level_action(3),
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
        assert!(take_pending_commands(&mut app).is_empty());
    }

    /// Verifies eval invocations submit tracked commands and announce their source.
    #[test]
    fn desk_eval_action_submits_command_and_source_notification() {
        let mut app = desk_action_app();
        app.world_mut().write_message(
            ActionInvocation::trigger(desk_eval_action("clip 1 go"), ActionSurface::Osc)
                .with_source("OSC 127.0.0.1:9000"),
        );

        app.update();

        let pending = take_pending_commands(&mut app);
        let [envelope] = pending.as_slice() else {
            panic!("eval invocation should queue one desk command");
        };
        assert!(matches!(
            envelope.payload.as_any().downcast_ref::<DeskCommand>(),
            Some(DeskCommand::Eval(value)) if value == "clip 1 go"
        ));
        assert!(
            app.world()
                .resource::<CommandTracker>()
                .is_active(envelope.command_id)
        );
        let notifications = app
            .world_mut()
            .resource_mut::<Messages<ExternalCommandInvocation>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].command_id, envelope.command_id);
        assert_eq!(notifications[0].source, "OSC 127.0.0.1:9000");
        assert!(matches!(
            take_invocation_result(&mut app).outcome,
            InvocationOutcome::Submitted { command_id } if command_id == envelope.command_id
        ));
    }
    /// Stores a toggle-mode playback rate master and returns its persistent UID.
    fn add_rate_master(app: &mut App) -> Uuid {
        let uid = Uuid::from_u128(41);
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(Master {
                identifiers: nightfall::prelude::Identifiers {
                    id: 4,
                    uid,
                    label: "Rate".to_string(),
                },
                kind: crate::masters::MasterKind::PlaybackRate,
                target: crate::masters::MasterTarget::Instances(
                    crate::masters::InstanceMasterTarget::All,
                ),
                mode: crate::masters::MasterMode::Toggle { active: false },
                level_percent: 100.0,
            })
            .expect("master should store");
        uid
    }

    /// Verifies master level input is scaled to the master kind's range as an untracked update.
    #[test]
    fn master_level_action_scales_rate_masters() {
        let mut app = desk_action_app();
        let uid = add_rate_master(&mut app);
        app.world_mut().write_message(ActionInvocation::scalar(
            master_level_action(uid),
            ActionSurface::Midi,
            0.75,
        ));

        app.update();

        let updates = app
            .world_mut()
            .resource_mut::<Messages<MasterUpdate>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            updates.as_slice(),
            [MasterUpdate::SetLevel { id: 4, level_percent }]
                if (*level_percent - 150.0).abs() < f32::EPSILON
        ));
        assert!(take_pending_commands(&mut app).is_empty());
    }

    /// Verifies master toggle resolves the master UID to a tracked toggle command.
    #[test]
    fn master_toggle_action_submits_toggle_command() {
        let mut app = desk_action_app();
        let uid = add_rate_master(&mut app);
        app.world_mut().write_message(ActionInvocation::trigger(
            master_toggle_action(uid),
            ActionSurface::Osc,
        ));

        app.update();

        let pending = take_pending_commands(&mut app);
        assert!(matches!(
            pending
                .as_slice()
                .first()
                .and_then(|envelope| envelope.payload.as_any().downcast_ref::<MasterCommand>()),
            Some(MasterCommand::ToggleMaster { id: 4 })
        ));
    }

    /// Verifies control Go lowers to the control Go command expanded later in the frame.
    #[test]
    fn control_go_action_submits_control_go_command() {
        let mut app = desk_action_app();
        app.world_mut().write_message(ActionInvocation::new(
            control_go_action(2),
            ActionSurface::Midi,
            nightfall_actions::ActionInput::Press,
        ));

        app.update();

        let pending = take_pending_commands(&mut app);
        assert!(matches!(
            pending
                .as_slice()
                .first()
                .and_then(|envelope| envelope.payload.as_any().downcast_ref::<ControlCommand>()),
            Some(ControlCommand::Go { control_index: 2 })
        ));
    }
}
