// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::{App, Update};
use bevy_ecs::message::Messages;
use nightfall::prelude::Identifiers;
use nightfall_clips::Clip;
use nightfall_compositor::prelude::ReleaseMarker;
use nightfall_instances::InstanceId;
use nightfall_timecode::prelude::Timecode;

use super::*;
use crate::components::{MaterializedTimeline, SpawnedEntityType};
use crate::recording::TimelineCommandOrigins;

#[derive(Resource, Default)]
struct ObservedTimelineActions(Vec<TimelineAction>);

/// Builds a focused app for testing direct timeline command completion.
fn timeline_runtime_command_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<TimelineCommand>>();
    app.add_message::<EngineActionEnvelope<TimelineAction>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.add_systems(Update, handle_timeline_events);
    app
}

/// Registers and submits one semantic timeline command.
fn submit_timeline_runtime_command(app: &mut App, command: TimelineCommand) -> CommandId {
    let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
    let command_id = envelope.command_id;
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("timeline command should register");
    app.world_mut().write_message(envelope);
    command_id
}

/// Verifies a runtime timeline command succeeds only after its target is updated.
#[test]
fn start_timeline_returns_success_after_activation() {
    let mut app = timeline_runtime_command_app();
    app.world_mut()
        .spawn(MaterializedTimeline::new(timeline(7, 0x700, "Timeline 7")));
    let command_id = submit_timeline_runtime_command(&mut app, TimelineCommand::StartTimeline(7));

    app.update();

    let timeline = app
        .world_mut()
        .query::<&MaterializedTimeline>()
        .single(app.world())
        .expect("materialized timeline should exist");
    assert!(timeline.is_active);
    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("tracked timeline command should finish");
    assert_eq!(result.command_id, command_id);
    assert_eq!(result.outcome, CommandOutcome::succeeded());
}

/// Verifies a missing runtime target returns a structured terminal failure.
#[test]
fn start_missing_timeline_returns_failure() {
    let mut app = timeline_runtime_command_app();
    let command_id = submit_timeline_runtime_command(&mut app, TimelineCommand::StartTimeline(404));

    app.update();

    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("tracked timeline command should finish");
    assert_eq!(result.command_id, command_id);
    let CommandOutcome::Failed(error) = result.outcome else {
        panic!("missing timeline should fail");
    };
    assert_eq!(error.code, "timeline.command_failed");
    assert!(error.message.contains("404"));
}

/// Wraps a timecode command with detached lifecycle context for event tests.
fn timecode_command(command: TimecodeCommand) -> TimecodeEvent {
    match command {
        TimecodeCommand::StartTimecode(id) => TimecodeEvent::Started(id),
        TimecodeCommand::PauseTimecode(id) => TimecodeEvent::Paused(id),
        TimecodeCommand::StopTimecode(id) => TimecodeEvent::Stopped(id),
        TimecodeCommand::SeekTimecode { id, position } => TimecodeEvent::Seeked { id, position },
        TimecodeCommand::DeleteTimecode(id) => TimecodeEvent::Deleted(id),
        TimecodeCommand::StoreTimecode(_) | TimecodeCommand::RenameTimecode { .. } => {
            panic!("CRUD commands are not runtime timecode events")
        }
    }
}

/// Records timeline actions emitted during a test schedule.
fn record_timeline_actions(
    mut events: MessageReader<EngineActionEnvelope<TimelineAction>>,
    mut observed: ResMut<ObservedTimelineActions>,
) {
    observed
        .0
        .extend(events.read().map(|event| event.action.clone()));
}

/// Verifies persisted beatgrid tempos keep useful detector precision.
#[test]
fn applied_beatgrid_bpm_preserves_fractional_tempo() {
    assert_eq!(applied_beatgrid_bpm(128.5), 128.5);
}

/// Verifies persisted beatgrid tempos stay within playback-safe bounds.
#[test]
fn applied_beatgrid_bpm_clamps_out_of_range_values() {
    assert_eq!(applied_beatgrid_bpm(0.25), 1.0);
    assert_eq!(applied_beatgrid_bpm(420.5), 300.0);
    assert_eq!(applied_beatgrid_bpm(f32::NAN), 1.0);
}

#[test]
fn millis_delta_clamps_at_timeline_start() {
    assert_eq!(
        apply_millis_delta_clamped(Duration::from_millis(100), -250),
        Duration::ZERO
    );
}

#[test]
fn millis_delta_preserves_region_span_when_start_clamps() {
    let (start, end) = apply_millis_delta_preserve_span(
        Duration::from_millis(100),
        Duration::from_millis(600),
        -250,
    );

    assert_eq!(start, Duration::ZERO);
    assert_eq!(end, Duration::from_millis(500));
}

#[test]
fn store_timeline_marks_audio_sync_when_audio_enabled_changes() {
    let timeline_id = 44;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-44".to_owned(),
        },
        audio_enabled: true,
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline.clone());
    materialized.is_active = true;

    apply_stored_timeline_to_materialized(
        &mut materialized,
        &Timeline {
            audio_enabled: false,
            ..timeline
        },
    );

    assert!(
        !materialized.timeline.audio_enabled,
        "stored timeline should apply the disabled audio flag"
    );
    assert!(
        materialized.audio_needs_sync,
        "audio toggle should request a sync so the audio system stops existing sinks"
    );
}

/// Verifies accepted active timeline stores request live playback reconstruction.
#[test]
fn store_timeline_action_change_requests_reconstruction_event() {
    let clip_uid = Uuid::new_v4();
    let mut timeline = timeline(45, 45, "timeline-45");
    timeline.tracks = vec![Track {
        id: "track-1".to_owned(),
        label: "Track 1".to_owned(),
        muted: false,
        solo: false,
        expanded: false,
        actions: vec![Action {
            id: "action-start".to_owned(),
            label: "Start".to_owned(),
            position: Duration::from_secs(1),
            duration: Duration::ZERO,
            action: ActionKind::StartClip(clip_uid),
        }],
        automation_lanes: Vec::new(),
    }];
    let mut materialized = MaterializedTimeline::new(timeline.clone());
    materialized.activate();

    timeline.tracks[0].actions[0].position = Duration::from_secs(2);

    assert!(apply_stored_timeline_to_materialized(
        &mut materialized,
        &timeline
    ));
    assert_eq!(
        materialized.timeline.tracks[0].actions[0].position,
        Duration::from_secs(2),
        "stored timeline should apply the changed action before reconstruction"
    );
}

/// Verifies active timeline action order changes request live playback reconstruction.
#[test]
fn store_timeline_action_reorder_requests_reconstruction_event() {
    let first_clip_uid = Uuid::new_v4();
    let second_clip_uid = Uuid::new_v4();
    let mut timeline = timeline(46, 46, "timeline-46");
    timeline.tracks = vec![Track {
        id: "track-1".to_owned(),
        label: "Track 1".to_owned(),
        muted: false,
        solo: false,
        expanded: false,
        actions: vec![
            Action {
                id: "action-first".to_owned(),
                label: "First".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(first_clip_uid),
            },
            Action {
                id: "action-second".to_owned(),
                label: "Second".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(second_clip_uid),
            },
        ],
        automation_lanes: Vec::new(),
    }];
    let mut materialized = MaterializedTimeline::new(timeline.clone());
    materialized.activate();

    timeline.tracks[0].actions.reverse();

    assert!(
        apply_stored_timeline_to_materialized(&mut materialized, &timeline),
        "reordering simultaneous active actions should request live action reconstruction"
    );
}

/// Verifies clip start duration edits do not request live playback reconstruction.
#[test]
fn store_timeline_start_action_duration_change_does_not_request_reconstruction_event() {
    let clip_uid = Uuid::new_v4();
    let registered_clip_uid = Uuid::new_v4();
    let mut timeline = timeline(47, 47, "timeline-47");
    timeline.tracks = vec![Track {
        id: "track-1".to_owned(),
        label: "Track 1".to_owned(),
        muted: false,
        solo: false,
        expanded: false,
        actions: vec![
            Action {
                id: "action-start".to_owned(),
                label: "Start".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::from_secs(1),
                action: ActionKind::StartClip(clip_uid),
            },
            Action {
                id: "action-registered-start".to_owned(),
                label: "Registered start".to_owned(),
                position: Duration::from_secs(2),
                duration: Duration::from_secs(1),
                action: ActionKind::RegisteredAction(start_clip_action(ClipTarget::Uid(
                    registered_clip_uid,
                ))),
            },
        ],
        automation_lanes: Vec::new(),
    }];

    let mut builtin_duration_timeline = timeline.clone();
    let mut materialized = MaterializedTimeline::new(timeline.clone());
    materialized.activate();
    builtin_duration_timeline.tracks[0].actions[0].duration = Duration::from_secs(2);

    assert!(
        !apply_stored_timeline_to_materialized(&mut materialized, &builtin_duration_timeline),
        "built-in clip start duration changes should not request reconstruction"
    );

    let mut registered_duration_timeline = timeline.clone();
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    registered_duration_timeline.tracks[0].actions[1].duration = Duration::from_secs(2);

    assert!(
        !apply_stored_timeline_to_materialized(&mut materialized, &registered_duration_timeline),
        "registered clip start duration changes should not request reconstruction"
    );
}

/// Verifies non-action active timeline stores do not request live action reconstruction.
#[test]
fn store_timeline_marker_change_does_not_request_reconstruction_event() {
    let mut timeline = timeline(48, 48, "timeline-48");
    timeline.tracks = vec![Track {
        id: "track-1".to_owned(),
        label: "Track 1".to_owned(),
        muted: false,
        solo: false,
        expanded: false,
        actions: vec![Action {
            id: "action-desk".to_owned(),
            label: "Desk eval".to_owned(),
            position: Duration::from_secs(1),
            duration: Duration::ZERO,
            action: ActionKind::DeskEval("go sequence".to_owned()),
        }],
        automation_lanes: Vec::new(),
    }];
    let mut materialized = MaterializedTimeline::new(timeline.clone());
    materialized.activate();

    timeline.markers.push(TimelineMarker {
        uid: Uuid::new_v4(),
        label: "Marker".to_owned(),
        time: Duration::from_secs(2),
        color: None,
    });

    assert!(
        !apply_stored_timeline_to_materialized(&mut materialized, &timeline),
        "marker-only stores should not request live action reconstruction"
    );
}

/// Builds a minimal timeline definition for timeline event tests.
fn timeline(id: u32, uid: u128, label: &str) -> Timeline {
    Timeline {
        identifiers: Identifiers {
            id,
            uid: Uuid::from_u128(uid),
            label: label.to_owned(),
        },
        ..Default::default()
    }
}

/// Builds a minimal timecode definition for timeline event tests.
fn timecode(id: u32, uid: u128, label: &str) -> Timecode {
    Timecode {
        identifiers: Identifiers {
            id,
            uid: Uuid::from_u128(uid),
            label: label.to_owned(),
        },
        ..Default::default()
    }
}

/// Verifies timeline creation links to the UID of an existing same-numbered timecode.
#[test]
fn timeline_creation_reuses_existing_same_numbered_timecode() {
    let mut timelines = DataProvider::<Timeline>::default();
    let mut timecodes = DataProvider::<Timecode>::default();
    let existing_timecode = timecode(7, 0x70, "Existing Timecode");
    let existing_timecode_uid = existing_timecode.identifiers.uid;
    timecodes
        .add(existing_timecode)
        .expect("existing timecode should be stored");
    let proposed_timecode = timecode(7, 0x71, "Proposed Timecode");
    let proposed_timeline = timeline(7, 0x700, "Timeline 7");

    let stored = store_timeline_creation(
        &mut timelines,
        &mut timecodes,
        &proposed_timeline,
        TimelineTimecodeStoreMode::ReuseOrCreate(&proposed_timecode),
    )
    .expect("timeline creation should reuse the existing timecode");

    assert_eq!(stored.timeline.timecode_uid, existing_timecode_uid);
    assert_eq!(stored.timecode.identifiers.uid, existing_timecode_uid);
    assert_eq!(timecodes.iter().count(), 1);
}

/// Verifies undoing a timeline linked to a shared timecode preserves that timecode.
#[test]
fn timeline_creation_removal_preserves_shared_timecode() {
    let mut timelines = DataProvider::<Timeline>::default();
    let mut timecodes = DataProvider::<Timecode>::default();
    let shared_timecode = timecode(8, 0x80, "Shared Timecode");
    let shared_timecode_uid = shared_timecode.identifiers.uid;
    timecodes
        .add(shared_timecode)
        .expect("shared timecode should be stored");
    let proposed_timecode = timecode(8, 0x81, "Proposed Timecode");
    let proposed_timeline = timeline(8, 0x800, "Timeline 8");
    let stored = store_timeline_creation(
        &mut timelines,
        &mut timecodes,
        &proposed_timeline,
        TimelineTimecodeStoreMode::ReuseOrCreate(&proposed_timecode),
    )
    .expect("timeline creation should succeed");

    remove_timeline_creation(
        &mut timelines,
        &mut timecodes,
        stored.timeline.identifiers.uid,
        None,
    )
    .expect("created timeline should be removed");

    assert!(
        timelines.from_id(8).is_err(),
        "the created timeline should be deleted"
    );
    assert_eq!(
        timecodes
            .get(shared_timecode_uid)
            .expect("shared timecode should remain")
            .identifiers
            .uid,
        shared_timecode_uid
    );
}

/// Verifies undoing a timeline removes the exact timecode created with it.
#[test]
fn timeline_creation_removal_deletes_owned_timecode() {
    let mut timelines = DataProvider::<Timeline>::default();
    let mut timecodes = DataProvider::<Timecode>::default();
    let proposed_timecode = timecode(9, 0x90, "Owned Timecode");
    let proposed_timeline = timeline(9, 0x900, "Timeline 9");
    let stored = store_timeline_creation(
        &mut timelines,
        &mut timecodes,
        &proposed_timeline,
        TimelineTimecodeStoreMode::ReuseOrCreate(&proposed_timecode),
    )
    .expect("timeline creation should create both objects");

    let (_, removed_timecode) = remove_timeline_creation(
        &mut timelines,
        &mut timecodes,
        stored.timeline.identifiers.uid,
        Some(proposed_timecode.identifiers.uid),
    )
    .expect("created timeline and owned timecode should be removed");

    assert!(timelines.from_id(9).is_err());
    assert!(timecodes.from_id(9).is_err());
    assert_eq!(
        removed_timecode
            .expect("owned timecode should be returned")
            .identifiers
            .uid,
        proposed_timecode.identifiers.uid
    );
}

/// Returns a materialized timeline linked to the requested timecode UID.
fn active_timeline_for_timecode(
    timeline_id: u32,
    timeline_uid: u128,
    timecode_uid: Uuid,
    trigger_mode: TimelineTriggerMode,
) -> MaterializedTimeline {
    let mut materialized = MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::from_u128(timeline_uid),
            label: format!("Timeline {timeline_id}"),
        },
        timecode_uid,
        trigger_mode,
        ..Default::default()
    });
    materialized.is_active = true;
    materialized.audio_needs_sync = false;
    materialized
}

/// Verifies deleting a timecode stops active timelines using that timecode.
#[test]
fn delete_timecode_stops_associated_timelines() {
    let mut app = App::new();
    app.add_message::<TimecodeEvent>();
    app.add_message::<CommandEnvelope<TimelineCommand>>();
    app.add_message::<EngineActionEnvelope<TimelineAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<ObservedTimelineActions>();
    app.add_systems(
        Update,
        (
            handle_timecode_events,
            record_timeline_actions,
            handle_timeline_events,
            crate::systems::cleanup_timeline_entities,
        )
            .chain(),
    );
    let deleted_timecode = timecode(42, 0x420, "Deleted Timecode");
    let deleted_timecode_uid = deleted_timecode.identifiers.uid;
    let other_timecode = timecode(43, 0x430, "Other Timecode");
    let other_timecode_uid = other_timecode.identifiers.uid;
    let timeline_spawned_cue = app.world_mut().spawn_empty().id();
    let mut follow_materialized = active_timeline_for_timecode(
        101,
        0x101,
        deleted_timecode_uid,
        TimelineTriggerMode::FollowTimecode,
    );
    follow_materialized.spawned_entities.insert(
        timeline_spawned_cue,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Cue,
        ),
    );
    let follow_timeline = app.world_mut().spawn(follow_materialized).id();
    let manual_timeline = app
        .world_mut()
        .spawn(active_timeline_for_timecode(
            102,
            0x102,
            deleted_timecode_uid,
            TimelineTriggerMode::Manual,
        ))
        .id();
    let unrelated_timeline = app
        .world_mut()
        .spawn(active_timeline_for_timecode(
            103,
            0x103,
            other_timecode_uid,
            TimelineTriggerMode::FollowTimecode,
        ))
        .id();
    app.world_mut()
        .spawn(TimecodeGenerator::new(deleted_timecode));
    app.world_mut()
        .spawn(TimecodeGenerator::new(other_timecode));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::DeleteTimecode(42)));
    app.update();

    let observed = &app.world().resource::<ObservedTimelineActions>().0;
    assert!(
        observed
            .iter()
            .any(|action| matches!(action, TimelineAction::Stop(101))),
        "deleting the timecode should issue a stop action for the follow-timecode timeline"
    );
    assert!(
        observed
            .iter()
            .any(|action| matches!(action, TimelineAction::Stop(102))),
        "deleting the timecode should issue a stop action for the manual timeline using that timecode"
    );
    assert!(
        observed
            .iter()
            .all(|action| !matches!(action, TimelineAction::Stop(103))),
        "deleting the timecode should not stop timelines using a different timecode"
    );

    let follow = app
        .world()
        .get::<MaterializedTimeline>(follow_timeline)
        .expect("follow-timecode timeline should remain materialized");
    assert!(!follow.is_active);
    assert!(follow.audio_needs_sync);
    assert!(
        follow.spawned_entities.is_empty(),
        "stop cleanup should clear timeline-owned spawned entity tracking"
    );
    assert!(
        app.world()
            .get::<ReleaseMarker>(timeline_spawned_cue)
            .is_some(),
        "deleting the timecode should release timeline-owned cue output"
    );

    let manual = app
        .world()
        .get::<MaterializedTimeline>(manual_timeline)
        .expect("manual timeline should remain materialized");
    assert!(!manual.is_active);
    assert!(manual.audio_needs_sync);

    let unrelated = app
        .world()
        .get::<MaterializedTimeline>(unrelated_timeline)
        .expect("unrelated timeline should remain materialized");
    assert!(unrelated.is_active);
    assert!(!unrelated.audio_needs_sync);
}

/// Runs the timeline-owned entity release helper once in a schedule.
fn run_release_timeline_owned_entities(
    mut commands: Commands,
    clip_query: Query<&Clip>,
    mut instance_clocks: Query<(Option<&mut InstanceClock>, Option<&mut InstanceControls>)>,
    mut ev_clip: MessageWriter<EngineActionEnvelope<ClipAction>>,
    mut timeline_command_origins: ResMut<TimelineCommandOrigins>,
    timelines: Query<&MaterializedTimeline>,
) {
    for timeline in &timelines {
        release_timeline_owned_entities(
            &mut commands,
            &clip_query,
            &mut instance_clocks,
            &mut ev_clip,
            &mut timeline_command_origins,
            timeline,
        );
    }
}

/// Creates an app with the resources needed to release timeline-owned entities.
fn release_test_app() -> App {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.init_resource::<TimelineCommandOrigins>();
    app
}

/// Verifies timeline deletion releases timeline-owned cue instances.
#[test]
fn delete_timeline_releases_owned_cue_instances() {
    let mut app = release_test_app();
    let timeline_uid = Uuid::from_u128(0x100);
    let playback = app
        .world_mut()
        .spawn((
            InstanceClock {
                source: InstanceClockSource::Timeline {
                    timeline_uid,
                    started_at_timeline: Duration::ZERO,
                },
                ..Default::default()
            },
            InstanceControls {
                intensity_scale: 1.0,
                rate: 0.0,
                ..Default::default()
            },
        ))
        .id();
    let mut materialized_timeline = MaterializedTimeline::new(timeline(1, 0x100, "Timeline"));
    materialized_timeline.spawned_entities.insert(
        playback,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Cue,
        ),
    );
    app.world_mut().spawn(materialized_timeline);
    app.add_systems(Update, run_release_timeline_owned_entities);

    app.update();

    assert!(app.world().get::<ReleaseMarker>(playback).is_some());
    let clock = app
        .world()
        .get::<InstanceClock>(playback)
        .expect("clock should remain attached");
    assert!(matches!(clock.source, InstanceClockSource::Realtime));
    assert_eq!(
        app.world()
            .get::<InstanceControls>(playback)
            .expect("controls should remain attached")
            .rate,
        1.0
    );
}

/// Verifies timeline deletion sends stop commands for timeline-owned clips.
#[test]
fn delete_timeline_stops_owned_clip_instances() {
    let mut app = release_test_app();
    let clip = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 77,
                uid: Uuid::from_u128(0x777),
                label: "Clip".to_owned(),
            },
            ..Default::default()
        })
        .id();
    let mut materialized_timeline = MaterializedTimeline::new(timeline(1, 0x100, "Timeline"));
    materialized_timeline.spawned_entities.insert(
        clip,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    app.world_mut().spawn(materialized_timeline);
    app.add_systems(Update, run_release_timeline_owned_entities);

    app.update();

    let events = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect::<Vec<_>>();
    assert!(matches!(
        events.as_slice(),
        [ClipAction::Stop(IdExpr::Single(77))]
    ));
}

/// Verifies timeline deletion despawns timeline-owned planner playback entities.
#[test]
fn delete_timeline_despawns_owned_planner_instances() {
    let mut app = release_test_app();
    let playback = app
        .world_mut()
        .spawn((InstanceId::new(), ReleaseMarker::default()))
        .id();
    let mut materialized_timeline = MaterializedTimeline::new(timeline(1, 0x100, "Timeline"));
    materialized_timeline.spawned_entities.insert(
        playback,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Instance,
        ),
    );
    app.world_mut().spawn(materialized_timeline);
    app.add_systems(Update, run_release_timeline_owned_entities);

    app.update();

    assert!(!app.world().entities().contains(playback));
}
