// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Domain-owned bindable actions for desk clips, controls, and command evaluation.

use std::collections::BTreeSet;

use bevy_app::App;
use bevy_ecs::prelude::{Changed, DetectChanges, Local, Query, RemovedComponents, Res, World};
use nightfall::prelude::IdExpr;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionInputKind, ActionInvocation, ActionParameter,
    ActionParameterKind, ActionReference, ExternalCommandInvocation, InvocationDispatch,
    InvocationError, submit_command,
};
use nightfall_engine::prelude::*;
use nightfall_playback_planner::{
    PlannedPlaybackInterventionKind, TimelineEvalActionPlan, TimelinePlaybackActionKind,
    TimelinePlaybackActionPlan,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::clips::{Clip, ClipCommand};
use crate::controls::{ControlCommand, ControlUpdate, Controls};
use crate::desk_command::DeskCommand;
use crate::masters::{Master, MasterCommand, MasterMode, MasterUpdate};

/// Stable action ID for starting a clip.
pub const CLIP_START_ACTION_ID: &str = "clip.start";

/// Stable action ID for stopping a clip.
pub const CLIP_STOP_ACTION_ID: &str = "clip.stop";

/// Stable action ID for advancing a clip.
pub const CLIP_GO_ACTION_ID: &str = "clip.go";

/// Stable action ID for moving a sequence clip back one cue.
pub const CLIP_BACK_ACTION_ID: &str = "clip.back";

/// Stable action ID for jumping a sequence clip to a cue.
pub const CLIP_GOTO_ACTION_ID: &str = "clip.goto";

/// Stable action ID for setting a clip's playback rate.
pub const CLIP_SET_RATE_ACTION_ID: &str = "clip.set-rate";

/// Stable action ID for driving a control slot's level from external hardware input.
pub const CONTROL_LEVEL_ACTION_ID: &str = "control.level";

/// Stable action ID for running a control slot's Go behavior.
pub const CONTROL_GO_ACTION_ID: &str = "control.go";

/// Stable action ID for driving a master's level.
pub const MASTER_LEVEL_ACTION_ID: &str = "master.level";

/// Stable action ID for toggling a toggle-mode master.
pub const MASTER_TOGGLE_ACTION_ID: &str = "master.toggle";

/// Stable action ID for turning a toggle-mode master on.
pub const MASTER_ON_ACTION_ID: &str = "master.on";

/// Stable action ID for turning a toggle-mode master off.
pub const MASTER_OFF_ACTION_ID: &str = "master.off";

/// Stable action ID for evaluating a desk command.
pub const DESK_EVAL_ACTION_ID: &str = "desk.eval";

/// Persisted arguments shared by clip lifecycle actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
}

/// Persisted arguments for jumping a sequence clip to a cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipGotoActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
    /// One-based cue position to jump to.
    pub cue_index: u32,
}

/// Persisted arguments for setting a clip's playback rate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipRateActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
    /// Playback clock rate multiplier.
    pub rate: f32,
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
pub fn start_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_START_ACTION_ID, clip)
}

/// Creates a persisted stop-clip action reference.
pub fn stop_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_STOP_ACTION_ID, clip)
}

/// Creates a persisted go-clip action reference.
pub fn go_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_GO_ACTION_ID, clip)
}

/// Creates a persisted back-clip action reference.
pub fn back_clip_action(clip: Uuid) -> ActionReference {
    clip_action_reference(CLIP_BACK_ACTION_ID, clip)
}

/// Creates a persisted go-to-cue action reference.
pub fn goto_clip_action(clip: Uuid, cue_index: u32) -> ActionReference {
    ActionReference::with_arguments(
        CLIP_GOTO_ACTION_ID,
        &ClipGotoActionArguments { clip, cue_index },
    )
    .expect("clip goto arguments should serialize")
}

/// Creates a persisted clip-rate action reference.
pub fn set_clip_rate_action(clip: Uuid, rate: f32) -> ActionReference {
    ActionReference::with_arguments(
        CLIP_SET_RATE_ACTION_ID,
        &ClipRateActionArguments { clip, rate },
    )
    .expect("clip rate arguments should serialize")
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
    register_desk_target_validators(app);
    register_clip_action(
        app,
        ActionDescriptor::new(CLIP_START_ACTION_ID, "Start clip", "Clips")
            .with_hold_release(CLIP_STOP_ACTION_ID),
        ClipCommand::StartClip,
        TimelinePlaybackActionKind::Start,
    );
    register_clip_action(
        app,
        ActionDescriptor::new(CLIP_STOP_ACTION_ID, "Stop clip", "Clips"),
        ClipCommand::StopClip,
        TimelinePlaybackActionKind::Stop,
    );
    register_clip_action(
        app,
        ActionDescriptor::new(CLIP_GO_ACTION_ID, "Go clip", "Clips"),
        ClipCommand::GoClip,
        TimelinePlaybackActionKind::Intervene(PlannedPlaybackInterventionKind::SequenceGo),
    );
    register_clip_action(
        app,
        ActionDescriptor::new(CLIP_BACK_ACTION_ID, "Back clip", "Clips"),
        ClipCommand::BackClip,
        TimelinePlaybackActionKind::Intervene(PlannedPlaybackInterventionKind::SequenceBack),
    );
    app.register_command_action::<ClipGotoActionArguments, ClipCommand, _>(
        ActionDescriptor::new(CLIP_GOTO_ACTION_ID, "Go to cue", "Clips")
            .with_description("Jumps a sequence clip to a cue position")
            .with_parameter(clip_parameter())
            .with_parameter(ActionParameter::required(
                "cue_index",
                "Cue",
                ActionParameterKind::Integer { min: 1, max: None },
            )),
        |world, arguments| {
            Ok(ClipCommand::GotoClip {
                clip_id: IdExpr::Single(resolve_clip_id(world, arguments.clip)?),
                position: arguments.cue_index,
                timing: None,
            })
        },
    )
    .register_action_capability::<ClipGotoActionArguments, TimelinePlaybackActionPlan, _>(
        CLIP_GOTO_ACTION_ID,
        TimelinePlaybackActionPlan::CAPABILITY,
        |arguments| {
            Ok(TimelinePlaybackActionPlan {
                owner_uid: arguments.clip,
                kind: TimelinePlaybackActionKind::Intervene(
                    PlannedPlaybackInterventionKind::SequenceGotoCue(arguments.cue_index),
                ),
            })
        },
    );
    app.register_command_action::<ClipRateActionArguments, ClipCommand, _>(
        ActionDescriptor::new(CLIP_SET_RATE_ACTION_ID, "Set clip rate", "Clips")
            .with_description("Sets the playback rate multiplier of a running clip")
            .with_parameter(clip_parameter())
            .with_parameter(ActionParameter::required(
                "rate",
                "Rate",
                ActionParameterKind::Number { min: 0.0, max: 4.0 },
            )),
        |world, arguments| {
            Ok(ClipCommand::SetRate {
                clip_id: IdExpr::Single(resolve_clip_id(world, arguments.clip)?),
                rate: arguments.rate,
            })
        },
    )
    .register_action_capability::<ClipRateActionArguments, TimelinePlaybackActionPlan, _>(
        CLIP_SET_RATE_ACTION_ID,
        TimelinePlaybackActionPlan::CAPABILITY,
        |arguments| {
            Ok(TimelinePlaybackActionPlan {
                owner_uid: arguments.clip,
                kind: TimelinePlaybackActionKind::SetRate(arguments.rate),
            })
        },
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
    )
    .register_flash_level::<MasterActionArguments, _>(
        MASTER_LEVEL_ACTION_ID,
        |world, arguments| {
            let master = resolve_master(world, arguments.master)?;
            Ok(Some(
                Master::control_percent_from_level(master.kind, master.level_percent) / 100.0,
            ))
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
    for (action_id, label, active) in [
        (MASTER_ON_ACTION_ID, "Master on", true),
        (MASTER_OFF_ACTION_ID, "Master off", false),
    ] {
        let mut descriptor = ActionDescriptor::new(action_id, label, "Masters")
            .with_description("Turns a toggle-mode master on or off")
            .with_parameter(master_parameter());
        if active {
            descriptor = descriptor.with_hold_release(MASTER_OFF_ACTION_ID);
        }
        app.register_command_action::<MasterActionArguments, MasterCommand, _>(
            descriptor,
            move |world, arguments| set_master_active(world, arguments.master, active),
        );
    }
    app.register_action::<DeskEvalActionArguments, _>(
        ActionDescriptor::new(DESK_EVAL_ACTION_ID, "Evaluate command", "Desk")
            .with_description("Runs a desk command line as if it were typed")
            .with_parameter(ActionParameter::required(
                "command",
                "Command",
                ActionParameterKind::Text,
            )),
        invoke_desk_eval,
    )
    .register_action_capability::<DeskEvalActionArguments, TimelineEvalActionPlan, _>(
        DESK_EVAL_ACTION_ID,
        TimelineEvalActionPlan::CAPABILITY,
        |arguments| {
            Ok(TimelineEvalActionPlan {
                command: arguments.command,
            })
        },
    );
}

/// Registers how stored bindings check that their clip, master, and control targets exist.
///
/// Binding diagnostics are recomputed when clip entities, the set of masters, or the number
/// of control slots change.
fn register_desk_target_validators(app: &mut App) {
    app.register_action_target_validator::<Uuid, _>(ActionParameterKind::Clip, |world, uid| {
        resolve_clip_id(world, uid).map(drop)
    })
    .register_action_target_validator::<Uuid, _>(ActionParameterKind::Master, |world, uid| {
        resolve_master(world, uid).map(drop)
    })
    .register_action_target_validator::<u32, _>(ActionParameterKind::Control, validate_control)
    .invalidate_action_targets_when(clips_changed)
    .invalidate_action_targets_when(master_set_changed)
    .invalidate_action_targets_when(control_slot_count_changed);
}

/// Run condition reporting whether masters were added or removed.
///
/// Master levels change on every fader move and master targets only need to exist, so this
/// compares the set of master UIDs, and only on frames where masters changed at all.
fn master_set_changed(
    masters: Option<Res<DataProvider<Master>>>,
    mut last_uids: Local<Option<BTreeSet<Uuid>>>,
) -> bool {
    let Some(masters) = masters else {
        return last_uids.take().is_some();
    };
    if !masters.is_changed() && last_uids.is_some() {
        return false;
    }
    let uids: BTreeSet<Uuid> = masters.iter().map(|entry| *entry.key()).collect();
    let changed = last_uids.as_ref() != Some(&uids);
    *last_uids = Some(uids);
    changed
}

/// Run condition reporting whether any clip was added, edited, or removed.
fn clips_changed(changed: Query<(), Changed<Clip>>, removed: RemovedComponents<Clip>) -> bool {
    !changed.is_empty() || !removed.is_empty()
}

/// Run condition reporting whether the control bank gained or lost slots.
///
/// Controls change on every fader move, so this compares slot counts rather than change
/// ticks to avoid recomputing binding diagnostics while a fader is dragged.
fn control_slot_count_changed(
    controls: Option<Res<Controls>>,
    mut last_count: Local<Option<usize>>,
) -> bool {
    let count = controls.map(|controls| controls.slot_count());
    let changed = *last_count != count;
    *last_count = count;
    changed
}

/// Checks that a 1-based control index addresses a slot in the bank.
///
/// Unassigned slots are valid targets, since a binding follows whatever is later assigned.
fn validate_control(world: &World, control_index: u32) -> Result<(), InvocationError> {
    let controls = world.get_resource::<Controls>().ok_or_else(|| {
        InvocationError::new("control.bank_unavailable", "Controls are unavailable")
    })?;
    if controls.contains(control_index) {
        return Ok(());
    }
    Err(InvocationError::new(
        "control.not_found",
        format!(
            "Control {control_index} does not exist; controls are numbered 1 to {}",
            controls.slot_count()
        ),
    )
    .with_details(serde_json::json!({ "control_index": control_index })))
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

/// Describes the clip argument shared by clip actions.
fn clip_parameter() -> ActionParameter {
    ActionParameter::required("clip", "Clip", ActionParameterKind::Clip)
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
            .with_details(serde_json::json!({ "master": uid }))
        })
}

/// Lowers turning a toggle-mode master on or off to a mode change.
///
/// Masters in other modes are rejected so a held button never changes how a master works.
fn set_master_active(
    world: &World,
    uid: Uuid,
    active: bool,
) -> Result<MasterCommand, InvocationError> {
    let master = resolve_master(world, uid)?;
    if !matches!(master.mode, MasterMode::Toggle { .. }) {
        return Err(InvocationError::new(
            "master.not_toggle",
            format!(
                "Master '{}' is not a toggle master",
                master.identifiers.label
            ),
        )
        .with_details(serde_json::json!({ "master": uid })));
    }
    Ok(MasterCommand::SetMasterMode {
        id: master.identifiers.id,
        mode: MasterMode::Toggle { active },
    })
}

/// Creates a clip action reference for one stable action ID.
fn clip_action_reference(action_id: &str, clip: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &ClipActionArguments { clip })
        .expect("clip action arguments should serialize")
}

/// Registers one clip lifecycle action lowering to its clip command and timeline plan.
fn register_clip_action(
    app: &mut App,
    descriptor: ActionDescriptor,
    command: fn(IdExpr) -> ClipCommand,
    timeline_kind: TimelinePlaybackActionKind,
) {
    let action_id = descriptor.id.as_str().to_owned();
    app.register_command_action::<ClipActionArguments, ClipCommand, _>(
        descriptor.with_parameter(clip_parameter()),
        move |world, arguments| {
            let id = resolve_clip_id(world, arguments.clip)?;
            Ok(command(IdExpr::Single(id)))
        },
    )
    .register_action_capability::<ClipActionArguments, TimelinePlaybackActionPlan, _>(
        &action_id,
        TimelinePlaybackActionPlan::CAPABILITY,
        move |arguments| {
            Ok(TimelinePlaybackActionPlan {
                owner_uid: arguments.clip,
                kind: timeline_kind,
            })
        },
    );
}

/// Resolves a persisted clip UID to the numeric ID used by runtime commands.
///
/// Clips are stored as entities, so the lookup scans clip components.
fn resolve_clip_id(world: &World, uid: Uuid) -> Result<u32, InvocationError> {
    world
        .try_query::<&Clip>()
        .and_then(|mut clips| {
            clips
                .iter(world)
                .find(|clip| clip.identifiers.uid == uid)
                .map(|clip| clip.identifiers.id)
        })
        .ok_or_else(|| {
            InvocationError::new(
                "clip.not_found",
                format!("Clip with UID {uid} does not exist"),
            )
            .with_details(serde_json::json!({ "clip": uid }))
        })
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
    use bevy_ecs::change_detection::DetectChanges;
    use bevy_ecs::message::Messages;
    use nightfall_actions::{
        ActionInput, ActionSurface, ActionsPlugin, InvocationOutcome, InvocationResult,
    };

    use super::*;

    /// Creates a focused app containing registry dispatch and desk-owned action registrations.
    fn desk_action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.add_message::<ControlUpdate>();
        app.add_message::<MasterUpdate>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<Controls>();
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
        let uid = Uuid::from_u128(7);
        app.world_mut().spawn(Clip {
            identifiers: nightfall::prelude::Identifiers {
                id: 7,
                uid,
                label: "Clip 7".to_string(),
            },
            ..Default::default()
        });
        app.world_mut().write_message(ActionInvocation::trigger(
            go_clip_action(uid),
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

    /// Verifies Start clip declares Stop clip as its Hold release counterpart.
    #[test]
    fn start_clip_holds_until_stop_clip() {
        let app = desk_action_app();
        let registry = app.world().resource::<nightfall_actions::ActionRegistry>();
        let uid = Uuid::from_u128(7);

        assert_eq!(
            registry.hold_release_action(&start_clip_action(uid)),
            Some(stop_clip_action(uid))
        );
    }

    /// Verifies clip actions expose deterministic timeline plans keyed by the clip UID.
    #[test]
    fn clip_action_plans_timeline_playback() {
        let app = desk_action_app();
        let registry = app.world().resource::<nightfall_actions::ActionRegistry>();
        let uid = Uuid::new_v4();

        let plan = registry
            .resolve_capability::<TimelinePlaybackActionPlan>(&start_clip_action(uid))
            .expect("clip arguments should plan")
            .expect("clip actions should expose timeline planning");

        assert_eq!(
            plan,
            TimelinePlaybackActionPlan {
                owner_uid: uid,
                kind: TimelinePlaybackActionKind::Start,
            }
        );
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

    /// Verifies desk target validators report missing clips and masters and accept present ones.
    #[test]
    fn target_validation_resolves_clips_and_masters() {
        let mut app = desk_action_app();
        let clip_uid = Uuid::from_u128(8);
        let master_uid = Uuid::from_u128(41);
        /// Validates one reference's targets against the app's current world.
        fn validate(app: &App, action: &ActionReference) -> Result<(), InvocationError> {
            app.world()
                .resource::<nightfall_actions::ActionRegistry>()
                .validate_target(app.world(), action)
        }

        assert_eq!(
            validate(&app, &start_clip_action(clip_uid)).map_err(|error| error.code),
            Err("clip.not_found".to_string())
        );
        assert_eq!(
            validate(&app, &master_level_action(master_uid)).map_err(|error| error.code),
            Err("master.not_found".to_string())
        );

        app.world_mut().spawn(Clip {
            identifiers: nightfall::prelude::Identifiers {
                id: 8,
                uid: clip_uid,
                label: "Clip 8".to_string(),
            },
            ..Default::default()
        });
        add_rate_master(&mut app);

        assert!(validate(&app, &start_clip_action(clip_uid)).is_ok());
        assert!(validate(&app, &master_level_action(master_uid)).is_ok());
        assert!(validate(&app, &control_go_action(2)).is_ok());
    }

    /// Verifies control targets accept every slot in the bank, assigned or not, and reject
    /// indices outside `1..=slot_count`.
    #[test]
    fn target_validation_bounds_control_slots() {
        let app = desk_action_app();
        let registry = app.world().resource::<nightfall_actions::ActionRegistry>();
        let last = u32::try_from(app.world().resource::<Controls>().slot_count())
            .expect("slot count fits in u32");
        let code = |index| {
            registry
                .validate_target(app.world(), &control_go_action(index))
                .map_err(|error| error.code)
        };

        assert_eq!(code(1), Ok(()));
        assert_eq!(code(last), Ok(()));
        assert_eq!(code(0), Err("control.not_found".to_string()));
        assert_eq!(code(last + 1), Err("control.not_found".to_string()));
        assert_eq!(
            registry
                .validate_target(app.world(), &control_level_action(last + 1))
                .map_err(|error| error.code),
            Err("control.not_found".to_string())
        );
    }

    /// Verifies removing a clip marks action targets changed so bindings are re-diagnosed.
    #[test]
    fn removing_a_clip_marks_action_targets_changed() {
        let mut app = desk_action_app();
        let clip = app.world_mut().spawn(Clip::default()).id();
        app.update();
        app.update();
        let unchanged = app
            .world()
            .resource_ref::<nightfall_actions::ActionTargets>()
            .last_changed();

        app.world_mut().despawn(clip);
        app.update();

        assert!(
            app.world()
                .resource_ref::<nightfall_actions::ActionTargets>()
                .last_changed()
                .is_newer_than(unchanged, app.world().read_change_tick()),
            "clip removal should mark action targets changed"
        );
    }

    /// Verifies changing a master's level leaves action targets untouched, so dragging a
    /// master fader does not recompute binding diagnostics, while adding a master marks them.
    #[test]
    fn only_master_set_changes_mark_action_targets_changed() {
        let mut app = desk_action_app();
        let uid = add_rate_master(&mut app);
        app.update();
        app.update();
        /// Returns when action targets were last marked changed.
        fn targets_changed(app: &App) -> bevy_ecs::change_detection::Tick {
            app.world()
                .resource_ref::<nightfall_actions::ActionTargets>()
                .last_changed()
        }
        let settled = targets_changed(&app);

        let mut masters = app.world_mut().resource_mut::<DataProvider<Master>>();
        let mut master = masters.remove(&uid).expect("master should exist");
        master.level_percent = 40.0;
        masters.add(master).expect("master should store");
        app.update();
        assert_eq!(
            targets_changed(&app),
            settled,
            "a level change is not a target change"
        );

        let second = Master {
            identifiers: nightfall::prelude::Identifiers {
                id: 5,
                uid: Uuid::from_u128(42),
                label: "Second".to_string(),
            },
            ..app
                .world()
                .resource::<DataProvider<Master>>()
                .get(uid)
                .expect("master should exist")
                .clone()
        };
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(second)
            .expect("master should store");
        app.update();
        assert!(
            targets_changed(&app).is_newer_than(settled, app.world().read_change_tick()),
            "adding a master should mark action targets changed"
        );
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

    /// Verifies Master on and off set a toggle master's state and pair up for Hold.
    #[test]
    fn master_on_and_off_set_toggle_state() {
        let mut app = desk_action_app();
        let uid = add_rate_master(&mut app);
        let on = master_action_reference(MASTER_ON_ACTION_ID, uid);
        assert_eq!(
            app.world()
                .resource::<nightfall_actions::ActionRegistry>()
                .hold_release_action(&on),
            Some(master_action_reference(MASTER_OFF_ACTION_ID, uid))
        );
        for action in [on, master_action_reference(MASTER_OFF_ACTION_ID, uid)] {
            app.world_mut()
                .write_message(ActionInvocation::trigger(action, ActionSurface::Midi));
            app.update();
        }

        let modes = take_pending_commands(&mut app)
            .iter()
            .filter_map(|envelope| match envelope.payload.as_any().downcast_ref() {
                Some(MasterCommand::SetMasterMode { id: 4, mode }) => Some(mode.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            modes,
            vec![
                MasterMode::Toggle { active: true },
                MasterMode::Toggle { active: false }
            ]
        );
    }

    /// Verifies flashing a master pushes it to full and restores its level on release.
    #[test]
    fn master_level_flash_restores_the_previous_level() {
        let mut app = desk_action_app();
        let uid = add_rate_master(&mut app);
        for input in [ActionInput::Press, ActionInput::Release] {
            app.world_mut().write_message(ActionInvocation::new(
                master_level_action(uid),
                ActionSurface::Midi,
                input,
            ));
            app.update();
        }

        let levels = app
            .world_mut()
            .resource_mut::<Messages<MasterUpdate>>()
            .drain()
            .filter_map(|update| match update {
                MasterUpdate::SetLevel {
                    id: 4,
                    level_percent,
                } => Some(level_percent),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(levels, vec![200.0, 100.0]);
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
