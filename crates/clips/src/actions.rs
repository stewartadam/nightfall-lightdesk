// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bindable clip lifecycle actions.
//!
//! The IDs and argument shapes are public so other domains can build references to clip
//! actions; [`register_clip_actions`] installs their handlers, timeline plans, and feedback.

use bevy_app::App;
use bevy_ecs::prelude::{Changed, Query, RemovedComponents, World};
use nightfall::prelude::IdExpr;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionFeedback, ActionId, ActionParameter, ActionParameterKind,
    ActionReference, ActionRegistry, InvocationError,
};
use nightfall_instances::InstanceControls;
use nightfall_playback_planner::{
    PlannedPlaybackInterventionKind, TimelinePlaybackActionKind, TimelinePlaybackActionPlan,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Clip, ClipCommand, InstanceIndex, MaterializedClip};

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

/// Stable action ID for setting a clip's playback speed.
pub const CLIP_SET_SPEED_ACTION_ID: &str = "clip.set-speed";

/// Stable action ID for firing every live launch waiting for the next beat or bar now.
pub const CLIP_LAUNCH_ARMED_ACTION_ID: &str = "clip.launch-armed";

/// Arguments for actions that take none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct NoArguments {}

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

/// Persisted arguments for setting a clip's playback speed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ClipSpeedActionArguments {
    /// Persistent UID of the addressed clip.
    #[typeshare(serialized_as = "String")]
    pub clip: Uuid,
    /// Playback clock speed multiplier.
    pub speed: f32,
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

/// Creates a persisted clip-speed action reference.
pub fn set_clip_speed_action(clip: Uuid, speed: f32) -> ActionReference {
    ActionReference::with_arguments(
        CLIP_SET_SPEED_ACTION_ID,
        &ClipSpeedActionArguments { clip, speed },
    )
    .expect("clip speed arguments should serialize")
}

/// Creates a clip lifecycle action reference with its typed clip argument.
fn clip_action_reference(action_id: &str, clip: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &ClipActionArguments { clip })
        .expect("clip action arguments should serialize")
}

/// Registers every bindable clip action, plus how stored bindings check their clip targets.
///
/// Binding diagnostics are recomputed whenever a clip is added, edited, or removed.
/// [`crate::ClipsPlugin`] calls this; focused apps without the plugin can call it directly.
/// Registering them again does nothing, so such an app can still add the plugin afterwards.
pub fn register_clip_actions(app: &mut App) {
    let already_registered = app
        .world()
        .get_resource::<ActionRegistry>()
        .is_some_and(|registry| registry.get(&ActionId::new(CLIP_START_ACTION_ID)).is_some());
    if already_registered {
        return;
    }
    app.register_action_target_validator::<Uuid, _>(ActionParameterKind::Clip, |world, uid| {
        resolve_clip_id(world, uid).map(drop)
    })
    .invalidate_action_targets_when(clips_changed);
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
    .register_action_feedback::<ClipGotoActionArguments, _>(
        CLIP_GOTO_ACTION_ID,
        |world, arguments| clip_feedback(world, arguments.clip),
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
    app.register_command_action::<NoArguments, ClipCommand, _>(
        ActionDescriptor::new(
            CLIP_LAUNCH_ARMED_ACTION_ID,
            "Launch armed clips now",
            "Clips",
        )
        .with_description(
            "Fires every clip waiting for the next beat or bar at once, skipping launch \
                 quantize",
        ),
        |_, _| Ok(ClipCommand::LaunchArmed),
    );
    app.register_command_action::<ClipSpeedActionArguments, ClipCommand, _>(
        ActionDescriptor::new(CLIP_SET_SPEED_ACTION_ID, "Set clip speed", "Clips")
            .with_description("Sets the playback speed multiplier of a running clip")
            .with_parameter(clip_parameter())
            .with_parameter(ActionParameter::required(
                "speed",
                "Speed",
                ActionParameterKind::Number { min: 0.0, max: 4.0 },
            )),
        |world, arguments| {
            Ok(ClipCommand::SetSpeed {
                clip_id: IdExpr::Single(resolve_clip_id(world, arguments.clip)?),
                speed: arguments.speed,
            })
        },
    )
    .register_action_capability::<ClipSpeedActionArguments, TimelinePlaybackActionPlan, _>(
        CLIP_SET_SPEED_ACTION_ID,
        TimelinePlaybackActionPlan::CAPABILITY,
        |arguments| {
            Ok(TimelinePlaybackActionPlan {
                owner_uid: arguments.clip,
                kind: TimelinePlaybackActionKind::SetSpeed(arguments.speed),
            })
        },
    );
}

/// Run condition reporting whether any clip was added, edited, or removed.
fn clips_changed(changed: Query<(), Changed<Clip>>, removed: RemovedComponents<Clip>) -> bool {
    !changed.is_empty() || !removed.is_empty()
}

/// Describes the clip argument shared by clip actions.
fn clip_parameter() -> ActionParameter {
    ActionParameter::required("clip", "Clip", ActionParameterKind::Clip)
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
    )
    .register_action_feedback::<ClipActionArguments, _>(&action_id, |world, arguments| {
        clip_feedback(world, arguments.clip)
    });
}

/// Reports a clip as active while it is running.
fn clip_feedback(world: &World, clip: Uuid) -> Result<ActionFeedback, InvocationError> {
    let clip_id = resolve_clip_id(world, clip)?;
    Ok(ActionFeedback::active_if(clip_live_state(world, clip_id).1))
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

/// Reads a clip's console level (percent) and whether it is running, from the live world.
///
/// A clip that is not running, or whose playback has no instance controls yet, reads as
/// level zero, matching the runtime state fader snapshots use.
pub fn clip_live_state(world: &World, clip_id: u32) -> (f32, bool) {
    let attached = world
        .try_query::<&MaterializedClip>()
        .and_then(|mut materialized| {
            materialized
                .iter(world)
                .find(|materialized| materialized.clip_id == clip_id)
                .map(|materialized| materialized.attached_instance)
        });
    let Some(attached) = attached else {
        return (0.0, false);
    };
    let level = world
        .get_resource::<InstanceIndex>()
        .and_then(|index| index.get(&attached))
        .and_then(|entity| world.get::<InstanceControls>(entity))
        .map_or(0.0, |controls| {
            (controls.intensity_scale * 100.0).clamp(0.0, 100.0)
        });
    (level, true)
}

#[cfg(test)]
mod tests {
    use bevy_ecs::change_detection::DetectChanges;
    use bevy_ecs::message::Messages;
    use nightfall_actions::{
        ActionInvocation, ActionSurface, ActionsPlugin, InvocationOutcome, InvocationResult,
    };
    use nightfall_engine::prelude::*;

    use super::*;

    /// Creates a focused app containing registry dispatch and the clip action registrations.
    fn clip_action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
        register_clip_actions(&mut app);
        app
    }

    /// Spawns a clip with the given numeric ID and persistent UID.
    fn spawn_clip(app: &mut App, id: u32, uid: Uuid) {
        app.world_mut().spawn(Clip {
            identifiers: nightfall::prelude::Identifiers {
                id,
                uid,
                label: format!("Clip {id}"),
            },
            ..Default::default()
        });
    }

    /// Verifies clip actions lower to tracked clip commands instead of runtime operations.
    #[test]
    fn clip_action_submits_tracked_clip_command() {
        let mut app = clip_action_app();
        let uid = Uuid::from_u128(7);
        spawn_clip(&mut app, 7, uid);
        app.world_mut().write_message(ActionInvocation::trigger(
            go_clip_action(uid),
            ActionSurface::Midi,
        ));

        app.update();

        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("registered action should emit an invocation result");
        let InvocationOutcome::Submitted { command_id } = result.outcome else {
            panic!("clip action should submit a tracked command");
        };
        let pending = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain();
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
        let app = clip_action_app();
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
        let app = clip_action_app();
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

    /// Verifies the clip target validator rejects a missing clip and accepts it once it exists.
    #[test]
    fn target_validation_resolves_clips() {
        let mut app = clip_action_app();
        let uid = Uuid::from_u128(8);
        /// Validates one reference's targets against the app's current world.
        fn validate(app: &App, action: &ActionReference) -> Result<(), InvocationError> {
            app.world()
                .resource::<nightfall_actions::ActionRegistry>()
                .validate_target(app.world(), action)
        }

        assert_eq!(
            validate(&app, &start_clip_action(uid)).map_err(|error| error.code),
            Err("clip.not_found".to_string())
        );
        spawn_clip(&mut app, 8, uid);
        assert!(validate(&app, &start_clip_action(uid)).is_ok());
    }

    /// Verifies removing a clip marks action targets changed so bindings are re-diagnosed.
    #[test]
    fn removing_a_clip_marks_action_targets_changed() {
        let mut app = clip_action_app();
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
}
