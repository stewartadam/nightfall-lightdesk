// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_app::{App, Update};

use super::*;

/// Installs the shared resources required by systems using `CommandResponder`.
fn add_command_lifecycle(app: &mut App) {
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
}

/// Builds the focused resources required by semantic cue preview command tests.
fn cue_preview_command_app() -> App {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<DataProvider<Group>>();
    add_command_lifecycle(&mut app);
    app.add_message::<CommandEnvelope<CuePreviewCommand>>();
    app.add_systems(Update, handle_cue_preview_commands);
    app
}

/// Registers and submits one cue preview command to the focused handler app.
fn submit_cue_preview_command(app: &mut App, command: CuePreviewCommand) -> CommandId {
    let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
    let command_id = envelope.command_id;
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("cue preview command should register");
    app.world_mut().write_message(envelope);
    command_id
}

/// Verifies preview materialization completes before returning its typed instance ID.
#[test]
fn cue_preview_command_returns_instance_id_after_spawn() {
    let mut app = cue_preview_command_app();
    let expected_instance_id = InstanceId(uuid::Uuid::from_u128(0x4000));
    let command_id = submit_cue_preview_command(
        &mut app,
        CuePreviewCommand::PreviewCue {
            instance_id: Some(expected_instance_id),
            cue: Box::new(Cue {
                identifiers: Identifiers {
                    id: 1,
                    uid: uuid::Uuid::from_u128(0x5000),
                    label: "preview cue".to_owned(),
                },
                ..Default::default()
            }),
        },
    );

    app.update();

    let preview_count = app
        .world_mut()
        .query_filtered::<&InstanceId, With<EditorPreviewInstance>>()
        .iter(app.world())
        .filter(|instance_id| **instance_id == expected_instance_id)
        .count();
    assert_eq!(preview_count, 1);
    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("preview command should return a terminal result");
    assert_eq!(result.command_id, command_id);
    assert!(matches!(
        result.outcome,
        CommandOutcome::Succeeded {
            output: Some(CommandOutput { value })
        } if value == serde_json::json!({ "instance_id": expected_instance_id.0 })
    ));
}

/// Verifies backward scrubbing and resume preserve other preview clocks.
#[test]
fn preview_seek_moves_backward_and_resumes_only_the_owned_preview() {
    let mut app = cue_preview_command_app();
    let target_id = InstanceId::new();
    let other_id = InstanceId::new();
    for instance_id in [target_id, other_id] {
        submit_cue_preview_command(
            &mut app,
            CuePreviewCommand::PreviewCue {
                instance_id: Some(instance_id),
                cue: Box::new(Cue::default()),
            },
        );
    }
    app.update();
    for (seconds, playing) in [(3, false), (1, false), (1, true)] {
        submit_cue_preview_command(
            &mut app,
            CuePreviewCommand::SeekPreview {
                instance_id: target_id,
                position: Duration::from_secs(seconds),
                playing,
            },
        );
        app.update();
        let mut query = app
            .world_mut()
            .query::<(&InstanceId, &InstanceClock, &InstanceControls)>();
        for (id, clock, controls) in query.iter(app.world()) {
            if *id == target_id {
                assert_eq!(clock.position, Duration::from_secs(seconds));
                assert_eq!(controls.rate, if playing { 1.0 } else { 0.0 });
            } else {
                assert_eq!(clock.position, Duration::ZERO);
                assert_eq!(controls.rate, 1.0);
            }
        }
    }
}

/// Verifies an in-flight slider update cannot cancel stopping its preview.
#[test]
fn preview_stop_takes_precedence_over_a_queued_seek() {
    let mut app = cue_preview_command_app();
    let instance_id = InstanceId::new();
    submit_cue_preview_command(
        &mut app,
        CuePreviewCommand::PreviewCue {
            instance_id: Some(instance_id),
            cue: Box::new(Cue::default()),
        },
    );
    app.update();
    submit_cue_preview_command(&mut app, CuePreviewCommand::StopPreview { instance_id });
    submit_cue_preview_command(
        &mut app,
        CuePreviewCommand::SeekPreview {
            instance_id,
            position: Duration::from_secs(1),
            playing: false,
        },
    );
    app.update();
    assert_eq!(
        app.world_mut()
            .query_filtered::<&InstanceId, With<ReleaseMarker>>()
            .iter(app.world())
            .count(),
        1
    );
}

/// Verifies preview stop releases only the matching runtime instance ID.
#[test]
fn release_preview_playback_by_id_leaves_same_source_preview_active() {
    let source_uid = uuid::Uuid::from_u128(0x1234);
    let target_instance_id = InstanceId(uuid::Uuid::from_u128(0x1000));
    let other_instance_id = InstanceId(uuid::Uuid::from_u128(0x2000));

    /// Releases only the target preview instance by runtime ID.
    fn release_target_playback(
        mut commands: Commands,
        preview_query: Query<
            (Entity, &InstanceId, Option<&ReleaseMarker>),
            With<EditorPreviewInstance>,
        >,
    ) {
        release_preview_playback_by_id(
            &mut commands,
            &preview_query,
            InstanceId(uuid::Uuid::from_u128(0x1000)),
        );
    }

    let mut app = App::new();
    app.add_systems(Update, release_target_playback);

    let target = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Cue,
                uid: source_uid,
            }),
            EditorPreviewInstance,
            target_instance_id,
        ))
        .id();
    let other = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Cue,
                uid: source_uid,
            }),
            EditorPreviewInstance,
            other_instance_id,
        ))
        .id();

    app.update();

    assert!(app.world().get::<ReleaseMarker>(target).is_some());
    assert!(app.world().get::<ReleaseMarker>(other).is_none());
}

/// Verifies preview replacement removes only the matching runtime instance ID.
#[test]
fn despawn_preview_instances_by_id_removes_same_source_owner() {
    let source_uid = uuid::Uuid::from_u128(0x1234);
    let target_instance_id = InstanceId(uuid::Uuid::from_u128(0x1000));
    let other_instance_id = InstanceId(uuid::Uuid::from_u128(0x2000));

    /// Despawns only the target preview instance before replacement.
    fn despawn_target_playback(
        mut commands: Commands,
        preview_query: Query<
            (Entity, &InstanceId, Option<&ReleaseMarker>),
            With<EditorPreviewInstance>,
        >,
    ) {
        despawn_preview_instances_by_id(
            &mut commands,
            &preview_query,
            InstanceId(uuid::Uuid::from_u128(0x1000)),
        );
    }

    let mut app = App::new();
    app.add_systems(Update, despawn_target_playback);
    let target = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Cue,
                uid: source_uid,
            }),
            EditorPreviewInstance,
            target_instance_id,
            ReleaseMarker::default(),
        ))
        .id();
    let other = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Cue,
                uid: source_uid,
            }),
            EditorPreviewInstance,
            other_instance_id,
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    assert!(app.world().get_entity(target).is_err());
    assert!(app.world().get_entity(other).is_ok());
}

/// Verifies editor previews attach playback clocks during preview materialization.
#[test]
fn preview_instances_spawn_immediate_realtime_instance_clocks() {
    /// Spawns one cue preview and one sequence preview using the real preview helpers.
    fn spawn_previews(
        mut commands: Commands,
        color_path_data_provider: Option<Res<DataProvider<ColorPath>>>,
        fixture_data_provider: Res<FixtureDataProviderExt>,
        selection_resolver: SpatialSelectionResolver,
        parameter_query: Query<InstanceRef<Parameter>>,
    ) {
        let cue = Cue {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::from_u128(0x1000),
                label: "preview cue".to_owned(),
            },
            ..Default::default()
        };
        spawn_preview_cue(
            &mut commands,
            InstanceId(uuid::Uuid::from_u128(0x2000)),
            &cue,
            color_path_data_provider.as_deref(),
            None,
            &fixture_data_provider,
            &selection_resolver,
            &parameter_query,
        );

        let preview = SequencePreview {
            sequence: Sequence {
                identifiers: Identifiers {
                    id: 2,
                    uid: uuid::Uuid::from_u128(0x3000),
                    label: "preview sequence".to_owned(),
                },
                ..Default::default()
            },
            cues: Vec::new(),
            position: 1,
        };
        spawn_sequence_preview(
            &mut commands,
            InstanceId(uuid::Uuid::from_u128(0x4000)),
            &preview,
            color_path_data_provider.as_deref(),
            None,
            &fixture_data_provider,
            &selection_resolver,
            &parameter_query,
        );
    }

    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, spawn_previews);

    app.update();

    let mut preview_clocks = app
        .world_mut()
        .query_filtered::<(&InstanceMetadata, &InstanceClock), With<EditorPreviewInstance>>();
    let mut names_and_clocks = preview_clocks
        .iter(app.world())
        .map(|(metadata, clock)| (metadata.name.clone().unwrap_or_default(), clock.clone()))
        .collect::<Vec<_>>();
    names_and_clocks.sort_by(|left, right| left.0.cmp(&right.0));

    assert_eq!(names_and_clocks.len(), 2);
    assert_eq!(names_and_clocks[0].0, "Cue Preview: preview cue");
    assert_eq!(names_and_clocks[1].0, "Sequence Preview: preview sequence");
    for (_, clock) in names_and_clocks {
        assert_eq!(clock.source, InstanceClockSource::Realtime);
        assert_eq!(clock.position, Duration::ZERO);
        assert_eq!(clock.delta, Duration::ZERO);
    }
}

/// Builds a focused app for direct cue and sequence definition storage.
fn cue_definition_storage_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<CueCommand>>();
    add_command_lifecycle(&mut app);
    app.add_message::<CueDefinitionChange>();
    app.add_message::<SequenceDefinitionChange>();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(Update, (cue_crud_events, sequence_crud_events));
    app
}

/// Inserts one group used to resolve authored aliases in definition-store tests.
fn insert_definition_test_group(app: &mut App, id: u32, uid: Uuid) {
    let mut group = Group::default();
    group.identifiers.id = id;
    group.identifiers.uid = uid;
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(group)
        .expect("group should store");
}

/// Registers and submits one direct cue-domain command.
fn submit_definition_command(app: &mut App, command: CueCommand) {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("command should register");
    app.world_mut().write_message(envelope);
}

/// Builds one cue instruction targeting an authored group alias.
fn group_instruction(group_id: u32) -> BoundCueInstruction {
    BoundCueInstruction {
        selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(group_id))),
        cue_instruction: CueInstruction::default(),
    }
}

/// Verifies direct cue commands persist stable group identities.
#[test]
fn direct_cue_store_stabilizes_group_aliases() {
    let mut app = cue_definition_storage_app();
    let group_uid = Uuid::from_u128(0x440);
    insert_definition_test_group(&mut app, 4, group_uid);
    let mut cue = Cue::default();
    cue.identifiers.id = 1;
    cue.identifiers.uid = Uuid::from_u128(0x441);
    cue.instructions = vec![group_instruction(4)];
    submit_definition_command(&mut app, CueCommand::StoreCue(Box::new(cue)));

    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<Cue>>()
        .from_id(1)
        .expect("cue should store");
    assert_eq!(
        stored.instructions[0].selection.source,
        SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
    );
}

/// Verifies direct sequence commands stabilize built-in cue group aliases.
#[test]
fn direct_sequence_store_stabilizes_builtin_cue_group_aliases() {
    let mut app = cue_definition_storage_app();
    let group_uid = Uuid::from_u128(0x450);
    insert_definition_test_group(&mut app, 5, group_uid);
    let mut sequence = Sequence::default();
    sequence.identifiers.id = 2;
    sequence.identifiers.uid = Uuid::from_u128(0x451);
    sequence.setup_cue.instructions = vec![group_instruction(5)];
    submit_definition_command(&mut app, CueCommand::StoreSequence(Box::new(sequence)));

    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<Sequence>>()
        .from_id(2)
        .expect("sequence should store");
    assert_eq!(
        stored.setup_cue.instructions[0].selection.source,
        SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
    );
}

/// Verifies moving a color path updates stored path identity and authored references.
#[test]
fn rename_color_path_moves_path_and_rewrites_references() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<CueCommand>>();
    add_command_lifecycle(&mut app);
    app.add_message::<CueDefinitionChange>();
    app.add_message::<SequenceDefinitionChange>();
    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<ColorPath>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, cue_crud_events);

    let fixture_ref = FixtureRef {
        fixture_uid: uuid::Uuid::from_u128(0x1010),
        index: Some(1),
    };
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .set_color_path_default(fixture_ref.clone(), Some(ColorPathId(101)));

    let color_path = ColorPath::new(101, "Custom HSV", ColorInterpolationSpace::Hsv);
    let color_path_uid = color_path.identifiers.uid;
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(color_path)
        .expect("test color path should be stored");

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::from_u128(0x2020),
                label: "cue".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    color_path_id: Some(ColorPathId(101)),
                    ..Default::default()
                },
            }],
            parts: vec![CuePart {
                identifiers: Identifiers {
                    id: 1,
                    uid: uuid::Uuid::from_u128(0x3030),
                    label: "part".to_owned(),
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref.clone(),
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        color_path_id: Some(ColorPathId(101)),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            }],
            ..Default::default()
        })
        .expect("test cue should be stored");

    let envelope = CommandEnvelope::new(
        CueCommand::RenameColorPath {
            id: 101,
            new_id: 202,
        },
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    );
    let command_id = envelope.command_id;
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("color path rename should register");
    app.world_mut().write_message(envelope);
    app.update();

    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("rename should report success");
    assert_eq!(result.command_id, command_id);
    assert_eq!(result.outcome, CommandOutcome::succeeded());

    let color_paths = app.world().resource::<DataProvider<ColorPath>>();
    assert!(color_paths.from_id(101).is_err());
    let moved_path = color_paths
        .from_id(202)
        .expect("moved color path should be indexed by the new ID");
    assert_eq!(moved_path.identifiers.uid, color_path_uid);
    assert_eq!(moved_path.identifiers.label, "Custom HSV");

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .from_id(1)
        .expect("test cue should remain stored");
    assert_eq!(
        cue.instructions[0].cue_instruction.color_path_id,
        Some(ColorPathId(202))
    );
    assert_eq!(
        cue.parts[0].instructions[0].cue_instruction.color_path_id,
        Some(ColorPathId(202))
    );

    let fixture_default = app
        .world()
        .resource::<FixtureDataProviderExt>()
        .color_path_default_for_element(&fixture_ref);
    assert_eq!(fixture_default, Some(ColorPathId(202)));
}

/// Verifies timed sequence positioning seeds a InstanceClock for deterministic replay.
#[test]
fn timed_sequence_goto_inserts_instance_clock_at_evaluated_position() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<SequencePlaybackAction>>();
    add_command_lifecycle(&mut app);
    app.add_systems(Update, handle_sequence_playback_actions);

    let instance_id = InstanceId(uuid::Uuid::from_u128(0x1000));
    let timeline_uid = uuid::Uuid::from_u128(0x2000);
    let entity = app
        .world_mut()
        .spawn((MaterializedSequence::default(), instance_id))
        .id();
    let mut instance_index = InstanceIndex::default();
    instance_index.insert(instance_id, entity);
    app.insert_resource(instance_index);

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            SequencePlaybackAction::Goto {
                instance_id,
                position: 1,
                timing: Some(PlaybackReconstructionTiming::timeline_source_local(
                    Duration::from_millis(250),
                    Duration::from_millis(900),
                    timeline_uid,
                    Duration::from_millis(400),
                )),
            },
        ));

    app.update();

    let clock = app
        .world()
        .get::<InstanceClock>(entity)
        .expect("timed sequence goto should insert a playback clock");
    assert_eq!(clock.position, Duration::from_millis(900));
    assert_eq!(clock.previous_position, Duration::from_millis(900));
    assert_eq!(clock.delta, Duration::ZERO);
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(400)
        }
    );
    assert_eq!(
        clock.discontinuity,
        InstanceClockDiscontinuity::Discontinuous
    );
}

/// Verifies sequence render reconstruction seeds InstanceClock state.
#[test]
fn sequence_render_at_inserts_instance_clock_at_evaluated_position() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<SequencePlaybackAction>>();
    add_command_lifecycle(&mut app);
    app.add_systems(Update, handle_sequence_playback_actions);

    let first_instance_id = InstanceId(uuid::Uuid::from_u128(0x3000));
    let second_instance_id = InstanceId(uuid::Uuid::from_u128(0x4000));
    let timeline_uid = uuid::Uuid::from_u128(0x5000);
    let first_entity = app
        .world_mut()
        .spawn((MaterializedSequence::default(), first_instance_id))
        .id();
    let second_entity = app
        .world_mut()
        .spawn((MaterializedSequence::default(), second_instance_id))
        .id();
    let mut instance_index = InstanceIndex::default();
    instance_index.insert(first_instance_id, first_entity);
    instance_index.insert(second_instance_id, second_entity);
    app.insert_resource(instance_index);

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            SequencePlaybackAction::RenderAt {
                instance_id: first_instance_id,
                position: 1,
                timing: PlaybackReconstructionTiming::timeline_source_local(
                    Duration::from_millis(250),
                    Duration::from_millis(900),
                    timeline_uid,
                    Duration::from_millis(400),
                ),
            },
        ));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            SequencePlaybackAction::RenderAt {
                instance_id: second_instance_id,
                position: 1,
                timing: PlaybackReconstructionTiming::timeline_source_local(
                    Duration::from_millis(300),
                    Duration::from_millis(950),
                    timeline_uid,
                    Duration::from_millis(450),
                ),
            },
        ));

    app.update();

    let first_clock = app
        .world()
        .get::<InstanceClock>(first_entity)
        .expect("sequence render should insert a playback clock");
    assert_eq!(first_clock.position, Duration::from_millis(900));
    assert_eq!(
        first_clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(400)
        }
    );

    let second_clock = app
        .world()
        .get::<InstanceClock>(second_entity)
        .expect("sequence render should insert a playback clock");
    assert_eq!(second_clock.position, Duration::from_millis(950));
    assert_eq!(
        second_clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(450)
        }
    );
}

/// Verifies generated direct block assertions remain separate from Blueprint applications.
#[test]
fn block_merge_does_not_absorb_direct_values_into_blueprint_rows() {
    let fixture_uid = uuid::Uuid::new_v4();
    let selection: SpatialSelection = SelectionExpr::Resolved(vec![FixtureRef {
        fixture_uid,
        index: None,
    }])
    .into();
    let mut existing = vec![BoundCueInstruction {
        selection: selection.clone(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid: uuid::Uuid::new_v4(),
                selector: BlueprintSelector::Attribute(Attribute::Red),
            }),
            ..Default::default()
        },
    }];
    let incoming = vec![BoundCueInstruction {
        selection,
        cue_instruction: CueInstruction {
            values: HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
            )]),
            ..Default::default()
        },
    }];

    merge_block_instructions(&mut existing, incoming);

    assert_eq!(existing.len(), 2);
    assert!(existing[0].cue_instruction.values.is_empty());
    assert!(existing[1].cue_instruction.blueprint_application.is_none());
    assert!(
        existing[1]
            .cue_instruction
            .values
            .contains_key(&Attribute::Red)
    );
}

/// Verifies a whole-fixture Blueprint row does not suppress an element block assertion.
#[test]
fn element_block_is_not_suppressed_by_whole_fixture_blueprint_row() {
    let fixture_uid = uuid::Uuid::new_v4();
    let mut existing = vec![BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid,
            index: None,
        }])
        .into(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid: uuid::Uuid::new_v4(),
                selector: BlueprintSelector::Attribute(Attribute::Blue),
            }),
            ..Default::default()
        },
    }];
    let incoming = vec![BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid,
            index: Some(1),
        }])
        .into(),
        cue_instruction: CueInstruction {
            values: HashMap::from([(
                Attribute::Blue,
                ValueSource::Inline(ParameterValue::Absolute { value: 80.0 }),
            )]),
            ..Default::default()
        },
    }];

    merge_block_instructions(&mut existing, incoming);

    assert_eq!(existing.len(), 2);
    assert_eq!(
        cue_instruction_fixture(&existing[1]).and_then(|row| row.index),
        Some(1)
    );
}
