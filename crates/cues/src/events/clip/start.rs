// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip start handling: refreshes running sequence playback or defers a new one.

use super::*;

/// Starts every clip selected by a start operation.
///
/// `start_timing` seeds sequence playback from a reconstruction timing and
/// `lookahead_enabled` overrides the sequence's lookahead option when supplied.
pub(super) fn handle_operation(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_ids: &IdExpr,
    start_timing: Option<PlaybackReconstructionTiming>,
    lookahead_enabled: Option<bool>,
) {
    for clip_id in clip_ids.expand() {
        start_clip(
            context,
            tick,
            event,
            clip_id,
            start_timing,
            lookahead_enabled,
        );
    }
}

/// Starts one clip's sequence playback.
///
/// When the clip already drives a live, non-detaching playback of its sequence, that
/// playback is rematerialized in place and un-released. Otherwise creation is deferred to
/// the end of the system run so same-tick transport operations coalesce into a single
/// materialization. Clips targeting anything other than a sequence are ignored.
fn start_clip(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_id: u32,
    start_timing: Option<PlaybackReconstructionTiming>,
    lookahead_enabled: Option<bool>,
) {
    let Some(clip) = lookup_clip(
        &context.exec_query,
        &mut context.outbound,
        event.correlation_id,
        clip_id,
        "StartClip",
    ) else {
        return;
    };

    let Some(target) = clip.source.as_ref() else {
        tracing::warn!(
            clip = %clip.identifiers().uid,
            "Tried to start an clip with no target"
        );
        context.outbound.fail_cue(
            event.correlation_id,
            format!("Clip '{}' has no playback target", clip.identifiers().label),
        );
        return;
    };

    let Source::Sequence(sequence_uid) = target else {
        return;
    };
    let sequence = match context.seq_data_provider.get(*sequence_uid) {
        Ok(sequence) => sequence,
        Err(err) => {
            report_missing_clip_sequence(
                &mut context.outbound,
                event.correlation_id,
                clip,
                *sequence_uid,
                "StartClip",
                &err,
            );
            return;
        }
    };

    tracing::debug!(
        uid = %sequence.identifiers().uid,
        clip = %clip.identifiers().uid,
        "Materializing sequence '{}' for clip '{}'",
        sequence.identifiers().label,
        clip.identifiers().label
    );

    if let Some((msequence_entity, instance_id)) =
        existing_sequence_playback(context, clip_id, *sequence_uid, &tick.detaching_instances)
    {
        let mut msequence = context.sources.materialize_initial(&sequence);
        msequence.set_priority(clip.priority);
        if let Some(timing) = start_timing {
            msequence.set_sequence_start_timing(timing);
        }
        let instance_options = instance_options_for_sequence(&sequence, lookahead_enabled);
        tracing::debug!(
            uid = %sequence.identifiers().uid,
            clip = %clip.identifiers().uid,
            "Updating materialization sequence '{}' on clip '{}'",
            sequence.identifiers().label,
            clip.identifiers().label
        );

        let instance_clock = start_timing
            .map(instance_clock_from_reconstruction_timing)
            .unwrap_or_default();
        context
            .commands
            .entity(msequence_entity)
            .insert(msequence)
            .insert(instance_options)
            .insert(instance_clock)
            .remove::<ReleaseMarker>()
            .remove::<PlaybackReleaseTiming>();

        refresh_materialized_clip(
            &context.materialized_clips,
            &mut context.commands,
            clip_id,
            instance_id,
        );
    } else {
        tracing::debug!(
            uid = %sequence.identifiers().uid,
            clip = %clip.identifiers().uid,
            "Deferring materialization sequence '{}' on clip '{}'",
            sequence.identifiers().label,
            clip.identifiers().label
        );

        tick.deferred.defer_start(
            clip_id,
            clip,
            sequence.identifiers().uid,
            start_timing,
            lookahead_enabled,
        );
    }
    context.outbound.succeed_cue(event.correlation_id);
}

/// Finds the live playback of `sequence_uid` attached to the clip's first non-detaching
/// materialized clip, ignoring playbacks already marked for release.
fn existing_sequence_playback(
    context: &ClipOperationContext,
    clip_id: u32,
    sequence_uid: Uuid,
    detaching_instances: &HashSet<InstanceId>,
) -> Option<(Entity, InstanceId)> {
    context
        .materialized_clips
        .iter()
        .find(|(_, mexec)| {
            mexec.clip_id == clip_id && !detaching_instances.contains(&mexec.attached_instance)
        })
        .and_then(|(_, mexec)| {
            context
                .msequences
                .iter()
                .find(|(_, existing, release_marker, instance_id)| {
                    **instance_id == mexec.attached_instance
                        && existing.identifiers().uid == sequence_uid
                        && release_marker.is_none()
                })
                .map(|(entity, _, _, instance_id)| (entity, *instance_id))
        })
}

/// Re-arms the clip's materialized clip link for a restarted playback, spawning one
/// attached to `instance_id` when the clip has none.
fn refresh_materialized_clip(
    materialized_clips: &Query<(Entity, &MaterializedClip)>,
    commands: &mut Commands,
    clip_id: u32,
    instance_id: InstanceId,
) {
    let existing_materialized_clip = materialized_clips
        .iter()
        .find(|(_, mexec)| mexec.clip_id == clip_id)
        .map(|(entity, mexec)| (entity, mexec.attached_instance));

    if let Some((mexec_entity, attached_instance)) = existing_materialized_clip {
        commands.entity(mexec_entity).try_insert(MaterializedClip {
            clip_id,
            attached_instance,
            auto_release_on_stop: false,
        });
    } else {
        tracing::debug!(
            clip_id = %clip_id,
            instance_id = ?instance_id,
            "Spawning MaterializedClip for restarted sequence clip"
        );
        commands.spawn(MaterializedClip {
            clip_id,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });
    }
}
