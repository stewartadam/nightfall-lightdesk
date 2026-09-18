// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_actions::ActionInvocation;
use nightfall_desk::prelude::{DESK_EVAL_ACTION_ID, desk_eval_action};

use super::*;
use crate::TimelineNondeterministicSeekBehavior;

/// Verifies invalid JumpToCue seek data still cleans up existing timeline-owned playback.
#[test]
fn seek_tracks_clip_autostarted_by_jump_to_cue_after_cleanup() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 46;
    let clip_uid = Uuid::new_v4();
    let clip_id = 7;
    let sequence_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-7".to_owned(),
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
            label: "timeline-seek-jump".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
    materialized.spawned_entities.insert(
        clip_entity,
        (
            "track-1".to_owned(),
            "old-start".to_owned(),
            SpawnedEntityType::Clip,
        ),
    );
    let timeline_entity = app.world_mut().spawn(materialized).id();

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
    assert_eq!(clip_events.len(), 1);
    assert!(matches!(
        clip_events[0],
        ClipAction::Stop(IdExpr::Single(id)) if id == clip_id
    ));

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(!timeline.spawned_entities.contains_key(&clip_entity));
}

/// Verifies resolvable navigation-only sequence seek materializes directly.
#[test]
fn seek_replay_direct_materializes_jump_to_cue_autostart() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 251;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 244;
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid) in [(1, cue_1_uid), (2, cue_2_uid)] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: format!("cue-{id}"),
                    },
                    ..Default::default()
                })
                .expect("cue should be stored");
        }
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: [cue_1_uid, cue_2_uid].into_iter().map(Into::into).collect(),
            ..Default::default()
        })
        .expect("sequence should be stored");

    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "sequence-exec".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-navigation-direct".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
    let timeline_entity = app
        .world_mut()
        .spawn(MaterializedTimeline::new(timeline))
        .id();

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
    assert!(
        clip_events.is_empty(),
        "resolvable navigation-only sequence seek should materialize directly: {clip_events:?}"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].0, 2);
    assert_eq!(sequences[0].1.position, Duration::from_secs(1));
    assert_eq!(
        sequences[0].1.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-jump"
    ));
}

/// Verifies resolvable go-autostart sequence seek materializes directly.
#[test]
fn seek_replay_direct_materializes_go_autostart() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 252;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid) in [(1, cue_1_uid), (2, cue_2_uid)] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: format!("cue-{id}"),
                    },
                    ..Default::default()
                })
                .expect("cue should be stored");
        }
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: [cue_1_uid, cue_2_uid].into_iter().map(Into::into).collect(),
            ..Default::default()
        })
        .expect("sequence should be stored");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 245,
            uid: clip_uid,
            label: "sequence-exec".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-go-direct".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-go".to_owned(),
                label: "Go exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::AdvanceSequence(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

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
    assert!(
        clip_events.is_empty(),
        "resolvable go-autostart sequence seek should materialize directly: {clip_events:?}"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].0, 2);
    assert_eq!(sequences[0].1.position, Duration::from_secs(1));
    assert_eq!(
        sequences[0].1.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );
}

/// Verifies semantic desk eval is not converted into deterministic sequence materialization.
#[test]
fn seek_replay_ignores_desk_eval_go_autostart_by_default() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 253;
    let timeline_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid) in [(1, cue_1_uid), (2, cue_2_uid)] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: format!("cue-{id}"),
                    },
                    ..Default::default()
                })
                .expect("cue should be stored");
        }
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: [cue_1_uid, cue_2_uid].into_iter().map(Into::into).collect(),
            ..Default::default()
        })
        .expect("sequence should be stored");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 246,
            uid: Uuid::new_v4(),
            label: "sequence-exec".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-desk-go-direct".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-desk-go".to_owned(),
                label: "Desk go".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval("clip 246 go".to_owned()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

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
    assert!(
        clip_events.is_empty(),
        "default seek policy should not parse desk eval into clip commands: {clip_events:?}"
    );

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "default seek policy should ignore non-deterministic desk eval: {desk_events:?}"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert!(
        sequences.is_empty(),
        "desk eval should not materialize a sequence during deterministic seek: {sequences:?}"
    );
}

/// Verifies seek reconstruction tracks deterministic sequence navigation, not desk eval actions.
#[test]
fn seek_replay_tracks_sequence_navigation_desk_eval_and_running_jump_clips() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 47;
    let advance_uid = Uuid::new_v4();
    let back_uid = Uuid::new_v4();
    let jump_uid = Uuid::new_v4();
    let desk_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_3_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid) in [(1, cue_1_uid), (2, cue_2_uid), (3, cue_3_uid)] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: format!("cue-{id}"),
                    },
                    ..Default::default()
                })
                .expect("cue should be stored");
        }
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: [cue_1_uid, cue_2_uid, cue_3_uid]
                .into_iter()
                .map(Into::into)
                .collect(),
            ..Default::default()
        })
        .expect("sequence should be stored");

    let advance_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 20,
                uid: advance_uid,
                label: "advance-exec".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();
    let back_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 21,
                uid: back_uid,
                label: "back-exec".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();
    let jump_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 22,
                uid: jump_uid,
                label: "jump-exec".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();
    let desk_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 23,
                uid: desk_uid,
                label: "desk-exec".to_owned(),
            },
            ..Default::default()
        })
        .id();
    app.world_mut().spawn(MaterializedClip {
        clip_id: 22,
        attached_instance: InstanceId::new(),
        auto_release_on_stop: false,
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-seek-navigation-ownership".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
                    action: ActionKind::AdvanceSequence(advance_uid),
                },
                Action {
                    id: "action-back".to_owned(),
                    label: "Back exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::BackSequence(back_uid),
                },
                Action {
                    id: "action-jump".to_owned(),
                    label: "Jump exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::JumpToCue {
                        uid: jump_uid,
                        cue_index: 2,
                    },
                },
                Action {
                    id: "action-desk".to_owned(),
                    label: "Desk eval exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("clip 23 go".to_owned()),
                },
            ],
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
            position: Duration::from_secs(2),
        }));

    app.update();

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&advance_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-advance"
    ));
    assert!(matches!(
        timeline.spawned_entities.get(&back_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-back"
    ));
    assert!(matches!(
        timeline.spawned_entities.get(&jump_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-jump"
    ));
    assert!(!timeline.spawned_entities.contains_key(&desk_entity));
}

/// Verifies default seek policy ignores semantic desk eval clip commands.
#[test]
fn seek_replay_ignores_desk_eval_clip_go_by_default() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 246;
    let clip_uid = Uuid::new_v4();
    let clip_id = 23;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "semantic-desk-exec".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-semantic-desk-eval".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-desk".to_owned(),
                label: "Desk eval exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval("clip 23 go".to_owned()),
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
            position: Duration::from_secs(2),
        }));

    app.update();

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "semantic clip desk eval should not replay opaque desk commands: {desk_events:?}"
    );

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "default seek policy should not parse desk eval into clip commands: {clip_events:?}"
    );

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(!timeline.spawned_entities.contains_key(&clip_entity));
}

/// Verifies dispatch seek policy replays semantic desk eval as eval text, not clip commands.
#[test]
fn seek_replay_dispatches_desk_eval_clip_back_when_configured() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 247;
    let clip_uid = Uuid::new_v4();
    let clip_id = 23;
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "semantic-desk-back-exec".to_owned(),
            },
            source: Some(Source::Sequence(Uuid::new_v4())),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-semantic-desk-back".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Dispatch,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-desk".to_owned(),
                label: "Desk eval exec".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::DeskEval("clip 23 back".to_owned()),
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
            position: Duration::from_secs(2),
        }));

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
        DeskAction::Eval(command) if command == "clip 23 back"
    ));

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "dispatch seek policy should not parse desk eval into clip commands: {clip_events:?}"
    );

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(!timeline.spawned_entities.contains_key(&clip_entity));
}

/// Verifies registered desk eval actions use the same seek replay policy as native desk eval.
#[test]
fn seek_replay_dispatches_registered_desk_eval_when_configured() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<ActionInvocation>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 998;
    let command = "group 1 at 50";
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-registered-desk-dispatch".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Dispatch,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-registered-desk".to_owned(),
                label: "Registered desk eval".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::RegisteredAction(desk_eval_action(command)),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(2),
        }));

    app.update();

    let action_invocations: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<ActionInvocation>>()
        .drain()
        .collect();
    assert_eq!(action_invocations.len(), 1);
    assert_eq!(
        action_invocations[0].action.id.as_str(),
        DESK_EVAL_ACTION_ID
    );
    assert_eq!(action_invocations[0].action.arguments["command"], command);
}

/// Verifies desk eval does not participate in planned sequence materialization.
#[test]
fn seek_replay_direct_materializes_sequence_without_desk_eval_go() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 248;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 24;
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "cue-1".to_owned(),
            },
            ..Default::default()
        })
        .expect("cue 1 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "cue-2".to_owned(),
            },
            trigger: CueTriggerType::Manual,
            ..Default::default()
        })
        .expect("cue 2 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-24".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-desk-eval-go-direct".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
                    position: Duration::from_millis(100),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-desk".to_owned(),
                    label: "Desk eval go".to_owned(),
                    position: Duration::from_millis(450),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("clip 24 go".to_owned()),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(800),
        }));

    app.update();

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "default seek policy should ignore desk eval instead of planning it: {desk_events:?}"
    );
    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "sequence start should materialize directly without eval intervention: {clip_events:?}"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].0, 1);
    assert_eq!(sequences[0].1.position, Duration::from_millis(700));
    assert_eq!(
        sequences[0].1.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(100),
        }
    );
}

/// Verifies cleanup of one clip does not block direct materialization for another.
#[test]
fn seek_replay_direct_materializes_sequence_with_unrelated_clip_cleanup() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 249;
    let timeline_uid = Uuid::new_v4();
    let old_clip_uid = Uuid::new_v4();
    let old_clip_id = 241;
    let clip_uid = Uuid::new_v4();
    let clip_id = 242;
    let sequence_uid = Uuid::new_v4();
    let cue_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_uid,
                label: "cue-1".to_owned(),
            },
            ..Default::default()
        })
        .expect("cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: vec![cue_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");

    let old_clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: old_clip_id,
                uid: old_clip_uid,
                label: "old-exec".to_owned(),
            },
            ..Default::default()
        })
        .id();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "sequence-exec".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-unrelated-cleanup-direct".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_millis(100),
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
            materialized.spawned_entities.insert(
                old_clip_entity,
                (
                    "old-track".to_owned(),
                    "old-action".to_owned(),
                    SpawnedEntityType::Clip,
                ),
            );
            materialized
        })
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(800),
        }));

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
        ClipAction::Stop(IdExpr::Single(id)) if id == old_clip_id
    ));

    let mut sequence_query = app.world_mut().query::<(
        bevy_ecs::prelude::Entity,
        &MaterializedSequence,
        &InstanceClock,
    )>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(entity, sequence, clock)| (entity, sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].1, 1);
    assert_eq!(sequences[0].2.position, Duration::from_millis(700));
    assert_eq!(
        sequences[0].2.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(100),
        }
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        !timeline.spawned_entities.contains_key(&old_clip_entity),
        "old cleanup clip should not remain tracked"
    );
    assert!(matches!(
        timeline.spawned_entities.get(&clip_entity),
        Some((track_id, action_id, SpawnedEntityType::Clip))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies same-clip cleanup does not force planned sequence command replay.
#[test]
fn seek_replay_direct_materializes_sequence_with_same_clip_cleanup() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 250;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 243;
    let sequence_uid = Uuid::new_v4();
    let cue_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_uid,
                label: "cue-1".to_owned(),
            },
            ..Default::default()
        })
        .expect("cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: vec![cue_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");

    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "sequence-exec".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();
    let stale_instance_id = InstanceId::new();
    let stale_playback_entity = app
        .world_mut()
        .spawn((
            stale_instance_id,
            InstanceMetadata::new(InstanceKind::Sequence).with_name("stale-sequence"),
            InstanceControls::default(),
        ))
        .id();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: stale_instance_id,
        auto_release_on_stop: false,
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-same-cleanup-direct".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start exec".to_owned(),
                position: Duration::from_millis(100),
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
            materialized.spawned_entities.insert(
                clip_entity,
                (
                    "old-track".to_owned(),
                    "old-action".to_owned(),
                    SpawnedEntityType::Clip,
                ),
            );
            materialized
        })
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(800),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "same-clip planned sequence seek should directly reconcile instead of replaying stop/start commands: {clip_events:?}"
    );
    assert!(
        app.world()
            .get::<InstanceId>(stale_playback_entity)
            .is_none(),
        "stale attached playback should be despawned directly during seek cleanup"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].0, 1);
    assert_eq!(sequences[0].1.position, Duration::from_millis(700));
    assert_eq!(
        sequences[0].1.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(100),
        }
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

/// Verifies opaque desk eval text is not replayed during deterministic seek reconstruction.
#[test]
fn seek_replay_skips_opaque_desk_eval_commands() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 247;
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-opaque-desk-eval".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
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
                action: ActionKind::DeskEval("group 1 at 50".to_owned()),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(2),
        }));

    app.update();

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "opaque desk eval should not replay during deterministic seek: {desk_events:?}"
    );

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "opaque desk eval should not emit clip commands during seek: {clip_events:?}"
    );
}

/// Verifies incomplete sequence source data does not fall back to clip replay.
#[test]
fn seek_replay_skips_started_clip_with_missing_sequence_data() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 46;
    let clip_uid = Uuid::new_v4();
    let clip_id = 7;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-7".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-offset".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
                duration: Duration::from_secs(5),
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(3),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "missing sequence data should not replay clip commands: {clip_events:?}"
    );
}

/// Verifies seek replay asks the sequence domain to derive autonomous AfterDelay progression.
#[test]
fn seek_replay_materializes_autonomous_sequence_progression() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 149;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 24;
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "cue-1".to_owned(),
            },
            ..Default::default()
        })
        .expect("cue 1 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "cue-2".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            ..Default::default()
        })
        .expect("cue 2 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-24".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-autonomous-sequence".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(3),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "planned sequence seek should materialize directly instead of replaying clip commands: {clip_events:?}"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].0, 2);
    assert_eq!(sequences[0].1.position, Duration::from_secs(2));
    assert_eq!(
        sequences[0].1.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );
}

/// Verifies planned sequence reduction applies autonomous movement before explicit navigation.
#[test]
fn seek_replay_applies_autonomous_progression_before_planned_intervention() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 150;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 25;
    let sequence_uid = Uuid::new_v4();
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_3_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "cue-1".to_owned(),
            },
            ..Default::default()
        })
        .expect("cue 1 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "cue-2".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_millis(200)),
            ..Default::default()
        })
        .expect("cue 2 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 3,
                uid: cue_3_uid,
                label: "cue-3".to_owned(),
            },
            trigger: CueTriggerType::Manual,
            ..Default::default()
        })
        .expect("cue 3 should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into(), cue_3_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-25".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-autonomous-before-go".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
                    position: Duration::from_millis(100),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-advance".to_owned(),
                    label: "Advance exec".to_owned(),
                    position: Duration::from_millis(450),
                    duration: Duration::ZERO,
                    action: ActionKind::AdvanceSequence(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(800),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "planned sequence seek should materialize directly instead of replaying clip commands: {clip_events:?}"
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock)>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(sequence, clock)| (sequence.position(), clock.clone()))
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].0, 3);
    assert_eq!(sequences[0].1.position, Duration::from_millis(700));
    assert_eq!(
        sequences[0].1.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(100),
        }
    );
}

/// Verifies seek directly materializes a planned stopped sequence release.
#[test]
fn seek_replay_materializes_stopped_sequence_release_directly() {
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
        (handle_timeline_seek_system, paint_materialized_sequences).chain(),
    );

    let timeline_id = 151;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 26;
    let sequence_uid = Uuid::new_v4();
    let cue_uid = Uuid::new_v4();

    let cue = cue_with_release_duration(&mut app, cue_uid, Duration::from_secs(1));
    let release_cue = cue.clone();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-release".to_owned(),
            },
            steps: vec![cue_uid.into()],
            release_cue,
            ..Default::default()
        })
        .expect("sequence should be stored");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-26".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-stopped-sequence-release".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
                    position: Duration::from_millis(100),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Stop exec".to_owned(),
                    position: Duration::from_millis(1100),
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
        .spawn(MaterializedTimeline::new(timeline))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(1600),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "planned stopped sequence release should materialize directly instead of replaying clip commands: {clip_events:?}"
    );

    let mut sequence_query = app.world_mut().query::<(
        bevy_ecs::prelude::Entity,
        &MaterializedSequence,
        &InstanceClock,
        &PlaybackReleaseTiming,
        &ReleaseMarker,
    )>();
    let sequences = sequence_query
        .iter(app.world())
        .map(|(entity, sequence, clock, release_timing, _)| {
            (
                entity,
                sequence.position(),
                sequence.release_started_position(),
                clock.clone(),
                *release_timing,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(sequences.len(), 1);
    assert_eq!(sequences[0].1, 1);
    assert_eq!(sequences[0].2, Some(Duration::from_secs(1)));
    assert_eq!(sequences[0].3.position, Duration::from_millis(1500));
    assert_eq!(
        sequences[0].3.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(100),
        }
    );
    assert_eq!(sequences[0].4.released_at, Duration::from_secs(1));
    let compositing_context = app
        .world()
        .entity(sequences[0].0)
        .get::<LayerCompositingContext>()
        .expect("paint should observe sequence release timing in the seek frame");
    assert_eq!(
        compositing_context.released_at,
        Some(Duration::from_secs(1))
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(matches!(
        timeline.spawned_entities.get(&sequences[0].0),
        Some((track_id, action_id, SpawnedEntityType::Instance))
            if track_id == "track-1" && action_id == "action-start"
    ));
}

/// Verifies authored stops with incomplete sequence data do not fall back to clip replay.
#[test]
fn seek_replay_skips_timed_stop_with_missing_sequence_data() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 148;
    let clip_uid = Uuid::new_v4();
    let clip_id = 19;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-19".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-stop-offset".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(3),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "missing sequence data should not replay clip start/stop commands: {clip_events:?}"
    );
}

/// Verifies sequence navigation with missing cue data does not fall back to clip replay.
#[test]
fn seek_replay_skips_advanced_sequence_with_missing_cue_data() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 48;
    let clip_uid = Uuid::new_v4();
    let clip_id = 9;
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: [Uuid::new_v4(), Uuid::new_v4()]
                .into_iter()
                .map(Into::into)
                .collect(),
            wrap: false,
            ..Default::default()
        })
        .expect("sequence should be stored");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "exec-9".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-advance-offset".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
                    duration: Duration::from_millis(750),
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-advance".to_owned(),
                    label: "Advance exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::AdvanceSequence(clip_uid),
                },
            ],
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
            position: Duration::from_secs(3),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "missing cue data should not replay clip commands: {clip_events:?}"
    );

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "invalid sequence reconstruction should not emit desk commands"
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(!timeline.spawned_entities.contains_key(&clip_entity));
}

/// Verifies sequence back with missing cue data does not fall back to clip replay.
#[test]
fn seek_replay_skips_back_sequence_with_missing_cue_data() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 49;
    let clip_uid = Uuid::new_v4();
    let clip_id = 10;
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence-1".to_owned(),
            },
            steps: [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()]
                .into_iter()
                .map(Into::into)
                .collect(),
            wrap: false,
            ..Default::default()
        })
        .expect("sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-10".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-back-offset".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-jump".to_owned(),
                    label: "Jump exec".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::JumpToCue {
                        uid: clip_uid,
                        cue_index: 3,
                    },
                },
                Action {
                    id: "action-back".to_owned(),
                    label: "Back exec".to_owned(),
                    position: Duration::from_secs(2),
                    duration: Duration::ZERO,
                    action: ActionKind::BackSequence(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(3),
        }));

    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        clip_events.is_empty(),
        "missing cue data should not replay clip commands: {clip_events:?}"
    );

    let desk_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<DeskAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        desk_events.is_empty(),
        "invalid sequence reconstruction should not emit desk commands"
    );
}
