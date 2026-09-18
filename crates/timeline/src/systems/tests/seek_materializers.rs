// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_instances::DomainInstanceReconstructionRequest;

use super::*;

/// Verifies source-less clip starts are not replayed during deterministic seek.
#[test]
fn seek_replay_skips_source_less_clip_start() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 47;
    let clip_uid = Uuid::new_v4();
    let clip_id = 8;
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: clip_uid,
            label: "exec-8".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-non-sequence".to_owned(),
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
        "source-less clip starts should not be replayed during deterministic seek: {clip_events:?}"
    );
}

/// Verifies resolvable classic FX clip starts materialize from evaluated planner state.
#[test]
fn seek_replay_direct_materializes_classic_fx_clip() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Fx>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 48;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 9;
    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 3,
                uid: fx_uid,
                label: "planner-fx".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "fx-clip".to_owned(),
            },
            source: Some(Source::Fx(fx_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-direct-fx-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "FX Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "fx-start".to_owned(),
                    label: "Start FX".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "fx-rate".to_owned(),
                    label: "Set FX rate".to_owned(),
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
        "resolvable classic FX seek should materialize directly instead of replaying clip commands: {clip_events:?}"
    );

    let (materialized_fx_uid, clock_position, clock_rate, clock_source, instance_id) = {
        let mut materialized_fx_query =
            app.world_mut()
                .query::<(&MaterializedFx, &InstanceClock, &InstanceId)>();
        let materialized_fx = materialized_fx_query
            .iter(app.world())
            .map(|(mfx, clock, instance_id)| {
                (
                    mfx.identifiers().uid,
                    clock.position,
                    clock.rate,
                    clock.source,
                    *instance_id,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            materialized_fx.len(),
            1,
            "expected exactly one directly materialized FX playback"
        );
        materialized_fx[0]
    };
    assert_eq!(materialized_fx_uid, fx_uid);
    assert_eq!(clock_position, Duration::from_secs(3));
    assert_eq!(clock_rate, 2.0);
    assert_eq!(
        clock_source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );

    let materialized_clips = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|mexec| (mexec.clip_id, mexec.attached_instance))
        .collect::<Vec<_>>();
    assert_eq!(materialized_clips.len(), 1);
    assert_eq!(materialized_clips[0].0, clip_id);
    assert_eq!(materialized_clips[0].1, instance_id);

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "directly materialized FX clip should remain timeline-owned"
    );
}

/// Verifies same-clip cleanup does not force planned classic FX command replay.
#[test]
fn seek_replay_direct_materializes_classic_fx_with_same_clip_cleanup() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Fx>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 248;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 209;
    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 23,
                uid: fx_uid,
                label: "planner-fx".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "fx-clip".to_owned(),
            },
            source: Some(Source::Fx(fx_uid)),
            ..Default::default()
        })
        .id();

    let stale_instance_id = InstanceId::new();
    let stale_playback_entity = app
        .world_mut()
        .spawn((
            stale_instance_id,
            InstanceMetadata::new(InstanceKind::Fx).with_name("stale-fx"),
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
            label: "timeline-direct-fx-same-cleanup".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "FX Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "fx-start".to_owned(),
                label: "Start FX".to_owned(),
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
        "same-clip planned FX seek should directly reconcile instead of replaying stop/start commands: {clip_events:?}"
    );
    assert!(
        app.world()
            .get::<InstanceId>(stale_playback_entity)
            .is_none(),
        "stale attached playback should be despawned directly during seek cleanup"
    );

    let (materialized_fx_uid, clock_position, clock_source, instance_id) = {
        let mut materialized_fx_query =
            app.world_mut()
                .query::<(&MaterializedFx, &InstanceClock, &InstanceId)>();
        let materialized_fx = materialized_fx_query
            .iter(app.world())
            .map(|(mfx, clock, instance_id)| {
                (
                    mfx.identifiers().uid,
                    clock.position,
                    clock.source,
                    *instance_id,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            materialized_fx.len(),
            1,
            "expected exactly one directly materialized FX playback"
        );
        materialized_fx[0]
    };
    assert_eq!(materialized_fx_uid, fx_uid);
    assert_eq!(clock_position, Duration::from_secs(2));
    assert_eq!(
        clock_source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );

    let materialized_clips = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|mexec| (mexec.clip_id, mexec.attached_instance))
        .collect::<Vec<_>>();
    assert_eq!(materialized_clips.len(), 1);
    assert_eq!(materialized_clips[0].0, clip_id);
    assert_eq!(materialized_clips[0].1, instance_id);

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "directly materialized FX clip should remain timeline-owned"
    );
}

/// Verifies resolvable Step FX clip starts materialize from evaluated planner state.
#[test]
fn seek_replay_direct_materializes_step_fx_clip() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 50;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 11;
    let step_fx_uid = Uuid::new_v4();
    let step_fx_entity = app
        .world_mut()
        .spawn(StepFx {
            identifiers: Identifiers {
                id: 7,
                uid: step_fx_uid,
                label: "planner-step-fx".to_owned(),
            },
            selection: SelectionExpr::Resolved(vec![]).into(),
            ..Default::default()
        })
        .id();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "step-fx-clip".to_owned(),
            },
            source: Some(Source::StepFx(step_fx_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-direct-step-fx-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Step FX Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "step-fx-start".to_owned(),
                label: "Start Step FX".to_owned(),
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
        "resolvable Step FX seek should materialize directly instead of replaying clip commands: {clip_events:?}"
    );

    let (fx_entity, clock_position, clock_source, instance_id, display_kind) = {
        let mut active_fx_query = app.world_mut().query::<(
            &ActiveStepFx,
            &InstanceClock,
            &InstanceId,
            &InstanceMetadata,
        )>();
        let active_fx = active_fx_query
            .iter(app.world())
            .map(|(active_fx, clock, instance_id, metadata)| {
                (
                    active_fx.fx_entity,
                    clock.position,
                    clock.source,
                    *instance_id,
                    metadata.display_kind.clone(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            active_fx.len(),
            1,
            "expected exactly one directly materialized Step FX playback"
        );
        active_fx[0].clone()
    };
    assert_eq!(fx_entity, step_fx_entity);
    assert_eq!(clock_position, Duration::from_secs(2));
    assert_eq!(
        clock_source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );
    assert_eq!(display_kind, InstanceDisplayKind::StepFx);

    let materialized_clips = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|mexec| (mexec.clip_id, mexec.attached_instance))
        .collect::<Vec<_>>();
    assert_eq!(materialized_clips.len(), 1);
    assert_eq!(materialized_clips[0].0, clip_id);
    assert_eq!(materialized_clips[0].1, instance_id);

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "directly materialized Step FX clip should remain timeline-owned"
    );
}

/// Verifies resolvable FX module clip starts reconcile active module timing directly.
#[test]
fn seek_replay_direct_reconciles_fx_module_clip() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<DomainInstanceReconstructionRequest>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(DataProvider::<StoredFxModule>::default());
    app.insert_resource(ActiveFxModuleIds::default());
    app.insert_resource(ActiveFxModuleTimings::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (
            handle_timeline_seek_system,
            nightfall_fx_module::events::handle_domain_playback_reconstruction_requests,
        )
            .chain(),
    );

    let timeline_id = 51;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 12;
    let fx_module_uid = Uuid::new_v4();
    let fx_module_id = 17;
    app.world_mut()
        .resource_mut::<DataProvider<StoredFxModule>>()
        .add(StoredFxModule {
            identifiers: Identifiers {
                id: fx_module_id,
                uid: fx_module_uid,
                label: "planner-fx-module".to_owned(),
            },
            module_name: "test-module".to_owned(),
            ..Default::default()
        })
        .expect("store fx module definition");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "fx-module-clip".to_owned(),
            },
            source: Some(Source::FxModule(fx_module_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-direct-fx-module-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "FX Module Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "fx-module-start".to_owned(),
                    label: "Start FX Module".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "fx-module-rate".to_owned(),
                    label: "Set FX Module rate".to_owned(),
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
        "resolvable FX module seek should reconcile active module state directly instead of replaying clip commands: {clip_events:?}"
    );

    assert!(
        app.world()
            .resource::<ActiveFxModuleIds>()
            .0
            .contains(&fx_module_id),
        "direct FX module seek should mark the stored module active"
    );
    let clock = app
        .world()
        .resource::<ActiveFxModuleTimings>()
        .0
        .get(&fx_module_id)
        .cloned()
        .expect("direct FX module seek should seed a playback clock");
    assert_eq!(clock.position, Duration::from_secs(3));
    assert_eq!(clock.rate, 2.0);
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "directly reconciled FX module clip should remain timeline-owned"
    );

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::ZERO,
        }));
    app.update();

    let clip_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
        .drain()
        .map(|event| event.action)
        .collect();
    assert!(
        matches!(
            clip_events.as_slice(),
            [ClipAction::Stop(IdExpr::Single(id))] if *id == clip_id
        ),
        "backward seek before a started FX module should use stop cleanup: {clip_events:?}"
    );
}

/// Verifies repeated FX module seek reconciliation preserves runtime-owned playback layers.
#[test]
fn seek_replay_direct_fx_module_second_seek_keeps_existing_layer() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<DomainInstanceReconstructionRequest>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(DataProvider::<StoredFxModule>::default());
    app.insert_resource(ActiveFxModuleIds::default());
    app.insert_resource(ActiveFxModuleTimings::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (
            handle_timeline_seek_system,
            nightfall_fx_module::events::handle_domain_playback_reconstruction_requests,
        )
            .chain(),
    );

    let timeline_id = 59;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 25;
    let fx_module_uid = Uuid::new_v4();
    let fx_module_id = 31;
    app.world_mut()
        .resource_mut::<DataProvider<StoredFxModule>>()
        .add(StoredFxModule {
            identifiers: Identifiers {
                id: fx_module_id,
                uid: fx_module_uid,
                label: "repeated-seek-fx-module".to_owned(),
            },
            module_name: "test-module".to_owned(),
            ..Default::default()
        })
        .expect("store fx module definition");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "repeated-fx-module-clip".to_owned(),
            },
            source: Some(Source::FxModule(fx_module_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-repeated-fx-module-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "FX Module Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "fx-module-start".to_owned(),
                label: "Start FX Module".to_owned(),
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

    let instance_id = InstanceId::new();
    let layer_entity = app
        .world_mut()
        .spawn((
            ActiveFxModuleLayer { fx_module_uid },
            instance_id,
            InstanceMetadata::new(InstanceKind::Fx)
                .with_display_kind(InstanceDisplayKind::ModuleFx),
            InstanceControls::default(),
            InstanceStatus::default(),
        ))
        .id();
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_secs(4),
        }));
    app.update();

    assert!(
        app.world().get_entity(layer_entity).is_ok(),
        "second direct FX module seek should not despawn the runtime-owned layer"
    );
    assert!(
        app.world()
            .resource::<ActiveFxModuleIds>()
            .0
            .contains(&fx_module_id),
        "second direct FX module seek should keep the module active"
    );
    assert!(
        app.world()
            .resource::<ActiveFxModuleTimings>()
            .0
            .contains_key(&fx_module_id),
        "second direct FX module seek should refresh source-local timing"
    );
    let timeline = app
        .world_mut()
        .query::<&MaterializedTimeline>()
        .single(app.world())
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "directly reconciled FX module clip should remain timeline-owned after repeated seek"
    );
}

/// Verifies resolvable Flow clip starts reconstruct through Flow-owned playback state.
#[test]
fn seek_replay_direct_materializes_flow_clip() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<DomainInstanceReconstructionRequest>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(DataProvider::<FlowDefinition>::default());
    app.insert_resource(FlowNodeRegistry::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(
        Update,
        (
            handle_timeline_seek_system,
            nightfall_flow::events::handle_domain_playback_reconstruction_requests,
        )
            .chain(),
    );

    let timeline_id = 52;
    let timeline_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();
    let clip_id = 13;
    let flow_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<FlowDefinition>>()
        .add(FlowDefinition::new(Identifiers {
            id: 23,
            uid: flow_uid,
            label: "planner-flow".to_owned(),
        }))
        .expect("store flow definition");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "flow-clip".to_owned(),
            },
            source: Some(Source::Flow(flow_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline-direct-flow-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Flow Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "flow-start".to_owned(),
                    label: "Start Flow".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "flow-rate".to_owned(),
                    label: "Set Flow rate".to_owned(),
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
        "resolvable Flow seek should materialize directly instead of replaying clip commands: {clip_events:?}"
    );

    let (flow_id, clock_position, clock_rate, clock_source, display_kind) = {
        let mut flow_query = app
            .world_mut()
            .query::<(&FlowInstance, &InstanceClock, &InstanceMetadata)>();
        let flows = flow_query
            .iter(app.world())
            .map(|(instance, clock, metadata)| {
                (
                    instance.flow_id,
                    clock.position,
                    clock.rate,
                    clock.source,
                    metadata.display_kind.clone(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            flows.len(),
            1,
            "expected exactly one directly materialized Flow playback"
        );
        flows[0].clone()
    };
    assert_eq!(flow_id, 23);
    assert_eq!(clock_position, Duration::from_secs(3));
    assert_eq!(clock_rate, 2.0);
    assert_eq!(
        clock_source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );
    assert_eq!(display_kind, InstanceDisplayKind::FlowFx);

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "directly materialized Flow clip should remain timeline-owned"
    );
}

/// Verifies unsupported source-less StartClip actions are not reconstructed after visual duration.
#[test]
fn seek_replay_skips_source_less_clip_after_action_duration_without_stop() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 48;
    let clip_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 9,
                uid: clip_uid,
                label: "sparkles-fx".to_owned(),
            },
            source: None,
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-start-clip-visual-duration-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "FX Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "sparkles".to_owned(),
                label: "Sparkles".to_owned(),
                position: Duration::from_secs(10),
                duration: Duration::from_secs(5),
                action: ActionKind::StartClip(clip_uid),
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
            position: Duration::from_secs(16),
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
        "source-less clip starts should not be replayed after visual duration: {clip_events:?}"
    );

    let timeline = app
        .world_mut()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        !timeline.spawned_entities.contains_key(&clip_entity),
        "unsupported clip starts should not become timeline-owned during seek"
    );
}

/// Verifies stopped classic FX clip aggregates are planned as no-ops on seek.
#[test]
fn seek_replay_skips_stopped_fx_clip_after_zero_release() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<TimelineCommandOrigins>();
    app.add_systems(Update, handle_timeline_seek_system);

    let timeline_id = 49;
    let clip_uid = Uuid::new_v4();
    let clip_id = 10;
    let fx_uid = Uuid::new_v4();
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: clip_id,
                uid: clip_uid,
                label: "clip-fx".to_owned(),
            },
            source: Some(Source::Fx(fx_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-stopped-fx-seek".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "FX Track".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "fx-start".to_owned(),
                    label: "Start FX".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "fx-stop".to_owned(),
                    label: "Stop FX".to_owned(),
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
        .spawn(MaterializedTimeline::new(timeline))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(2501),
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
        "stopped classic FX should be a planned seek no-op after its zero release: {clip_events:?}"
    );

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        !timeline.spawned_entities.contains_key(&clip_entity),
        "stopped classic FX should not remain tracked as active"
    );
}
