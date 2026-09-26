// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::*;
use nightfall_clips::{
    Clip, ClipAction, ClipCommand, MaterializedClip, Source, clip_action_from_command,
};
use nightfall_compositor::prelude::ReleaseMarker;
use nightfall_cues::events::handle_events;
use nightfall_cues::materialized_sequence::{
    despawn_materialized_sequences, release_materialized_sequences,
};
use nightfall_cues::prelude::{Cue, CueLifecycleAction, MaterializedSequence, Sequence};
use nightfall_desk::instances::sync_active_state_on_instance_despawn;
use nightfall_desk::prelude::{DeskCommand, InstanceIndex};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandError, CommandNotice, CommandReply, CommandResult, CommandTracker,
    DataProvider, EngineActionEnvelope, FinishedCommand, OperationResult, PendingCommandBuffer,
    PendingEngineActionBuffer,
};
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_instances::{InstanceId, PlaybackAction};
use uuid::Uuid;

/// Installs lifecycle resources required by the cue event responder.
fn add_command_lifecycle(app: &mut App) {
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_message::<OperationResult<(), CommandError>>();
}

/// Converts a clip command fixture into a detached concrete runtime action.
fn clip_action(command: ClipCommand) -> EngineActionEnvelope<ClipAction> {
    let action = clip_action_from_command(&command)
        .expect("test clip command should map to a runtime action");
    EngineActionEnvelope::detached(action)
}

fn build_cue(id: u32, uid: Uuid, label: &str) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        ..Default::default()
    }
}

fn build_sequence(id: u32, uid: Uuid, label: &str, steps: Vec<Uuid>) -> Sequence {
    Sequence {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        steps: steps.into_iter().map(Into::into).collect(),
        ..Default::default()
    }
}

#[test]
fn same_frame_stop_start_go_goto_keeps_sequence_linked_and_not_releasing() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    add_command_lifecycle(&mut app);

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(PendingCommandBuffer::default());
    app.insert_resource(PendingEngineActionBuffer::default());
    app.add_systems(Update, handle_events);

    let cue_uid_a = Uuid::new_v4();
    let cue_uid_b = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, cue_uid_a, "cue-a"))
            .expect("store cue-a");
        cue_provider
            .add(build_cue(2, cue_uid_b, "cue-b"))
            .expect("store cue-b");
    }
    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(
                1,
                sequence_uid,
                "sequence-a",
                vec![cue_uid_a, cue_uid_b],
            ))
            .expect("store sequence-a");
    }

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 1,
            uid: clip_uid,
            label: "exec-1".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(1))));
    app.update();

    let mut before_query =
        app.world_mut()
            .query::<(&MaterializedSequence, Option<&ReleaseMarker>, &InstanceId)>();
    let before = before_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(before.len(), 1);
    assert!(before[0].1.is_none(), "sequence should not be releasing");
    let initial_instance_id = *before[0].2;

    let mut before_clip_query = app.world_mut().query::<&MaterializedClip>();
    let before_clips = before_clip_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(before_clips.len(), 1);
    assert_eq!(before_clips[0].clip_id, 1);
    assert_eq!(before_clips[0].attached_instance, initial_instance_id);

    app.world_mut()
        .write_message(clip_action(ClipCommand::StopClip(IdExpr::Single(1))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(1))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GoClip(IdExpr::Single(1))));
    app.world_mut()
        .write_message(clip_action(ClipCommand::GotoClip {
            clip_id: IdExpr::Single(1),
            position: 2,
            timing: None,
        }));
    app.update();

    let mut after_query =
        app.world_mut()
            .query::<(&MaterializedSequence, Option<&ReleaseMarker>, &InstanceId)>();
    let after = after_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(
        after.len(),
        2,
        "restart should leave the old instance fading while a new one starts"
    );
    let active = after
        .iter()
        .find(|(_, release_marker, _)| release_marker.is_none())
        .expect("expected a newly active sequence playback");
    let releasing = after
        .iter()
        .find(|(_, release_marker, _)| release_marker.is_some())
        .expect("expected the old sequence playback to be releasing");
    assert!(
        releasing
            .0
            .mcues
            .iter()
            .all(|mcue| mcue.release_position.is_none()),
        "old sequence should be marked for release but not processed until release systems run"
    );
    let instance_id_after = *active.2;
    assert_ne!(
        instance_id_after, initial_instance_id,
        "restart should create a fresh playback instead of reusing the fading one"
    );
    assert_eq!(active.0.position(), 2);

    let mut after_clip_query = app.world_mut().query::<&MaterializedClip>();
    let after_clips = after_clip_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(
        after_clips.len(),
        1,
        "clip should keep a single materialized link after stop/start replay"
    );
    assert_eq!(after_clips[0].clip_id, 1);
    assert_eq!(after_clips[0].attached_instance, instance_id_after);

    let drained = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    assert!(
        drained.is_empty(),
        "go/goto should coalesce into the deferred restart"
    );
}

/// Verifies orphan cleanup cannot race a sequence clip restart into a stale entity insert.
#[test]
fn orphan_cleanup_before_sequence_restart_spawns_fresh_clip_link() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    add_command_lifecycle(&mut app);

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(PendingCommandBuffer::default());
    app.insert_resource(PendingEngineActionBuffer::default());
    app.insert_resource(InstanceIndex::default());
    app.add_systems(
        Update,
        (
            sync_active_state_on_instance_despawn.before(handle_events),
            handle_events,
        ),
    );

    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(build_cue(1, cue_uid, "cue-a"))
        .expect("store cue-a");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence-a", vec![cue_uid]))
        .expect("store sequence-a");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 1,
            uid: clip_uid,
            label: "exec-1".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(1))));
    app.update();

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(1))));
    app.update();

    let mut mclip_query = app.world_mut().query::<&MaterializedClip>();
    let materialized_clips = mclip_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(
        materialized_clips.len(),
        1,
        "sequence restart should leave one fresh materialized clip"
    );
    assert_eq!(materialized_clips[0].clip_id, 1);
}

/// Verifies restart removes release state before sequence release systems observe it.
#[test]
fn same_frame_sequence_restart_does_not_release_reactivated_cues() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<DeskCommand>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ClipAction>>();
    add_command_lifecycle(&mut app);

    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(PendingCommandBuffer::default());
    app.insert_resource(PendingEngineActionBuffer::default());
    app.add_systems(
        Update,
        (
            handle_events,
            (
                release_materialized_sequences,
                despawn_materialized_sequences,
            )
                .chain()
                .after(handle_events),
        ),
    );

    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let clip_uid = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(build_cue(1, cue_uid, "cue-a"))
        .expect("store cue-a");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence-a", vec![cue_uid]))
        .expect("store sequence-a");

    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 1,
            uid: clip_uid,
            label: "exec-1".to_string(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(1))));
    app.update();

    app.world_mut()
        .write_message(clip_action(ClipCommand::StopClip(IdExpr::Single(1))));
    app.update();

    app.world_mut()
        .write_message(clip_action(ClipCommand::StartClip(IdExpr::Single(1))));
    app.update();

    let mut sequence_query = app
        .world_mut()
        .query::<(&MaterializedSequence, Option<&ReleaseMarker>)>();
    let sequences = sequence_query.iter(app.world()).collect::<Vec<_>>();
    assert_eq!(
        sequences.len(),
        2,
        "expected old releasing and new active materialized sequences"
    );
    let active = sequences
        .iter()
        .find(|(_, release_marker)| release_marker.is_none())
        .expect("expected restarted sequence");
    assert!(
        active.1.is_none(),
        "restarted sequence should not keep a release marker"
    );
    assert!(
        active
            .0
            .mcues
            .iter()
            .all(|mcue| mcue.release_position.is_none()),
        "restarted sequence cues should not be released in the restart frame"
    );
}
