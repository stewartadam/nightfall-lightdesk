// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::cleanup::release_timeline_owned_entities;
use super::*;

/// Policy for resolving the timecode dependency of an atomic timeline creation.
pub(super) enum TimelineTimecodeStoreMode<'a> {
    /// Reuse a same-numbered timecode or create the proposed default.
    ReuseOrCreate(&'a Timecode),
    /// Restore the exact timecode previously owned by the timeline creation.
    RestoreOwned(&'a Timecode),
    /// Require the timeline's exact shared timecode to remain available.
    RequireShared,
}

/// Persisted objects produced by one successful atomic timeline creation.
pub(super) struct StoredTimelineCreation {
    /// Timeline linked to the resolved timecode UID.
    pub(super) timeline: Timeline,
    /// Timecode definition that should have a materialized generator.
    pub(super) timecode: Timecode,
}

/// Persist a timeline and its resolved timecode as one rollback-safe operation.
pub(super) fn store_timeline_creation(
    timelines: &mut DataProvider<Timeline>,
    timecodes: &mut DataProvider<Timecode>,
    timeline: &Timeline,
    timecode_mode: TimelineTimecodeStoreMode<'_>,
) -> Result<StoredTimelineCreation, String> {
    if timelines.from_id(timeline.identifiers.id).is_ok() {
        return Err(format!(
            "timeline with ID {} already exists",
            timeline.identifiers.id
        ));
    }
    if timelines.get(timeline.identifiers.uid).is_ok() {
        return Err(format!(
            "timeline with UID {} already exists",
            timeline.identifiers.uid
        ));
    }

    let (timecode, created_timecode) = match timecode_mode {
        TimelineTimecodeStoreMode::ReuseOrCreate(proposed) => {
            if let Ok(existing) = timecodes.from_id(proposed.identifiers.id) {
                ((*existing).clone(), false)
            } else {
                if timecodes.get(proposed.identifiers.uid).is_ok() {
                    return Err(format!(
                        "timecode with UID {} already exists under another ID",
                        proposed.identifiers.uid
                    ));
                }
                timecodes
                    .add(proposed.clone())
                    .map_err(|error| format!("failed to store timecode: {error}"))?;
                (proposed.clone(), true)
            }
        }
        TimelineTimecodeStoreMode::RestoreOwned(owned) => {
            if timecodes.from_id(owned.identifiers.id).is_ok()
                || timecodes.get(owned.identifiers.uid).is_ok()
            {
                return Err(format!(
                    "cannot restore owned timecode {} because its ID or UID is in use",
                    owned.identifiers.id
                ));
            }
            timecodes
                .add(owned.clone())
                .map_err(|error| format!("failed to restore timecode: {error}"))?;
            (owned.clone(), true)
        }
        TimelineTimecodeStoreMode::RequireShared => {
            let shared = timecodes
                .get(timeline.timecode_uid)
                .map_err(|error| format!("shared timeline timecode is unavailable: {error}"))?;
            ((*shared).clone(), false)
        }
    };

    let mut stored_timeline = timeline.clone();
    stored_timeline.timecode_uid = timecode.identifiers.uid;
    if let Err(error) = timelines.add(stored_timeline.clone()) {
        if created_timecode && let Err(rollback_error) = timecodes.remove(&timecode.identifiers.uid)
        {
            tracing::error!(
                %rollback_error,
                timecode_uid = %timecode.identifiers.uid,
                "Failed to roll back timecode after timeline creation failed"
            );
        }
        return Err(format!("failed to store timeline: {error}"));
    }

    Ok(StoredTimelineCreation {
        timeline: stored_timeline,
        timecode,
    })
}

/// Removes an exact created timeline and only the timecode UID it owns.
pub(super) fn remove_timeline_creation(
    timelines: &mut DataProvider<Timeline>,
    timecodes: &mut DataProvider<Timecode>,
    timeline_uid: Uuid,
    owned_timecode_uid: Option<Uuid>,
) -> Result<(Timeline, Option<Timecode>), String> {
    let timeline = timelines
        .get(timeline_uid)
        .map(|stored| (*stored).clone())
        .map_err(|error| format!("created timeline is unavailable: {error}"))?;

    let owned_timecode = if let Some(timecode_uid) = owned_timecode_uid {
        if timeline.timecode_uid != timecode_uid {
            return Err("created timeline no longer references its owned timecode".to_owned());
        }
        if timelines.iter().any(|other| {
            other.identifiers.uid != timeline_uid && other.timecode_uid == timecode_uid
        }) {
            return Err("owned timecode is now referenced by another timeline".to_owned());
        }
        Some(
            timecodes
                .get(timecode_uid)
                .map(|stored| (*stored).clone())
                .map_err(|error| format!("owned timeline timecode is unavailable: {error}"))?,
        )
    } else {
        timecodes
            .get(timeline.timecode_uid)
            .map_err(|error| format!("shared timeline timecode is unavailable: {error}"))?;
        None
    };

    timelines
        .remove(&timeline_uid)
        .map_err(|error| format!("failed to remove created timeline: {error}"))?;
    if let Some(timecode) = &owned_timecode
        && let Err(error) = timecodes.remove(&timecode.identifiers.uid)
    {
        if let Err(rollback_error) = timelines.add(timeline.clone()) {
            tracing::error!(
                %rollback_error,
                timeline_uid = %timeline.identifiers.uid,
                "Failed to restore timeline after owned timecode removal failed"
            );
        }
        return Err(format!("failed to remove owned timeline timecode: {error}"));
    }

    Ok((timeline, owned_timecode))
}

/// Materializes the objects persisted by an atomic timeline creation.
pub(super) fn materialize_timeline_creation(
    commands: &mut Commands,
    timecode_generators: &Query<(Entity, &TimecodeGenerator)>,
    stored: &StoredTimelineCreation,
) {
    let timecode_is_materialized = timecode_generators.iter().any(|(_, generator)| {
        generator.timecode.identifiers.uid == stored.timecode.identifiers.uid
    });
    if !timecode_is_materialized {
        commands.spawn(TimecodeGenerator::new(stored.timecode.clone()));
    }
    commands.spawn(MaterializedTimeline::new(stored.timeline.clone()));
}

/// Completes persistence, materialization, and optional beatgrid detection for a timeline creation.
pub(super) fn create_and_materialize_timeline(
    commands: &mut Commands,
    timelines: &mut DataProvider<Timeline>,
    timecodes: &mut DataProvider<Timecode>,
    timecode_generators: &Query<(Entity, &TimecodeGenerator)>,
    beatgrid_runtime: &mut crate::beatgrid_detection::BeatgridDetectionRuntime,
    broadcaster: &ClientEventSink,
    timeline: &Timeline,
    timecode_mode: TimelineTimecodeStoreMode<'_>,
) -> Result<(), String> {
    let stored = store_timeline_creation(timelines, timecodes, timeline, timecode_mode)?;
    materialize_timeline_creation(commands, timecode_generators, &stored);
    if !stored.timeline.audio_path.trim().is_empty() {
        crate::beatgrid_detection::request_detection_for_timeline(
            beatgrid_runtime,
            broadcaster,
            &stored.timeline,
            crate::beatgrid_detection::BeatgridDetectionTrigger::Automatic,
        );
    }
    Ok(())
}

/// Handle rollback-safe timeline creation, restoration, and deletion commands.
pub(super) fn handle_command(
    context: &mut TimelineMutationContext<'_, '_>,
    event: &CommandEnvelope<TimelineCommand>,
) {
    let TimelineMutationContext {
        commands,
        timelines,
        clip_query,
        instance_clocks,
        timeline_data_provider,
        timecode_store,
        recording,
        beatgrid_runtime,
        broadcaster,
        ev_clip,
        timeline_command_origins,
        responder,
        ..
    } = context;

    for event in std::iter::once(event) {
        match &event.command {
            TimelineCommand::CreateTimeline { timeline, timecode } => {
                let result = create_and_materialize_timeline(
                    commands,
                    timeline_data_provider,
                    &mut timecode_store.provider,
                    &timecode_store.generators,
                    beatgrid_runtime,
                    broadcaster,
                    timeline,
                    TimelineTimecodeStoreMode::ReuseOrCreate(timecode),
                );
                match result {
                    Ok(()) => {
                        succeed_timeline_command(responder, event.command_id);
                    }
                    Err(error) => {
                        tracing::warn!(%error, "Failed to create timeline");
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!("Failed to create timeline: {error}"),
                        );
                    }
                }
            }

            TimelineCommand::RestoreTimelineCreation {
                timeline,
                owned_timecode,
            } => {
                let timecode_mode = owned_timecode.as_ref().map_or(
                    TimelineTimecodeStoreMode::RequireShared,
                    TimelineTimecodeStoreMode::RestoreOwned,
                );
                let result = create_and_materialize_timeline(
                    commands,
                    timeline_data_provider,
                    &mut timecode_store.provider,
                    &timecode_store.generators,
                    beatgrid_runtime,
                    broadcaster,
                    timeline,
                    timecode_mode,
                );
                match result {
                    Ok(()) => {
                        succeed_timeline_command(responder, event.command_id);
                    }
                    Err(error) => {
                        tracing::warn!(%error, "Failed to restore timeline creation");
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!("Failed to restore timeline creation: {error}"),
                        );
                    }
                }
            }

            TimelineCommand::DeleteCreatedTimeline {
                timeline_uid,
                owned_timecode_uid,
            } => {
                let result = remove_timeline_creation(
                    timeline_data_provider,
                    &mut timecode_store.provider,
                    *timeline_uid,
                    *owned_timecode_uid,
                );
                match result {
                    Ok((timeline, owned_timecode)) => {
                        recording.states.remove(timeline.identifiers.id);
                        recording.sessions.remove(timeline.identifiers.id);
                        timelines
                            .iter_mut()
                            .filter(|(_, materialized)| {
                                materialized.timeline.identifiers.uid == *timeline_uid
                            })
                            .for_each(|(entity, materialized)| {
                                release_timeline_owned_entities(
                                    commands,
                                    clip_query,
                                    instance_clocks,
                                    ev_clip,
                                    timeline_command_origins,
                                    &materialized,
                                );
                                commands.entity(entity).despawn();
                            });
                        if let Some(timecode) = owned_timecode {
                            timecode_store
                                .generators
                                .iter()
                                .filter(|(_, generator)| {
                                    generator.timecode.identifiers.uid == timecode.identifiers.uid
                                })
                                .for_each(|(entity, _)| {
                                    commands.entity(entity).despawn();
                                });
                        }
                        succeed_timeline_command(responder, event.command_id);
                    }
                    Err(error) => {
                        tracing::warn!(%error, "Failed to delete created timeline");
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!("Failed to delete created timeline: {error}"),
                        );
                    }
                }
            }

            _ => return,
        }
    }
}
