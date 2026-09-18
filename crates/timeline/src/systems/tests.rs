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
use bevy_ecs::message::Messages;
use bevy_ecs::prelude::Entity;
use bevy_ecs::schedule::{ApplyDeferred, IntoScheduleConfigs};
use moonshine_kind::{Instance, InstanceMut};
use nightfall::prelude::*;
use nightfall_clips::{Clip, ClipAction, ClipOptions, MaterializedClip, Source};
use nightfall_compositor::prelude::{LayerCompositingContext, ObjectRefMarker, ReleaseMarker};
use nightfall_cues::materialized_cue::paint_materialized_cues;
use nightfall_cues::materialized_sequence::paint_materialized_sequences;
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueInstruction, CueLifecycleAction, CueTriggerType, MaterializedCue,
    MaterializedSequence, PlaybackReleaseTiming, Sequence, SequencePlaybackAction,
};
use nightfall_desk::instances::{ClipReleaseAfterInstance, InstanceIndex};
use nightfall_desk::prelude::{DeskAction, DeskCommand, GlobalVariables};
use nightfall_dmx::prelude::{Attribute, DmxValueResolution, ParameterValue};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandError, CommandIngressRouter, CommandNotice, CommandReply,
    CommandResult, CommandTracker, DataProvider, EngineActionEnvelope, EngineActionRouter,
    FinishedCommand, OperationResult, PendingCommandBuffer, PendingEngineActionBuffer,
    register_engine_action,
};
use nightfall_fixtures::prelude::{
    Fixture, FixtureDataProviderExt, FixtureElement, MergeStrategy, Parameter, ParameterMetadata,
    ParameterValues,
};
use nightfall_flow::prelude::{FlowDefinition, FlowInstance, FlowNodeRegistry};
use nightfall_fx::prelude::{ActiveStepFx, Fx, MaterializedFx, StepFx};
use nightfall_fx_module::instances::ActiveFxModuleLayer;
use nightfall_fx_module::prelude::{ActiveFxModuleIds, ActiveFxModuleTimings, StoredFxModule};
use nightfall_instances::{
    InstanceClock, InstanceClockSource, InstanceControls, InstanceDisplayKind, InstanceId,
    InstanceKind, InstanceMetadata, InstanceOptions, InstancePosition, InstanceStatus,
};
use nightfall_lookahead::LookaheadAssertions;
use nightfall_playback_planner::{
    EvaluatedInstanceState, PlannedPlaybackIntervention, PlannedPlaybackInterventionKind,
    PlannedPlaybackLifecycle, PlannedPlaybackSource, PlaybackPositionSource, TimelinePlaybackOwner,
};
use nightfall_timecode::prelude::{TimecodeCommand, TimecodeEvent, TimecodeGenerator};
use nightfall_undo::prelude::{UndoManager, UndoRegistry};
use uuid::Uuid;

use super::lookahead::{MaterializedLookaheadProvider, TimelineLookahead, TimelineLookaheadLayer};
use super::{
    PendingStoppedTimelineReleaseClocks, TimelinePausedPlaybackRates, cleanup_timeline_entities,
    detach_stopped_timeline_release_clocks, handle_timeline_seek_system,
    intervention_reconstruction_timing_from_evaluated_instance,
    populate_materialized_lookahead_assertions_system, process_actions_system,
    process_parameters_system, reconstruction_timing_from_evaluated_instance,
    record_stopped_timeline_release_clocks, release_reconstruction_timing_from_evaluated_instance,
    stop_timeline_owned_clips, sync_timeline_paused_instance_controls_system,
    update_timeline_lookahead_layers_system, update_timeline_lookahead_sources_system,
};
use crate::components::{MaterializedTimeline, SpawnedEntityType};
use crate::prelude::{
    Action, ActionKind, AutomationLane, AutomationPoint, ParameterType, Timeline,
    TimelineLookaheadActionStatusKind, TimelineLookaheadActionStatuses, TimelineSeekBehavior,
    Track,
};
use crate::recording::TimelineCommandOrigins;
use crate::{TimelineAction, TimelineCommand};
use crate::{TimelineLookaheadMode, TimelineStopBehavior};

fn spawn_timecode(app: &mut App, timecode_id: u32, current_time: Duration) -> Uuid {
    let mut timecode = TimecodeGenerator::default();
    timecode.timecode.identifiers.id = timecode_id;
    timecode.state.timecode_id = timecode_id;
    timecode.state.current_time = current_time;
    let timecode_uid = timecode.timecode.identifiers.uid;
    app.world_mut().spawn(timecode);
    timecode_uid
}

/// Wraps a timecode command with detached lifecycle context for system tests.
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

/// Wraps a timecode command for tests that exercise the owning domain handler.
fn timecode_ingress(command: TimecodeCommand) -> CommandEnvelope<TimecodeCommand> {
    CommandEnvelope::new(
        command,
        nightfall_engine::prelude::CommandOrigin::Cli,
        nightfall_engine::prelude::ReplyTarget::Detached,
    )
}

fn matches_timed_start(
    action: &ClipAction,
    expected_clip_id: u32,
    expected_started_at_timeline: Duration,
    expected_evaluated_at_timeline: Duration,
) -> bool {
    matches!(
        action,
        ClipAction::StartAtTiming {
            clip_id: IdExpr::Single(id),
            timing,
            ..
        } if *id == expected_clip_id
            && timing.started_at == Duration::ZERO
            && timing.position == expected_evaluated_at_timeline
                .saturating_sub(expected_started_at_timeline)
            && matches!(
                timing.source,
                PlaybackPositionSource::Timeline { started_at_timeline, .. }
                    if started_at_timeline == expected_started_at_timeline
            )
    )
}

/// Verifies command-adapter timing stores source-local positions with timeline provenance.
#[test]
fn evaluated_instance_reconstruction_timing_uses_source_local_timeline_positions() {
    let timeline_uid = Uuid::new_v4();
    let instance = EvaluatedInstanceState {
        owner: TimelinePlaybackOwner {
            timeline_uid,
            track_id: "track".to_owned(),
            action_id: "action".to_owned(),
        },
        source: PlannedPlaybackSource::Sequence(Uuid::new_v4()),
        instance_clock_position: Duration::from_millis(1500),
        started_at_timeline: Duration::from_secs(1),
        released_at_timeline: None,
        release_snapshot_position: None,
        lifecycle: PlannedPlaybackLifecycle::Active,
    };

    let timing = reconstruction_timing_from_evaluated_instance(&instance, timeline_uid);

    assert_eq!(timing.started_at, Duration::ZERO);
    assert_eq!(timing.position, Duration::from_millis(1500));
    assert_eq!(timing.elapsed(), Duration::from_millis(1500));
    assert_eq!(
        timing.source,
        PlaybackPositionSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );
}

/// Verifies release command-adapter timing uses source-local release anchors.
#[test]
fn evaluated_release_reconstruction_timing_uses_source_local_release_anchor() {
    let timeline_uid = Uuid::new_v4();
    let instance = EvaluatedInstanceState {
        owner: TimelinePlaybackOwner {
            timeline_uid,
            track_id: "track".to_owned(),
            action_id: "action".to_owned(),
        },
        source: PlannedPlaybackSource::Sequence(Uuid::new_v4()),
        instance_clock_position: Duration::from_millis(1500),
        started_at_timeline: Duration::from_secs(1),
        released_at_timeline: Some(Duration::from_secs(2)),
        release_snapshot_position: Some(Duration::from_secs(1)),
        lifecycle: PlannedPlaybackLifecycle::Releasing,
    };

    let timing = release_reconstruction_timing_from_evaluated_instance(&instance, timeline_uid)
        .expect("release snapshot should produce timing");

    assert_eq!(timing.started_at, Duration::from_secs(1));
    assert_eq!(timing.position, Duration::from_millis(1500));
    assert_eq!(timing.elapsed(), Duration::from_millis(500));
    assert_eq!(
        timing.source,
        PlaybackPositionSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        }
    );
}

/// Verifies intervention command-adapter timing uses source-local intervention anchors.
#[test]
fn evaluated_intervention_reconstruction_timing_uses_source_local_intervention_anchor() {
    let timeline_uid = Uuid::new_v4();
    let owner = TimelinePlaybackOwner {
        timeline_uid,
        track_id: "track".to_owned(),
        action_id: "start".to_owned(),
    };
    let instance = EvaluatedInstanceState {
        owner: owner.clone(),
        source: PlannedPlaybackSource::Sequence(Uuid::new_v4()),
        instance_clock_position: Duration::from_millis(2500),
        started_at_timeline: Duration::from_millis(500),
        released_at_timeline: None,
        release_snapshot_position: None,
        lifecycle: PlannedPlaybackLifecycle::Active,
    };
    let intervention = PlannedPlaybackIntervention {
        owner: TimelinePlaybackOwner {
            timeline_uid,
            track_id: "track".to_owned(),
            action_id: "jump".to_owned(),
        },
        timeline_position: Duration::from_millis(1500),
        playback_position: Duration::from_secs(1),
        kind: PlannedPlaybackInterventionKind::SequenceGotoCue(2),
    };

    let timing = intervention_reconstruction_timing_from_evaluated_instance(
        &instance,
        &intervention,
        timeline_uid,
    );

    assert_eq!(timing.started_at, Duration::from_secs(1));
    assert_eq!(timing.position, Duration::from_millis(2500));
    assert_eq!(timing.elapsed(), Duration::from_millis(1500));
    assert_eq!(
        timing.source,
        PlaybackPositionSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(500),
        }
    );
}

/// Verifies stopped timeline release tails continue after their timecode source halts.
#[test]
fn stop_timecode_detaches_releasing_timeline_instance_clock() {
    let mut app = App::new();
    app.add_message::<TimecodeEvent>();
    app.add_message::<CommandEnvelope<TimecodeCommand>>();
    app.add_message::<CommandEnvelope<TimelineCommand>>();
    app.add_message::<EngineActionEnvelope<TimelineAction>>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.init_resource::<PendingStoppedTimelineReleaseClocks>();
    app.add_systems(
        Update,
        (
            record_stopped_timeline_release_clocks,
            detach_stopped_timeline_release_clocks,
            sync_timeline_paused_instance_controls_system,
        )
            .chain(),
    );

    let timecode_id = 91;
    let timeline_uid = Uuid::new_v4();
    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::from_secs(4));
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: timeline_uid,
            label: "stopped-release-clock".to_owned(),
        },
        timecode_uid,
        ..Default::default()
    }));

    let mut clock = InstanceClock {
        source: InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1),
        },
        ..Default::default()
    };
    clock.seek_to(Duration::from_secs(3));
    clock.set_rate(0.0);
    let playback_entity = app
        .world_mut()
        .spawn((
            InstanceId::new(),
            InstanceMetadata::new(InstanceKind::Sequence),
            InstanceControls {
                rate: 0.0,
                ..Default::default()
            },
            ReleaseMarker::default(),
            PlaybackReleaseTiming {
                released_at: Duration::from_secs(2),
            },
            clock,
        ))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::StopTimecode(timecode_id)));

    app.update();

    let playback_ref = app.world().entity(playback_entity);
    let clock = playback_ref
        .get::<InstanceClock>()
        .expect("instance should keep a release clock");
    assert_eq!(clock.source, InstanceClockSource::Realtime);
    assert!(!clock.frozen, "release clock should continue after stop");
    assert_eq!(clock.rate, 1.0);
    let controls = playback_ref
        .get::<InstanceControls>()
        .expect("instance controls should remain present");
    assert_eq!(controls.rate, 1.0);
}

/// Verifies paused timeline release tails stay attached without a stop command.
#[test]
fn paused_timecode_keeps_releasing_timeline_instance_clock_attached() {
    let mut app = App::new();
    app.add_message::<TimecodeEvent>();
    app.add_message::<CommandEnvelope<TimelineCommand>>();
    app.add_message::<EngineActionEnvelope<TimelineAction>>();
    app.init_resource::<PendingStoppedTimelineReleaseClocks>();
    app.add_systems(
        Update,
        (
            record_stopped_timeline_release_clocks,
            detach_stopped_timeline_release_clocks,
        )
            .chain(),
    );

    let timecode_id = 92;
    let timeline_uid = Uuid::new_v4();
    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::from_secs(4));
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: timeline_uid,
            label: "paused-release-clock".to_owned(),
        },
        timecode_uid,
        ..Default::default()
    }));

    let playback_entity = app
        .world_mut()
        .spawn((
            InstanceId::new(),
            InstanceMetadata::new(InstanceKind::Sequence),
            ReleaseMarker::default(),
            InstanceClock {
                source: InstanceClockSource::Timeline {
                    timeline_uid,
                    started_at_timeline: Duration::from_secs(1),
                },
                ..Default::default()
            },
        ))
        .id();

    app.update();

    let playback_ref = app.world().entity(playback_entity);
    let clock = playback_ref
        .get::<InstanceClock>()
        .expect("instance should keep a release clock");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
}

/// Verifies KeepState timeline stops do not detach release clocks.
#[test]
fn keep_state_stop_keeps_releasing_timeline_instance_clock_attached() {
    let mut app = App::new();
    app.add_message::<TimecodeEvent>();
    app.add_message::<CommandEnvelope<TimelineCommand>>();
    app.add_message::<EngineActionEnvelope<TimelineAction>>();
    app.init_resource::<PendingStoppedTimelineReleaseClocks>();
    app.add_systems(
        Update,
        (
            record_stopped_timeline_release_clocks,
            detach_stopped_timeline_release_clocks,
        )
            .chain(),
    );

    let timecode_id = 93;
    let timeline_uid = Uuid::new_v4();
    let timecode_uid = spawn_timecode(&mut app, timecode_id, Duration::from_secs(4));
    app.world_mut().spawn(MaterializedTimeline::new(Timeline {
        identifiers: Identifiers {
            id: timecode_id,
            uid: timeline_uid,
            label: "keep-state-release-clock".to_owned(),
        },
        timecode_uid,
        stop_behavior: TimelineStopBehavior::KeepState,
        ..Default::default()
    }));

    let playback_entity = app
        .world_mut()
        .spawn((
            InstanceId::new(),
            InstanceMetadata::new(InstanceKind::Sequence),
            ReleaseMarker::default(),
            InstanceClock {
                source: InstanceClockSource::Timeline {
                    timeline_uid,
                    started_at_timeline: Duration::from_secs(1),
                },
                ..Default::default()
            },
        ))
        .id();

    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::StopTimecode(timecode_id)));
    app.update();

    let playback_ref = app.world().entity(playback_entity);
    let clock = playback_ref
        .get::<InstanceClock>()
        .expect("instance should keep a release clock");
    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_secs(1)
        }
    );
}

/// Builds a cue with one resolved intensity assertion and a finite release fade.
fn cue_with_release_duration(app: &mut App, cue_uid: Uuid, release_duration: Duration) -> Cue {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameter_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: parameter_metadata.clone(),
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
                parameters: vec![parameter_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);

    Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "cue-with-release".to_owned(),
        },
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(release_duration)),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

fn setup_sequence_timeline_app(seek_mode: bool) -> (App, Instance<Parameter>, u32) {
    setup_sequence_timeline_app_with_stop(seek_mode, None)
}

/// Builds a timeline app with one start-clip action driving a two-cue sequence.
fn setup_sequence_timeline_app_with_stop(
    seek_mode: bool,
    stop_position: Option<Duration>,
) -> (App, Instance<Parameter>, u32) {
    setup_sequence_timeline_app_with_clip_options(
        seek_mode,
        stop_position,
        Duration::ZERO,
        ClipOptions::default(),
    )
}

/// Builds a timeline test app with the sequence instance systems needed for seek or live mode.
fn setup_sequence_timeline_test_app(seek_mode: bool) -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.add_message::<EngineActionEnvelope<DeskAction>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<TimecodeEvent>();
    app.add_message::<CommandEnvelope<TimecodeCommand>>();
    app.add_message::<CommandEnvelope<TimelineCommand>>();
    app.add_message::<EngineActionEnvelope<TimelineAction>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_message::<OperationResult<(), CommandError>>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<CommandIngressRouter>();
    app.init_resource::<EngineActionRouter>();
    register_engine_action::<SequencePlaybackAction>(&mut app);
    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<InstanceIndex>();
    app.init_resource::<UndoManager>();
    app.init_resource::<UndoRegistry>();
    app.init_resource::<TimelineCommandOrigins>();
    app.init_resource::<TimelinePausedPlaybackRates>();
    app.init_resource::<PendingStoppedTimelineReleaseClocks>();
    app.init_resource::<TimelineLookaheadActionStatuses>();
    app.init_resource::<nightfall_compositor::prelude::FinalLayerOutput>();
    app.init_resource::<PendingCommandBuffer>();
    app.init_resource::<PendingEngineActionBuffer>();
    if seek_mode {
        app.add_systems(
            Update,
            (
                handle_timeline_seek_system,
                ApplyDeferred,
                update_timeline_lookahead_sources_system,
                ApplyDeferred,
                populate_materialized_lookahead_assertions_system,
                ApplyDeferred,
                update_timeline_lookahead_layers_system,
                nightfall_cues::events::handle_events,
                nightfall_desk::instances::add_instances_to_index,
                nightfall_undo::dispatcher::process_pending_commands,
                ApplyDeferred,
                nightfall_cues::events::handle_sequence_playback_actions,
                nightfall_cues::materialized_sequence::release_materialized_sequences,
                sync_timeline_paused_instance_controls_system,
                nightfall_cues::materialized_sequence::advance_sequences,
                ApplyDeferred,
                nightfall_cues::materialized_sequence::release_materialized_sequences,
                nightfall_cues::materialized_sequence::paint_materialized_sequences,
                nightfall_cues::materialized_sequence::sync_sequence_playback_runtime_status,
            )
                .chain(),
        );
    } else {
        app.add_systems(
            Update,
            (
                (
                    nightfall_timecode::events::handle_events,
                    crate::timeline_events::handle_timecode_events,
                    crate::timeline_events::handle_timeline_events,
                    record_stopped_timeline_release_clocks,
                    stop_timeline_owned_clips,
                    update_timeline_lookahead_sources_system,
                    ApplyDeferred,
                    populate_materialized_lookahead_assertions_system,
                    ApplyDeferred,
                    update_timeline_lookahead_layers_system,
                    process_actions_system,
                    nightfall_cues::events::handle_events,
                    cleanup_timeline_entities,
                    nightfall_desk::instances::add_instances_to_index,
                    nightfall_undo::dispatcher::process_pending_commands,
                    ApplyDeferred,
                )
                    .chain(),
                (
                    nightfall_cues::events::handle_sequence_playback_actions,
                    nightfall_cues::materialized_sequence::release_materialized_sequences,
                    nightfall_cues::materialized_sequence::despawn_materialized_sequences,
                    ApplyDeferred,
                    detach_stopped_timeline_release_clocks,
                    sync_timeline_paused_instance_controls_system,
                    nightfall_cues::materialized_sequence::advance_sequences,
                    ApplyDeferred,
                    nightfall_cues::materialized_sequence::release_materialized_sequences,
                    nightfall_cues::materialized_sequence::paint_materialized_sequences,
                    nightfall_cues::materialized_sequence::sync_sequence_playback_runtime_status,
                )
                    .chain(),
            )
                .chain(),
        );
    }
    app
}

/// Builds a sequence timeline app with configurable clip lifecycle behavior.
fn setup_sequence_timeline_app_with_clip_options(
    seek_mode: bool,
    stop_position: Option<Duration>,
    start_duration: Duration,
    clip_options: ClipOptions,
) -> (App, Instance<Parameter>, u32) {
    let mut app = setup_sequence_timeline_test_app(seek_mode);

    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameter_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: parameter_metadata.clone(),
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
                parameters: vec![parameter_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);
    drop(fixtures);

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
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            })
            .expect("test cue should be stored");
    }

    let timeline_id = 314;
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
            release_cue: Cue {
                identifiers: Identifiers {
                    id: 99,
                    uid: Uuid::new_v4(),
                    label: "release".to_owned(),
                },
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref.clone(),
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
            ..Default::default()
        })
        .expect("test sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: clip_uid,
            label: "clip-31".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        options: clip_options,
        ..Default::default()
    });

    let mut actions = vec![Action {
        id: "action-start".to_owned(),
        label: "Start sequence".to_owned(),
        position: Duration::from_millis(100),
        duration: start_duration,
        action: ActionKind::StartClip(clip_uid),
    }];
    if let Some(stop_position) = stop_position {
        actions.push(Action {
            id: "action-stop".to_owned(),
            label: "Stop sequence".to_owned(),
            position: stop_position,
            duration: Duration::ZERO,
            action: ActionKind::StopClip(clip_uid),
        });
    }

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "sequence-timeline".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    if !seek_mode {
        materialized.activate();
    }
    app.world_mut().spawn(materialized);

    (app, parameter, timeline_id)
}

/// Enables lookahead on the helper target cue created by `setup_sequence_timeline_app`.
fn enable_helper_target_cue_lookahead(app: &mut App) {
    let sequence = app
        .world()
        .resource::<DataProvider<Sequence>>()
        .from_id(1)
        .expect("helper sequence should exist")
        .clone();
    let target_cue_uid = sequence
        .steps
        .get(1)
        .expect("helper sequence should have a target cue");
    let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
    let mut cue = cue_provider
        .get(target_cue_uid.0)
        .expect("helper target cue should exist")
        .clone();
    cue_provider
        .remove(&cue.identifiers.uid)
        .expect("helper target cue should be removable");
    cue.lookahead = Some(true);
    cue_provider
        .add(cue)
        .expect("helper target cue should be re-added");
}

/// Sets the lookahead mode on the helper timeline created by `setup_sequence_timeline_app`.
fn set_helper_timeline_lookahead(app: &mut App, mode: TimelineLookaheadMode) {
    let mut timeline_query = app.world_mut().query::<&mut MaterializedTimeline>();
    let mut timeline = timeline_query
        .single_mut(app.world_mut())
        .expect("helper timeline should exist");
    timeline.timeline.lookahead = mode;
}

/// Returns the instance options on the single materialized sequence in the app.
fn single_sequence_instance_options(app: &mut App) -> InstanceOptions {
    let mut instance_options_query = app.world_mut().query::<&InstanceOptions>();
    *instance_options_query
        .single(app.world())
        .expect("one sequence instance should expose instance options")
}

/// Builds RGB fixture parameters and registers them with the fixture data provider.
fn add_rgb_fixture_parameters(
    app: &mut App,
    fixture_id: u32,
) -> (FixtureRef, Vec<Instance<Parameter>>) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameter_metadata =
        [Attribute::Red, Attribute::Green, Attribute::Blue].map(|attribute| ParameterMetadata {
            attribute,
            ..Default::default()
        });
    let parameters = parameter_metadata
        .iter()
        .map(|metadata| unsafe {
            Instance::<Parameter>::from_entity_unchecked(
                app.world_mut()
                    .spawn(Parameter {
                        metadata: metadata.clone(),
                        values: ParameterValues::default(),
                    })
                    .id(),
            )
        })
        .collect::<Vec<_>>();
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: fixture_id,
                uid: fixture_uid,
                label: format!("fixture-{fixture_id}"),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: parameter_metadata.to_vec(),
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    for (attribute, parameter) in [Attribute::Red, Attribute::Green, Attribute::Blue]
        .into_iter()
        .zip(parameters.iter().copied())
    {
        fixtures.add_parameter(fixture_ref.clone(), attribute, parameter);
    }
    (fixture_ref, parameters)
}

/// Builds a fixture parameter and registers it with the fixture data provider.
fn add_intensity_fixture_parameter(
    app: &mut App,
    fixture_id: u32,
) -> (FixtureRef, Instance<Parameter>) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameter_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: parameter_metadata.clone(),
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
                id: fixture_id,
                uid: fixture_uid,
                label: format!("fixture-{fixture_id}"),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![parameter_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);
    (fixture_ref, parameter)
}

/// Builds an HTP intensity and LTP red fixture element for release-order tests.
fn add_intensity_red_fixture_parameters(
    app: &mut App,
    fixture_id: u32,
) -> (FixtureRef, Instance<Parameter>, Instance<Parameter>) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        resolution: DmxValueResolution::Coarse,
        merge_type: MergeStrategy::HTP,
        ..Default::default()
    };
    let red_metadata = ParameterMetadata {
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        resolution: DmxValueResolution::Coarse,
        merge_type: MergeStrategy::LTP,
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
    let red_parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: red_metadata.clone(),
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
                id: fixture_id,
                uid: fixture_uid,
                label: format!("fixture-{fixture_id}"),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![intensity_metadata, red_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(
        fixture_ref.clone(),
        Attribute::Intensity,
        intensity_parameter,
    );
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Red, red_parameter);
    (fixture_ref, intensity_parameter, red_parameter)
}

/// Builds a timeline app with a four-cue auto-progressing sequence.
fn setup_four_cue_auto_sequence_timeline_app(
    seek_mode: bool,
    stop_position: Option<Duration>,
) -> (App, Vec<Instance<Parameter>>, u32) {
    let mut app = setup_sequence_timeline_test_app(seek_mode);

    let mut fixture_refs = Vec::new();
    let mut parameters = Vec::new();
    for fixture_id in 1..=4 {
        let (fixture_ref, parameter) = add_intensity_fixture_parameter(&mut app, fixture_id);
        fixture_refs.push(fixture_ref);
        parameters.push(parameter);
    }

    let mut cue_uids = Vec::new();
    for (index, fixture_ref) in fixture_refs.iter().enumerate() {
        let cue_uid = Uuid::new_v4();
        cue_uids.push(cue_uid);
        app.world_mut()
            .resource_mut::<DataProvider<Cue>>()
            .add(Cue {
                identifiers: Identifiers {
                    id: (index + 1) as u32,
                    uid: cue_uid,
                    label: format!("cue-{}", index + 1),
                },
                trigger: if index == 0 {
                    CueTriggerType::Manual
                } else {
                    CueTriggerType::AfterDelay(Duration::from_secs(2))
                },
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                    fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                        fixture_ref.clone(),
                    ])),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            })
            .expect("test cue should be stored");
    }

    let release_instructions = fixture_refs
        .iter()
        .map(|fixture_ref| BoundCueInstruction {
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                fixture_ref.clone(),
            ])),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                ..Default::default()
            },
        })
        .collect();

    let timeline_id = 315;
    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 2,
                uid: sequence_uid,
                label: "four-cue-sequence".to_owned(),
            },
            steps: cue_uids.into_iter().map(Into::into).collect(),
            release_cue: Cue {
                identifiers: Identifiers {
                    id: 99,
                    uid: Uuid::new_v4(),
                    label: "release".to_owned(),
                },
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                instructions: release_instructions,
                ..Default::default()
            },
            ..Default::default()
        })
        .expect("test sequence should be stored");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 32,
            uid: clip_uid,
            label: "clip-32".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });

    let mut actions = vec![Action {
        id: "action-start".to_owned(),
        label: "Start sequence".to_owned(),
        position: Duration::from_millis(100),
        duration: Duration::ZERO,
        action: ActionKind::StartClip(clip_uid),
    }];
    if let Some(stop_position) = stop_position {
        actions.push(Action {
            id: "action-stop".to_owned(),
            label: "Stop sequence".to_owned(),
            position: stop_position,
            duration: Duration::ZERO,
            action: ActionKind::StopClip(clip_uid),
        });
    }

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "four-cue-sequence-timeline".to_owned(),
        },
        timecode_uid: spawn_timecode(&mut app, timeline_id, Duration::ZERO),
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
    };
    let mut materialized = MaterializedTimeline::new(timeline);
    if !seek_mode {
        materialized.activate();
    }
    app.world_mut().spawn(materialized);

    (app, parameters, timeline_id)
}

/// Assigns the only test timecode's current time and active state.
fn set_single_timecode(app: &mut App, current_time: Duration, is_active: bool) {
    let mut timecode_query = app.world_mut().query::<&mut TimecodeGenerator>();
    let mut timecode = timecode_query
        .single_mut(app.world_mut())
        .expect("test app should contain one timecode");
    timecode.state.current_time = current_time;
    timecode.state.is_active = is_active;
}

/// Returns the active sequence position, instance position, and evaluated intensity.
fn sequence_runtime_snapshot(
    app: &mut App,
    parameter: Instance<Parameter>,
) -> (u32, Duration, f32, InstanceStatus) {
    let (position, playback_position, mut layer, compositing_context, status, is_releasing) = {
        let mut sequence_query = app.world_mut().query::<(
            &MaterializedSequence,
            &InstanceClock,
            &nightfall_compositor::prelude::Layer,
            &nightfall_compositor::prelude::LayerCompositingContext,
            &InstanceStatus,
            Option<&ReleaseMarker>,
        )>();
        let (sequence, clock, layer, compositing_context, status, release_marker) = sequence_query
            .single(app.world())
            .expect("test app should contain one materialized sequence");
        (
            sequence.position(),
            clock.position,
            layer.clone(),
            *compositing_context,
            status.clone(),
            release_marker.is_some(),
        )
    };
    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let param_query = param_query_state.query_mut(app.world_mut());
    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        is_releasing,
        compositing_context,
    );
    let value = *computed
        .absolute
        .get(&parameter)
        .expect("sequence output should include the test parameter");
    (position, playback_position, value, status)
}

/// Returns the active sequence position, instance position, and evaluated intensities.
fn sequence_runtime_values_snapshot(
    app: &mut App,
    parameters: &[Instance<Parameter>],
) -> (u32, Duration, Vec<f32>, InstanceStatus) {
    let (position, playback_position, mut layer, compositing_context, status, is_releasing) = {
        let mut sequence_query = app.world_mut().query::<(
            &MaterializedSequence,
            &InstanceClock,
            &nightfall_compositor::prelude::Layer,
            &nightfall_compositor::prelude::LayerCompositingContext,
            &InstanceStatus,
            Option<&ReleaseMarker>,
        )>();
        let (sequence, clock, layer, compositing_context, status, release_marker) = sequence_query
            .single(app.world())
            .expect("test app should contain one materialized sequence");
        (
            sequence.position(),
            clock.position,
            layer.clone(),
            *compositing_context,
            status.clone(),
            release_marker.is_some(),
        )
    };
    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let param_query = param_query_state.query_mut(app.world_mut());
    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        is_releasing,
        compositing_context,
    );
    let values = parameters
        .iter()
        .map(|parameter| {
            computed
                .absolute
                .get(parameter)
                .copied()
                .unwrap_or_default()
        })
        .collect();
    (position, playback_position, values, status)
}

/// Verifies inspectable sequence runtime status matches the materialized sequence snapshot.
fn assert_sequence_runtime_status(
    status: &InstanceStatus,
    expected_position: u32,
    expected_cue_count: u32,
    context: &str,
) {
    let InstancePosition::Sequence {
        current_position,
        cue_count,
        next_position,
        ..
    } = &status.position
    else {
        panic!("{context}: expected sequence runtime status, got {status:?}");
    };

    assert_eq!(
        *current_position, expected_position,
        "{context}: runtime status current position"
    );
    assert_eq!(
        *cue_count, expected_cue_count,
        "{context}: runtime status cue count"
    );
    if let Some(next_position) = next_position {
        assert!(
            (1..=expected_cue_count).contains(next_position),
            "{context}: runtime status next position should target a valid cue"
        );
    }
    assert!(
        status.source_activation_epoch_ms.is_some(),
        "{context}: runtime status should preserve UI activation epoch metadata"
    );
}

/// Seeks the test timeline app and runs enough frames for materialization and paint.
fn seek_sequence_timeline(app: &mut App, timeline_id: u32, position: Duration) {
    set_single_timecode(app, position, true);
    app.world_mut()
        .write_message(timecode_command(TimecodeCommand::SeekTimecode {
            id: timeline_id,
            position,
        }));
    app.update();
    app.update();
}

/// Returns how many materialized sequences currently exist in the test app.
fn materialized_sequence_count(app: &mut App) -> usize {
    app.world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count()
}

/// Advances a live four-cue test app through sequence milestones up to a target position.
fn drive_four_cue_live_timeline_to(app: &mut App, target_timeline_position: Duration) {
    let mut positions = vec![
        Duration::from_millis(100),
        Duration::from_millis(700),
        Duration::from_millis(1100),
        Duration::from_millis(2200),
        Duration::from_millis(4100),
        Duration::from_millis(6100),
        Duration::from_millis(7601),
        target_timeline_position,
    ];
    positions.sort_unstable();
    positions.dedup();

    for position in positions {
        if position > target_timeline_position {
            continue;
        }
        set_single_timecode(app, position, true);
        app.update();
        app.update();
    }
}

/// Asserts each evaluated output value is within a small DMX-style tolerance.
fn assert_values_close(actual: &[f32], expected: &[f32], context: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{context}: value count should match"
    );
    for (index, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
        assert!(
            (*actual - *expected).abs() <= 2.0,
            "{context}: value {index} expected {expected}, got {actual}"
        );
    }
}

mod live_actions;
mod seek_controls;
mod seek_fire_cue;
mod seek_materializers;
mod seek_navigation;
mod sequence_scenarios;
