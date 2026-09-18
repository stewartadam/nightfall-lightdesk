// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Stop, release, or despawn entities owned by a timeline before removing its runtime.
pub(super) fn release_timeline_owned_entities(
    commands: &mut Commands,
    clip_query: &Query<&Clip>,
    instance_clocks: &mut Query<(Option<&mut InstanceClock>, Option<&mut InstanceControls>)>,
    ev_clip: &mut MessageWriter<EngineActionEnvelope<ClipAction>>,
    timeline_command_origins: &mut TimelineCommandOrigins,
    timeline: &MaterializedTimeline,
) {
    for (entity, (track_id, action_id, spawned_type)) in &timeline.spawned_entities {
        match spawned_type {
            SpawnedEntityType::Clip => {
                let Ok(clip) = clip_query.get(*entity) else {
                    tracing::warn!(
                        ?entity,
                        track_id,
                        action_id,
                        "Clip entity no longer exists for deleted timeline action"
                    );
                    continue;
                };
                write_timeline_clip_action(
                    ev_clip,
                    timeline_command_origins,
                    ClipAction::Stop(IdExpr::Single(clip.identifiers.id)),
                );
            }
            SpawnedEntityType::Cue => {
                detach_timeline_sourced_clock(*entity, instance_clocks);
                commands.entity(*entity).insert(ReleaseMarker::default());
            }
            SpawnedEntityType::Instance => {
                commands.entity(*entity).despawn();
            }
        }
    }
}

/// Converts timeline-sourced playback clocks to realtime before their owning timeline is removed.
fn detach_timeline_sourced_clock(
    entity: Entity,
    instance_clocks: &mut Query<(Option<&mut InstanceClock>, Option<&mut InstanceControls>)>,
) {
    let Ok((clock, controls)) = instance_clocks.get_mut(entity) else {
        return;
    };
    let Some(mut clock) = clock else {
        return;
    };
    if !matches!(clock.source, InstanceClockSource::Timeline { .. }) {
        return;
    }

    let release_rate = controls
        .as_ref()
        .map(|controls| controls.effective_rate())
        .filter(|rate| *rate > 0.0)
        .unwrap_or(1.0);
    clock.source = InstanceClockSource::Realtime;
    clock.set_rate(release_rate);

    if let Some(mut controls) = controls {
        controls.set_rate(release_rate as f32);
    }
}
