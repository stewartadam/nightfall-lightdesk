// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

#[test]
fn move_playhead_only_seek_does_not_activate_timeline() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 79;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-79".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        seek_behavior: TimelineSeekBehavior::MovePlayheadOnly,
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(1),
        }));

    app.update();

    let mut timelines = app.world_mut().query::<&MaterializedTimeline>();
    let materialized = timelines
        .single(app.world())
        .expect("timeline should exist");
    assert!(
        !materialized.is_active,
        "move-only seek should not activate a stopped timeline"
    );
    assert!(
        !materialized.audio_needs_sync,
        "move-only seek should not request timeline-owned audio sync"
    );
}

#[test]
fn seek_coalesces_multiple_timecode_events_per_frame() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 78;
    let clip_uid = Uuid::new_v4();
    let clip_id = 9;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-9".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-78".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-1".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.spawned_entities.insert(
        clip_entity,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    app.world_mut().spawn(materialized);

    for position in [Duration::from_millis(1500), Duration::from_secs(2)] {
        app.world_mut()
            .write_message(timecode_command(TimecodeCommand::SeekTimecode {
                id: timeline_id,
                position,
            }));
    }

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();

    assert_eq!(
        clip_events.len(),
        1,
        "duplicate seeks in one frame should only clean up pre-owned clip state"
    );
    assert!(matches!(
        clip_events[0],
        ClipAction::Stop(IdExpr::Single(id)) if id == clip_id
    ));
}

#[test]
fn seek_coalesces_distinct_timecodes_in_last_event_order() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let clip_uid = Uuid::new_v4();
    let clip_id = 11;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-11".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let start_timeline_id = 101;
    let start_timecode_uid = spawn_timecode(&mut app, start_timeline_id, Duration::ZERO);
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: start_timeline_id,
            uid: Uuid::new_v4(),
            label: "start-timeline".to_owned(),
        },
        timecode_uid: start_timecode_uid,
        tracks: vec![Track {
            id: "track-start".to_owned(),
            label: "Track Start".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    }));

    let stop_timeline_id = 202;
    let stop_timecode_uid = spawn_timecode(&mut app, stop_timeline_id, Duration::ZERO);
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: stop_timeline_id,
            uid: Uuid::new_v4(),
            label: "stop-timeline".to_owned(),
        },
        timecode_uid: stop_timecode_uid,
        tracks: vec![Track {
            id: "track-stop".to_owned(),
            label: "Track Stop".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-stop".to_owned(),
                label: "Stop exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StopClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    }));

    for (id, position) in [
        (start_timeline_id, Duration::from_millis(1500)),
        (stop_timeline_id, Duration::from_millis(1500)),
        (start_timeline_id, Duration::from_secs(2)),
    ] {
        app.world_mut()
            .write_message(timecode_command(TimecodeCommand::SeekTimecode {
                id,
                position,
            }));
    }

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();

    assert_eq!(
        clip_events.len(),
        0,
        "seeks for distinct timecodes should not replay unsupported raw clip actions"
    );
}

#[test]
fn seek_coalesces_each_timeline_for_shared_timecode() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let clip_uid = Uuid::new_v4();
    let clip_id = 12;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-12".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timecode_id = 303;
    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::ZERO);
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: Uuid::new_v4(),
            label: "stop-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-stop".to_owned(),
            label: "Track Stop".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-stop".to_owned(),
                label: "Stop exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StopClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    }));

    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: Uuid::new_v4(),
            label: "start-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-start".to_owned(),
            label: "Track Start".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    }));

    for position in [Duration::from_millis(1500), Duration::from_secs(2)] {
        app.world_mut()
            .write_message(timecode_command(TimecodeCommand::SeekTimecode {
                id: timecode_id,
                position,
            }));
    }

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();

    assert_eq!(
        clip_events.len(),
        0,
        "coalescing one timecode should not replay unsupported raw clip actions"
    );
}
