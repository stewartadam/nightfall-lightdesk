// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_app::prelude::*;
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::*;
use nightfall_clips::{Clip, ClipAction, MaterializedClip, Source};
use nightfall_compositor::prelude::{Layer, ReleaseMarker};
use nightfall_desk::instances::{
    add_instances_to_index, remove_instances_from_index, sync_active_state_on_instance_despawn,
};
use nightfall_desk::prelude::InstanceIndex;
use nightfall_desk::systems::event_handlers::instance_events::handle_playback_commands;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandNotice, CommandOrigin, CommandReply, CommandResult, CommandTracker,
    DataProvider, EngineActionEnvelope, EventEnvelope, FinishedCommand, ReplyTarget,
};
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_fx::events::{StepFxCommandResult, handle_events, handle_preview_commands};
use nightfall_fx::prelude::{
    ActiveStepFx, CurveType, Fx, FxDirection, FxLane, FxPreviewUpdate, FxStep, FxTrack,
    MaterializedFx, PreviewMaterializedFx, Snap, StepFx, StepFxCommand, StepFxPhase, StepFxTiming,
};
use nightfall_instances::{
    InstanceClock, InstanceClockSource, InstanceCommand, InstanceControls, InstanceDisplayKind,
    InstanceId, InstanceKind, InstanceMetadata, PlaybackAction, PlaybackReleaseAction,
};
use nightfall_playback_planner::PlaybackReconstructionTiming;
use uuid::Uuid;

/// Wraps a step FX command in detached semantic command context for focused handler tests.
fn step_fx_command(command: StepFxCommand) -> CommandEnvelope<StepFxCommand> {
    CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached)
}

/// Adds the lifecycle resources required by command responders in focused system tests.
fn add_command_lifecycle(app: &mut App) {
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
}

/// Adds fixture and group resources required by selection-aware FX command handlers.
fn add_selection_resources(app: &mut App) {
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<DataProvider<Group>>();
}

/// Builds a valid two-step intensity chase for runtime lifecycle tests.
fn minimal_step_fx(id: u32, uid: Uuid, label: &str, beat_duration: Duration) -> StepFx {
    StepFx {
        color_lane: None,
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_owned(),
        },
        selection: SelectionExpr::Resolved(vec![]).into(),
        timing: StepFxTiming { beat_duration },
        phase: StepFxPhase {
            waypoints: vec![0.0, 1.0],
            ..Default::default()
        },
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![FxLane {
            attribute: Attribute::Intensity,
            timing_override: None,
            phase_override: None,
            absolute: Some(FxTrack {
                steps: vec![
                    FxStep::new(
                        ParameterValue::AbsolutePercent { value: 1.0.into() },
                        1.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                    FxStep::new(
                        ParameterValue::AbsolutePercent { value: 0.0.into() },
                        1.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                ],
            }),
            relative: None,
        }],
    }
}

#[test]
fn duplicate_start_clip_in_same_tick_does_not_duplicate_fx_materialization() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 3,
                uid: fx_uid,
                label: "fx3".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 6,
            uid: Uuid::new_v4(),
            label: "exec-6".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(6),
        )));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(6),
        )));
    app.update();

    let mfx_count = app
        .world_mut()
        .query::<&MaterializedFx>()
        .iter(app.world())
        .filter(|mfx| mfx.identifiers().uid == fx_uid)
        .count();
    assert_eq!(
        mfx_count, 1,
        "expected exactly one materialized fx after duplicate start commands"
    );

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 6)
        .count();
    assert_eq!(
        mexec_count, 1,
        "expected exactly one materialized clip after duplicate start commands"
    );
    let clock = app
        .world_mut()
        .query::<&InstanceClock>()
        .single(app.world())
        .expect("ordinary FX start should attach one realtime playback clock");
    assert_eq!(clock.source, InstanceClockSource::Realtime);
}

/// Verifies same-target FX clips create separate materialized FX with their own priorities.
#[test]
fn fx_clips_with_same_target_keep_distinct_priorities() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 3,
                uid: fx_uid,
                label: "shared-fx".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    for (id, priority) in [(61, Priority(5)), (62, Priority(23))] {
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: format!("exec-{id}"),
            },
            source: Some(Source::Fx(fx_uid)),
            priority,
            ..Default::default()
        });
        app.world_mut()
            .write_message(EngineActionEnvelope::detached(ClipAction::Start(
                IdExpr::Single(id),
            )));
    }

    app.update();

    let mut priorities = app
        .world_mut()
        .query::<&MaterializedFx>()
        .iter(app.world())
        .filter(|mfx| mfx.identifiers().uid == fx_uid)
        .map(|mfx| mfx.priority)
        .collect::<Vec<_>>();
    priorities.sort_by_key(|priority| priority.0);
    assert_eq!(
        priorities,
        vec![Priority(5), Priority(23)],
        "same-target FX clips should materialize independent priorities"
    );

    let attached_instances = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|mexec| mexec.attached_instance)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        attached_instances.len(),
        2,
        "same-target FX clips should attach to distinct instances"
    );
}

/// Verifies that starting a clip without a target only logs and skips FX materialization.
#[test]
fn start_clip_without_target_does_not_panic_or_materialize_fx() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 9,
            uid: Uuid::new_v4(),
            label: "exec-9".to_owned(),
        },
        source: None,
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(9),
        )));

    app.update();

    let materialized_fx_count = app
        .world_mut()
        .query::<&MaterializedFx>()
        .iter(app.world())
        .count();
    assert_eq!(
        materialized_fx_count, 0,
        "expected no materialized fx for a clip without a target"
    );

    let materialized_clip_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .count();
    assert_eq!(
        materialized_clip_count, 0,
        "expected no materialized clip for a clip without a target"
    );
}

#[test]
fn stop_clip_releases_running_fx_after_target_changes_to_sequence() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 5,
                uid: fx_uid,
                label: "fx5".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 8,
            uid: Uuid::new_v4(),
            label: "exec-8".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(8),
        )));
    app.update();

    {
        let mut clips = app.world_mut().query::<&mut Clip>();
        let mut clip = clips
            .single_mut(app.world_mut())
            .expect("expected one clip");
        clip.source = Some(Source::Sequence(Uuid::new_v4()));
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Stop(
            IdExpr::Single(8),
        )));
    app.update();

    let released_fx = app
        .world_mut()
        .query::<(&MaterializedFx, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .filter(|(mfx, marker)| mfx.identifiers().uid == fx_uid && marker.is_some())
        .count();

    assert_eq!(
        released_fx, 1,
        "expected stop to release the running fx even after target changed"
    );
}

#[test]
fn stop_clip_ignores_non_fx_materialized_clip_bindings() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let instance_id = InstanceId::new();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 10,
            uid: Uuid::new_v4(),
            label: "sequence-exec-10".to_owned(),
        },
        source: Some(Source::Sequence(Uuid::new_v4())),
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 10,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Stop(
            IdExpr::Single(10),
        )));
    app.update();

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 10 && mexec.attached_instance == instance_id)
        .count();
    assert_eq!(
        mexec_count, 0,
        "desk clip routing should remove the binding while FX ignores non-FX playback release"
    );
}

#[test]
fn stop_and_restart_clip_in_same_tick_rebinds_fx_without_stale_entity_insert() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 6,
                uid: fx_uid,
                label: "fx6".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 9,
            uid: Uuid::new_v4(),
            label: "exec-9".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(9),
        )));
    app.update();

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Stop(
            IdExpr::Single(9),
        )));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(9),
        )));
    app.update();

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 9)
        .count();
    assert_eq!(
        mexec_count, 1,
        "expected stop/start in one tick to leave one live clip binding"
    );
}

/// Verifies retargeting a running StepFx clip to FX releases the old StepFx playback.
#[test]
fn retarget_running_step_fx_clip_to_fx_replaces_playback_binding() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<CommandEnvelope<InstanceCommand>>();
    add_command_lifecycle(&mut app);
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.init_resource::<InstanceIndex>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_playback_commands,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        100,
        step_fx_uid,
        "old-stepfx",
        Duration::from_secs(1),
    ));

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 101,
                uid: fx_uid,
                label: "new-fx".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 27,
            uid: Uuid::new_v4(),
            label: "exec-27".to_owned(),
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(27),
        )));
    app.update();

    let old_step_playback = app
        .world_mut()
        .query::<&InstanceId>()
        .single(app.world())
        .expect("step fx start should create one instance")
        .to_owned();

    {
        let mut clips = app.world_mut().query::<&mut Clip>();
        let mut clip = clips
            .single_mut(app.world_mut())
            .expect("expected one clip");
        clip.source = Some(Source::Fx(fx_uid));
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(27),
        )));
    app.update();

    let released_old_step_fx = app
        .world_mut()
        .query::<(&InstanceId, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .filter(|(instance_id, marker)| **instance_id == old_step_playback && marker.is_some())
        .count();
    assert_eq!(
        released_old_step_fx, 1,
        "expected retarget to release the old step fx playback"
    );

    let new_fx_playback = app
        .world_mut()
        .query::<(&MaterializedFx, &InstanceId, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .find_map(|(mfx, instance_id, marker)| {
            (mfx.identifiers().uid == fx_uid && marker.is_none()).then_some(*instance_id)
        })
        .expect("retarget should start an unreleased fx playback");

    let bindings = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 27)
        .map(|mexec| mexec.attached_instance)
        .collect::<Vec<_>>();
    assert_eq!(
        bindings,
        vec![new_fx_playback],
        "expected retarget to leave one binding attached to the new fx playback"
    );
}

/// Verifies starting a retargeted FX clip releases a prior non-FX playback binding.
#[test]
fn start_fx_clip_retargeted_from_existing_playback_replaces_binding() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 101,
                uid: fx_uid,
                label: "new-fx".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 29,
            uid: Uuid::new_v4(),
            label: "exec-29".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    let old_playback = InstanceId::new();
    app.world_mut().spawn((
        old_playback,
        InstanceMetadata::new(InstanceKind::Sequence).with_name("old-sequence"),
        InstanceControls::default(),
    ));
    app.world_mut().spawn(MaterializedClip {
        clip_id: 29,
        attached_instance: old_playback,
        auto_release_on_stop: false,
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(29),
        )));
    app.update();

    let released_old_playback = app
        .world_mut()
        .query::<(&InstanceId, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .filter(|(instance_id, marker)| **instance_id == old_playback && marker.is_some())
        .count();
    assert_eq!(
        released_old_playback, 1,
        "expected retarget to release the old instance"
    );

    let new_fx_playback = app
        .world_mut()
        .query::<(&MaterializedFx, &InstanceId, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .find_map(|(mfx, instance_id, marker)| {
            (mfx.identifiers().uid == fx_uid && marker.is_none()).then_some(*instance_id)
        })
        .expect("retarget should start an unreleased fx playback");

    let bindings = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 29)
        .map(|mexec| mexec.attached_instance)
        .collect::<Vec<_>>();
    assert_eq!(
        bindings,
        vec![new_fx_playback],
        "expected retarget to leave one binding attached to the new fx playback"
    );
}

/// Verifies retargeting a running FX clip to StepFx releases the old FX playback.
#[test]
fn retarget_running_fx_clip_to_step_fx_replaces_playback_binding() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 102,
                uid: fx_uid,
                label: "old-fx".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        103,
        step_fx_uid,
        "new-stepfx",
        Duration::from_secs(1),
    ));

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 28,
            uid: Uuid::new_v4(),
            label: "exec-28".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(28),
        )));
    app.update();

    let old_fx_playback = app
        .world_mut()
        .query::<&InstanceId>()
        .single(app.world())
        .expect("fx start should create one instance")
        .to_owned();

    {
        let mut clips = app.world_mut().query::<&mut Clip>();
        let mut clip = clips
            .single_mut(app.world_mut())
            .expect("expected one clip");
        clip.source = Some(Source::StepFx(step_fx_uid));
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(28),
        )));
    app.update();

    let released_old_fx = app
        .world_mut()
        .query::<(&InstanceId, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .filter(|(instance_id, marker)| **instance_id == old_fx_playback && marker.is_some())
        .count();
    assert_eq!(
        released_old_fx, 1,
        "expected retarget to release the old fx playback"
    );

    let new_step_playback = app
        .world_mut()
        .query::<(&ActiveStepFx, &InstanceId, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .find_map(|(_, instance_id, marker)| marker.is_none().then_some(*instance_id))
        .expect("retarget should start an unreleased step fx playback");

    let bindings = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 28)
        .map(|mexec| mexec.attached_instance)
        .collect::<Vec<_>>();
    assert_eq!(
        bindings,
        vec![new_step_playback],
        "expected retarget to leave one binding attached to the new step fx playback"
    );
}

#[test]
fn start_clip_for_step_fx_spawns_single_active_fx_and_binding() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        100,
        step_fx_uid,
        "stepfx-100",
        Duration::from_secs(1),
    ));

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 26,
            uid: Uuid::new_v4(),
            label: "exec-26".to_owned(),
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(26),
        )));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(26),
        )));
    app.update();

    let active_count = app
        .world_mut()
        .query::<(&ActiveStepFx, &InstanceId)>()
        .iter(app.world())
        .count();
    assert_eq!(
        active_count, 1,
        "expected exactly one active step fx after duplicate start commands"
    );

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 26)
        .count();
    assert_eq!(
        mexec_count, 1,
        "expected exactly one materialized clip after duplicate step fx start commands"
    );
}

/// Verifies same-target StepFX clips create separate active FX with their own priorities.
#[test]
fn step_fx_clips_with_same_target_keep_distinct_priorities() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        100,
        step_fx_uid,
        "shared-stepfx",
        Duration::from_secs(1),
    ));

    for (id, priority) in [(261, Priority(7)), (262, Priority(29))] {
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: format!("exec-{id}"),
            },
            source: Some(Source::StepFx(step_fx_uid)),
            priority,
            ..Default::default()
        });
        app.world_mut()
            .write_message(EngineActionEnvelope::detached(ClipAction::Start(
                IdExpr::Single(id),
            )));
    }

    app.update();

    let mut priorities = app
        .world_mut()
        .query::<&ActiveStepFx>()
        .iter(app.world())
        .map(|active_fx| active_fx.priority)
        .collect::<Vec<_>>();
    priorities.sort_by_key(|priority| priority.0);
    assert_eq!(
        priorities,
        vec![Priority(7), Priority(29)],
        "same-target StepFX clips should materialize independent priorities"
    );

    let attached_instances = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .map(|mexec| mexec.attached_instance)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        attached_instances.len(),
        2,
        "same-target StepFX clips should attach to distinct instances"
    );
}

/// Verifies timeline seek reconstruction seeds StepFx playback clock from reconstruction timing.
#[test]
fn timed_start_clip_for_step_fx_seeds_instance_clock() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        100,
        step_fx_uid,
        "stepfx-100",
        Duration::from_secs(2),
    ));

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 10,
            uid: Uuid::new_v4(),
            label: "exec-10".to_owned(),
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });

    let timeline_uid = Uuid::from_u128(0x3000);
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::StartAtTiming {
            clip_id: IdExpr::Single(10),
            timing: PlaybackReconstructionTiming::timeline(
                Duration::from_millis(250),
                Duration::from_millis(750),
                timeline_uid,
                Duration::from_millis(125),
            ),
            instance_options: None,
        }));
    app.update();

    app.world_mut()
        .query::<&ActiveStepFx>()
        .single(app.world())
        .expect("timed start should spawn one active StepFx");
    let clock = app
        .world_mut()
        .query::<&InstanceClock>()
        .single(app.world())
        .expect("timed start should seed one instance clock");

    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(125)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(500));
}

/// Verifies timeline seek reconstruction seeds StepFx stop state at the evaluated source position.
#[test]
fn timed_stop_clip_for_step_fx_seeds_release_instance_clock() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        101,
        step_fx_uid,
        "stepfx-101",
        Duration::from_secs(2),
    ));

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 11,
            uid: Uuid::new_v4(),
            label: "exec-11".to_owned(),
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(11),
        )));
    app.update();

    let timeline_uid = Uuid::from_u128(0x3002);
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::StopAtTiming {
            clip_id: IdExpr::Single(11),
            timing: PlaybackReconstructionTiming::timeline_source_local(
                Duration::from_millis(400),
                Duration::from_millis(900),
                timeline_uid,
                Duration::from_millis(125),
            ),
        }));
    app.update();

    let (_active_fx, _release_marker, clock) = app
        .world_mut()
        .query::<(&ActiveStepFx, &ReleaseMarker, &InstanceClock)>()
        .single(app.world())
        .expect("timed stop should leave one releasing StepFx with a playback clock");

    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(125)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(900));
}

/// Verifies timeline seek reconstruction seeds classic FX playback clock from reconstruction timing.
#[test]
fn timed_start_clip_for_fx_seeds_instance_clock() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 3,
                uid: fx_uid,
                label: "fx-3".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 10,
            uid: Uuid::new_v4(),
            label: "exec-10".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    let timeline_uid = Uuid::from_u128(0x3001);
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::StartAtTiming {
            clip_id: IdExpr::Single(10),
            timing: PlaybackReconstructionTiming::timeline(
                Duration::from_millis(250),
                Duration::from_millis(750),
                timeline_uid,
                Duration::from_millis(125),
            ),
            instance_options: None,
        }));
    app.update();

    app.world_mut()
        .query::<&MaterializedFx>()
        .single(app.world())
        .expect("timed start should spawn one materialized FX");
    let clock = app
        .world_mut()
        .query::<&InstanceClock>()
        .single(app.world())
        .expect("timed start should seed one instance clock");

    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(125)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(500));
}

/// Verifies timeline seek reconstruction seeds classic FX stop state at the evaluated source position.
#[test]
fn timed_stop_clip_for_fx_seeds_release_instance_clock() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let fx_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 4,
                uid: fx_uid,
                label: "fx-4".to_owned(),
            },
            ..Default::default()
        })
        .expect("store fx definition");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 12,
            uid: Uuid::new_v4(),
            label: "exec-12".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(12),
        )));
    app.update();

    let timeline_uid = Uuid::from_u128(0x3003);
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::StopAtTiming {
            clip_id: IdExpr::Single(12),
            timing: PlaybackReconstructionTiming::timeline_source_local(
                Duration::from_millis(400),
                Duration::from_millis(900),
                timeline_uid,
                Duration::from_millis(125),
            ),
        }));
    app.update();

    let (_mfx, _release_marker, clock) = app
        .world_mut()
        .query::<(&MaterializedFx, &ReleaseMarker, &InstanceClock)>()
        .single(app.world())
        .expect("timed stop should leave one releasing FX with a playback clock");

    assert_eq!(
        clock.source,
        InstanceClockSource::Timeline {
            timeline_uid,
            started_at_timeline: Duration::from_millis(125)
        }
    );
    assert_eq!(clock.position, Duration::from_millis(900));
}

#[test]
fn start_step_fx_command_spawns_playback_without_clip() {
    let mut app = App::new();
    add_selection_resources(&mut app);
    app.add_message::<CommandEnvelope<StepFxCommand>>();
    app.add_message::<StepFxCommandResult>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_systems(Update, nightfall_fx::events::handle_step_fx_commands);

    app.world_mut().spawn(minimal_step_fx(
        102,
        Uuid::new_v4(),
        "stepfx-102",
        Duration::from_secs(1),
    ));

    app.world_mut()
        .write_message(step_fx_command(StepFxCommand::Start(102)));
    app.update();

    let mut active_query = app.world_mut().query::<(
        &ActiveStepFx,
        &InstanceId,
        &InstanceMetadata,
        &InstanceControls,
        &InstanceClock,
    )>();
    let (_active, _instance_id, metadata, _controls, clock) = active_query
        .single(app.world())
        .expect("expected one direct-started step fx");
    assert_eq!(metadata.kind, InstanceKind::Fx);
    assert_eq!(metadata.display_kind, InstanceDisplayKind::StepFx);
    assert_eq!(metadata.name.as_deref(), Some("stepfx-102"));
    assert_eq!(clock.source, InstanceClockSource::Realtime);

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .count();
    assert_eq!(
        mexec_count, 0,
        "direct step fx start should not create a clip binding"
    );
}

/// Verifies FX previews attach realtime clocks for deterministic preview rendering.
#[test]
fn fx_preview_start_attaches_realtime_instance_clock() {
    let mut app = App::new();
    app.add_message::<FxPreviewUpdate>();
    app.add_systems(Update, handle_preview_commands);

    app.world_mut()
        .write_message(FxPreviewUpdate::StartPreview(Fx {
            identifiers: Identifiers {
                id: 201,
                uid: Uuid::new_v4(),
                label: "preview-fx".to_owned(),
            },
            ..Default::default()
        }));
    app.update();

    let mut preview_query =
        app.world_mut()
            .query::<(&MaterializedFx, &PreviewMaterializedFx, &InstanceClock)>();
    let (_mfx, _preview, clock) = preview_query
        .single(app.world())
        .expect("preview should spawn one clocked materialized FX");
    assert_eq!(clock.source, InstanceClockSource::Realtime);
}

#[test]
fn start_step_fx_command_preserves_controls_on_active_playback() {
    let mut app = App::new();
    add_selection_resources(&mut app);
    app.add_message::<CommandEnvelope<StepFxCommand>>();
    app.add_message::<StepFxCommandResult>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_systems(Update, nightfall_fx::events::handle_step_fx_commands);

    app.world_mut().spawn(minimal_step_fx(
        104,
        Uuid::new_v4(),
        "stepfx-104",
        Duration::from_secs(1),
    ));

    app.world_mut()
        .write_message(step_fx_command(StepFxCommand::Start(104)));
    app.update();

    {
        let mut controls_query = app.world_mut().query::<&mut InstanceControls>();
        let mut controls = controls_query
            .single_mut(app.world_mut())
            .expect("expected controls on active step fx");
        controls.intensity_scale = 0.4;
        controls.rate = 0.5;
    }

    app.world_mut()
        .write_message(step_fx_command(StepFxCommand::Start(104)));
    app.update();

    let mut controls_query = app.world_mut().query::<&InstanceControls>();
    let controls = controls_query
        .single(app.world())
        .expect("expected controls on restarted step fx");
    assert_eq!(controls.intensity_scale, 0.4);
    assert_eq!(controls.rate, 0.5);
}

#[test]
fn stop_all_releases_direct_step_fx_playback() {
    let mut app = App::new();
    add_selection_resources(&mut app);
    app.add_message::<CommandEnvelope<StepFxCommand>>();
    app.add_message::<StepFxCommandResult>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    app.init_resource::<InstanceIndex>();
    app.add_systems(
        Update,
        (
            add_instances_to_index,
            nightfall_fx::events::handle_step_fx_commands,
            nightfall_fx::events::handle_step_fx_playback_commands,
            despawn_released_active_step_fx,
            remove_instances_from_index,
            sync_active_state_on_instance_despawn,
        )
            .chain(),
    );

    app.world_mut().spawn(minimal_step_fx(
        103,
        Uuid::new_v4(),
        "stepfx-103",
        Duration::from_secs(1),
    ));

    app.world_mut()
        .write_message(step_fx_command(StepFxCommand::Start(103)));
    app.update();

    let active_count = app
        .world_mut()
        .query::<&ActiveStepFx>()
        .iter(app.world())
        .count();
    assert_eq!(active_count, 1, "expected one active direct step fx");

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(PlaybackReleaseAction::All));
    app.update();
    app.update();

    let active_count = app
        .world_mut()
        .query::<&ActiveStepFx>()
        .iter(app.world())
        .count();
    assert_eq!(
        active_count, 0,
        "expected StopAll to release direct step fx playback"
    );
}

#[test]
fn stop_clip_for_step_fx_marks_release_and_removes_binding() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx::events::FxPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_flow::events::FlowPlaybackAction>>();
    app.add_message::<EngineActionEnvelope<nightfall_fx_module::events::FxModulePlaybackAction>>();
    app.add_message::<EventEnvelope<nightfall_instances::ClipInstanceAttachment>>();
    app.insert_resource(DataProvider::<Fx>::default());
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions,
            handle_events,
            nightfall_desk::systems::event_handlers::clip_events::handle_clip_playback_attachments,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    app.world_mut().spawn(minimal_step_fx(
        101,
        step_fx_uid,
        "stepfx-101",
        Duration::from_secs(1),
    ));

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 27,
            uid: Uuid::new_v4(),
            label: "exec-27".to_owned(),
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Start(
            IdExpr::Single(27),
        )));
    app.update();

    let started_count = app
        .world_mut()
        .query::<&ActiveStepFx>()
        .iter(app.world())
        .count();
    assert_eq!(started_count, 1, "expected one active step fx after start");

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClipAction::Stop(
            IdExpr::Single(27),
        )));
    app.update();

    let released_count = app
        .world_mut()
        .query::<(&ActiveStepFx, Option<&ReleaseMarker>)>()
        .iter(app.world())
        .filter(|(_, release_marker)| release_marker.is_some())
        .count();
    assert_eq!(
        released_count, 1,
        "expected active step fx to be marked for release after clip stop"
    );

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .filter(|mexec| mexec.clip_id == 27)
        .count();
    assert_eq!(
        mexec_count, 0,
        "expected materialized clip to be removed after step fx stop"
    );
}

/// Verifies stored definition edits re-anchor active playback without releasing its layer.
#[test]
fn redefining_running_step_fx_preserves_normalized_phase() {
    let mut app = App::new();
    add_selection_resources(&mut app);
    app.add_message::<CommandEnvelope<StepFxCommand>>();
    app.add_message::<StepFxCommandResult>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_systems(Update, nightfall_fx::events::handle_step_fx_commands);

    let step_fx_uid = Uuid::new_v4();
    let old_fx_entity = app
        .world_mut()
        .spawn(minimal_step_fx(
            1,
            step_fx_uid,
            "stepfx-1-old",
            Duration::from_secs(1),
        ))
        .id();

    let active_entity = app
        .world_mut()
        .spawn((
            ActiveStepFx {
                fx_entity: old_fx_entity,
                priority: Priority(50),
                rate: 1.0,
                is_playing: true,
            },
            Layer::new("orphan candidate".to_owned(), Priority::default()),
            InstanceClock {
                position: Duration::from_millis(1500),
                ..Default::default()
            },
        ))
        .id();

    app.world_mut()
        .write_message(step_fx_command(StepFxCommand::Store(minimal_step_fx(
            1,
            step_fx_uid,
            "stepfx-1-new",
            Duration::from_secs(5),
        ))));
    app.update();

    let active = app.world().entity(active_entity);
    assert!(active.get::<ReleaseMarker>().is_none());
    assert_ne!(
        active.get::<ActiveStepFx>().unwrap().fx_entity,
        old_fx_entity
    );
    assert_eq!(
        active.get::<InstanceClock>().unwrap().position,
        Duration::from_millis(7500),
        "75% through a two-second cycle should remain 75% through the new ten-second cycle"
    );

    let step_fx_count = app
        .world_mut()
        .query::<&StepFx>()
        .iter(app.world())
        .filter(|fx| fx.identifiers.id == 1)
        .count();
    assert_eq!(
        step_fx_count, 1,
        "expected replacement definition to remain"
    );
}

/// Verifies clip-owned Step FX edits preserve the runtime playback binding.
#[test]
fn redefining_clip_owned_step_fx_preserves_playback_binding() {
    let mut app = App::new();
    add_selection_resources(&mut app);
    app.add_message::<CommandEnvelope<StepFxCommand>>();
    app.add_message::<StepFxCommandResult>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<CommandEnvelope<InstanceCommand>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    add_command_lifecycle(&mut app);
    app.init_resource::<InstanceIndex>();
    app.add_systems(
        Update,
        (
            add_instances_to_index,
            nightfall_fx::events::handle_step_fx_commands,
            handle_playback_commands,
            despawn_released_active_step_fx,
            remove_instances_from_index,
            sync_active_state_on_instance_despawn,
        )
            .chain(),
    );

    let step_fx_uid = Uuid::new_v4();
    let old_fx_entity = app
        .world_mut()
        .spawn(minimal_step_fx(
            2,
            step_fx_uid,
            "stepfx-2-old",
            Duration::from_secs(1),
        ))
        .id();

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 42,
            uid: Uuid::new_v4(),
            label: "exec-42".to_owned(),
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });

    let instance_id = InstanceId::new();
    app.world_mut().spawn((
        ActiveStepFx {
            fx_entity: old_fx_entity,
            priority: Priority(50),
            rate: 1.0,
            is_playing: true,
        },
        instance_id,
        InstanceMetadata::new(InstanceKind::Fx).with_name("stepfx-2-old"),
        InstanceControls::default(),
        InstanceClock::default(),
        Layer::new(
            "clip-owned orphan candidate".to_owned(),
            Priority::default(),
        ),
    ));
    app.world_mut().spawn(MaterializedClip {
        clip_id: 42,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.world_mut()
        .write_message(step_fx_command(StepFxCommand::Store(minimal_step_fx(
            2,
            step_fx_uid,
            "stepfx-2-new",
            Duration::from_secs(5),
        ))));

    app.update();
    app.update();

    let active_count = app
        .world_mut()
        .query::<&ActiveStepFx>()
        .iter(app.world())
        .count();
    assert_eq!(
        active_count, 1,
        "expected redefine to preserve the clip-owned active step fx playback"
    );

    let mexec_count = app
        .world_mut()
        .query::<&MaterializedClip>()
        .iter(app.world())
        .count();
    assert_eq!(
        mexec_count, 1,
        "expected the clip binding to remain attached"
    );

    let step_fx_count = app
        .world_mut()
        .query::<&StepFx>()
        .iter(app.world())
        .filter(|fx| fx.identifiers.id == 2)
        .count();
    assert_eq!(
        step_fx_count, 1,
        "expected replacement definition to remain"
    );
}

fn despawn_released_active_step_fx(
    mut commands: bevy_ecs::prelude::Commands,
    active_fx_query: bevy_ecs::prelude::Query<
        bevy_ecs::prelude::Entity,
        (
            bevy_ecs::prelude::With<ActiveStepFx>,
            bevy_ecs::prelude::With<ReleaseMarker>,
        ),
    >,
) {
    for entity in active_fx_query.iter() {
        commands.entity(entity).despawn();
    }
}
