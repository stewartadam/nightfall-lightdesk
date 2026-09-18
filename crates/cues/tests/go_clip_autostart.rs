// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use bevy_app::prelude::*;
use bevy_ecs::{
    prelude::{MessageReader, Messages, Query, Res, ResMut},
    schedule::IntoScheduleConfigs,
    system::SystemState,
};
use moonshine_kind::{Instance, InstanceRef};
use nightfall::prelude::*;
use nightfall_clips::{
    Clip, ClipAction, ClipCommand, MaterializedClip, Source, clip_action_from_command,
};
use nightfall_compositor::prelude::ReleaseMarker;
use nightfall_cues::events::handle_events;
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueInstruction, CueLifecycleAction, MaterializedSequence, Sequence,
    SequencePlaybackAction,
};
use nightfall_desk::prelude::*;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandError, CommandId, CommandNotice, CommandOrigin, CommandOutcome,
    CommandReply, CommandResult, CommandTracker, DataProvider, EngineActionEnvelope,
    FinishedCommand, OperationResult, PendingEngineActionBuffer, ReplyTarget,
};
use nightfall_fixtures::prelude::*;
use nightfall_instances::{
    InstanceClock, InstanceClockSource, InstanceId, InstanceOptions, InstancePosition,
    InstanceSequenceCueStatus, InstanceStatus,
};
use nightfall_playback_planner::{PlaybackPositionSource, PlaybackReconstructionTiming};
use uuid::Uuid;

/// Registers command context carried by test clip actions.
fn register_clip_commands(
    mut commands: MessageReader<EngineActionEnvelope<ClipAction>>,
    mut tracker: ResMut<CommandTracker>,
) {
    for command in commands.read() {
        let (Some(command_id), Some(undo_id)) = (command.command_id, command.undo_id) else {
            continue;
        };
        let _ = tracker.register_context(
            command_id,
            undo_id,
            CommandOrigin::Cli,
            ReplyTarget::Detached,
        );
    }
}

/// Converts a clip command fixture into a tracked concrete action.
fn clip_action(command: ClipCommand) -> EngineActionEnvelope<ClipAction> {
    let command_id = CommandId::new();
    let action = clip_action_from_command(&command)
        .expect("test clip command should map to a runtime action");
    EngineActionEnvelope::for_command_context(command_id, command_id.into(), action)
}

fn setup_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_message::<OperationResult<(), CommandError>>();

    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<PendingEngineActionBuffer>();
    app.init_resource::<CommandTracker>();

    app.add_systems(Update, (register_clip_commands, handle_events).chain());
    app
}

/// Stores an empty sequence and one clip that targets it.
fn add_sequence_clip(app: &mut App, clip_id: u32) -> Uuid {
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: clip_id,
                uid: sequence_uid,
                label: format!("sequence-{clip_id}"),
            },
            ..Default::default()
        })
        .expect("sequence should store");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: format!("clip-{clip_id}"),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });
    sequence_uid
}

/// Drains all command results produced by the focused clip app.
fn drain_command_results(app: &mut App) -> Vec<CommandResult> {
    app.world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect()
}

/// Asserts that one command produced exactly one successful terminal result.
fn assert_single_success(results: &[CommandResult], command_id: CommandId) {
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].command_id, command_id);
    assert!(matches!(
        results[0].outcome,
        CommandOutcome::Succeeded { .. }
    ));
}

/// Builds deterministic reconstruction timing for clip lifecycle tests.
fn lifecycle_test_timing() -> PlaybackReconstructionTiming {
    PlaybackReconstructionTiming {
        started_at: Duration::from_millis(250),
        position: Duration::from_millis(900),
        source: PlaybackPositionSource::ExternalPosition,
    }
}

/// Verifies sequence start commands each publish one terminal success.
#[test]
fn sequence_clip_start_commands_publish_one_terminal_success() {
    let commands = [
        ClipCommand::StartClip(IdExpr::Single(401)),
        ClipCommand::StartClipAtTiming {
            clip_id: IdExpr::Single(401),
            timing: lifecycle_test_timing(),
            instance_options: None,
        },
    ];

    for command in commands {
        let mut app = setup_app();
        add_sequence_clip(&mut app, 401);
        let action = clip_action(command);
        let command_id = action.command_id.expect("command should carry an identity");
        app.world_mut().write_message(action);

        app.update();

        assert_single_success(&drain_command_results(&mut app), command_id);
        assert_eq!(
            app.world_mut()
                .query::<&MaterializedSequence>()
                .iter(app.world())
                .count(),
            1
        );
    }
}

/// Verifies sequence stop commands each publish one terminal success.
#[test]
fn sequence_clip_stop_commands_publish_one_terminal_success() {
    let commands = [
        ClipCommand::StopClip(IdExpr::Single(402)),
        ClipCommand::StopClipAtTiming {
            clip_id: IdExpr::Single(402),
            timing: lifecycle_test_timing(),
        },
    ];

    for command in commands {
        let mut app = setup_app();
        add_sequence_clip(&mut app, 402);
        app.world_mut()
            .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(402))));
        app.update();
        drain_command_results(&mut app);

        let action = clip_action(command);
        let command_id = action.command_id.expect("command should carry an identity");
        app.world_mut().write_message(action);
        app.update();

        assert_single_success(&drain_command_results(&mut app), command_id);
        let released = app
            .world_mut()
            .query::<(&MaterializedSequence, Option<&ReleaseMarker>)>()
            .iter(app.world())
            .filter(|(_, release_marker)| release_marker.is_some())
            .count();
        assert_eq!(released, 1);
    }
}

/// Verifies missing sequence clip IDs fail every start and stop lifecycle variant.
#[test]
fn missing_sequence_clip_lifecycle_commands_publish_one_terminal_failure() {
    let commands = [
        ClipCommand::StartClip(IdExpr::Single(403)),
        ClipCommand::StartClipAtTiming {
            clip_id: IdExpr::Single(403),
            timing: lifecycle_test_timing(),
            instance_options: None,
        },
        ClipCommand::StopClip(IdExpr::Single(403)),
        ClipCommand::StopClipAtTiming {
            clip_id: IdExpr::Single(403),
            timing: lifecycle_test_timing(),
        },
    ];

    for command in commands {
        let mut app = setup_app();
        let action = clip_action(command);
        let command_id = action.command_id.expect("command should carry an identity");
        app.world_mut().write_message(action);

        app.update();

        let results = drain_command_results(&mut app);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command_id);
        assert!(matches!(results[0].outcome, CommandOutcome::Failed(_)));
    }
}

/// Adds the 32 forty-element fixtures that drive clip 412's expansion cost.
fn add_clip_412_fixture_shape(app: &mut App) -> Vec<FixtureRef> {
    let mut whole_fixture_refs = Vec::with_capacity(32);
    for fixture_id in 1..=32 {
        let fixture_uid = Uuid::new_v4();
        app.world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: fixture_id,
                    uid: fixture_uid,
                    label: format!("clip-412-fixture-{fixture_id}"),
                },
                make: "test".to_owned(),
                model: "forty-element-pixel-bar".to_owned(),
                mode: "default".to_owned(),
                elements: (1..=40)
                    .map(|index| FixtureElement {
                        label: format!("Element {index}"),
                        parameters: vec![ParameterMetadata {
                            attribute: Attribute::Intensity,
                            native_unit: Attribute::Intensity.native_unit(),
                            value_polarity: Attribute::Intensity.value_polarity(),
                            ..Default::default()
                        }],
                    })
                    .collect(),
                ..Default::default()
            })
            .expect("store clip 412 fixture");

        for index in 1..=40 {
            let fixture_ref = FixtureRef {
                fixture_uid,
                index: Some(index),
            };
            let parameter_entity = app
                .world_mut()
                .spawn(Parameter {
                    metadata: ParameterMetadata {
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        ..Default::default()
                    },
                    values: Default::default(),
                })
                .id();
            // SAFETY: parameter_entity was spawned in this world with a Parameter component.
            let parameter = unsafe { Instance::from_entity_unchecked(parameter_entity) };
            app.world()
                .resource::<FixtureDataProviderExt>()
                .add_parameter(fixture_ref, Attribute::Intensity, parameter);
        }
        whole_fixture_refs.push(FixtureRef {
            fixture_uid,
            index: None,
        });
    }
    whole_fixture_refs
}

/// Verifies clip 412 starts well below one full materialization pass.
#[test]
fn start_clip_materializes_only_first_cue_of_large_sequence() {
    let mut app = setup_app();
    let clip_id = 412;
    let sequence_uid = Uuid::new_v4();
    let cue_uids = (1..=59).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    let fixture_refs = add_clip_412_fixture_shape(&mut app);
    let instruction = BoundCueInstruction {
        selection: SpatialSelection {
            source: SelectionExpr::Resolved(fixture_refs),
            clauses: Vec::new(),
            union: Vec::new(),
        },
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::Intensity,
                ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
            )]),
            ..Default::default()
        },
    };

    {
        let mut cues = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (index, cue_uid) in cue_uids.iter().copied().enumerate() {
            cues.add(Cue {
                identifiers: Identifiers {
                    id: index as u32 + 1,
                    uid: cue_uid,
                    label: format!("large-sequence-cue-{}", index + 1),
                },
                instructions: vec![instruction.clone()],
                ..Default::default()
            })
            .expect("store large sequence cue");
        }
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: clip_id,
                uid: sequence_uid,
                label: "large live sequence".to_owned(),
            },
            steps: cue_uids.iter().copied().map(Into::into).collect(),
            ..Default::default()
        })
        .expect("store large live sequence");
    let sequence = app
        .world()
        .resource::<DataProvider<Sequence>>()
        .get(sequence_uid)
        .expect("read large live sequence")
        .clone();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "large sequence clip".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let full_materialization_elapsed = {
        let mut system_state = SystemState::<(
            Res<DataProvider<Cue>>,
            Res<FixtureDataProviderExt>,
            nightfall_fixtures::selection::SpatialSelectionResolver,
            Query<InstanceRef<Parameter>>,
        )>::new(app.world_mut());
        let (cues, fixtures, selection_resolver, parameters) = system_state
            .get(app.world())
            .expect("materialization inputs should exist");
        let started_at = Instant::now();
        let materialized = MaterializedSequence::materialize(
            &sequence,
            &cues,
            &fixtures,
            &parameters,
            &selection_resolver,
        );
        let elapsed = started_at.elapsed();
        assert_eq!(materialized.mcues.len(), 59);
        elapsed
    };

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    let start_frame_started_at = Instant::now();
    app.update();
    let start_frame_elapsed = start_frame_started_at.elapsed();

    let mut query = app.world_mut().query::<&MaterializedSequence>();
    let sequence = query
        .single(app.world())
        .expect("clip start should create one sequence playback");
    assert_eq!(sequence.position(), 1);
    assert_eq!(sequence.mcues.len(), 1);
    assert_eq!(sequence.current().identifiers.uid, cue_uids[0]);
    assert!(
        start_frame_elapsed * 4 < full_materialization_elapsed,
        "clip 412 start frame {start_frame_elapsed:?} should stay below one quarter of a full {full_materialization_elapsed:?} materialization pass"
    );
}

/// Verifies a stale sequence target on a start command reports an error instead of panicking.
#[test]
fn start_clip_with_missing_sequence_target_reports_error_without_materializing() {
    let mut app = setup_app();

    let clip_id = 301;
    let sequence_uid = Uuid::new_v4();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "missing-sequence-start".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));

    app.update();

    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert!(matches!(
        &results[0].outcome,
        CommandOutcome::Failed(error)
            if error.message.contains("missing-sequence-start")
                && error.message.contains(&sequence_uid.to_string())
    ));
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        0
    );
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedSequence>()
            .iter(app.world())
            .count(),
        0
    );
}

/// Verifies a stale sequence target on deferred go autostart is rejected before flush.
#[test]
fn go_clip_with_missing_sequence_target_reports_error_without_materializing() {
    let mut app = setup_app();

    let clip_id = 302;
    let sequence_uid = Uuid::new_v4();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "missing-sequence-go".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert!(matches!(
        &results[0].outcome,
        CommandOutcome::Failed(error)
            if error.message.contains("missing-sequence-go")
                && error.message.contains(&sequence_uid.to_string())
    ));
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        0
    );
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedSequence>()
            .iter(app.world())
            .count(),
        0
    );
}

/// Verifies attached-playback go waits for its delegated sequence action.
#[test]
fn go_clip_with_missing_sequence_target_queues_action_before_completion() {
    let mut app = setup_app();

    let clip_id = 303;
    let sequence_uid = Uuid::new_v4();
    let instance_id = InstanceId::new();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "missing-sequence-attached-go".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(
        results.is_empty(),
        "the clip command must wait for delegated sequence playback"
    );

    let queued = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert_eq!(queued.len(), 1);
    assert!(matches!(
        queued[0]
            .action
            .as_any()
            .downcast_ref::<SequencePlaybackAction>(),
        Some(SequencePlaybackAction::Go { instance_id: queued_instance_id })
            if *queued_instance_id == instance_id
    ));
}

/// Verifies attached-playback back waits for its delegated sequence action.
#[test]
fn back_clip_with_missing_sequence_target_queues_action_before_completion() {
    let mut app = setup_app();

    let clip_id = 304;
    let sequence_uid = Uuid::new_v4();
    let instance_id = InstanceId::new();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "missing-sequence-attached-back".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::BackClip(IdExpr::Single(clip_id))));

    app.update();

    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(
        results.is_empty(),
        "the clip command must wait for delegated sequence playback"
    );

    let queued = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert_eq!(queued.len(), 1);
    assert!(matches!(
        queued[0]
            .action
            .as_any()
            .downcast_ref::<SequencePlaybackAction>(),
        Some(SequencePlaybackAction::Back { instance_id: queued_instance_id })
            if *queued_instance_id == instance_id
    ));
}

/// Verifies same-target sequence clips create separate instances with their own priorities.
#[test]
fn sequence_clips_with_same_target_keep_distinct_priorities() {
    let mut app = setup_app();

    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "shared sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    for (id, priority) in [(101, Priority(3)), (102, Priority(17))] {
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: format!("clip-{id}"),
            },
            source: Some(Source::Sequence(sequence_uid)),
            priority,
            ..Default::default()
        });
        app.world_mut()
            .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(id))));
    }

    app.update();

    let mut sequence_priorities = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .map(|msequence| msequence.priority)
        .collect::<Vec<_>>();
    sequence_priorities.sort_by_key(|priority| priority.0);
    assert_eq!(
        sequence_priorities,
        vec![Priority(3), Priority(17)],
        "same-target sequence clips should materialize independent priorities"
    );

    let attached_instances = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|materialized_clip| materialized_clip.attached_instance)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        attached_instances.len(),
        2,
        "same-target sequence clips should attach to distinct instances"
    );
}

/// Verifies Go autostart does not attach to another clip's same-target playback.
#[test]
fn go_clip_with_same_target_starts_its_own_priority_playback() {
    let mut app = setup_app();

    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "shared sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    for (id, priority) in [(201, Priority(4)), (202, Priority(21))] {
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: format!("clip-{id}"),
            },
            source: Some(Source::Sequence(sequence_uid)),
            priority,
            ..Default::default()
        });
    }

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(201))));
    app.update();

    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(202))));
    app.update();

    let mut sequence_priorities = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .map(|msequence| msequence.priority)
        .collect::<Vec<_>>();
    sequence_priorities.sort_by_key(|priority| priority.0);
    assert_eq!(
        sequence_priorities,
        vec![Priority(4), Priority(21)],
        "go autostart should not reattach to another clip's same-target playback"
    );
}

#[test]
fn go_clip_queues_start_then_go_when_not_running() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let queued_after_go = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();

    assert!(
        queued_after_go.is_empty(),
        "go autostart should not recursively queue pending commands"
    );

    let materialized_clip_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|materialized_clip| materialized_clip.clip_id == clip_id)
        .count();
    assert_eq!(
        materialized_clip_count, 1,
        "expected one materialized clip after go autostart"
    );

    let msequence_count = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count();
    assert!(
        msequence_count >= 1,
        "expected at least one materialized sequence after go autostart"
    );

    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("go autostart should spawn an immediate realtime playback clock");
    assert_eq!(clock.source, InstanceClockSource::Realtime);
    assert_eq!(clock.position, Duration::ZERO);
}

/// Verifies restarting an existing sequence clip resets its source-local clock.
#[test]
fn start_clip_restarts_existing_sequence_with_fresh_realtime_clock() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.update();

    {
        let mut clock_query = app.world_mut().query::<&mut InstanceClock>();
        let mut clock = clock_query
            .single_mut(app.world_mut())
            .expect("expected one sequence playback clock");
        clock.seek_to(Duration::from_secs(5));
    }

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.update();

    let mut clock_query = app.world_mut().query::<&InstanceClock>();
    let clock = clock_query
        .single(app.world())
        .expect("expected restarted sequence playback clock");
    assert_eq!(clock.source, InstanceClockSource::Realtime);
    assert_eq!(clock.position, Duration::ZERO);
    assert_eq!(clock.delta, Duration::ZERO);
}

/// Ensures goto autostarts a stopped sequence clip at the requested cue.
#[test]
fn goto_clip_queues_start_then_goto_when_not_running() {
    let mut app = setup_app();

    let clip_id = 255;
    let cue_uid_a = Uuid::new_v4();
    let cue_uid_b = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid, label) in [(1, cue_uid_a, "cue-a"), (2, cue_uid_b, "cue-b")] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: label.to_string(),
                    },
                    ..Default::default()
                })
                .expect("failed to add test cue");
        }
    }

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: [cue_uid_a, cue_uid_b].into_iter().map(Into::into).collect(),
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::GotoClip {
            clip_id: IdExpr::Single(clip_id),
            position: 2,
            timing: None,
        }));

    app.update();

    let queued_after_goto = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert!(
        queued_after_goto.is_empty(),
        "goto autostart should not recursively queue pending commands"
    );

    let mut msequence_query = app.world_mut().query::<&MaterializedSequence>();
    let msequences = msequence_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(msequences.len(), 1);
    assert_eq!(
        msequences[0].position(),
        2,
        "goto autostart should materialize the sequence at the requested cue"
    );
    assert_eq!(
        msequences[0].mcues.len(),
        2,
        "goto autostart should materialize exactly the requested prefix"
    );
}

#[test]
fn go_clip_twice_in_same_tick_does_not_duplicate_materialization() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let materialized_clip_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|materialized_clip| materialized_clip.clip_id == clip_id)
        .count();
    assert_eq!(
        materialized_clip_count, 1,
        "expected exactly one materialized clip after duplicate go commands"
    );

    let msequence_count = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count();
    assert_eq!(
        msequence_count, 1,
        "expected exactly one materialized sequence after duplicate go commands"
    );
}

#[test]
fn start_then_go_in_same_tick_does_not_duplicate_materialization() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let materialized_clip_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|materialized_clip| materialized_clip.clip_id == clip_id)
        .count();
    assert_eq!(
        materialized_clip_count, 1,
        "expected exactly one materialized clip after start+go"
    );

    let msequence_count = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count();
    assert_eq!(
        msequence_count, 1,
        "expected exactly one materialized sequence after start+go"
    );
}

/// Ensures a coalesced timed start+go stamps the advanced cue in playback-clock space.
#[test]
fn timed_start_then_go_in_same_tick_uses_clock_position_for_advanced_cue() {
    let mut app = setup_app();

    let clip_id = 255;
    let cue_uid_a = Uuid::new_v4();
    let cue_uid_b = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid, label) in [(1, cue_uid_a, "cue-a"), (2, cue_uid_b, "cue-b")] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: label.to_string(),
                    },
                    ..Default::default()
                })
                .expect("failed to add test cue");
        }
    }

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: [cue_uid_a, cue_uid_b].into_iter().map(Into::into).collect(),
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClipAtTiming {
            clip_id: IdExpr::Single(clip_id),
            timing: PlaybackReconstructionTiming {
                started_at: Duration::from_millis(250),
                position: Duration::from_millis(900),
                source: PlaybackPositionSource::ExternalPosition,
            },
            instance_options: None,
        }));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let mut query = app
        .world_mut()
        .query::<(&MaterializedSequence, &InstanceClock, &InstanceStatus)>();
    let (msequence, clock, status) = query
        .single(app.world())
        .expect("timed start+go should materialize one clocked sequence");

    assert_eq!(msequence.position(), 2);
    assert_eq!(
        msequence.mcues.len(),
        2,
        "coalesced go should materialize the newly active cue"
    );
    assert_eq!(clock.position, Duration::from_millis(900));
    assert_eq!(
        status.position,
        InstancePosition::Sequence {
            sequence_uid,
            current_position: 2,
            cue_count: 2,
            current_cue_uid: Some(cue_uid_b),
            current_label: Some("cue-b".to_owned()),
            current_part_count: 0,
            next_position: None,
            next_cue_uid: None,
            next_label: None,
            next_part_count: None,
            retained_cues: vec![
                InstanceSequenceCueStatus {
                    position: 1,
                    cue_uid: cue_uid_a,
                    transition_elapsed: Some(Duration::from_millis(650)),
                },
                InstanceSequenceCueStatus {
                    position: 2,
                    cue_uid: cue_uid_b,
                    transition_elapsed: Some(Duration::ZERO),
                },
            ],
        }
    );
    assert!(
        !msequence.has_terminated_at_clock(Some(clock)),
        "advanced final cue should start at the same playback-clock position as the coalesced go"
    );
}

/// Ensures deferred sequence start applies goto/go commands in command order.
#[test]
fn start_then_goto_then_go_in_same_tick_advances_from_goto_position() {
    let mut app = setup_app();

    let clip_id = 255;
    let cue_uid_a = Uuid::new_v4();
    let cue_uid_b = Uuid::new_v4();
    let cue_uid_c = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (id, uid, label) in [
            (1, cue_uid_a, "cue-a"),
            (2, cue_uid_b, "cue-b"),
            (3, cue_uid_c, "cue-c"),
        ] {
            cue_provider
                .add(Cue {
                    identifiers: Identifiers {
                        id,
                        uid,
                        label: label.to_string(),
                    },
                    ..Default::default()
                })
                .expect("failed to add test cue");
        }
    }

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: [cue_uid_a, cue_uid_b, cue_uid_c]
                .into_iter()
                .map(Into::into)
                .collect(),
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GotoClip {
            clip_id: IdExpr::Single(clip_id),
            position: 2,
            timing: None,
        }));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));

    app.update();

    let mut msequence_query = app.world_mut().query::<&MaterializedSequence>();
    let msequences = msequence_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(msequences.len(), 1);
    assert_eq!(
        msequences[0].position(),
        3,
        "deferred goto should be applied before the following deferred go"
    );
}

#[test]
fn start_go_stop_in_same_tick_leaves_clip_stopped() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::StopClip(IdExpr::Single(clip_id))));

    app.update();

    let materialized_clip_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|materialized_clip| materialized_clip.clip_id == clip_id)
        .count();
    assert_eq!(
        materialized_clip_count, 0,
        "expected no materialized clip after start+go+stop in same tick"
    );

    let msequence_count = app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count();
    assert_eq!(
        msequence_count, 0,
        "expected no materialized sequence after start+go+stop in same tick"
    );
}

#[test]
fn go_then_stop_in_same_tick_cancels_pending_sequence_go() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.update();

    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(clip_id))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::StopClip(IdExpr::Single(clip_id))));
    app.update();

    let queued_after_go_stop = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert!(
        queued_after_go_stop.is_empty(),
        "expected stop to cancel delegated sequence go commands in the pending buffer"
    );
}

#[test]
fn stop_clip_releases_running_sequence_after_target_changes_to_fx() {
    let mut app = setup_app();

    let clip_id = 255;
    let sequence_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "test sequence".to_string(),
            },
            steps: vec![],
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "255/0/0".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(clip_id))));
    app.update();

    {
        let mut clips = app.world_mut().query::<&mut Clip>();
        let mut clip = clips
            .single_mut(app.world_mut())
            .expect("expected one clip");
        clip.source = Some(Source::Fx(Uuid::new_v4()));
    }

    app.world_mut()
        .write_message(clip_action(ClipCommand::StopClip(IdExpr::Single(clip_id))));
    app.update();

    let released_sequences = app
        .world_mut()
        .query::<(&MaterializedSequence, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .filter(|(sequence, marker)| sequence.identifiers().uid == sequence_uid && marker.is_some())
        .count();

    assert_eq!(
        released_sequences, 1,
        "expected stop to release the running sequence even after target changed"
    );
}

/// Verifies render autostart preserves caller-supplied lookahead options.
#[test]
fn render_clip_at_autostart_preserves_lookahead_options() {
    let mut app = setup_app();

    let clip_id = 256;
    let sequence_uid = Uuid::new_v4();
    let cue_uid_a = Uuid::new_v4();
    let cue_uid_b = Uuid::new_v4();

    app.world_mut().resource_mut::<DataProvider<Cue>>().extend([
        Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_uid_a,
                label: "cue-a".to_owned(),
            },
            ..Default::default()
        },
        Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_uid_b,
                label: "cue-b".to_owned(),
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
                label: "test sequence".to_string(),
            },
            steps: [cue_uid_a, cue_uid_b].into_iter().map(Into::into).collect(),
            wrap: false,
            release_on_start: false,
            setup_cue: Cue::default(),
            release_cue: Cue::default(),
            default_timing: Transition::default(),
            tracking_mode: Default::default(),
        })
        .expect("failed to add test sequence");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: clip_id,
            uid: Uuid::new_v4(),
            label: "render-autostart".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::RenderClipAt {
            clip_id: IdExpr::Single(clip_id),
            position: 2,
            timing: PlaybackReconstructionTiming {
                started_at: Duration::from_millis(250),
                position: Duration::from_millis(900),
                source: PlaybackPositionSource::ExternalPosition,
            },
            instance_options: Some(InstanceOptions {
                lookahead_enabled: Some(true),
            }),
        }));

    app.update();

    let instance_options = app
        .world_mut()
        .query::<&InstanceOptions>()
        .single(app.world())
        .expect("render autostart should spawn one instance options component");
    assert_eq!(
        instance_options.lookahead_enabled,
        Some(true),
        "render autostart should preserve caller-supplied Lookahead options"
    );
}
