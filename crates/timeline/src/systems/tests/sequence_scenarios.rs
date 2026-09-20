// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::change_detection::DetectChanges;

use super::*;

/// Verifies repeated live Go actions retain earlier navigation across frames and within one frame.
#[test]
fn live_repeated_sequence_go_reaches_each_manual_cue() {
    for batched in [false, true] {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<DeskAction>>();
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.add_message::<TimecodeEvent>();
        app.init_resource::<DataProvider<Cue>>();
        app.init_resource::<DataProvider<Sequence>>();
        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<TimelineCommandOrigins>();
        app.add_systems(Update, process_actions_system);
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let mut steps = Vec::new();
        for id in 1..=4 {
            let uid = Uuid::new_v4();
            app.world_mut()
                .resource_mut::<DataProvider<Cue>>()
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: format!("Cue {id}"),
                    },
                    trigger: CueTriggerType::Manual,
                    ..Default::default()
                })
                .expect("manual cue should insert");
            steps.push(uid.into());
        }
        app.world_mut()
            .resource_mut::<DataProvider<Sequence>>()
            .add(Sequence {
                identifiers: Identifiers {
                    id: 1,
                    uid: sequence_uid,
                    label: "Manual sequence".to_owned(),
                },
                steps,
                ..Default::default()
            })
            .expect("sequence should insert");
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id: 1,
                uid: clip_uid,
                label: "Sequence clip".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        });
        let timecode_uid = spawn_timecode(&mut app, 1, Duration::ZERO);
        let mut timeline = MaterializedTimeline::new(Timeline {
            timecode_uid,
            tracks: vec![Track {
                id: "sequence".to_owned(),
                label: "Sequence".to_owned(),
                muted: false,
                solo: false,
                expanded: false,
                automation_lanes: Vec::new(),
                actions: (1..=4)
                    .map(|cue| Action {
                        id: cue.to_string(),
                        label: format!("Cue {cue}"),
                        position: Duration::from_secs(cue),
                        duration: Duration::ZERO,
                        action: if cue == 1 {
                            ActionKind::StartClip(clip_uid)
                        } else {
                            ActionKind::AdvanceSequence(clip_uid)
                        },
                    })
                    .collect(),
            }],
            ..Default::default()
        });
        timeline.activate();
        app.world_mut().spawn(timeline);
        for cue in 1..=4 {
            if batched && cue < 4 {
                continue;
            }
            set_single_timecode(&mut app, Duration::from_secs(cue), true);
            app.update();
            let positions = app
                .world_mut()
                .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
                .drain()
                .map(|event| match event.action {
                    ClipAction::StartAtTiming { .. } => 1,
                    ClipAction::RenderAt { position, .. } => position,
                    other => panic!("unexpected playback action: {other:?}"),
                })
                .collect::<Vec<_>>();
            assert_eq!(
                positions,
                if batched {
                    vec![1, 2, 3, 4]
                } else {
                    vec![cue as u32]
                },
                "Go should reach cue {cue}, batched={batched}"
            );
        }
    }
}

/// Verifies live timeline playback and seek replay produce the same sequence state.
#[test]
fn live_timeline_sequence_matches_seek_reconstruction() {
    let (mut live_app, live_parameter, _) = setup_sequence_timeline_app(false);
    set_single_timecode(&mut live_app, Duration::from_millis(100), true);
    live_app.update();
    live_app.update();
    set_single_timecode(&mut live_app, Duration::from_millis(1600), true);
    live_app.update();
    live_app.update();
    let live_snapshot = sequence_runtime_snapshot(&mut live_app, live_parameter);

    let (mut seek_app, seek_parameter, timeline_id) = setup_sequence_timeline_app(true);
    set_single_timecode(&mut seek_app, Duration::from_millis(1600), true);
    seek_app
        .world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(1600),
        }));
    seek_app.update();
    seek_app.update();
    let seek_snapshot = sequence_runtime_snapshot(&mut seek_app, seek_parameter);

    assert_eq!(live_snapshot.0, 2);
    assert_eq!(seek_snapshot.0, live_snapshot.0);
    assert_eq!(seek_snapshot.1, live_snapshot.1);
    assert_sequence_runtime_status(&live_snapshot.3, live_snapshot.0, 2, "live parity");
    assert_sequence_runtime_status(&seek_snapshot.3, seek_snapshot.0, 2, "seek parity");
    assert!(
        (live_snapshot.2 - 150.0).abs() <= 1.0,
        "live output should be halfway through cue 2 fade, got {}",
        live_snapshot.2
    );
    assert!(
        (seek_snapshot.2 - live_snapshot.2).abs() <= 1.0,
        "seek output {} should match live output {}",
        seek_snapshot.2,
        live_snapshot.2
    );
}

/// Verifies seek reconstruction materializes setup-only sequence clips at setup position.
#[test]
fn seek_timeline_sequence_materializes_setup_only_clip() {
    let mut app = setup_sequence_timeline_test_app(true);
    let (fixture_ref, parameter) = add_intensity_fixture_parameter(&mut app, 77);

    let timeline_id = 316;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 77,
                uid: sequence_uid,
                label: "setup-only-sequence".to_owned(),
            },
            setup_cue: Cue {
                identifiers: Identifiers {
                    id: 0,
                    uid: Uuid::new_v4(),
                    label: "Setup".to_owned(),
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref,
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
            steps: Vec::new(),
            ..Default::default()
        })
        .expect("setup-only sequence should be stored");
    let clip_entity = app
        .world_mut()
        .spawn(Clip {
            identifiers: Identifiers {
                id: 77,
                uid: clip_uid,
                label: "setup-only-clip".to_owned(),
            },
            source: Some(Source::Sequence(sequence_uid)),
            ..Default::default()
        })
        .id();

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "setup-only-timeline".to_owned(),
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
                label: "Start setup-only sequence".to_owned(),
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
        .spawn(MaterializedTimeline::new(timeline))
        .id();

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(350));

    let snapshot = sequence_runtime_snapshot(&mut app, parameter);
    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "setup-only sequence clip should materialize during seek"
    );
    assert_eq!(snapshot.1, Duration::from_millis(250));
    assert_eq!(
        snapshot.2, 200.0,
        "setup cue output should be rendered after seek reconstruction"
    );
    assert!(matches!(
        snapshot.3.position,
        InstancePosition::Sequence {
            current_position: 0,
            cue_count: 0,
            ..
        }
    ));

    let materialized_clips = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|mexec| mexec.clip_id)
        .collect::<Vec<_>>();
    assert_eq!(materialized_clips, vec![77]);

    let timeline = app
        .world()
        .get::<MaterializedTimeline>(timeline_entity)
        .expect("timeline should remain materialized");
    assert!(
        timeline.spawned_entities.contains_key(&clip_entity),
        "setup-only clip should remain owned by the timeline seek reconstruction"
    );
}

/// Verifies live timeline sequence starts leave playback Lookahead unset for cue-authored Lookahead.
#[test]
fn live_timeline_sequence_leaves_playback_lookahead_unset_for_cue_lookahead() {
    let (mut app, _parameter, _) = setup_sequence_timeline_app(false);
    enable_helper_target_cue_lookahead(&mut app);

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();

    let instance_options = single_sequence_instance_options(&mut app);
    assert!(
        instance_options.lookahead_enabled.is_none(),
        "timeline start should not need a playback override for cue lookahead"
    );
}

/// Verifies live timeline sequence starts keep playback Lookahead unset when timeline Lookahead is explicitly off.
#[test]
fn live_timeline_sequence_leaves_playback_lookahead_unset_when_timeline_is_off() {
    let (mut app, _parameter, _) = setup_sequence_timeline_app(false);
    enable_helper_target_cue_lookahead(&mut app);
    set_helper_timeline_lookahead(&mut app, TimelineLookaheadMode::Disabled);

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();

    let instance_options = single_sequence_instance_options(&mut app);
    assert!(
        instance_options.lookahead_enabled == Some(false),
        "timeline start should force-disable playback Lookahead when timeline Lookahead is disabled"
    );
}

/// Verifies live timeline sequence starts apply explicit timeline-level Lookahead.
#[test]
fn live_timeline_sequence_uses_timeline_lookahead_override() {
    let (mut app, _parameter, _) = setup_sequence_timeline_app(false);
    set_helper_timeline_lookahead(&mut app, TimelineLookaheadMode::Enabled);

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();

    let instance_options = single_sequence_instance_options(&mut app);
    assert!(
        instance_options.lookahead_enabled == Some(true),
        "timeline start should use explicit timeline lookahead"
    );
}

/// Verifies timeline seek reconstruction leaves playback Lookahead unset for cue-authored Lookahead.
#[test]
fn seek_timeline_sequence_leaves_playback_lookahead_unset_for_cue_lookahead() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app(true);
    enable_helper_target_cue_lookahead(&mut app);

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(100));

    let instance_options = single_sequence_instance_options(&mut app);
    assert!(
        instance_options.lookahead_enabled.is_none(),
        "timeline seek should not need a playback override for cue lookahead"
    );
}

/// Verifies seek reconstruction keeps playback Lookahead unset when timeline Lookahead is explicitly off.
#[test]
fn seek_timeline_sequence_leaves_playback_lookahead_unset_when_timeline_is_off() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app(true);
    enable_helper_target_cue_lookahead(&mut app);
    set_helper_timeline_lookahead(&mut app, TimelineLookaheadMode::Disabled);

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(100));

    let instance_options = single_sequence_instance_options(&mut app);
    assert!(
        instance_options.lookahead_enabled == Some(false),
        "timeline seek should force-disable playback Lookahead when timeline Lookahead is disabled"
    );
}

/// Verifies seek reconstruction applies explicit timeline-level Lookahead.
#[test]
fn seek_timeline_sequence_uses_timeline_lookahead_override() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app(true);
    set_helper_timeline_lookahead(&mut app, TimelineLookaheadMode::Enabled);

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(100));

    let instance_options = single_sequence_instance_options(&mut app);
    assert!(
        instance_options.lookahead_enabled == Some(true),
        "timeline seek should use explicit timeline lookahead"
    );
}

/// Verifies timeline-level Lookahead preactivates a future sequence start without changing sequence options.
#[test]
fn timeline_lookahead_preactivates_future_sequence_start() {
    let mut app = setup_sequence_timeline_test_app(false);

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("first cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("second cue should be stored");

    let timeline_id = 44;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: clip_uid,
            label: "clip-31".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start sequence".to_owned(),
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

    set_single_timecode(&mut app, Duration::ZERO, true);
    set_single_timecode(&mut app, Duration::ZERO, false);
    app.update();

    let mut sequence_query = app.world_mut().query::<&MaterializedSequence>();
    assert_eq!(
        sequence_query.iter(app.world()).count(),
        0,
        "sequence clip should not have started yet"
    );

    let (provider_entity, provider_activation_time) = {
        let mut provider_query = app.world_mut().query::<(
            Entity,
            &TimelineLookahead,
            &MaterializedLookaheadProvider,
            &LookaheadAssertions,
        )>();
        let (provider_entity, source, provider, provider_assertions) = provider_query
            .single(app.world())
            .expect("timeline Lookahead should create one materialized lookahead provider");
        assert!(matches!(
            source.source,
            PlannedPlaybackSource::Sequence(uid) if uid == sequence_uid
        ));
        let provider_activation_time = match provider {
            MaterializedLookaheadProvider::Sequence(sequence) => sequence.activation_time,
        };
        assert_eq!(provider_assertions.assertions.len(), 1);
        assert_eq!(provider_assertions.assertions[0].parameter, tilt_parameter);
        (provider_entity, provider_activation_time)
    };

    app.update();

    let provider_activation_time_after = {
        let mut provider_query = app
            .world_mut()
            .query::<(Entity, &MaterializedLookaheadProvider)>();
        let (provider_entity_after, provider_after) = provider_query
            .single(app.world())
            .expect("timeline Lookahead provider should remain materialized");
        assert_eq!(provider_entity_after, provider_entity);
        match provider_after {
            MaterializedLookaheadProvider::Sequence(sequence) => sequence.activation_time,
        }
    };
    assert_eq!(
        provider_activation_time_after, provider_activation_time,
        "paused timeline Lookahead source should reuse its materialized provider"
    );

    {
        let mut stable_provider_query = app.world_mut().query::<(
            bevy_ecs::prelude::Ref<TimelineLookahead>,
            bevy_ecs::prelude::Ref<LookaheadAssertions>,
        )>();
        let (source, assertions) = stable_provider_query
            .single(app.world())
            .expect("stable timeline Lookahead provider should remain queryable");
        assert!(
            !source.is_changed(),
            "stable timeline Lookahead source should not be reinserted"
        );
        assert!(
            !assertions.is_changed(),
            "stable lookahead assertions should not be reinserted"
        );

        let mut stable_layer_query = app
            .world_mut()
            .query::<bevy_ecs::prelude::Ref<nightfall_compositor::prelude::Layer>>();
        let layer = stable_layer_query
            .single(app.world())
            .expect("stable timeline Lookahead layer should remain queryable");
        assert!(
            !layer.is_changed(),
            "stable timeline Lookahead layer should not be reinserted"
        );
    }

    app.world_mut()
        .get_mut::<Parameter>(intensity_parameter.entity())
        .expect("intensity parameter should exist")
        .set_raw_value(0.0);
    app.world_mut()
        .get_mut::<Parameter>(tilt_parameter.entity())
        .expect("tilt parameter should exist")
        .set_raw_value(0.0);
    app.update();

    {
        let mut stable_provider_query = app.world_mut().query::<(
            bevy_ecs::prelude::Ref<LookaheadAssertions>,
            bevy_ecs::prelude::Ref<nightfall_compositor::prelude::Layer>,
        )>();
        let (assertions, layer) = stable_provider_query
            .single(app.world())
            .expect("parameter churn should not remove lookahead output");
        assert!(
            !assertions.is_changed(),
            "dirty parameter components should not reinsert unchanged lookahead assertions"
        );
        assert!(
            !layer.is_changed(),
            "dirty parameter components should not reinsert unchanged lookahead layers"
        );
    }

    app.world_mut()
        .resource_mut::<nightfall_compositor::prelude::FinalLayerOutput>()
        .0
        .absolute
        .insert(intensity_parameter, 255.0);
    app.update();

    {
        let mut provider_query = app.world_mut().query::<&LookaheadAssertions>();
        let provider_assertions = provider_query
            .single(app.world())
            .expect("lookahead provider should remain materialized");
        assert!(
            provider_assertions.assertions.is_empty(),
            "lit global output should make the candidate ineligible"
        );

        let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
        assert_eq!(
            layer_query.iter(app.world()).count(),
            0,
            "lit global output should remove the lookahead layer"
        );
    }

    app.world_mut()
        .resource_mut::<nightfall_compositor::prelude::FinalLayerOutput>()
        .0
        .absolute
        .insert(intensity_parameter, 0.0);
    app.update();

    let mut layer_query = app.world_mut().query::<(
        &TimelineLookaheadLayer,
        &ObjectRefMarker,
        &LookaheadAssertions,
        &nightfall_compositor::prelude::Layer,
    )>();
    let (marker, object_ref, assertions, layer) = layer_query
        .single(app.world())
        .expect("timeline Lookahead should produce one lookahead layer");
    assert_eq!(marker.timeline_uid, timeline_uid);
    assert!(matches!(
        &object_ref.0,
        ObjectRef::ByUid {
            object_type: ObjectType::Timeline,
            uid,
        } if *uid == timeline_uid
    ));
    assert_eq!(assertions.assertions.len(), 1);
    assert_eq!(assertions.assertions[0].parameter, tilt_parameter);
    assert_eq!(
        assertions.assertions[0].value,
        ParameterValue::Absolute { value: 90.0 }
    );
    assert!(layer.absolute.contains_key(&tilt_parameter));
}

/// Verifies timeline Lookahead scans setup and cue one before a sequence start.
#[test]
fn timeline_lookahead_preactivates_setup_and_first_sequence_cues() {
    let mut app = setup_sequence_timeline_test_app(false);

    let first_fixture_uid = Uuid::new_v4();
    let first_fixture_ref = FixtureRef {
        fixture_uid: first_fixture_uid,
        index: Some(1),
    };
    let second_fixture_uid = Uuid::new_v4();
    let second_fixture_ref = FixtureRef {
        fixture_uid: second_fixture_uid,
        index: Some(1),
    };
    let third_fixture_uid = Uuid::new_v4();
    let third_fixture_ref = FixtureRef {
        fixture_uid: third_fixture_uid,
        index: Some(1),
    };
    let pan_metadata = ParameterMetadata {
        attribute: Attribute::Pan,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let setup_pan_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: pan_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let setup_intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let setup_only_pan_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: pan_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let cue_1_tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let cue_2_pan_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: pan_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: first_fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![pan_metadata.clone(), tilt_metadata, intensity_metadata],
            }],
            ..Default::default()
        })
        .expect("first fixture should be stored");
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 2,
                uid: second_fixture_uid,
                label: "fixture-2".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![pan_metadata.clone()],
            }],
            ..Default::default()
        })
        .expect("second fixture should be stored");
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 3,
                uid: third_fixture_uid,
                label: "fixture-3".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![pan_metadata.clone()],
            }],
            ..Default::default()
        })
        .expect("third fixture should be stored");
    fixtures.add_parameter(
        first_fixture_ref.clone(),
        Attribute::Pan,
        setup_pan_parameter,
    );
    fixtures.add_parameter(
        first_fixture_ref.clone(),
        Attribute::Tilt,
        cue_1_tilt_parameter,
    );
    fixtures.add_parameter(
        first_fixture_ref.clone(),
        Attribute::Intensity,
        setup_intensity_parameter,
    );
    fixtures.add_parameter(
        second_fixture_ref.clone(),
        Attribute::Pan,
        cue_2_pan_parameter,
    );
    fixtures.add_parameter(
        third_fixture_ref.clone(),
        Attribute::Pan,
        setup_only_pan_parameter,
    );
    drop(fixtures);

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "first-position".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    first_fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([
                        (
                            Attribute::Pan,
                            ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                        ),
                        (
                            Attribute::Tilt,
                            ValueSource::Inline(ParameterValue::Absolute { value: 30.0 }),
                        ),
                    ]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("first cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "second-position".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    second_fixture_ref,
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 75.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("second cue should be stored");

    let timeline_id = 46;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence".to_owned(),
            },
            setup_cue: Cue {
                identifiers: Identifiers {
                    id: 0,
                    uid: Uuid::new_v4(),
                    label: "Setup".to_owned(),
                },
                instructions: vec![
                    BoundCueInstruction {
                        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                            first_fixture_ref,
                        ])),
                        cue_instruction: CueInstruction {
                            blueprint_application: None,
                            values: HashMap::from([
                                (
                                    Attribute::Pan,
                                    ValueSource::Inline(ParameterValue::Absolute { value: 15.0 }),
                                ),
                                (
                                    Attribute::Intensity,
                                    ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                                ),
                            ]),
                            ..Default::default()
                        },
                    },
                    BoundCueInstruction {
                        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                            third_fixture_ref,
                        ])),
                        cue_instruction: CueInstruction {
                            blueprint_application: None,
                            values: HashMap::from([(
                                Attribute::Pan,
                                ValueSource::Inline(ParameterValue::Absolute { value: 20.0 }),
                            )]),
                            ..Default::default()
                        },
                    },
                ],
                ..Default::default()
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 32,
            uid: clip_uid,
            label: "clip-32".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline_uid = Uuid::new_v4();
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start sequence".to_owned(),
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

    set_single_timecode(&mut app, Duration::ZERO, true);
    app.update();
    app.update();

    let mut sequence_query = app.world_mut().query::<&MaterializedSequence>();
    assert_eq!(
        sequence_query.iter(app.world()).count(),
        0,
        "timeline should not start the sequence before the action"
    );

    let mut layer_query = app
        .world_mut()
        .query::<(&TimelineLookaheadLayer, &LookaheadAssertions)>();
    let (marker, assertions) = layer_query
        .single(app.world())
        .expect("timeline Lookahead should produce one lookahead layer");
    assert_eq!(marker.timeline_uid, timeline_uid);
    assert_eq!(assertions.assertions.len(), 4);
    assert!(
        assertions.assertions.iter().any(|assertion| {
            assertion.parameter == setup_only_pan_parameter
                && assertion.value == ParameterValue::Absolute { value: 20.0 }
        }),
        "setup cue position should be preactivated"
    );
    assert!(
        assertions.assertions.iter().all(|assertion| {
            assertion.parameter != setup_pan_parameter
                || assertion.value != ParameterValue::Absolute { value: 45.0 }
        }),
        "cue 1 should not override setup cue position for the same parameter"
    );
    assert!(
        assertions.assertions.iter().any(|assertion| {
            assertion.parameter == setup_pan_parameter
                && assertion.value == ParameterValue::Absolute { value: 15.0 }
        }),
        "setup cue position should shadow cue 1 for the same parameter"
    );
    assert!(
        assertions.assertions.iter().any(|assertion| {
            assertion.parameter == cue_1_tilt_parameter
                && assertion.value == ParameterValue::Absolute { value: 30.0 }
        }),
        "cue 1 position should be preactivated"
    );
    assert!(
        assertions.assertions.iter().any(|assertion| {
            assertion.parameter == cue_2_pan_parameter
                && assertion.value == ParameterValue::Absolute { value: 75.0 }
        }),
        "later cue position should remain preactivated"
    );
}

/// Verifies timeline Lookahead publishes action statuses while stopped without preactivating output.
#[test]
fn timeline_lookahead_reports_future_sequence_status_while_stopped() {
    let mut app = setup_sequence_timeline_test_app(false);

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("first cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("second cue should be stored");

    let timeline_id = 45;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "sequence".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            ..Default::default()
        })
        .expect("sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: clip_uid,
            label: "clip-31".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let timeline_uid = Uuid::new_v4();
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: timeline_uid,
            label: "timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "action-start".to_owned(),
                label: "Start sequence".to_owned(),
                position: Duration::from_secs(1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    }));
    set_single_timecode(&mut app, Duration::from_secs(2), false);

    app.update();

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].track_id, "track-1");
    assert_eq!(statuses.statuses[0].action_id, "action-start");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::Ready
    );

    let mut provider_query = app
        .world_mut()
        .query::<(&TimelineLookahead, &LookaheadAssertions)>();
    let (source, assertions) = provider_query
        .single(app.world())
        .expect("stopped timeline Lookahead should still create a status provider");
    assert_eq!(source.timeline_uid, timeline_uid);
    assert_eq!(assertions.assertions.len(), 1);
    assert_eq!(assertions.assertions[0].parameter, tilt_parameter);

    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        0,
        "stopped timeline should not create a live lookahead layer"
    );
}

/// Verifies future Lookahead assertions wait behind intervening actions that assert the same fixture.
#[test]
fn timeline_lookahead_blocks_future_source_behind_intervening_fixture_assertion() {
    let mut app = setup_sequence_timeline_test_app(false);

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let blocker_cue_uid = Uuid::new_v4();
    let future_dark_cue_uid = Uuid::new_v4();
    let future_tilt_cue_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: blocker_cue_uid,
                label: "blocker".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 50.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("blocker cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: future_dark_cue_uid,
                label: "dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("future dark cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 3,
                uid: future_tilt_cue_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("future tilt cue should be stored");

    let blocker_clip_uid = Uuid::new_v4();
    let future_clip_uid = Uuid::new_v4();
    let blocker_sequence_uid = Uuid::new_v4();
    let future_sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: blocker_sequence_uid,
                label: "blocker sequence".to_owned(),
            },
            steps: vec![blocker_cue_uid.into()],
            ..Default::default()
        })
        .expect("blocker sequence should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 2,
                uid: future_sequence_uid,
                label: "future sequence".to_owned(),
            },
            steps: vec![future_dark_cue_uid.into(), future_tilt_cue_uid.into()],
            ..Default::default()
        })
        .expect("future sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: blocker_clip_uid,
            label: "blocker clip".to_owned(),
        },
        source: Some(Source::Sequence(blocker_sequence_uid)),
        ..Default::default()
    });
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 32,
            uid: future_clip_uid,
            label: "future clip".to_owned(),
        },
        source: Some(Source::Sequence(future_sequence_uid)),
        ..Default::default()
    });

    let timeline_id = 45;
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-blocker".to_owned(),
                    label: "Blocker".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(blocker_clip_uid),
                },
                Action {
                    id: "action-future".to_owned(),
                    label: "Future".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(future_clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    set_single_timecode(&mut app, Duration::ZERO, true);
    set_single_timecode(&mut app, Duration::ZERO, false);
    app.update();

    let mut provider_query = app
        .world_mut()
        .query::<(&TimelineLookahead, &LookaheadAssertions)>();
    let future_assertions = provider_query
        .iter(app.world())
        .find(|(source, _)| source.action_id == "action-future")
        .map(|(_, assertions)| assertions)
        .expect("future action should still materialize lookahead assertions");
    assert_eq!(future_assertions.assertions.len(), 1);
    assert_eq!(future_assertions.assertions[0].parameter, tilt_parameter);

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].action_id, "action-future");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::BlockedByInterveningFixtureAssertions
    );
    assert_eq!(statuses.statuses[0].blocking_actions.len(), 1);
    assert_eq!(statuses.statuses[0].blocking_actions[0].track_id, "track-1");
    assert_eq!(
        statuses.statuses[0].blocking_actions[0].action_id,
        "action-blocker"
    );

    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        0,
        "blocked lookahead assertions should not create a timeline layer"
    );
}

/// Verifies dense intervening blockers keep runtime Lookahead status payloads bounded.
#[test]
fn timeline_lookahead_reports_bounded_blockers_for_dense_intervening_actions() {
    let mut app = setup_sequence_timeline_test_app(false);
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 88,
                uid: fixture_uid,
                label: "fixture-88".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);
    let blocker_count = 8_u32;

    let mut blocker_clip_uids = Vec::new();
    for index in 0..blocker_count {
        let blocker_cue_uid = Uuid::new_v4();
        app.world_mut()
            .resource_mut::<DataProvider<Cue>>()
            .add(Cue {
                identifiers: Identifiers {
                    id: index + 1,
                    uid: blocker_cue_uid,
                    label: format!("blocker-{index}"),
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref.clone(),
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value: 50.0 }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            })
            .expect("blocker cue should be stored");

        let blocker_sequence_uid = Uuid::new_v4();
        app.world_mut()
            .resource_mut::<DataProvider<Sequence>>()
            .add(Sequence {
                identifiers: Identifiers {
                    id: index + 1,
                    uid: blocker_sequence_uid,
                    label: format!("blocker-sequence-{index}"),
                },
                steps: vec![blocker_cue_uid.into()],
                ..Default::default()
            })
            .expect("blocker sequence should be stored");

        let blocker_clip_uid = Uuid::new_v4();
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id: 40 + index,
                uid: blocker_clip_uid,
                label: format!("blocker-clip-{index}"),
            },
            source: Some(Source::Sequence(blocker_sequence_uid)),
            ..Default::default()
        });
        blocker_clip_uids.push(blocker_clip_uid);
    }

    let future_dark_cue_uid = Uuid::new_v4();
    let future_red_cue_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 100,
                uid: future_dark_cue_uid,
                label: "future-dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("future dark cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 101,
                uid: future_red_cue_uid,
                label: "future-tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("future red cue should be stored");

    let future_sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 100,
                uid: future_sequence_uid,
                label: "future sequence".to_owned(),
            },
            steps: vec![future_dark_cue_uid.into(), future_red_cue_uid.into()],
            ..Default::default()
        })
        .expect("future sequence should be stored");
    let future_clip_uid = Uuid::new_v4();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 100,
            uid: future_clip_uid,
            label: "future clip".to_owned(),
        },
        source: Some(Source::Sequence(future_sequence_uid)),
        ..Default::default()
    });

    let mut actions = blocker_clip_uids
        .iter()
        .enumerate()
        .map(|(index, clip_uid)| Action {
            id: format!("action-blocker-{index}"),
            label: format!("Blocker {index}"),
            position: Duration::from_millis(500 + index as u64 * 100),
            duration: Duration::ZERO,
            action: ActionKind::StartClip(*clip_uid),
        })
        .collect::<Vec<_>>();
    actions.push(Action {
        id: "action-future".to_owned(),
        label: "Future".to_owned(),
        position: Duration::from_secs(2),
        duration: Duration::ZERO,
        action: ActionKind::StartClip(future_clip_uid),
    });

    let timeline_id = 46;
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let mut materialized = MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "dense-lookahead-timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions,
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    });
    materialized.activate();
    app.world_mut().spawn(materialized);

    set_single_timecode(&mut app, Duration::ZERO, true);
    set_single_timecode(&mut app, Duration::ZERO, false);
    app.update();

    let mut provider_query = app
        .world_mut()
        .query::<(&TimelineLookahead, &LookaheadAssertions)>();
    let future_assertions = provider_query
        .iter(app.world())
        .find(|(source, _)| source.action_id == "action-future")
        .map(|(_, assertions)| assertions)
        .expect("future action should still materialize lookahead assertions");
    assert_eq!(future_assertions.assertions.len(), 1);
    assert_eq!(future_assertions.assertions[0].parameter, tilt_parameter);

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].action_id, "action-future");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::BlockedByInterveningFixtureAssertions
    );
    assert_eq!(
        statuses.statuses[0].blocking_actions.len(),
        1,
        "dense blocker status should remain bounded instead of reporting every blocker"
    );
    assert_eq!(statuses.statuses[0].blocking_actions[0].track_id, "track-1");
    assert_eq!(
        statuses.statuses[0].blocking_actions[0].action_id,
        "action-blocker-0"
    );

    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        0,
        "blocked dense lookahead assertions should not create a timeline layer"
    );
}

/// Verifies selected FX fixtures block future Lookahead assertions for the same fixture.
#[test]
fn timeline_lookahead_blocks_future_source_behind_intervening_fx_selection() {
    let mut app = setup_sequence_timeline_test_app(false);
    app.insert_resource(DataProvider::<Fx>::default());

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let future_dark_cue_uid = Uuid::new_v4();
    let future_tilt_cue_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: future_dark_cue_uid,
                label: "dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("future dark cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: future_tilt_cue_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("future tilt cue should be stored");

    let blocker_fx_uid = Uuid::new_v4();
    let blocker_clip_uid = Uuid::new_v4();
    let future_clip_uid = Uuid::new_v4();
    let future_sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 1,
                uid: blocker_fx_uid,
                label: "blocker fx".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                fixture_ref.clone(),
            ])),
            ..Default::default()
        })
        .expect("blocker fx should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 2,
                uid: future_sequence_uid,
                label: "future sequence".to_owned(),
            },
            steps: vec![future_dark_cue_uid.into(), future_tilt_cue_uid.into()],
            ..Default::default()
        })
        .expect("future sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: blocker_clip_uid,
            label: "blocker clip".to_owned(),
        },
        source: Some(Source::Fx(blocker_fx_uid)),
        ..Default::default()
    });
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 32,
            uid: future_clip_uid,
            label: "future clip".to_owned(),
        },
        source: Some(Source::Sequence(future_sequence_uid)),
        ..Default::default()
    });

    let timeline_id = 46;
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-blocker".to_owned(),
                    label: "Blocker".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(blocker_clip_uid),
                },
                Action {
                    id: "action-future".to_owned(),
                    label: "Future".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(future_clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    set_single_timecode(&mut app, Duration::ZERO, true);
    set_single_timecode(&mut app, Duration::ZERO, false);
    app.update();

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].action_id, "action-future");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::BlockedByInterveningFixtureAssertions
    );
    assert_eq!(statuses.statuses[0].blocking_actions.len(), 1);
    assert_eq!(statuses.statuses[0].blocking_actions[0].track_id, "track-1");
    assert_eq!(
        statuses.statuses[0].blocking_actions[0].action_id,
        "action-blocker"
    );

    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        0,
        "selected FX fixture overlap should block the timeline Lookahead layer"
    );
}

/// Verifies group edits invalidate intervening FX footprint checks for Lookahead layers.
#[test]
fn timeline_lookahead_rebuilds_when_intervening_fx_group_selection_changes() {
    let mut app = setup_sequence_timeline_test_app(false);
    app.insert_resource(DataProvider::<Fx>::default());

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let group_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: 1,
                uid: group_uid,
                label: "Group 1".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Resolved(Vec::new())),
            ..Default::default()
        })
        .expect("empty blocker group should be stored");

    let future_dark_cue_uid = Uuid::new_v4();
    let future_tilt_cue_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: future_dark_cue_uid,
                label: "dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("future dark cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: future_tilt_cue_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("future tilt cue should be stored");

    let blocker_fx_uid = Uuid::new_v4();
    let blocker_clip_uid = Uuid::new_v4();
    let future_clip_uid = Uuid::new_v4();
    let future_sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 1,
                uid: blocker_fx_uid,
                label: "blocker fx".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(1))),
            ..Default::default()
        })
        .expect("blocker fx should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 2,
                uid: future_sequence_uid,
                label: "future sequence".to_owned(),
            },
            steps: vec![future_dark_cue_uid.into(), future_tilt_cue_uid.into()],
            ..Default::default()
        })
        .expect("future sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: blocker_clip_uid,
            label: "blocker clip".to_owned(),
        },
        source: Some(Source::Fx(blocker_fx_uid)),
        ..Default::default()
    });
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 32,
            uid: future_clip_uid,
            label: "future clip".to_owned(),
        },
        source: Some(Source::Sequence(future_sequence_uid)),
        ..Default::default()
    });

    let timeline_id = 47;
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-blocker".to_owned(),
                    label: "Blocker".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(blocker_clip_uid),
                },
                Action {
                    id: "action-future".to_owned(),
                    label: "Future".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(future_clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    set_single_timecode(&mut app, Duration::ZERO, true);
    set_single_timecode(&mut app, Duration::ZERO, false);
    app.update();

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].action_id, "action-future");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::Asserted
    );
    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        1,
        "empty blocker group should allow the timeline Lookahead layer"
    );

    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: 1,
                uid: group_uid,
                label: "Group 1".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
            ..Default::default()
        })
        .expect("updated blocker group should be stored");
    app.update();

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].action_id, "action-future");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::BlockedByInterveningFixtureAssertions
    );
    assert_eq!(statuses.statuses[0].blocking_actions.len(), 1);
    assert_eq!(statuses.statuses[0].blocking_actions[0].track_id, "track-1");
    assert_eq!(
        statuses.statuses[0].blocking_actions[0].action_id,
        "action-blocker"
    );
    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        0,
        "group edit should rebuild and remove the blocked timeline Lookahead layer"
    );
}

/// Verifies unsupported intervening output commands conservatively block future Lookahead assertions.
#[test]
fn timeline_lookahead_blocks_future_source_behind_unknown_intervening_action() {
    let mut app = setup_sequence_timeline_test_app(false);

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let future_dark_cue_uid = Uuid::new_v4();
    let future_tilt_cue_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: future_dark_cue_uid,
                label: "dark".to_owned(),
            },
            ..Default::default()
        })
        .expect("future dark cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: future_tilt_cue_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(1)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("future tilt cue should be stored");

    let future_clip_uid = Uuid::new_v4();
    let future_sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: future_sequence_uid,
                label: "future sequence".to_owned(),
            },
            steps: vec![future_dark_cue_uid.into(), future_tilt_cue_uid.into()],
            ..Default::default()
        })
        .expect("future sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 32,
            uid: future_clip_uid,
            label: "future clip".to_owned(),
        },
        source: Some(Source::Sequence(future_sequence_uid)),
        ..Default::default()
    });

    let timeline_id = 47;
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline".to_owned(),
        },
        timecode_uid,
        lookahead: TimelineLookaheadMode::Enabled,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![
                Action {
                    id: "action-unknown".to_owned(),
                    label: "Unknown".to_owned(),
                    position: Duration::from_millis(500),
                    duration: Duration::ZERO,
                    action: ActionKind::DeskEval("group 1 at 50".to_owned()),
                },
                Action {
                    id: "action-future".to_owned(),
                    label: "Future".to_owned(),
                    position: Duration::from_secs(1),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(future_clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    materialized.activate();
    app.world_mut().spawn(materialized);

    set_single_timecode(&mut app, Duration::ZERO, true);
    set_single_timecode(&mut app, Duration::ZERO, false);
    app.update();

    let statuses = app.world().resource::<TimelineLookaheadActionStatuses>();
    assert_eq!(statuses.statuses.len(), 1);
    assert_eq!(statuses.statuses[0].action_id, "action-future");
    assert_eq!(
        statuses.statuses[0].kind,
        TimelineLookaheadActionStatusKind::BlockedByInterveningFixtureAssertions
    );

    let mut layer_query = app.world_mut().query::<&TimelineLookaheadLayer>();
    assert_eq!(
        layer_query.iter(app.world()).count(),
        0,
        "unknown intervening action should block the timeline Lookahead layer"
    );
}

/// Verifies a StartClip action's visual duration does not implicitly stop sequence playback.
#[test]
fn seek_start_clip_duration_does_not_release_auto_progressing_sequence() {
    let (mut app, parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        None,
        Duration::from_secs(1),
        ClipOptions::default(),
    );

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(1600));

    let snapshot = sequence_runtime_snapshot(&mut app, parameter);
    assert_eq!(
        snapshot.0, 2,
        "sequence should advance to cue 2 instead of releasing cue 1 at the action duration"
    );
    assert_eq!(snapshot.1, Duration::from_millis(1500));
    assert!(
        (snapshot.2 - 150.0).abs() <= 1.0,
        "sequence output should be halfway through cue 2 fade, got {}",
        snapshot.2
    );

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, Option<&ReleaseMarker>)>();
    assert_eq!(
        sequence_query
            .iter(app.world())
            .filter(|(_, release_marker)| release_marker.is_some())
            .count(),
        0,
        "StartClip action duration should not insert a release marker without an explicit stop"
    );
}

/// Verifies sequence seek reconstruction folds authored rate actions into the playback clock.
#[test]
fn seek_timeline_sequence_reconstructs_authored_rate() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app(true);
    {
        let mut timeline_query = app.world_mut().query::<&mut MaterializedTimeline>();
        let mut timeline = timeline_query
            .single_mut(app.world_mut())
            .expect("helper timeline should exist");
        let ActionKind::StartClip(clip_uid) = timeline.timeline.tracks[0].actions[0].action else {
            panic!("helper timeline should start a clip");
        };
        timeline.timeline.tracks[0].actions.push(Action {
            id: "action-rate".to_owned(),
            label: "Set sequence rate".to_owned(),
            position: Duration::from_millis(600),
            duration: Duration::ZERO,
            action: ActionKind::SetClipRate {
                uid: clip_uid,
                rate: 2.0,
            },
        });
    }

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(1600));

    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("timeline sequence should reconstruct one instance clock");
    assert_eq!(clock.position, Duration::from_millis(2500));
    assert_eq!(clock.rate, 2.0);
}

/// Verifies paused timeline-owned sequence output and auto-progression remain frozen.
#[test]
fn paused_timeline_sequence_output_and_position_remain_frozen() {
    let (mut app, parameter, _) = setup_sequence_timeline_app(false);
    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_single_timecode(&mut app, Duration::from_millis(1600), true);
    app.update();
    app.update();
    let running_snapshot = sequence_runtime_snapshot(&mut app, parameter);

    set_single_timecode(&mut app, Duration::from_millis(1600), false);
    app.update();
    std::thread::sleep(Duration::from_millis(20));
    app.update();
    app.update();
    let paused_snapshot = sequence_runtime_snapshot(&mut app, parameter);

    assert_eq!(paused_snapshot.0, running_snapshot.0);
    assert_eq!(paused_snapshot.1, running_snapshot.1);
    assert_sequence_runtime_status(&paused_snapshot.3, paused_snapshot.0, 2, "paused sequence");
    assert!(
        (paused_snapshot.2 - running_snapshot.2).abs() <= 1.0,
        "paused sequence output {} should match running output {}",
        paused_snapshot.2,
        running_snapshot.2
    );

    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("timeline sequence should keep a playback clock");
    assert!(clock.frozen, "paused timeline should freeze sequence clock");
    assert_eq!(clock.delta, Duration::ZERO);
}

/// Verifies stopping a paused live timeline clears timeline-started sequence releases.
#[test]
fn stopped_paused_timeline_sequence_release_clears_without_resume() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app(false);

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_single_timecode(&mut app, Duration::from_millis(1600), true);
    app.update();
    app.update();
    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "live timeline should start one sequence playback"
    );

    app.world_mut()
        .write_message(timecode_ingress(TimecodeCommand::PauseTimecode(
            timeline_id,
        )));
    app.update();
    app.update();
    {
        let mut clock_query = app.world_mut().query::<&InstanceClock>();
        let clock = clock_query
            .single(app.world())
            .expect("paused sequence should keep one instance clock");
        assert!(
            clock.frozen,
            "paused timeline should freeze the active sequence playback clock"
        );
    }

    app.world_mut()
        .write_message(timecode_ingress(TimecodeCommand::StopTimecode(timeline_id)));
    app.update();
    app.update();

    let released_sequence_entity = {
        let mut sequence_query = app.world_mut().query::<(
            bevy_ecs::prelude::Entity,
            &InstanceClock,
            Option<&ReleaseMarker>,
        )>();
        let released_sequences = sequence_query
            .iter(app.world())
            .filter_map(|(entity, clock, release_marker)| {
                let release_marker = release_marker?;
                assert_eq!(
                    clock.source,
                    InstanceClockSource::Realtime,
                    "stopped timeline should detach release playback clock from timeline source"
                );
                assert!(
                    !clock.frozen,
                    "stopped timeline should let release playback clock continue while paused"
                );
                Some((entity, release_marker.start_time))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            released_sequences.len(),
            1,
            "timeline stop should leave one release-marked sequence before cleanup completes"
        );
        released_sequences[0].0
    };

    app.world_mut()
        .entity_mut(released_sequence_entity)
        .get_mut::<ReleaseMarker>()
        .expect("released sequence should keep its release marker")
        .start_time = Instant::now() - Duration::from_secs(10);
    app.update();

    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "paused timeline stop release should clear without resuming playback"
    );
}

/// Verifies paused backward seeks before a sequence remove the stale instance.
#[test]
fn paused_seek_backward_before_sequence_removes_existing_playback() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app(true);

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(1600));
    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "forward seek should materialize the active sequence"
    );

    set_single_timecode(&mut app, Duration::from_millis(1600), false);
    app.update();

    set_single_timecode(&mut app, Duration::ZERO, false);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::ZERO,
        }));
    app.update();
    app.update();

    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "paused seek before the sequence should remove the stale sequence playback"
    );
}

/// Verifies paused backward seeks preserve sequence clip auto-release cleanup.
#[test]
fn paused_seek_backward_before_sequence_arms_auto_release_cleanup() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        None,
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            ..Default::default()
        },
    );

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(1600));
    set_single_timecode(&mut app, Duration::from_millis(1600), false);
    app.update();

    set_single_timecode(&mut app, Duration::ZERO, false);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::ZERO,
        }));
    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(app.world())
            .count(),
        1,
        "paused seek cleanup should arm clip auto-release before removing playback"
    );
}

/// Verifies backward seeks before a release point rebuild active playback without stale release state.
#[test]
fn paused_seek_backward_before_sequence_release_rebuilds_active_playback() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        Some(Duration::from_secs(2)),
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            ..Default::default()
        },
    );

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(2500));

    set_single_timecode(&mut app, Duration::from_millis(1600), false);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::from_millis(1600),
        }));
    app.update();
    app.update();

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, Option<&ReleaseMarker>)>();
    let sequences = sequence_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(
        sequences.len(),
        1,
        "backward seek before release should rebuild one active sequence playback"
    );
    assert!(
        sequences[0].1.is_none(),
        "rebuilt active playback should not retain stale release state"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(app.world())
            .count(),
        0,
        "active target reconstruction should not arm clip auto-release cleanup"
    );
}

/// Verifies four auto-progressing cues seek to deterministic multi-fixture outputs.
#[test]
fn seek_four_cue_auto_sequence_matches_expected_values() {
    for (source_position, expected_position, expected_values, context) in [
        (
            Duration::from_millis(600),
            1,
            vec![25.5, 0.0, 0.0, 0.0],
            "cue 1 fade just after delay",
        ),
        (
            Duration::from_secs(1),
            1,
            vec![127.5, 0.0, 0.0, 0.0],
            "cue 1 fade halfway",
        ),
        (
            Duration::from_millis(2100),
            2,
            vec![255.0, 0.0, 0.0, 0.0],
            "cue 2 delay",
        ),
        (
            Duration::from_secs(8),
            4,
            vec![127.5, 127.5, 127.5, 127.5],
            "auto-end release halfway",
        ),
    ] {
        let (mut app, parameters, timeline_id) =
            setup_four_cue_auto_sequence_timeline_app(true, None);
        let timeline_position = Duration::from_millis(100).saturating_add(source_position);

        seek_sequence_timeline(&mut app, timeline_id, timeline_position);
        let snapshot = sequence_runtime_values_snapshot(&mut app, &parameters);

        assert_eq!(
            snapshot.0, expected_position,
            "{context}: sequence position"
        );
        assert_eq!(
            snapshot.1, source_position,
            "{context}: source-local playback position"
        );
        assert_sequence_runtime_status(&snapshot.3, expected_position, 4, context);
        assert_values_close(&snapshot.2, &expected_values, context);
    }

    let (mut app, _parameters, timeline_id) = setup_four_cue_auto_sequence_timeline_app(true, None);
    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(8800));
    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "completed auto-end release tail should be a no-op"
    );
}

/// Verifies four-cue live playback reconstructs the same state as direct seek.
#[test]
fn live_four_cue_auto_sequence_matches_seek_reconstruction() {
    for source_position in [
        Duration::from_millis(600),
        Duration::from_secs(1),
        Duration::from_millis(2100),
        Duration::from_secs(8),
    ] {
        let timeline_position = Duration::from_millis(100).saturating_add(source_position);

        let (mut live_app, live_parameters, _) =
            setup_four_cue_auto_sequence_timeline_app(false, None);
        drive_four_cue_live_timeline_to(&mut live_app, timeline_position);
        let live_snapshot = sequence_runtime_values_snapshot(&mut live_app, &live_parameters);

        let (mut seek_app, seek_parameters, timeline_id) =
            setup_four_cue_auto_sequence_timeline_app(true, None);
        seek_sequence_timeline(&mut seek_app, timeline_id, timeline_position);
        let seek_snapshot = sequence_runtime_values_snapshot(&mut seek_app, &seek_parameters);

        assert_eq!(
            seek_snapshot.0, live_snapshot.0,
            "sequence position should match at source position {source_position:?}"
        );
        assert_eq!(
            seek_snapshot.1, live_snapshot.1,
            "playback clock should match at source position {source_position:?}"
        );
        assert_sequence_runtime_status(
            &live_snapshot.3,
            live_snapshot.0,
            4,
            &format!("live runtime status at source position {source_position:?}"),
        );
        assert_sequence_runtime_status(
            &seek_snapshot.3,
            seek_snapshot.0,
            4,
            &format!("seek runtime status at source position {source_position:?}"),
        );
        assert_values_close(
            &seek_snapshot.2,
            &live_snapshot.2,
            &format!("live/seek parity at source position {source_position:?}"),
        );
    }
}

/// Verifies a paused four-cue timeline freezes output and autonomous cue progression.
#[test]
fn paused_four_cue_auto_sequence_remains_frozen() {
    let (mut app, parameters, _) = setup_four_cue_auto_sequence_timeline_app(false, None);
    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_single_timecode(&mut app, Duration::from_millis(1100), true);
    app.update();
    app.update();
    let running_snapshot = sequence_runtime_values_snapshot(&mut app, &parameters);

    set_single_timecode(&mut app, Duration::from_millis(1100), false);
    app.update();
    std::thread::sleep(Duration::from_millis(20));
    app.update();
    app.update();
    let paused_snapshot = sequence_runtime_values_snapshot(&mut app, &parameters);

    assert_eq!(paused_snapshot.0, running_snapshot.0);
    assert_eq!(paused_snapshot.1, running_snapshot.1);
    assert_sequence_runtime_status(&paused_snapshot.3, paused_snapshot.0, 4, "paused four-cue");
    assert_values_close(
        &paused_snapshot.2,
        &running_snapshot.2,
        "paused four-cue output",
    );
}

/// Verifies manual stop releases a four-cue sequence from the partial transition snapshot.
#[test]
fn seek_four_cue_manual_stop_releases_from_partial_transition_snapshot() {
    let stop_position = Duration::from_millis(3100);
    let cases = [
        (
            Duration::from_millis(3099),
            2,
            vec![255.0, 127.245, 0.0, 0.0],
            "just before stop",
        ),
        (
            Duration::from_millis(3100),
            2,
            vec![255.0, 127.5, 0.0, 0.0],
            "at stop release anchor",
        ),
        (
            Duration::from_millis(3600),
            2,
            vec![127.5, 63.75, 0.0, 0.0],
            "release halfway",
        ),
    ];

    for (timeline_position, expected_position, expected_values, context) in cases {
        let (mut app, parameters, timeline_id) =
            setup_four_cue_auto_sequence_timeline_app(true, Some(stop_position));
        seek_sequence_timeline(&mut app, timeline_id, timeline_position);
        let snapshot = sequence_runtime_values_snapshot(&mut app, &parameters);

        assert_eq!(
            snapshot.0, expected_position,
            "{context}: sequence position"
        );
        assert_eq!(
            snapshot.1,
            timeline_position.saturating_sub(Duration::from_millis(100)),
            "{context}: source-local playback position"
        );
        assert_sequence_runtime_status(&snapshot.3, expected_position, 4, context);
        assert_values_close(&snapshot.2, &expected_values, context);
    }

    let (mut app, _parameters, timeline_id) =
        setup_four_cue_auto_sequence_timeline_app(true, Some(stop_position));
    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(4200));
    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "completed manual release tail should be a no-op"
    );
}

/// Verifies timeline stop releases freeze partial sequence output identically in live and seek.
#[test]
fn live_timeline_sequence_stop_release_matches_seek_reconstruction() {
    let stop_position = Duration::from_millis(1600);
    let release_halfway_position = Duration::from_millis(2100);

    let (mut live_app, live_parameter, _) =
        setup_sequence_timeline_app_with_stop(false, Some(stop_position));
    set_single_timecode(&mut live_app, Duration::from_millis(100), true);
    live_app.update();
    live_app.update();
    set_single_timecode(&mut live_app, stop_position, true);
    live_app.update();
    live_app.update();
    set_single_timecode(&mut live_app, release_halfway_position, true);
    live_app.update();
    live_app.update();
    let live_snapshot = sequence_runtime_snapshot(&mut live_app, live_parameter);

    let (mut seek_app, seek_parameter, timeline_id) =
        setup_sequence_timeline_app_with_stop(true, Some(stop_position));
    set_single_timecode(&mut seek_app, release_halfway_position, true);
    seek_app
        .world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: release_halfway_position,
        }));
    seek_app.update();
    seek_app.update();
    let seek_snapshot = sequence_runtime_snapshot(&mut seek_app, seek_parameter);

    assert_eq!(live_snapshot.0, 2);
    assert_eq!(seek_snapshot.0, live_snapshot.0);
    assert_eq!(seek_snapshot.1, live_snapshot.1);
    assert_sequence_runtime_status(&live_snapshot.3, live_snapshot.0, 2, "live release parity");
    assert_sequence_runtime_status(&seek_snapshot.3, seek_snapshot.0, 2, "seek release parity");
    assert!(
        (live_snapshot.2 - 75.0).abs() <= 1.0,
        "live release should be halfway down from the frozen 150 output, got {}",
        live_snapshot.2
    );
    assert!(
        (seek_snapshot.2 - live_snapshot.2).abs() <= 1.0,
        "seek release output {} should match live release output {}",
        seek_snapshot.2,
        live_snapshot.2
    );
}

/// Verifies live auto-end release remains materialized through the release cue span.
#[test]
fn live_timeline_sequence_auto_end_release_matches_seek_reconstruction() {
    let release_halfway_position = Duration::from_millis(2600);

    let (mut live_app, live_parameter, _) = setup_sequence_timeline_app_with_clip_options(
        false,
        None,
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    );
    set_single_timecode(&mut live_app, Duration::from_millis(100), true);
    live_app.update();
    live_app.update();
    set_single_timecode(&mut live_app, release_halfway_position, true);
    live_app.update();
    live_app.update();
    let live_snapshot = sequence_runtime_snapshot(&mut live_app, live_parameter);

    let (mut seek_app, seek_parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        None,
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    );
    set_single_timecode(&mut seek_app, release_halfway_position, true);
    seek_app
        .world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: release_halfway_position,
        }));
    seek_app.update();
    seek_app.update();
    let seek_snapshot = sequence_runtime_snapshot(&mut seek_app, seek_parameter);

    assert_eq!(live_snapshot.0, 2);
    assert_eq!(seek_snapshot.0, live_snapshot.0);
    assert_eq!(seek_snapshot.1, live_snapshot.1);
    assert_sequence_runtime_status(
        &live_snapshot.3,
        live_snapshot.0,
        2,
        "live auto-end release parity",
    );
    assert_sequence_runtime_status(
        &seek_snapshot.3,
        seek_snapshot.0,
        2,
        "seek auto-end release parity",
    );
    assert!(
        (live_snapshot.2 - 100.0).abs() <= 1.0,
        "live auto-end release should be halfway down from final 200 output, got {}",
        live_snapshot.2
    );
    assert!(
        (seek_snapshot.2 - live_snapshot.2).abs() <= 1.0,
        "seek auto-end release output {} should match live release output {}",
        seek_snapshot.2,
        live_snapshot.2
    );
}

/// Verifies live auto-end release honors release cue timing even with no visible transition.
#[test]
fn live_timeline_sequence_auto_end_waits_for_noop_release_timing() {
    let release_halfway_position = Duration::from_millis(2600);
    let (mut app, _parameter, _) = setup_sequence_timeline_app_with_clip_options(
        false,
        None,
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    );
    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        let mut sequence = sequence_provider
            .from_id(1)
            .expect("helper sequence should exist")
            .clone();
        let sequence_uid = sequence.identifiers.uid;
        sequence_provider
            .remove(&sequence_uid)
            .expect("helper sequence should be removable");
        sequence.release_cue = Cue {
            identifiers: Identifiers {
                id: 99,
                uid: Uuid::new_v4(),
                label: "noop release timing".to_owned(),
            },
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                ..Default::default()
            },
            ..Default::default()
        };
        sequence_provider
            .add(sequence)
            .expect("helper sequence should be restored");
    }

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_single_timecode(&mut app, release_halfway_position, true);
    app.update();
    app.update();

    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "live auto-end sequence should remain materialized during no-op release timing"
    );
    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, Option<&ReleaseMarker>)>();
    let (_, release_marker) = sequence_query
        .single(app.world())
        .expect("release tail should still be materialized");
    assert!(
        release_marker.is_some(),
        "sequence should be in its release tail at the halfway release position"
    );
}

/// Verifies live auto-end release runs LTP release timing after same-fixture HTP fade-down.
#[test]
fn live_timeline_sequence_auto_end_holds_ltp_until_htp_release_completes() {
    let mut app = setup_sequence_timeline_test_app(false);
    let (fixture_ref, intensity_parameter, red_parameter) =
        add_intensity_red_fixture_parameters(&mut app, 718);

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    for (id, uid, label, value, trigger, fade_in) in [
        (
            1,
            cue_1_uid,
            "cue-1",
            100.0,
            CueTriggerType::Manual,
            Duration::ZERO,
        ),
        (
            2,
            cue_2_uid,
            "cue-2",
            200.0,
            CueTriggerType::AfterDelay(Duration::from_secs(1)),
            Duration::from_secs(1),
        ),
    ] {
        app.world_mut()
            .resource_mut::<DataProvider<Cue>>()
            .add(Cue {
                identifiers: Identifiers {
                    id,
                    uid,
                    label: label.to_owned(),
                },
                trigger,
                transitions: PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(fade_in)),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref.clone(),
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([
                            (
                                Attribute::Intensity,
                                ValueSource::Inline(ParameterValue::Absolute { value }),
                            ),
                            (
                                Attribute::Red,
                                ValueSource::Inline(ParameterValue::Absolute { value }),
                            ),
                        ]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            })
            .expect("test cue should be stored");
    }

    let timeline_id = 318;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 718,
                uid: sequence_uid,
                label: "held-ltp-sequence".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            release_cue: Cue {
                identifiers: Identifiers {
                    id: 99,
                    uid: Uuid::new_v4(),
                    label: "global release".to_owned(),
                },
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                    fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        })
        .expect("test sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 718,
            uid: clip_uid,
            label: "clip-718".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    app.world_mut().spawn({
        let mut timeline = MaterializedTimeline::new(Timeline {
            identifiers: Identifiers {
                id: timeline_id,
                uid: Uuid::new_v4(),
                label: "held-ltp-timeline".to_owned(),
            },
            timecode_uid,
            tracks: vec![Track {
                id: "track-1".to_owned(),
                label: "Track 1".to_owned(),
                muted: false,
                solo: false,
                expanded: false,
                actions: vec![Action {
                    id: "action-start".to_owned(),
                    label: "Start sequence".to_owned(),
                    position: Duration::from_millis(100),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                }],
                automation_lanes: Vec::new(),
            }],
            ..Default::default()
        });
        timeline.activate();
        timeline
    });

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_single_timecode(&mut app, Duration::from_millis(3350), true);
    app.update();
    app.update();
    let held_snapshot =
        sequence_runtime_values_snapshot(&mut app, &[intensity_parameter, red_parameter]);

    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "live auto-end sequence should remain materialized during HTP-gated LTP release"
    );
    assert_values_close(
        &held_snapshot.2,
        &[0.0, 200.0],
        "LTP should hold until HTP release and its own delay finish",
    );

    set_single_timecode(&mut app, Duration::from_millis(4600), true);
    app.update();
    app.update();
    let fading_snapshot =
        sequence_runtime_values_snapshot(&mut app, &[intensity_parameter, red_parameter]);

    assert_values_close(
        &fading_snapshot.2,
        &[0.0, 100.0],
        "LTP should fade only after HTP release and its own delay complete",
    );
}

/// Verifies scoped release cue instructions also hold LTP until same-fixture HTP release completes.
#[test]
fn live_timeline_sequence_auto_end_scoped_release_holds_ltp_until_htp_release_completes() {
    let mut app = setup_sequence_timeline_test_app(false);
    let (fixture_ref, intensity_parameter, red_parameter) =
        add_intensity_red_fixture_parameters(&mut app, 719);

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    for (id, uid, label, value, trigger, fade_in) in [
        (
            1,
            cue_1_uid,
            "cue-1",
            100.0,
            CueTriggerType::Manual,
            Duration::ZERO,
        ),
        (
            2,
            cue_2_uid,
            "cue-2",
            200.0,
            CueTriggerType::AfterDelay(Duration::from_secs(1)),
            Duration::from_secs(1),
        ),
    ] {
        app.world_mut()
            .resource_mut::<DataProvider<Cue>>()
            .add(Cue {
                identifiers: Identifiers {
                    id,
                    uid,
                    label: label.to_owned(),
                },
                trigger,
                transitions: PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(fade_in)),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref.clone(),
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([
                            (
                                Attribute::Intensity,
                                ValueSource::Inline(ParameterValue::Absolute { value }),
                            ),
                            (
                                Attribute::Red,
                                ValueSource::Inline(ParameterValue::Absolute { value }),
                            ),
                        ]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            })
            .expect("test cue should be stored");
    }

    let timeline_id = 319;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 719,
                uid: sequence_uid,
                label: "scoped-held-ltp-sequence".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            release_cue: Cue {
                identifiers: Identifiers {
                    id: 99,
                    uid: Uuid::new_v4(),
                    label: "scoped release".to_owned(),
                },
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref,
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
            ..Default::default()
        })
        .expect("test sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 719,
            uid: clip_uid,
            label: "clip-719".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    let timecode_uid = spawn_timecode(&mut app, timeline_id, Duration::ZERO);
    app.world_mut().spawn({
        let mut timeline = MaterializedTimeline::new(Timeline {
            identifiers: Identifiers {
                id: timeline_id,
                uid: Uuid::new_v4(),
                label: "scoped-held-ltp-timeline".to_owned(),
            },
            timecode_uid,
            tracks: vec![Track {
                id: "track-1".to_owned(),
                label: "Track 1".to_owned(),
                muted: false,
                solo: false,
                expanded: false,
                actions: vec![Action {
                    id: "action-start".to_owned(),
                    label: "Start sequence".to_owned(),
                    position: Duration::from_millis(100),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                }],
                automation_lanes: Vec::new(),
            }],
            ..Default::default()
        });
        timeline.activate();
        timeline
    });

    set_single_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_single_timecode(&mut app, Duration::from_millis(2600), true);
    app.update();
    app.update();
    let held_snapshot =
        sequence_runtime_values_snapshot(&mut app, &[intensity_parameter, red_parameter]);

    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "live auto-end sequence should remain materialized during scoped HTP-gated LTP release"
    );
    assert_values_close(
        &held_snapshot.2,
        &[100.0, 200.0],
        "scoped LTP should hold while HTP fades down",
    );

    set_single_timecode(&mut app, Duration::from_millis(3600), true);
    app.update();
    app.update();
    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "scoped unmatched LTP release should complete after same-fixture HTP release"
    );
}

/// Verifies seek release snapshots include cues due exactly at a bounded action's release edge.
#[test]
fn seek_timeline_sequence_release_delay_keeps_boundary_cue_and_tracked_values() {
    let mut app = setup_sequence_timeline_test_app(true);
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let tilt_metadata = ParameterMetadata {
        attribute: Attribute::Tilt,
        ..Default::default()
    };
    let intensity_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: intensity_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let tilt_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: tilt_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 710,
                uid: fixture_uid,
                label: "release-boundary-fixture".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, tilt_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Tilt, tilt_parameter);
    drop(fixtures);

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_1_uid,
                label: "intensity".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("first cue should be stored");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_2_uid,
                label: "tilt".to_owned(),
            },
            trigger: CueTriggerType::AfterDelay(Duration::from_secs(2)),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("second cue should be stored");

    let timeline_id = 516;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "release-boundary-sequence".to_owned(),
            },
            steps: vec![cue_1_uid.into(), cue_2_uid.into()],
            release_cue: Cue {
                identifiers: Identifiers {
                    id: 99,
                    uid: Uuid::new_v4(),
                    label: "release".to_owned(),
                },
                transitions: PartialTransition {
                    delay_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        })
        .expect("sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: clip_uid,
            label: "clip-31".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "release-boundary-timeline".to_owned(),
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
                    label: "Start sequence".to_owned(),
                    position: Duration::from_millis(100),
                    duration: Duration::ZERO,
                    action: ActionKind::StartClip(clip_uid),
                },
                Action {
                    id: "action-stop".to_owned(),
                    label: "Stop sequence".to_owned(),
                    position: Duration::from_millis(2100),
                    duration: Duration::ZERO,
                    action: ActionKind::StopClip(clip_uid),
                },
            ],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut().spawn(MaterializedTimeline::new(timeline));

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(2500));

    let (position, clock_position, compositing_context, mut layer) = {
        let mut sequence_query = app.world_mut().query::<(
            &MaterializedSequence,
            &InstanceClock,
            &LayerCompositingContext,
            &nightfall_compositor::prelude::Layer,
        )>();
        let (sequence, clock, compositing_context, layer) = sequence_query
            .single(app.world())
            .expect("seek should materialize one released sequence");
        (
            sequence.position(),
            clock.position,
            *compositing_context,
            layer.clone(),
        )
    };
    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let param_query = param_query_state.query_mut(app.world_mut());
    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        compositing_context,
    );

    assert_eq!(position, 2);
    assert_eq!(clock_position, Duration::from_millis(2400));
    assert_eq!(
        compositing_context.released_at,
        Some(Duration::from_secs(2))
    );
    assert_eq!(
        compositing_context.elapsed_since_release(),
        Some(Duration::from_millis(400))
    );
    assert_eq!(
        computed.absolute.get(&intensity_parameter),
        Some(&100.0),
        "release delay should preserve tracked intensity from cue 1"
    );
    assert_eq!(
        computed.absolute.get(&tilt_parameter),
        Some(&90.0),
        "release delay should preserve cue 2 output due at the release boundary"
    );
}

/// Verifies seeking after a stopped sequence release tail is an aggregate no-op.
#[test]
fn seek_timeline_sequence_stop_after_release_tail_is_noop() {
    let stop_position = Duration::from_millis(1600);
    let after_release_tail_position = Duration::from_millis(2700);
    let (mut app, _parameter, timeline_id) =
        setup_sequence_timeline_app_with_stop(true, Some(stop_position));

    set_single_timecode(&mut app, after_release_tail_position, true);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: after_release_tail_position,
        }));
    app.update();
    app.update();

    let sequence_count = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count();
    assert_eq!(
        sequence_count, 0,
        "completed stopped sequence release should not materialize output"
    );
}

/// Verifies paused backward seeks from a release tail remove stale unbound release instances.
#[test]
fn paused_seek_backward_from_sequence_release_removes_stale_release_playback() {
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        Some(Duration::from_secs(2)),
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            ..Default::default()
        },
    );

    seek_sequence_timeline(&mut app, timeline_id, Duration::from_millis(2500));
    let released_sequence_entity = {
        let mut sequence_query = app.world_mut().query::<(
            bevy_ecs::prelude::Entity,
            &MaterializedSequence,
            Option<&ReleaseMarker>,
        )>();
        let released_sequences = sequence_query
            .iter(app.world())
            .filter_map(|(entity, _, release_marker)| release_marker.is_some().then_some(entity))
            .collect::<Vec<_>>();
        assert_eq!(
            released_sequences.len(),
            1,
            "forward seek should materialize the released sequence tail"
        );
        released_sequences[0]
    };
    {
        let mut timeline_query = app.world_mut().query::<&mut MaterializedTimeline>();
        let mut timeline = timeline_query
            .single_mut(app.world_mut())
            .expect("test app should have one timeline");
        timeline.spawned_entities.remove(&released_sequence_entity);
    }

    set_single_timecode(&mut app, Duration::ZERO, false);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: Duration::ZERO,
        }));
    app.update();
    app.update();

    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "backward seek before the sequence should remove stale released playback"
    );
}

/// Verifies seek reconstruction starts auto-end release at sequence completion.
#[test]
fn seek_timeline_sequence_auto_end_release_uses_completion_anchor() {
    let release_halfway_position = Duration::from_millis(2600);
    let (mut app, parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        None,
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    );

    set_single_timecode(&mut app, release_halfway_position, true);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: release_halfway_position,
        }));
    app.update();
    app.update();

    let snapshot = sequence_runtime_snapshot(&mut app, parameter);
    assert_eq!(snapshot.0, 2);
    assert_eq!(snapshot.1, Duration::from_millis(2500));
    assert_sequence_runtime_status(&snapshot.3, snapshot.0, 2, "auto-end release");
    assert!(
        (snapshot.2 - 100.0).abs() <= 1.0,
        "auto-end release should be halfway down from final 200 output, got {}",
        snapshot.2
    );

    let mut sequence_query = app.world_mut().query::<&PlaybackReleaseTiming>();
    let release_timing = sequence_query
        .single(app.world())
        .expect("auto-ended sequence should preserve source-local release timing");
    assert_eq!(release_timing.released_at, Duration::from_secs(2));
}

/// Verifies auto-ended sequences become no-ops after their release tail completes.
#[test]
fn seek_timeline_sequence_auto_end_after_release_tail_is_noop() {
    let after_release_tail_position = Duration::from_millis(3200);
    let (mut app, _parameter, timeline_id) = setup_sequence_timeline_app_with_clip_options(
        true,
        None,
        Duration::ZERO,
        ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    );

    set_single_timecode(&mut app, after_release_tail_position, true);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position: after_release_tail_position,
        }));
    app.update();
    app.update();

    let sequence_count = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count();
    assert_eq!(
        sequence_count, 0,
        "completed auto-end release should not materialize output"
    );
}
