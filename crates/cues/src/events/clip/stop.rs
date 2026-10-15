// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip stop handling: detaches and releases the sequence playback a clip drives.

use super::*;

/// Stops every clip selected by a stop operation.
///
/// `stop_timing` anchors the release to a reconstruction timing instead of releasing at
/// the current clock.
pub(super) fn handle_operation(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_ids: &IdExpr,
    stop_timing: Option<PlaybackReconstructionTiming>,
) {
    for clip_id in clip_ids.expand() {
        stop_clip(context, tick, event, clip_id, stop_timing);
    }
}

/// Returns whether an clip still owns a materialized sequence playback.
fn clip_has_sequence_playback(
    clip_id: u32,
    materialized_clips: &Query<(Entity, &MaterializedClip)>,
    msequences: &Query<ClipSequencePlaybackView>,
) -> bool {
    materialized_clips.iter().any(|(_, materialized_clip)| {
        materialized_clip.clip_id == clip_id
            && msequences
                .iter()
                .any(|(_, _, _, instance_id)| *instance_id == materialized_clip.attached_instance)
    })
}

/// Stops one clip.
///
/// Cancels (or, for a timed stop, converts to a releasing spawn) any same-tick deferred
/// start, detaches the clip's indexed instances, drops their pending sequence operations,
/// marks their sequences for release, and despawns the clip's materialized clip links.
/// Clips that neither target a sequence nor own sequence playback are ignored.
fn stop_clip(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_id: u32,
    stop_timing: Option<PlaybackReconstructionTiming>,
) {
    let Some(clip) = lookup_clip(
        &context.exec_query,
        &mut context.outbound,
        event.correlation_id,
        clip_id,
        "StopClip",
    ) else {
        return;
    };
    let owns_sequence_playback =
        clip_has_sequence_playback(clip_id, &context.materialized_clips, &context.msequences);
    if !matches!(clip.source, Some(Source::Sequence(_))) && !owns_sequence_playback {
        return;
    }

    tick.deferred.cancel_for_stop(clip_id, stop_timing);

    let instance_ids_to_cancel: HashSet<InstanceId> = context
        .materialized_clips
        .iter()
        .filter_map(|(_, mexec)| {
            if mexec.clip_id == clip_id
                && context.clip_playback.is_indexed(&mexec.attached_instance)
            {
                Some(mexec.attached_instance)
            } else {
                None
            }
        })
        .collect();
    tick.detaching_instances
        .extend(instance_ids_to_cancel.iter().copied());
    if !instance_ids_to_cancel.is_empty() {
        discard_pending_sequence_operations(
            &mut context.clip_playback.pending_buffer,
            &instance_ids_to_cancel,
        );
    }

    for (entity, _, _, instance_id) in context.msequences.iter() {
        if instance_ids_to_cancel.contains(instance_id) {
            tracing::debug!(
                instance_id = ?instance_id,
                clip = %clip.identifiers().uid,
                "Releasing materialized sequence for clip"
            );

            context
                .commands
                .entity(entity)
                .insert(ReleaseMarker::default());
            if let Some(timing) = stop_timing {
                context
                    .commands
                    .entity(entity)
                    .insert(instance_clock_from_reconstruction_timing(timing))
                    .insert(PlaybackReleaseTiming {
                        released_at: timing.started_at,
                    });
            }
        }
    }

    for (mexec_entity, mexec) in context.materialized_clips.iter() {
        if mexec.clip_id == clip_id && context.clip_playback.is_indexed(&mexec.attached_instance) {
            if clip.options.auto_release {
                context.commands.spawn(ClipReleaseAfterInstance {
                    clip_id: mexec.clip_id,
                    attached_instance: mexec.attached_instance,
                });
            }
            context.commands.entity(mexec_entity).despawn();
        }
    }
    context.outbound.succeed_cue(event.correlation_id);
}

/// Removes queued sequence playback operations that target any of the given instances,
/// keeping every other pending operation in its original order.
fn discard_pending_sequence_operations(
    pending_buffer: &mut PendingEngineOperationBuffer,
    instance_ids: &HashSet<InstanceId>,
) {
    let retained = pending_buffer
        .drain()
        .into_iter()
        .filter(|pending_cmd| {
            let should_cancel = pending_cmd
                .operation
                .as_any()
                .downcast_ref::<SequencePlaybackOperation>()
                .is_some_and(|sequence_cmd| match sequence_cmd {
                    SequencePlaybackOperation::Go { instance_id }
                    | SequencePlaybackOperation::Back { instance_id }
                    | SequencePlaybackOperation::Goto { instance_id, .. }
                    | SequencePlaybackOperation::RenderAt { instance_id, .. }
                    | SequencePlaybackOperation::Stop { instance_id } => {
                        instance_ids.contains(instance_id)
                    }
                });
            !should_cancel
        })
        .collect::<Vec<_>>();
    for cmd in retained {
        pending_buffer.push(cmd);
    }
}
