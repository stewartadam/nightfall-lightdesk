// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

#[test]
fn seek_releases_timeline_spawned_cues_instead_of_despawning_immediately() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 77;
    let cue_entity = app.world_mut().spawn(MaterializedCue::default()).id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-77".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.spawned_entities.insert(
        cue_entity,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Cue,
        ),
    );
    app.world_mut().spawn(materialized);

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(1),
        }));

    app.update();

    let cue_ref = app.world().get_entity(cue_entity);
    assert!(
        cue_ref.is_ok(),
        "cue should not be immediately despawned on seek"
    );
    let cue_ref = cue_ref.expect("cue entity should still exist");
    assert!(
        cue_ref.contains::<ReleaseMarker>(),
        "cue should be marked for release on seek"
    );
}

/// Verifies seek reconstruction attaches cue-local elapsed clocks to fired cues.
#[test]
fn seek_fire_cue_attaches_elapsed_instance_clock() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<ColorPath>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let cue_uid = Uuid::new_v4();
    let (fixture_ref, _) = add_rgb_fixture_parameters(&mut app, 78);
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath::new(
            9,
            "Timeline HSV",
            ColorInterpolationSpace::Hsv,
        ))
        .expect("test color path should be added");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_uid,
                label: "cue-1".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([
                        (
                            Attribute::Red,
                            ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                        ),
                        (
                            Attribute::Green,
                            ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                        ),
                        (
                            Attribute::Blue,
                            ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                        ),
                    ]),
                    color_path_id: Some(ColorPathId(9)),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("test cue should be added");

    let timeline_id = 78;
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
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
                label: "Fire cue".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::FireCue(cue_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn(MaterializedTimeline::new(timeline))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(2500),
        }));

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let cue_entity = timeline
        .spawned_entities
        .iter()
        .find_map(|(entity, (_, action_id, spawn_type))| {
            (action_id == "action-1" && matches!(spawn_type, SpawnedEntityType::Cue))
                .then_some(*entity)
        })
        .expect("fire cue should be tracked as a timeline-owned cue");
    let clock = app
        .world()
        .entity(cue_entity)
        .get::<InstanceClock>()
        .expect("seek-spawned cue should have a playback clock");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(1500));
    let mcue = app
        .world()
        .entity(cue_entity)
        .get::<MaterializedCue>()
        .expect("seek-spawned cue should remain materialized");
    assert_eq!(
        mcue.color_path_groups.len(),
        1,
        "seek timeline FireCue should resolve custom color path groups"
    );
    assert_eq!(mcue.color_path_groups[0].path.identifiers.id, 9);
}

/// Verifies bounded cue actions seek into their source-local release interval.
#[test]
fn seek_fire_cue_with_duration_marks_release_window() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, paint_materialized_cues).chain(),
    );

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(1));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 178;
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-bounded-cue-release".to_owned(),
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
                label: "Fire cue".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::from_secs(1),
                action: ActionKind::FireCue(cue_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn(MaterializedTimeline::new(timeline))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(2500),
        }));

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let cue_entity = timeline
        .spawned_entities
        .iter()
        .find_map(|(entity, (_, action_id, spawn_type))| {
            (action_id == "action-1" && matches!(spawn_type, SpawnedEntityType::Cue))
                .then_some(*entity)
        })
        .expect("releasing cue should still be tracked while output-relevant");
    let cue_ref = app.world().entity(cue_entity);
    assert!(cue_ref.contains::<ReleaseMarker>());
    let clock = cue_ref
        .get::<InstanceClock>()
        .expect("released seek-spawned cue should keep a playback clock");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(1500));
    let release_timing = cue_ref
        .get::<PlaybackReleaseTiming>()
        .expect("released seek-spawned cue should carry a source-local release anchor");
    assert_eq!(release_timing.released_at, Duration::from_secs(1));
    let materialized_cue = cue_ref
        .get::<MaterializedCue>()
        .expect("released seek-spawned cue should remain materialized");
    assert_eq!(
        materialized_cue.release_position,
        Some(Duration::from_secs(1))
    );
    let compositing_context = cue_ref
        .get::<LayerCompositingContext>()
        .expect("paint should observe release timing in the seek frame");
    assert_eq!(
        compositing_context.released_at,
        Some(Duration::from_secs(1))
    );
}

/// Verifies bounded cue actions become aggregate no-ops after release completes.
#[test]
fn seek_fire_cue_with_duration_skips_completed_release() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(1));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 179;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-bounded-cue-complete".to_owned(),
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
                label: "Fire cue".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::from_secs(1),
                action: ActionKind::FireCue(cue_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn(MaterializedTimeline::new(timeline))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(3500),
        }));

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.is_empty(),
        "fully released cue action should not materialize timeline-owned output"
    );
    let cue_count = app
        .world_mut()
        .query::<&MaterializedCue>()
        .iter(app.world())
        .count();
    assert_eq!(cue_count, 0);
}
