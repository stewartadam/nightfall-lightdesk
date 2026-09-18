// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_actions::{ActionInvocation, ActionReference, ActionSurface, ActionsPlugin};
use nightfall_desk::prelude::{CLIP_START_ACTION_ID, ClipTarget, start_clip_action};

use super::*;
use crate::TimelineNondeterministicSeekBehavior;
use crate::timeline_events::TimelineActionsChanged;

/// Returns a materialized timeline mutation handle after marking live reconciliation dirty.
fn timeline_for_live_action_edit(
    app: &mut App,
    timeline_entity: Entity,
) -> bevy_ecs::world::Mut<'_, MaterializedTimeline> {
    let timeline_id = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let timeline_id = timeline_id.timeline.identifiers.id;
    app.world_mut()
        .init_resource::<Messages<TimelineActionsChanged>>();
    app.world_mut()
        .write_message(TimelineActionsChanged { timeline_id });
    app.world_mut()
        .get_mut::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized")
}

#[test]
fn process_actions_skips_regular_trigger_scan_on_seek_frames() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 42;
    let clip_uid = Uuid::new_v4();

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 7,
            uid: clip_uid,
            label: "exec-7".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-42".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
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
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(2),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .collect();
    assert!(
        clip_events.is_empty(),
        "regular action processing should not emit lifecycle events in seek frames"
    );
}

/// Verifies a running seek frame resumes live scanning from the requested destination, not the advanced timecode sample.
#[test]
fn process_actions_resumes_after_running_seek_target() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 142;
    let clip_uid = Uuid::new_v4();
    let clip_id = 142;

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-142".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-running-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2100)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-after-seek".to_owned(),
                label: "Start after seek".to_owned(),
                position: Duration::from_millis(2050),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(2),
        }));

    app.update();

    let skipped_frame_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .collect();
    assert!(
        skipped_frame_events.is_empty(),
        "seek frames should still skip regular live scanning"
    );

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
        "live scanning should catch actions crossed after a running seek: {clip_events:?}"
    );
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_millis(2050),
        Duration::from_millis(2100)
    ));
}

/// Verifies mutation replay still runs when a same-frame move-only seek is ignored.
#[test]
fn process_actions_replays_mutation_after_move_playhead_only_seek_frame() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 143;
    let clip_uid = Uuid::new_v4();
    let clip_id = 143;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-143".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-move-only-mutation".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        seek_behavior: TimelineSeekBehavior::MovePlayheadOnly,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .push(Action {
            id: "action-start".to_owned(),
            label: "Start exec".to_owned(),
            position: Duration::from_secs(1),
            duration: Duration::ZERO,
            action: ActionKind::StartClip(clip_uid),
        });
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(2),
        }));

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
        "move-only seek frames should not suppress mutation live replay: {clip_events:?}"
    );
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_secs(1),
        Duration::from_secs(2)
    ));
}

/// Verifies registered timeline clip starts reuse timeline timing reconstruction.
#[test]
fn process_actions_dispatches_registered_clip_action() {
    let mut app = App::new();
    app.add_plugins(ActionsPlugin);
    nightfall_desk::automation_actions::register_desk_actions(&mut app);
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 43;
    let clip_uid = Uuid::new_v4();
    let clip_id = 7;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-7".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let action = start_clip_action(ClipTarget::Uid(clip_uid));
    assert_eq!(action.id.as_str(), CLIP_START_ACTION_ID);

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-registered-action".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "registered-start".to_owned(),
                label: "Registered Start".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::RegisteredAction(action),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_secs(1),
        Duration::from_secs(2)
    ));
}

/// Verifies actions unknown to timeline are delegated to the generic invocation registry.
#[test]
fn process_actions_delegates_registered_domain_action() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<ActionInvocation>();
    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, process_actions_system);

    let timeline_id = 44;
    let action = ActionReference::new("custom.domain-action", serde_json::json!({ "slot": 3 }));
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-generic-action".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "custom-action".to_owned(),
                label: "Custom Action".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::RegisteredAction(action.clone()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let invocations = app
        .world_mut()
        .resource_mut::<Messages<ActionInvocation>>()
        .drain()
        .collect::<Vec<_>>();
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0].action, action);
    assert_eq!(invocations[0].surface, ActionSurface::Timeline);
}

/// Verifies live FireCue actions keep cue playback clocks synced to timeline position.
#[test]
fn process_actions_syncs_live_fire_cue_clock_from_timeline_position() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<ColorPath>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(
        Update,
        (
            sync_timeline_paused_instance_controls_system,
            handle_timeline_seek_system,
            process_actions_system,
            paint_materialized_cues,
        )
            .chain(),
    );

    let cue_uid = Uuid::new_v4();
    let (fixture_ref, _) = add_rgb_fixture_parameters(&mut app, 43);
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

    let timeline_id = 43;
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-43".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
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
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

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
        .expect("live-spawned cue should have a playback clock");
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
        .expect("live-spawned cue should remain materialized");
    assert_eq!(
        mcue.color_path_groups.len(),
        1,
        "live timeline FireCue should resolve custom color path groups"
    );
    assert_eq!(mcue.color_path_groups[0].path.identifiers.id, 9);

    let mut timecodes = app.world_mut().query::<&mut TimecodeGenerator>();
    timecodes
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .current_time = Duration::from_millis(3500);

    app.update();

    let clock = app
        .world()
        .entity(cue_entity)
        .get::<InstanceClock>()
        .expect("live-spawned cue should keep its playback clock");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(2500));
}

/// Verifies live bounded FireCue actions release from their authored action end.
#[test]
fn process_actions_releases_bounded_fire_cue_at_action_end() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(
        Update,
        (
            sync_timeline_paused_instance_controls_system,
            handle_timeline_seek_system,
            process_actions_system,
            paint_materialized_cues,
        )
            .chain(),
    );

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(1));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 44;
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-bounded-live-cue".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(1500)),
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
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();

    let cue_entity = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized")
        .spawned_entities
        .iter()
        .find_map(|(entity, (_, action_id, spawn_type))| {
            (action_id == "action-1" && matches!(spawn_type, SpawnedEntityType::Cue))
                .then_some(*entity)
        })
        .expect("fire cue should be tracked before release");
    assert!(
        !app.world().entity(cue_entity).contains::<ReleaseMarker>(),
        "cue should still be active before the action end"
    );

    let mut timecodes = app.world_mut().query::<&mut TimecodeGenerator>();
    timecodes
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .current_time = Duration::from_millis(2500);

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&cue_entity),
        "releasing cue should stay timeline-owned until its release tail completes"
    );
    let cue_ref = app.world().entity(cue_entity);
    assert!(cue_ref.contains::<ReleaseMarker>());
    let clock = cue_ref
        .get::<InstanceClock>()
        .expect("released live cue should keep its playback clock");
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
        .expect("released live cue should carry source-local release timing");
    assert_eq!(release_timing.released_at, Duration::from_secs(1));
    let materialized_cue = cue_ref
        .get::<MaterializedCue>()
        .expect("released live cue should remain materialized");
    assert_eq!(
        materialized_cue.release_position,
        Some(Duration::from_secs(1))
    );
    let compositing_context = cue_ref
        .get::<LayerCompositingContext>()
        .expect("paint should observe live release timing in the release frame");
    assert_eq!(
        compositing_context.released_at,
        Some(Duration::from_secs(1))
    );
}

/// Verifies live bounded FireCue actions skipped past release do not materialize stale output.
#[test]
fn process_actions_skips_bounded_fire_cue_after_release_tail() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(1));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 45;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-skipped-live-cue".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(3500)),
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
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.is_empty(),
        "fully released bounded cue should not materialize live output after a large tick"
    );
    let cue_count = app
        .world_mut()
        .query::<&MaterializedCue>()
        .iter(app.world())
        .count();
    assert_eq!(cue_count, 0);
}

/// Verifies live StartClip actions carry timeline transition timing.
#[test]
fn process_actions_sends_timed_start_clip_from_timeline_position() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 44;
    let clip_uid = Uuid::new_v4();
    let clip_id = 5;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-5".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_secs(1),
        Duration::from_millis(2500)
    ));
    assert!(matches!(
        &clip_events[0],
        ClipAction::StartAtTiming {
            instance_options: Some(InstanceOptions {
                lookahead_enabled: Some(true)
            }),
            ..
        }
    ));
}

/// Verifies deleting a previously-triggered start action stops its live clip.
#[test]
fn process_actions_stops_clip_when_started_action_is_deleted() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 46;
    let clip_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 5,
                uid: clip_uid,
                label: "exec-5".to_owned(),
            },
            source: None,
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-delete-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .clear();

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        clip_events[0],
        ClipAction::Stop(IdExpr::Single(5))
    ));

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        !timeline.spawned_entities.contains_key(&clip_entity),
        "deleted start action should no longer own the clip"
    );
}

/// Verifies inserting an elapsed stop action immediately updates live clip state.
#[test]
fn process_actions_applies_inserted_elapsed_stop_action() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 47;
    let clip_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 5,
                uid: clip_uid,
                label: "exec-5".to_owned(),
            },
            source: None,
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-insert-stop".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(3500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .push(Action {
            id: "action-stop".to_owned(),
            label: "Stop exec".to_owned(),
            position: Duration::from_secs(2),
            duration: Duration::ZERO,
            action: ActionKind::StopClip(clip_uid),
        });

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        clip_events[0],
        ClipAction::Stop(IdExpr::Single(5))
    ));

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        !timeline.spawned_entities.contains_key(&clip_entity),
        "inserted elapsed stop should remove live clip ownership"
    );
}

/// Verifies deleting an elapsed stop action restores the earlier live start action.
#[test]
fn process_actions_restores_start_when_elapsed_stop_action_is_deleted() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 48;
    let clip_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 5,
                uid: clip_uid,
                label: "exec-5".to_owned(),
            },
            source: None,
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-delete-stop".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(3500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Stop exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::StopClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .retain(|action| action.id != "action-stop");

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches_timed_start(
        &clip_events[0],
        5,
        Duration::from_secs(1),
        Duration::from_millis(3500)
    ));

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies an unset timeline Lookahead setting lets sequence playback use its own Lookahead setting.
#[test]
fn process_actions_leaves_lookahead_unset_when_timeline_setting_is_unset() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 45;
    let clip_uid = Uuid::new_v4();
    let clip_id = 6;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-6".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-inherit-lookahead".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        lookahead: TimelineLookaheadMode::Inherit,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        &clip_events[0],
        ClipAction::StartAtTiming {
            instance_options: None,
            ..
        }
    ));
}

/// Verifies each live timeline keeps an independent processed-position cursor.
#[test]
fn process_actions_tracks_last_processed_per_timeline() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_a_uid = Uuid::new_v4();
    let clip_b_uid = Uuid::new_v4();
    let clip_a_id = 51;
    let clip_b_id = 52;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_a_id,
            uid: clip_a_uid,
            label: "exec-a".to_owned(),
        },
        source: None,
        ..Default::default()
    });
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_b_id,
            uid: clip_b_uid,
            label: "exec-b".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline_a_id = 451;
    let timeline_b_id = 452;
    let mut timeline_a = MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timeline_a_id,
            uid: Uuid::new_v4(),
            label: "timeline-a".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_a_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-a".to_owned(),
            label: "Track A".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-a".to_owned(),
                label: "Start exec A".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_a_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    });
    timeline_a.activate();
    app.world_mut().spawn(timeline_a);

    let mut timeline_b = MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timeline_b_id,
            uid: Uuid::new_v4(),
            label: "timeline-b".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_b_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-b".to_owned(),
            label: "Track B".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-b".to_owned(),
                label: "Start exec B".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_b_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    });
    timeline_b.activate();
    app.world_mut().spawn(timeline_b);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 2);
    assert!(clip_events.iter().any(|event| matches_timed_start(
        event,
        clip_a_id,
        Duration::from_secs(1),
        Duration::from_secs(2)
    )));
    assert!(clip_events.iter().any(|event| matches_timed_start(
        event,
        clip_b_id,
        Duration::from_secs(1),
        Duration::from_secs(2)
    )));
}

/// Verifies live StartClip action duration does not emit an implicit stop.
#[test]
fn process_actions_keeps_started_clip_active_after_action_duration() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 15;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-15".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 47;
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-start-clip-duration".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::from_secs(1),
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_secs(1),
        Duration::from_millis(2500)
    ));

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "started clip should remain timeline-owned until an explicit stop"
    );
}

/// Verifies resizing an elapsed StartClip action does not restart live playback.
#[test]
fn process_actions_ignores_start_clip_duration_resize() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 49;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-49".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 49;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-duration-resize".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::from_secs(1),
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[0]
        .duration = Duration::from_secs(5);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "duration-only resize should not stop or restart clip: {clip_events:?}"
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies inserting an elapsed muted-action does not disturb live playback.
#[test]
fn process_actions_ignores_inserted_elapsed_muted_action() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 50;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-50".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 50;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-muted-insert".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(3500)),
        tracks: vec![
            Track {
                id: "track-active".to_owned(),
                label: "Active".to_owned(),
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
            },
            Track {
                id: "track-muted".to_owned(),
                label: "Muted".to_owned(),
                muted: true,
                solo: false,
                expanded: false,
                actions: Vec::new(),
                automation_lanes: Vec::new(),
            },
        ],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[1]
        .actions
        .push(Action {
            id: "action-muted-stop".to_owned(),
            label: "Muted stop".to_owned(),
            position: Duration::from_secs(2),
            duration: Duration::ZERO,
            action: ActionKind::StopClip(clip_uid),
        });

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "muted inserted action should not stop or restart clip: {clip_events:?}"
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-active" && action_id == "action-start"
    ));
}

/// Verifies changing an elapsed StartClip action replays without queuing a stop.
#[test]
fn process_actions_directly_unlinks_changed_elapsed_start_clip() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 51;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-51".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 51;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-position-change".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();
    let instance_id = InstanceId::new();
    let materialized_clip_entity = app
        .world_mut()
        .spawn(MaterializedClip {
            clip_id,
            attached_instance: instance_id,
            auto_release_on_stop: true,
        })
        .id();
    let playback_entity = app.world_mut().spawn(instance_id).id();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[0]
        .position = Duration::from_millis(500);

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
        "changed start should replay without a queued stop: {clip_events:?}"
    );
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_millis(500),
        Duration::from_millis(2500)
    ));
    assert!(
        app.world().get_entity(materialized_clip_entity).is_err(),
        "stale materialized clip link should be directly despawned"
    );
    assert!(
        app.world().get_entity(playback_entity).is_err(),
        "stale attached playback should be directly despawned"
    );
    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies elapsed start-action edits flush stale sequence playback despawns before replay handling.
#[test]
fn changed_elapsed_start_clip_flushes_stale_sequence_before_replay() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_message::<OperationResult<(), CommandError>>();
    app.init_resource::<CommandTracker>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<PendingCommandBuffer>();
    app.init_resource::<PendingEngineActionBuffer>();
    app.add_systems(
        Update,
        (
            handle_timeline_seek_system,
            ApplyDeferred,
            nightfall_cues::events::handle_events,
            ApplyDeferred,
        )
            .chain(),
    );

    let sequence_uid = Uuid::new_v4();
    let sequence = Sequence {
        identifiers: Identifiers {
            id: 1,
            uid: sequence_uid,
            label: "sequence".to_owned(),
        },
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(sequence.clone())
        .expect("test sequence should be stored");

    let clip_uid = Uuid::new_v4();
    let clip_id = 51;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-51".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline_id = 51;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-position-change".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized.triggered_actions.insert(
                ("track-1".to_owned(), "action-start".to_owned()),
                Duration::from_secs(1),
            );
            materialized.spawned_entities.insert(
                clip_entity,
                (
                    "track-1".to_owned(),
                    "action-start".to_owned(),
                    SpawnedEntityType::Clip,
                ),
            );
            materialized
        })
        .id();

    let instance_id = InstanceId::new();
    let mut stale_sequence = MaterializedSequence::default();
    stale_sequence.sequence = sequence;
    let stale_playback_entity = app.world_mut().spawn((stale_sequence, instance_id)).id();
    let stale_materialized_clip_entity = app
        .world_mut()
        .spawn(MaterializedClip {
            clip_id,
            attached_instance: instance_id,
            auto_release_on_stop: true,
        })
        .id();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[0]
        .position = Duration::from_millis(500);

    app.update();

    assert!(
        app.world().get_entity(stale_playback_entity).is_err(),
        "stale attached playback should be flushed before sequence replay handling"
    );
    assert!(
        app.world()
            .get_entity(stale_materialized_clip_entity)
            .is_err(),
        "stale materialized clip link should be flushed before sequence replay handling"
    );

    let mut sequence_query = app.world_mut().query::<(Entity, &InstanceId)>();
    let sequence_instances: Vec<_> = sequence_query
        .iter(app.world())
        .map(|(entity, instance_id)| (entity, *instance_id))
        .collect();
    assert_eq!(
        sequence_instances.len(),
        1,
        "sequence replay should replace the stale instance: {sequence_instances:?}"
    );
    assert_ne!(sequence_instances[0].0, stale_playback_entity);
    assert_ne!(sequence_instances[0].1, instance_id);
}

/// Verifies future-only edits do not replay an unchanged active clip start.
#[test]
fn process_actions_preserves_active_start_after_future_only_edit() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 151;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-151".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 151;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-future-only-edit".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();
    let instance_id = InstanceId::new();
    let materialized_clip_entity = app
        .world_mut()
        .spawn(MaterializedClip {
            clip_id,
            attached_instance: instance_id,
            auto_release_on_stop: true,
        })
        .id();
    let playback_entity = app.world_mut().spawn(instance_id).id();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .push(Action {
            id: "action-future-stop".to_owned(),
            label: "Future stop".to_owned(),
            position: Duration::from_secs(5),
            duration: Duration::ZERO,
            action: ActionKind::StopClip(clip_uid),
        });

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "future-only edits should not restart active clip playback: {clip_events:?}"
    );
    assert!(
        app.world().get_entity(materialized_clip_entity).is_ok(),
        "unchanged active start should keep its materialized clip link"
    );
    assert!(
        app.world().get_entity(playback_entity).is_ok(),
        "unchanged active start should keep its attached playback"
    );
    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies inserting a no-op stop before an active start does not restart playback.
#[test]
fn process_actions_ignores_inserted_stop_before_active_start() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 53;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-53".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 53;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-stop-before-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .insert(
            0,
            Action {
                id: "action-noop-stop".to_owned(),
                label: "No-op stop".to_owned(),
                position: Duration::from_millis(500),
                duration: Duration::ZERO,
                action: ActionKind::StopClip(clip_uid),
            },
        );

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "no-op stop before active start should not stop or restart clip: {clip_events:?}"
    );
    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies deleting a no-op stop before an active start leaves playback untouched.
#[test]
fn process_actions_ignores_deleted_stop_before_active_start() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 57;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-57".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 57;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-delete-stop-before-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-noop-stop".to_owned(),
                    label: "No-op stop".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::StopClip(clip_uid),
                },
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .remove(0);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "deleting no-op stop before active start should not restart clip: {clip_events:?}"
    );
    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies moving a no-op stop into the future leaves current playback untouched.
#[test]
fn process_actions_ignores_shadowed_stop_moved_after_playhead() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 59;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-59".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 59;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-move-stop-after-playhead".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-noop-stop".to_owned(),
                    label: "No-op stop".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::StopClip(clip_uid),
                },
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[0]
        .position = Duration::from_secs(5);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "moving no-op stop after the playhead should not restart clip: {clip_events:?}"
    );
    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies inserting an elapsed rate action before an active start replays the rate change.
#[test]
fn process_actions_replays_inserted_rate_before_active_start() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 54;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-54".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline_id = 54;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-rate-before-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .insert(
            0,
            Action {
                id: "action-rate".to_owned(),
                label: "Set rate".to_owned(),
                position: Duration::from_millis(500),
                duration: Duration::ZERO,
                action: ActionKind::SetClipRate {
                    uid: clip_uid,
                    rate: 2.0,
                },
            },
        );

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.iter().any(|event| matches!(
            event,
            ClipAction::SetRate {
                clip_id: IdExpr::Single(id),
                rate,
            } if *id == clip_id && (*rate - 2.0).abs() < f32::EPSILON
        )),
        "inserted elapsed rate before active start should replay: {clip_events:?}"
    );
}

/// Verifies changing an elapsed rate action into a no-op stop replays later active state.
#[test]
fn process_actions_replays_start_after_rate_becomes_stop_before_it() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 56;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-56".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline_id = 56;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-rate-to-stop-before-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-rate".to_owned(),
                    label: "Set rate".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::SetClipRate {
                        uid: clip_uid,
                        rate: 2.0,
                    },
                },
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[0]
        .action = ActionKind::StopClip(clip_uid);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.iter().all(|event| !matches_timed_start(
            event,
            clip_id,
            Duration::from_secs(1),
            Duration::from_millis(2500)
        )),
        "changing a prior rate into a no-op stop should preserve the active start: {clip_events:?}"
    );
    assert!(
        clip_events
            .iter()
            .all(|event| !matches!(event, ClipAction::SetRate { .. })),
        "removed rate action should not replay a SetRate command: {clip_events:?}"
    );
}

/// Verifies changing an elapsed stop into an ignored action replays the active start.
#[test]
fn process_actions_replays_start_after_stop_becomes_ignored_desk_eval() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 58;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-58".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline_id = 58;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-stop-to-ignored-desk-eval".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Stop exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::StopClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[1]
        .action = ActionKind::DeskEval("ignored desk command".to_owned());

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.iter().any(|event| matches_timed_start(
            event,
            clip_id,
            Duration::from_secs(1),
            Duration::from_millis(2500)
        )),
        "changing stop to ignored DeskEval should replay the earlier start: {clip_events:?}"
    );
    assert!(
        clip_events
            .iter()
            .all(|event| !matches!(event, ClipAction::Stop(_))),
        "removed stop action should not replay a StopClip command: {clip_events:?}"
    );
}

/// Verifies moving an elapsed stop before a later start restores active playback.
#[test]
fn process_actions_replays_start_after_elapsed_stop_moves_before_it() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 55;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-55".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline_id = 55;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-move-stop-before-start".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Stop exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::StopClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[1]
        .position = Duration::from_millis(500);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.iter().any(|event| matches_timed_start(
            event,
            clip_id,
            Duration::from_secs(1),
            Duration::from_millis(2500)
        )),
        "moving a stop before a later start should replay the start: {clip_events:?}"
    );
    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies deleting an elapsed DeskEval stop replays prior DeskEval commands.
#[test]
fn process_actions_replays_desk_eval_actions_after_dispatch_desk_eval_delete() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    nightfall_engine::protocol::dispatch_ast::register_converter::<
        nightfall_desk::ast_conv::DeskAstConverter,
    >();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 52,
            uid: clip_uid,
            label: "exec-52".to_owned(),
        },
        ..Default::default()
    });

    let timeline_id = 52;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-desk-eval-delete".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(3500)),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Dispatch,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-go".to_owned(),
                    label: "Go exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("clip 52 go".to_owned()),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Stop exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("clip 52 stop".to_owned()),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .retain(|action| action.id != "action-stop");

    app.update();

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(desk_events.len(), 1);
    assert!(matches!(
        &desk_events[0],
        DeskAction::Eval(command) if command == "clip 52 go"
    ));
}

/// Verifies deleting a Dispatch DeskEval stop replays normal clip starts.
#[test]
fn process_actions_replays_start_after_dispatch_desk_eval_stop_delete() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    nightfall_engine::protocol::dispatch_ast::register_converter::<
        nightfall_desk::ast_conv::DeskAstConverter,
    >();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 61;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-61".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline_id = 61;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-desk-eval-stop-delete".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Dispatch,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Desk stop".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("clip 61 stop".to_owned()),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .clear();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .retain(|action| action.id != "action-stop");

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.iter().any(|event| matches_timed_start(
            event,
            clip_id,
            Duration::from_secs(1),
            Duration::from_millis(2500)
        )),
        "deleting a Dispatch DeskEval stop should replay the normal start: {clip_events:?}"
    );
}

/// Verifies DeskEval replay keeps unrelated active FireCue actions from duplicating.
#[test]
fn process_actions_desk_eval_delete_does_not_duplicate_active_fire_cue() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(
        Update,
        (
            sync_timeline_paused_instance_controls_system,
            handle_timeline_seek_system,
            process_actions_system,
            paint_materialized_cues,
        )
            .chain(),
    );

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(10));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 60;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-desk-eval-cue-retain".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Dispatch,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-cue".to_owned(),
                    label: "Fire cue".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::from_secs(10),
                    action: ActionKind::FireCue(cue_uid),
                },
                Action {
                    id: "action-desk".to_owned(),
                    label: "Desk eval".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("clip 1 go".to_owned()),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    let initial_cue_entity = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized")
        .spawned_entities
        .iter()
        .find_map(|(entity, (_, action_id, spawn_type))| {
            (action_id == "action-cue" && matches!(spawn_type, SpawnedEntityType::Cue))
                .then_some(*entity)
        })
        .expect("fire cue should be tracked before DeskEval edit");

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .retain(|action| action.id != "action-desk");

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let cue_entities: Vec<_> = timeline
        .spawned_entities
        .iter()
        .filter_map(|(entity, (_, action_id, spawn_type))| {
            (action_id == "action-cue" && matches!(spawn_type, SpawnedEntityType::Cue))
                .then_some(*entity)
        })
        .collect();
    assert_eq!(
        cue_entities,
        vec![initial_cue_entity],
        "DeskEval replay should keep the existing FireCue materialization without duplicating it"
    );
}

/// Verifies ignored DeskEval edits are marked processed without dispatching.
#[test]
fn process_actions_skips_inserted_desk_eval_when_seek_policy_ignores_it() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 54;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-ignore-desk-insert".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .push(Action {
            id: "action-desk".to_owned(),
            label: "Desk Eval".to_owned(),
            position: Duration::from_secs(1),
            duration: Duration::ZERO,
            action: ActionKind::DeskEval("group 1 at 50".to_owned()),
        });

    app.update();

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "ignored DeskEval insert should not dispatch during live reconciliation: {desk_events:?}"
    );
}

/// Verifies deleting a skipped action allows a later reused action ID to fire.
#[test]
fn process_actions_drops_skipped_deleted_action_trigger_state() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(
        Update,
        (
            sync_timeline_paused_instance_controls_system,
            handle_timeline_seek_system,
            process_actions_system,
            paint_materialized_cues,
        )
            .chain(),
    );

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(10));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 62;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-reused-skipped-action-id".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-reused".to_owned(),
                label: "Ignored desk eval".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval("ignored".to_owned()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .clear();
    app.update();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions
        .push(Action {
            id: "action-reused".to_owned(),
            label: "Reused FireCue".to_owned(),
            position: Duration::from_millis(1500),
            duration: Duration::from_secs(10),
            action: ActionKind::FireCue(cue_uid),
        });

    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline
            .spawned_entities
            .values()
            .any(|(_, action_id, spawn_type)| action_id == "action-reused"
                && matches!(spawn_type, SpawnedEntityType::Cue)),
        "reused action ID should fire after skipped deletion clears triggered state"
    );
}

/// Verifies skipped actions moved into the future can later fire after becoming replayable.
#[test]
fn process_actions_does_not_pretrigger_skipped_future_action() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(
        Update,
        (
            sync_timeline_paused_instance_controls_system,
            handle_timeline_seek_system,
            process_actions_system,
            paint_materialized_cues,
        )
            .chain(),
    );

    let cue_uid = Uuid::new_v4();
    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(10));
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be added");

    let timeline_id = 63;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-future-skipped-action".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_millis(2500)),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-future".to_owned(),
                label: "Ignored desk eval".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval("ignored".to_owned()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let timeline_entity = app
        .world_mut()
        .spawn({
            let mut materialized = MaterializedTimeline::new(timeline);
            materialized.activate();
            materialized
        })
        .id();

    app.update();
    {
        let mut timeline = timeline_for_live_action_edit(&mut app, timeline_entity);
        let action = &mut timeline.timeline.tracks[0].actions[0];
        action.position = Duration::from_secs(4);
        action.action = ActionKind::DeskEval("still ignored".to_owned());
    }
    app.update();

    timeline_for_live_action_edit(&mut app, timeline_entity)
        .timeline
        .tracks[0]
        .actions[0]
        .action = ActionKind::FireCue(cue_uid);
    app.update();

    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .current_time = Duration::from_millis(4500);
    app.update();

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline
            .spawned_entities
            .values()
            .any(|(_, action_id, spawn_type)| action_id == "action-future"
                && matches!(spawn_type, SpawnedEntityType::Cue)),
        "future skipped action should fire after it becomes a FireCue"
    );
}

/// Verifies live StopClip actions without a tracked origin do not fabricate timing.
#[test]
fn process_actions_sends_untimed_stop_without_tracked_origin() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_uid = Uuid::new_v4();
    let clip_id = 16;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-16".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline_id = 48;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-stop-untracked-clip".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
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
    };
    app.world_mut().spawn({
        let mut materialized = MaterializedTimeline::new(timeline);
        materialized.activate();
        materialized
    });

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        clip_events[0],
        ClipAction::Stop(IdExpr::Single(id)) if id == clip_id
    ));
}

/// Verifies desk eval timeline actions dispatch through the shared eval event path.
#[test]
fn process_actions_dispatches_desk_eval_actions() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 43;
    let command = "group 1 at 50".to_owned();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-desk-eval".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-1".to_owned(),
                label: "Desk Eval".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval(command.clone()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .collect();
    assert_eq!(desk_events.len(), 1);
    assert!(matches!(
        &desk_events[0].action,
        DeskAction::Eval(actual) if actual == &command
    ));
    assert!(
        app.world()
            .resource::<TimelineCommandOrigins>()
            .is_timeline_clip_undo_id(
                desk_events[0]
                    .undo_id
                    .expect("timeline desk action should retain undo context")
                    .into(),
            ),
        "desk eval batches should be marked as timeline-originated for recording filters"
    );
}

/// Verifies desk eval clip commands mark the clip as timeline-owned for pause sync.
#[test]
fn process_actions_tracks_desk_eval_clip_actions() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    nightfall_engine::protocol::dispatch_ast::register_converter::<
        nightfall_desk::ast_conv::DeskAstConverter,
    >();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 5,
                uid: Uuid::new_v4(),
                label: "clip-5".to_owned(),
            },
            ..Default::default()
        })
        .id();

    let timeline_id = 44;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-desk-eval-clip".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-1".to_owned(),
                label: "Desk Eval Clip".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval("clip 5 go".to_owned()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    let timeline_entity = app.world_mut().spawn(materialized).id();

    app.update();

    let materialized = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let (_, action_id, spawn_type) = materialized
        .spawned_entities
        .get(&clip_entity)
        .expect("desk eval clip should be tracked as timeline-owned");
    assert_eq!(action_id, "action-1");
    assert!(matches!(spawn_type, SpawnedEntityType::Clip));
}

/// Verifies timeline sequence navigation actions mark advanced clips as timeline-owned.
#[test]
fn process_actions_tracks_sequence_navigation_clip_actions() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let advance_clip_uid = Uuid::new_v4();
    let advance_clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 6,
                uid: advance_clip_uid,
                label: "advance-clip".to_owned(),
            },
            ..Default::default()
        })
        .id();
    let back_clip_uid = Uuid::new_v4();
    let back_clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 7,
                uid: back_clip_uid,
                label: "back-clip".to_owned(),
            },
            ..Default::default()
        })
        .id();

    let timeline_id = 46;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-sequence-navigation".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-advance".to_owned(),
                    label: "Advance exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::AdvanceSequence(advance_clip_uid),
                },
                Action {
                    id: "action-back".to_owned(),
                    label: "Back exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::BackSequence(back_clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    let timeline_entity = app.world_mut().spawn(materialized).id();

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 2);
    assert!(matches!(clip_events[0], ClipAction::Go(IdExpr::Single(6))));
    assert!(matches!(
        clip_events[1],
        ClipAction::Back(IdExpr::Single(7))
    ));
    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .collect();
    assert!(
        desk_events.is_empty(),
        "unresolved sequence navigation should remain semantic clip commands"
    );

    let materialized = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let (_, advance_action_id, advance_spawn_type) = materialized
        .spawned_entities
        .get(&advance_clip_entity)
        .expect("advance clip should be tracked as timeline-owned");
    assert_eq!(advance_action_id, "action-advance");
    assert!(matches!(advance_spawn_type, SpawnedEntityType::Clip));

    let (_, back_action_id, back_spawn_type) = materialized
        .spawned_entities
        .get(&back_clip_entity)
        .expect("back clip should be tracked as timeline-owned");
    assert_eq!(back_action_id, "action-back");
    assert!(matches!(back_spawn_type, SpawnedEntityType::Clip));
}

/// Verifies sourceful live sequence navigation emits planner-derived timing.
#[test]
fn process_actions_sends_timed_sequence_navigation_from_planner() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 146;
    let clip_uid = Uuid::new_v4();
    let clip_id = 16;
    let sequence_uid = Uuid::new_v4();
    let first_cue_uid = Uuid::new_v4();
    let second_cue_uid = Uuid::new_v4();
    app.world_mut().resource_mut::<DataProvider<Cue>>().extend([
        Cue {
            identifiers: Identifiers {
                id: 1,
                uid: first_cue_uid,
                label: "Cue 1".to_owned(),
            },
            ..Default::default()
        },
        Cue {
            identifiers: Identifiers {
                id: 2,
                uid: second_cue_uid,
                label: "Cue 2".to_owned(),
            },
            ..Default::default()
        },
    ]);
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "Sequence".to_owned(),
            },
            steps: vec![first_cue_uid.into(), second_cue_uid.into()],
            ..Default::default()
        })
        .expect("sequence should insert");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "sequence-exec".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-timed-navigation".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(4)),
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-advance".to_owned(),
                    label: "Advance exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::AdvanceSequence(clip_uid),
                },
                Action {
                    id: "action-back".to_owned(),
                    label: "Back exec".to_owned(),
                    position: Duration::from_secs(3),
                    duration: Duration::ZERO,
                    action: ActionKind::BackSequence(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 3);
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_secs(1),
        Duration::from_secs(4)
    ));
    assert!(matches!(
        clip_events[1],
        ClipAction::RenderAt {
            clip_id: IdExpr::Single(id),
            position: 2,
            timing,
            instance_options: Some(instance_options),
        } if id == clip_id
            && timing.started_at == Duration::from_secs(1)
            && timing.position == Duration::from_secs(3)
            && instance_options.lookahead_enabled == Some(true)
    ));
    assert!(
        matches!(
        clip_events[2],
        ClipAction::RenderAt {
            clip_id: IdExpr::Single(id),
            position: 2,
            timing,
            instance_options: Some(instance_options),
        } if id == clip_id
            && timing.started_at == Duration::from_secs(2)
            && timing.position == Duration::from_secs(3)
            && instance_options.lookahead_enabled == Some(true)
        ),
        "unexpected back render event: {:?}",
        clip_events[2]
    );

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "sourceful timed navigation should not fall back to desk eval"
    );
}

/// Verifies paused timelines freeze and restore rates for owned clip instances.
#[test]
fn paused_timeline_sets_owned_playback_rate_to_zero_and_restores() {
    let mut app = App::new();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(Update, sync_timeline_paused_instance_controls_system);

    let timecode_id = 901;
    let clip_uid = Uuid::new_v4();
    let clip_id = 10;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-10".to_owned(),
            },
            ..Default::default()
        })
        .id();
    let instance_id = InstanceId::new();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });
    app.world_mut().spawn((
        instance_id,
        InstanceControls {
            intensity_scale: 1.0,
            rate: 0.75,
            ..Default::default()
        },
    ));

    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::ZERO);
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: Uuid::new_v4(),
            label: "paused-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    materialized.spawned_entities.insert(
        clip_entity,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    app.world_mut().spawn(materialized);

    app.update();
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 0.0);

    let mut timecodes = app.world_mut().query::<&mut TimecodeGenerator>();
    timecodes
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .is_active = true;

    app.update();
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 0.75);
}

/// Verifies timeline-owned clip playback clocks follow timeline action elapsed time.
#[test]
fn timeline_syncs_owned_clip_instance_clock_from_action_position() {
    let mut app = App::new();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(Update, sync_timeline_paused_instance_controls_system);

    let timecode_id = 904;
    let clip_uid = Uuid::new_v4();
    let clip_id = 12;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-12".to_owned(),
            },
            ..Default::default()
        })
        .id();
    let instance_id = InstanceId::new();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });
    app.world_mut().spawn((
        instance_id,
        InstanceControls {
            intensity_scale: 1.0,
            rate: 1.0,
            ..Default::default()
        },
        InstanceClock::default(),
    ));

    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::from_millis(2500));
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: timeline_uid,
            label: "clocked-clip-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-1".to_owned(),
                label: "Start clip".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    materialized.spawned_entities.insert(
        clip_entity,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    app.world_mut().spawn(materialized);
    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .is_active = true;

    app.update();
    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should exist");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(1500));

    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .current_time = Duration::from_millis(3500);

    app.update();
    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should still exist");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(2500));
}

/// Verifies timeline-owned FX module clip clocks use authored playback rate changes.
#[test]
fn timeline_syncs_owned_fx_module_clip_clock_from_rate_aware_plan() {
    let mut app = App::new();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(Update, sync_timeline_paused_instance_controls_system);

    let timecode_id = 905;
    let clip_uid = Uuid::new_v4();
    let clip_id = 13;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-13".to_owned(),
            },
            source: Some(Source::FxModule(Uuid::new_v4())),
            ..Default::default()
        })
        .id();
    let instance_id = InstanceId::new();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });
    app.world_mut().spawn((
        instance_id,
        InstanceControls {
            intensity_scale: 1.0,
            rate: 1.0,
            ..Default::default()
        },
        InstanceClock::default(),
    ));

    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::from_millis(1500));
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: timeline_uid,
            label: "rate-aware-fx-module-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![
            Track {
                id: "track-1".to_owned(),
                label: "Track 1".to_owned(),
                muted: false,
                solo: false,
                expanded: false,
                actions: vec![
                    Action {
                        id: "start-1".to_owned(),
                        label: "Start FX module".to_owned(),
                        position: Duration::from_secs(1),
                        duration: Duration::ZERO,
                        action: ActionKind::StartClip(clip_uid),
                    },
                    Action {
                        id: "rate-1".to_owned(),
                        label: "Set rate".to_owned(),
                        position: Duration::from_secs(2),
                        duration: Duration::ZERO,
                        action: ActionKind::SetClipRate {
                            uid: clip_uid,
                            rate: 2.0,
                        },
                    },
                    Action {
                        id: "rate-0".to_owned(),
                        label: "Set zero rate".to_owned(),
                        position: Duration::from_secs(3),
                        duration: Duration::ZERO,
                        action: ActionKind::SetClipRate {
                            uid: clip_uid,
                            rate: 0.0,
                        },
                    },
                ],
                automation_lanes: Vec::new(),
            },
            Track {
                id: "track-2".to_owned(),
                label: "Muted Track".to_owned(),
                muted: true,
                solo: false,
                expanded: false,
                actions: vec![Action {
                    id: "muted-rate-1".to_owned(),
                    label: "Muted rate".to_owned(),
                    position: Duration::from_millis(1500),
                    duration: Duration::ZERO,
                    action: ActionKind::SetClipRate {
                        uid: clip_uid,
                        rate: 4.0,
                    },
                }],
                automation_lanes: Vec::new(),
            },
        ],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    materialized.spawned_entities.insert(
        clip_entity,
        (
            "track-1".to_owned(),
            "start-1".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    app.world_mut().spawn(materialized);
    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .is_active = true;

    app.update();
    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should exist");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(500));
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 1.0);

    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .current_time = Duration::from_millis(2500);

    app.update();
    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should still exist");
    assert_eq!(clock.position, Duration::from_secs(2));
    assert_eq!(clock.delta, Duration::from_millis(1500));
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should still exist");
    assert_eq!(controls.rate, 2.0);

    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .current_time = Duration::from_millis(3500);

    app.update();
    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should still exist after rate change");
    assert_eq!(clock.position, Duration::from_secs(3));
    assert_eq!(clock.delta, Duration::from_secs(1));
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should still exist after zero rate");
    assert_eq!(controls.rate, 0.0);

    app.update();
    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should still exist after stalled source tick");
    assert_eq!(clock.position, Duration::from_secs(3));
    assert_eq!(clock.delta, Duration::ZERO);
}

/// Verifies source-owned timeline clocks without clip attachments still use planned rates.
#[test]
fn timeline_syncs_source_owned_clock_without_materialized_clip_from_rate_aware_plan() {
    let mut app = App::new();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(Update, sync_timeline_paused_instance_controls_system);

    let timecode_id = 906;
    let clip_uid = Uuid::new_v4();
    let clip_id = 14;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-14".to_owned(),
            },
            source: Some(Source::Flow(Uuid::new_v4())),
            ..Default::default()
        })
        .id();
    let instance_id = InstanceId::new();
    let timeline_uid = Uuid::new_v4();
    let mut clock = InstanceClock {
        source: InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        },
        ..Default::default()
    };
    clock.seek_to(Duration::from_millis(500));
    app.world_mut().spawn((
        instance_id,
        InstanceControls {
            intensity_scale: 1.0,
            rate: 1.0,
            ..Default::default()
        },
        clock,
        nightfall_instances::Owner(clip_uid),
    ));

    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::from_millis(2500));
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: timeline_uid,
            label: "source-owned-rate-aware-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "start-1".to_owned(),
                    label: "Start Flow".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "rate-1".to_owned(),
                    label: "Set rate".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::SetClipRate {
                        uid: clip_uid,
                        rate: 2.0,
                    },
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    materialized.spawned_entities.insert(
        clip_entity,
        (
            "track-1".to_owned(),
            "start-1".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    app.world_mut().spawn(materialized);
    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .is_active = true;

    app.update();

    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("playback clock should exist");
    assert_eq!(clock.position, Duration::from_secs(2));
    assert_eq!(clock.rate, 2.0);
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 2.0);
}

/// Verifies timeline rate-master automation lanes drive attached playback controls.
#[test]
fn process_parameters_applies_rate_master_to_attached_instance() {
    let mut app = App::new();
    app.init_resource::<GlobalVariables>();
    app.add_systems(Update, process_parameters_system);

    let clip_uid = Uuid::new_v4();
    let clip_id = 42;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "rate-target".to_owned(),
        },
        ..Default::default()
    });

    let instance_id = InstanceId::new();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });
    app.world_mut().spawn((
        instance_id,
        InstanceControls {
            intensity_scale: 1.0,
            rate: 1.0,
            ..Default::default()
        },
    ));

    let timecode_uid = spawn_timecode(&mut app, 905, Duration::from_millis(500));
    app.world_mut()
        .query::<&mut TimecodeGenerator>()
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .is_active = true;

    let mut materialized = MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: 905,
            uid: Uuid::new_v4(),
            label: "rate-master-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: vec![AutomationLane {
                id: "rate-1".to_owned(),
                name: "Rate".to_owned(),
                color: "#ffffff".to_owned(),
                points: vec![AutomationPoint {
                    position: Duration::ZERO,
                    value: 0.75,
                }],
                parameter_type: ParameterType::RateMaster(clip_uid),
            }],
        }],
        ..Default::default()
    });
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 0.75);
}

/// Verifies a stopped manual timeline still freezes previously spawned clip instances while timecode is paused.
#[test]
fn inactive_paused_timeline_sets_owned_playback_rate_to_zero_and_restores() {
    let mut app = App::new();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(Update, sync_timeline_paused_instance_controls_system);

    let timecode_id = 903;
    let clip_uid = Uuid::new_v4();
    let clip_id = 11;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-11".to_owned(),
            },
            ..Default::default()
        })
        .id();
    let instance_id = InstanceId::new();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });
    app.world_mut().spawn((
        instance_id,
        InstanceControls {
            intensity_scale: 1.0,
            rate: 0.75,
            ..Default::default()
        },
    ));

    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::ZERO);
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: Uuid::new_v4(),
            label: "inactive-paused-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
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

    app.update();
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 0.0);

    let mut timecodes = app.world_mut().query::<&mut TimecodeGenerator>();
    timecodes
        .single_mut(app.world_mut())
        .expect("timecode should exist")
        .state
        .is_active = true;

    app.update();
    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("playback controls should exist");
    assert_eq!(controls.rate, 0.75);
}

/// Verifies paused timelines freeze clocked cues without shifting host-time anchors.
#[test]
fn paused_timeline_freezes_owned_cue_instance_clock_without_shifting() {
    let mut app = App::new();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.add_systems(Update, sync_timeline_paused_instance_controls_system);

    let timecode_id = 903;
    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::ZERO);
    let original_start = std::time::Instant::now() - Duration::from_millis(500);
    let cue_entity = app
        .world_mut()
        .spawn((
            MaterializedCue {
                activation_time: original_start,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(500),
                ..Default::default()
            },
        ))
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: Uuid::new_v4(),
            label: "clocked-paused-cue-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: Vec::new(),
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    materialized.spawned_entities.insert(
        cue_entity,
        (
            "track-1".to_owned(),
            "action-1".to_owned(),
            SpawnedEntityType::Cue,
        ),
    );
    app.world_mut().spawn(materialized);

    app.update();

    let cue = app
        .world()
        .get::<MaterializedCue>(cue_entity)
        .expect("timeline-owned cue should exist");
    assert_eq!(cue.activation_time, original_start);
    let clock = app
        .world()
        .get::<InstanceClock>(cue_entity)
        .expect("timeline-owned cue should keep its playback clock");
    assert!(
        clock.frozen,
        "timeline pause should freeze cue playback clock"
    );
}

#[test]
fn process_actions_skips_missing_clip_actions_without_panicking() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 43;
    let missing_clip_uid = Uuid::new_v4();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-missing-exec".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-1".to_owned(),
                label: "Missing exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(missing_clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .collect();
    assert!(
        clip_events.is_empty(),
        "missing clip references should be ignored without emitting commands"
    );
}

/// Verifies that a timeline owns a clip when JumpToCue autostarts it.
#[test]
fn process_actions_tracks_clip_autostarted_by_jump_to_cue() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 44;
    let clip_uid = Uuid::new_v4();
    let clip_id = 5;
    let sequence_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-5".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-jump".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-jump".to_owned(),
                label: "Jump exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::JumpToCue {
                    uid: clip_uid,
                    cue_index: 2,
                },
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    let timeline_entity = app.world_mut().spawn(materialized).id();

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        clip_events[0],
        ClipAction::Goto {
            clip_id: IdExpr::Single(id),
            position: 2,
            timing: None,
        } if id == clip_id
    ));

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-jump"
    ));
}

/// Verifies JumpToCue claims running clips without fabricating timing.
#[test]
fn process_actions_tracks_running_clip_for_jump_to_cue() {
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
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 45;
    let clip_uid = Uuid::new_v4();
    let clip_id = 6;
    let sequence_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-6".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: InstanceId::new(),
        auto_release_on_stop: false,
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-running-jump".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(2)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-jump".to_owned(),
                label: "Jump exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::JumpToCue {
                    uid: clip_uid,
                    cue_index: 2,
                },
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    let timeline_entity = app.world_mut().spawn(materialized).id();

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        clip_events[0],
        ClipAction::Goto {
            clip_id: IdExpr::Single(id),
            position: 2,
            timing: None,
        } if id == clip_id
    ));

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    let (_, action_id, spawn_type) = timeline
        .spawned_entities
        .get(&clip_entity)
        .expect("jumped clip should be tracked as timeline-owned");
    assert_eq!(action_id, "action-jump");
    assert!(matches!(spawn_type, SpawnedEntityType::Clip));
}

/// Verifies live navigation uses the clip's timeline start action as its clock origin.
#[test]
fn process_actions_preserves_started_clip_origin_for_jump_to_cue() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (handle_timeline_seek_system, process_actions_system).chain(),
    );

    let timeline_id = 144;
    let clip_uid = Uuid::new_v4();
    let clip_id = 105;
    let sequence_uid = Uuid::new_v4();
    let first_cue_uid = Uuid::new_v4();
    let second_cue_uid = Uuid::new_v4();
    app.world_mut().resource_mut::<DataProvider<Cue>>().extend([
        Cue {
            identifiers: Identifiers {
                id: 1,
                uid: first_cue_uid,
                label: "Cue 1".to_owned(),
            },
            ..Default::default()
        },
        Cue {
            identifiers: Identifiers {
                id: 2,
                uid: second_cue_uid,
                label: "Cue 2".to_owned(),
            },
            ..Default::default()
        },
    ]);
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "Sequence".to_owned(),
            },
            steps: vec![first_cue_uid.into(), second_cue_uid.into()],
            ..Default::default()
        })
        .expect("sequence should insert");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-105".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-then-jump".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::from_secs(3)),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-start".to_owned(),
                    label: "Start exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-jump".to_owned(),
                    label: "Jump exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::JumpToCue {
                        uid: clip_uid,
                        cue_index: 2,
                    },
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };

    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    let timeline_entity = app.world_mut().spawn(materialized).id();

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert_eq!(clip_events.len(), 2);
    assert!(matches_timed_start(
        &clip_events[0],
        clip_id,
        Duration::from_secs(1),
        Duration::from_secs(3)
    ));
    assert!(matches!(
        clip_events[1],
        ClipAction::RenderAt {
            clip_id: IdExpr::Single(id),
            position: 2,
            timing,
            ..
        } if id == clip_id
            && timing.started_at == Duration::from_secs(1)
            && timing.position == Duration::from_secs(2)
    ));

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}
