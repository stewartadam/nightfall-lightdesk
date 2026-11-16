// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Which clips are running, and at which level, speed, cue and position, as live state a backup
//! copies from its primary.
//!
//! Clips that a timeline plays are left out on both sides: the timeline section reproduces
//! them from the timecode position.

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use bevy_ecs::prelude::*;
use nightfall::prelude::IdExpr;
use nightfall_engine::prelude::*;
use nightfall_instances::{
    InstanceClock, InstanceClockSource, InstanceControls, InstanceId, InstancePosition,
    InstanceStatus,
};
use nightfall_playback_planner::PlaybackReconstructionTiming;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Clip, ClipOperation, InstanceIndex, MaterializedClip};

/// Live state section key of running clips.
pub const CLIPS_LIVE_STATE: &str = "clips";

/// Playback position difference a backup tolerates before seeking a running clip.
const POSITION_TOLERANCE: Duration = Duration::from_millis(150);

/// Level or speed difference a backup tolerates before matching its primary's.
const CONTROL_TOLERANCE: f32 = 0.001;

/// One running clip as the primary plays it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveClip {
    /// Console-facing clip ID.
    pub clip_id: u32,
    /// Stable clip UID, so a backup with a different clip under that ID leaves it alone.
    pub clip_uid: Uuid,
    /// Intensity scale, 0 to 1.
    pub level: f32,
    /// Operator-set speed multiplier.
    pub speed: f32,
    /// Rate the clock advances at, including speed masters, used to tell where the clip has got
    /// to since the checkpoint.
    pub rate: f64,
    /// Source-local playback position.
    pub position: Duration,
    /// Whether the clock is frozen.
    pub frozen: bool,
    /// One-based cue for sequence playback.
    pub cue: Option<u32>,
    /// Time since the current cue's transition began, for sequence playback.
    pub transition_elapsed: Option<Duration>,
}

/// Restores a start waits for its playback to appear before the start is sent again.
const START_RETRY_RESTORES: u32 = 10;

/// Starts and stops the live restore sent on this backup and is waiting to see take effect, so
/// later checkpoints do not send them again.
#[derive(Resource, Debug, Default)]
pub struct PendingLiveClips {
    /// Clips started for the primary, waiting for their playback to appear so the captured level,
    /// speed and real-time clock can be applied to it, with the restores waited so far.
    starting: HashMap<u32, (LiveClip, u32)>,
    /// Clips stopped because the primary no longer runs them, still releasing here.
    stopping: HashSet<u32>,
}

/// A running clip on this engine with the playback it drives.
struct RunningClip {
    clip_uid: Option<Uuid>,
    instance: Entity,
}

/// Lists the clips running on this engine outside of timelines, by clip ID.
fn running_clips(world: &mut World) -> HashMap<u32, RunningClip> {
    let uids: HashMap<u32, Uuid> = world
        .query::<&Clip>()
        .iter(world)
        .map(|clip| (clip.identifiers.id, clip.identifiers.uid))
        .collect();
    let attached: Vec<(u32, InstanceId)> = world
        .query::<&MaterializedClip>()
        .iter(world)
        .map(|materialized| (materialized.clip_id, materialized.attached_instance))
        .collect();
    let Some(index) = world.get_resource::<InstanceIndex>() else {
        return HashMap::new();
    };
    attached
        .into_iter()
        .filter_map(|(clip_id, instance_id)| {
            let instance = index.get(&instance_id)?;
            let timeline_driven = world
                .get::<InstanceClock>(instance)
                .is_some_and(|clock| matches!(clock.source, InstanceClockSource::Timeline { .. }));
            (!timeline_driven).then(|| {
                (
                    clip_id,
                    RunningClip {
                        clip_uid: uids.get(&clip_id).copied(),
                        instance,
                    },
                )
            })
        })
        .collect()
}

/// Captures every running clip outside of timelines.
pub fn capture_live_clips(world: &mut World) -> Vec<LiveClip> {
    let mut clips: Vec<LiveClip> = running_clips(world)
        .into_iter()
        .filter_map(|(clip_id, running)| {
            let clock = world.get::<InstanceClock>(running.instance)?;
            let controls = world
                .get::<InstanceControls>(running.instance)
                .cloned()
                .unwrap_or_default();
            let status = world.get::<InstanceStatus>(running.instance);
            let cue = status.and_then(|status| match status.position {
                InstancePosition::Sequence {
                    current_position, ..
                } => Some(current_position),
                _ => None,
            });
            Some(LiveClip {
                clip_id,
                clip_uid: running.clip_uid?,
                level: controls.intensity_scale,
                speed: controls.speed,
                rate: clock.speed,
                position: clock.position,
                frozen: clock.frozen,
                cue,
                transition_elapsed: status.and_then(|status| status.transition_elapsed),
            })
        })
        .collect();
    clips.sort_by_key(|clip| clip.clip_id);
    clips
}

/// Reconciles this engine's running clips with the primary's: stops clips the primary is not
/// running, starts missing ones at their captured position, and corrects cue, level, speed and
/// position drift on clips both are running.
pub fn restore_live_clips(world: &mut World, clips: Vec<LiveClip>, context: LiveStateRestore) {
    let running = running_clips(world);
    let wanted: HashSet<u32> = clips.iter().map(|clip| clip.clip_id).collect();
    let mut pending = world
        .remove_resource::<PendingLiveClips>()
        .unwrap_or_default();
    pending
        .stopping
        .retain(|clip_id| running.contains_key(clip_id) && !wanted.contains(clip_id));
    for clip_id in running.keys().filter(|clip_id| !wanted.contains(clip_id)) {
        if pending.stopping.insert(*clip_id) {
            world.write_message(EngineOperationEnvelope::detached(ClipOperation::Stop(
                IdExpr::Single(*clip_id),
            )));
        }
    }

    let known_uids: HashMap<u32, Uuid> = world
        .query::<&Clip>()
        .iter(world)
        .map(|clip| (clip.identifiers.id, clip.identifiers.uid))
        .collect();
    let mut starting = HashMap::new();
    for clip in clips {
        if known_uids.get(&clip.clip_id) != Some(&clip.clip_uid) {
            continue;
        }
        match running.get(&clip.clip_id) {
            Some(local) => reconcile_running_clip(world, local.instance, &clip, context),
            None => {
                let waited = match pending.starting.remove(&clip.clip_id) {
                    Some((_, waited)) if waited < START_RETRY_RESTORES => waited + 1,
                    _ => {
                        start_live_clip(world, &clip, context);
                        0
                    }
                };
                starting.insert(clip.clip_id, (clip, waited));
            }
        }
    }
    pending.starting = starting;
    world.insert_resource(pending);
}

/// Position the primary's clip has reached by now.
fn expected_position(clip: &LiveClip, context: LiveStateRestore) -> Duration {
    if clip.frozen {
        clip.position
    } else {
        clip.position
            .saturating_add(context.age.mul_f64(clip.rate.max(0.0)))
    }
}

/// Starts a clip the primary is running, seeded at its captured cue and position.
fn start_live_clip(world: &mut World, clip: &LiveClip, context: LiveStateRestore) {
    let position = expected_position(clip, context);
    let operation = match clip.cue {
        Some(cue) => {
            let started_at = position.saturating_sub(clip.transition_elapsed.unwrap_or_default());
            ClipOperation::RenderAt {
                clip_id: IdExpr::Single(clip.clip_id),
                position: cue,
                timing: PlaybackReconstructionTiming::external_position(started_at, position),
                instance_options: None,
            }
        }
        None => ClipOperation::StartAtTiming {
            clip_id: IdExpr::Single(clip.clip_id),
            timing: PlaybackReconstructionTiming::external_position(Duration::ZERO, position),
            instance_options: None,
        },
    };
    world.write_message(EngineOperationEnvelope::detached(operation));
}

/// Brings a clip both engines run in line with the primary's cue, level, speed and position.
fn reconcile_running_clip(
    world: &mut World,
    instance: Entity,
    clip: &LiveClip,
    context: LiveStateRestore,
) {
    let local_cue =
        world
            .get::<InstanceStatus>(instance)
            .and_then(|status| match status.position {
                InstancePosition::Sequence {
                    current_position, ..
                } => Some(current_position),
                _ => None,
            });
    if let Some(cue) = clip.cue
        && local_cue != Some(cue)
    {
        world.write_message(EngineOperationEnvelope::detached(ClipOperation::Goto {
            clip_id: IdExpr::Single(clip.clip_id),
            position: cue,
            timing: None,
        }));
        return;
    }
    apply_controls(world, instance, clip);
    if clip.cue.is_some() {
        return;
    }
    let target = expected_position(clip, context);
    if let Some(mut clock) = world.get_mut::<InstanceClock>(instance)
        && clock.source == InstanceClockSource::Realtime
        && clock.position.abs_diff(target) > POSITION_TOLERANCE
    {
        clock.seek_to(target);
    }
}

/// Applies the primary's level, speed and freeze state to a playback, switching a clock the
/// restore seeded from an external position over to real time so it keeps running.
fn apply_controls(world: &mut World, instance: Entity, clip: &LiveClip) {
    let Some(mut controls) = world.get_mut::<InstanceControls>(instance) else {
        return;
    };
    if (controls.intensity_scale - clip.level).abs() > CONTROL_TOLERANCE {
        controls.intensity_scale = clip.level.clamp(0.0, 1.0);
    }
    let speed_changed = (controls.speed - clip.speed).abs() > CONTROL_TOLERANCE;
    if speed_changed {
        controls.set_speed(clip.speed);
    }
    let effective_speed = controls.effective_speed();
    if let Some(mut clock) = world.get_mut::<InstanceClock>(instance) {
        if clock.source == InstanceClockSource::ExternalPosition {
            clock.source = InstanceClockSource::Realtime;
        }
        if speed_changed {
            clock.set_speed(effective_speed);
        }
        if clip.frozen && !clock.frozen {
            clock.freeze();
        } else if !clip.frozen && clock.frozen && effective_speed > 0.0 {
            clock.unfreeze();
        }
    }
}

/// Applies level, speed and a running clock to clips the live restore started once their
/// playback exists, then forgets them.
pub fn settle_pending_live_clips(world: &mut World) {
    let Some(pending) = world
        .get_resource::<PendingLiveClips>()
        .filter(|pending| !pending.starting.is_empty())
        .map(|pending| pending.starting.keys().copied().collect::<Vec<_>>())
    else {
        return;
    };
    let running = running_clips(world);
    for clip_id in pending {
        let Some(local) = running.get(&clip_id) else {
            continue;
        };
        let Some((clip, _)) = world
            .resource_mut::<PendingLiveClips>()
            .starting
            .remove(&clip_id)
        else {
            continue;
        };
        apply_controls(world, local.instance, &clip);
    }
}
