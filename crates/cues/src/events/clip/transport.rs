// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip transport handling: go, back, goto, and render-at.
//!
//! Each operation is coalesced into a same-tick deferred start when one exists, delegated
//! to [`SequencePlaybackOperation`] when the clip drives a live playback, and otherwise
//! turned into a new deferred start seeded with the operation.

use super::*;

/// Relative step direction of a `go` or `back` clip operation.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum StepDirection {
    /// Advance to the next cue.
    Go,
    /// Return to the previous cue.
    Back,
}

impl StepDirection {
    /// Command name reported in lookup and missing-sequence diagnostics.
    fn command_name(self) -> &'static str {
        match self {
            Self::Go => "GoClip",
            Self::Back => "BackClip",
        }
    }

    /// Verb phrase used in "Cannot ... clip" diagnostics.
    fn action(self) -> &'static str {
        match self {
            Self::Go => "use 'go' on",
            Self::Back => "use 'back' on",
        }
    }

    /// Operation name used when logging coalescing into a deferred start.
    fn coalesce_label(self) -> &'static str {
        match self {
            Self::Go => "GoClip",
            Self::Back => "back",
        }
    }

    /// Short verb used when logging a newly deferred start.
    fn verb(self) -> &'static str {
        match self {
            Self::Go => "go",
            Self::Back => "back",
        }
    }

    /// Name of the delegated [`SequencePlaybackOperation`] variant.
    fn sequence_variant(self) -> &'static str {
        match self {
            Self::Go => "Go",
            Self::Back => "Back",
        }
    }

    /// Builds the deferred operation replayed when a deferred start is flushed.
    fn deferred_operation(self, playback_position: Option<Duration>) -> DeferredClipOperation {
        match self {
            Self::Go => DeferredClipOperation::Go { playback_position },
            Self::Back => DeferredClipOperation::Back { playback_position },
        }
    }

    /// Builds the sequence operation delegated to a live playback instance.
    fn sequence_operation(self, instance_id: InstanceId) -> SequencePlaybackOperation {
        match self {
            Self::Go => SequencePlaybackOperation::Go { instance_id },
            Self::Back => SequencePlaybackOperation::Back { instance_id },
        }
    }
}

/// Absolute-position clip operation, which validates the position against the sequence.
#[derive(Clone, Copy)]
enum PositionedOperation {
    /// Jump to a cue position.
    Goto,
    /// Render playback at a planner-derived cue position.
    RenderAt,
}

impl PositionedOperation {
    /// Command name reported in lookup and missing-sequence diagnostics.
    fn command_name(self) -> &'static str {
        match self {
            Self::Goto => "GotoClip",
            Self::RenderAt => "RenderClipAt",
        }
    }

    /// Verb phrase used in "Cannot ... clip" diagnostics.
    fn action(self) -> &'static str {
        match self {
            Self::Goto => "use 'goto' on",
            Self::RenderAt => "render",
        }
    }

    /// Logs a requested position that falls outside the sequence's cue range.
    fn log_out_of_bounds(self, sequence_label: &str, position: u32, num_cues: u32) {
        match self {
            Self::Goto => tracing::error!(
                "Cannot jump sequence '{}' to position {} (sequence has {} cues)",
                sequence_label,
                position,
                num_cues
            ),
            Self::RenderAt => tracing::error!(
                "Cannot render sequence '{}' at position {} (sequence has {} cues)",
                sequence_label,
                position,
                num_cues
            ),
        }
    }
}

/// Resolves the sequence a clip targets, failing the command when it targets something
/// else or nothing.
fn sequence_target(
    outbound: &mut CommandResponder,
    correlation_id: Uuid,
    clip: &Clip,
    action: &str,
) -> Option<Uuid> {
    match &clip.source {
        Some(Source::Sequence(uid)) => Some(*uid),
        Some(other_executable) => {
            tracing::error!(
                clip_label = %clip.identifiers.label,
                target = ?other_executable,
                "Cannot {action} clip because it is not targeting a sequence"
            );
            outbound.fail_cue(
                correlation_id,
                format!(
                    "Clip '{}' is not targeting a sequence",
                    clip.identifiers.label
                ),
            );
            None
        }
        None => {
            tracing::error!(
                "Cannot {action} clip '{}': clip has no target",
                clip.identifiers.label
            );
            outbound.fail_cue(
                correlation_id,
                format!("Clip '{}' has no target assigned", clip.identifiers.label),
            );
            None
        }
    }
}

/// Resolves a clip's target sequence and checks that a one-based position lies within
/// its cues, returning the sequence identity and label.
fn positioned_sequence_target(
    outbound: &mut CommandResponder,
    seq_data_provider: &DataProvider<Sequence>,
    correlation_id: Uuid,
    clip: &Clip,
    position: u32,
    operation: PositionedOperation,
) -> Option<(Uuid, String)> {
    let sequence_uid = sequence_target(outbound, correlation_id, clip, operation.action())?;
    let sequence = match seq_data_provider.get(sequence_uid) {
        Ok(sequence) => sequence,
        Err(err) => {
            report_missing_clip_sequence(
                outbound,
                correlation_id,
                clip,
                sequence_uid,
                operation.command_name(),
                &err,
            );
            return None;
        }
    };
    let num_cues = sequence.steps.len() as u32;
    if position < 1 || position > num_cues {
        operation.log_out_of_bounds(&sequence.identifiers.label, position, num_cues);
        outbound.fail_cue(
            correlation_id,
            format!(
                "Position {} is out of bounds (sequence '{}' has {} cues)",
                position, sequence.identifiers.label, num_cues
            ),
        );
        return None;
    }
    Some((sequence_uid, sequence.identifiers.label.clone()))
}

/// Applies a `go` or `back` to every selected clip.
pub(super) fn handle_step(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_ids: &IdExpr,
    direction: StepDirection,
) {
    for clip_id in clip_ids.expand() {
        step_clip(context, tick, event, clip_id, direction);
    }
}

/// Applies a `go` or `back` to one clip.
///
/// A same-tick deferred start absorbs the step at its start position. A live playback
/// receives a delegated sequence operation; a `go` also re-arms its materialized clip link
/// so a later stop does not auto-release it. An idle clip gets a new deferred start.
fn step_clip(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_id: u32,
    direction: StepDirection,
) {
    if let Some(deferred) = tick.deferred.get_mut(clip_id) {
        let playback_position = deferred.start_playback_position();
        deferred.push_operation(direction.deferred_operation(playback_position));
        tracing::debug!(
            clip_id = %clip_id,
            operation_count = deferred.operation_count(),
            "Coalescing {} into deferred autostart in this tick",
            direction.coalesce_label()
        );
        context.outbound.succeed_cue(event.correlation_id);
        return;
    }

    let Some(clip) = lookup_clip(
        &context.exec_query,
        &mut context.outbound,
        event.correlation_id,
        clip_id,
        direction.command_name(),
    ) else {
        return;
    };

    let Some(sequence_uid) = sequence_target(
        &mut context.outbound,
        event.correlation_id,
        clip,
        direction.action(),
    ) else {
        return;
    };

    match context.active_instance(clip_id, &tick.detaching_instances) {
        Some((mexec_entity, instance_id)) => {
            if direction == StepDirection::Go {
                context
                    .commands
                    .entity(mexec_entity)
                    .try_insert(MaterializedClip {
                        clip_id,
                        attached_instance: instance_id,
                        auto_release_on_stop: false,
                    });
            }
            context
                .clip_playback
                .delegate(event.envelope, direction.sequence_operation(instance_id));

            tracing::debug!(
                clip_id = %clip_id,
                instance_id = ?instance_id,
                undo_id = ?event.undo_id,
                "Delegating {} to SequencePlaybackOperation::{}",
                direction.command_name(),
                direction.sequence_variant()
            );
        }
        None => {
            if let Err(err) = context.seq_data_provider.get(sequence_uid) {
                report_missing_clip_sequence(
                    &mut context.outbound,
                    event.correlation_id,
                    clip,
                    sequence_uid,
                    direction.command_name(),
                    &err,
                );
                return;
            }
            tick.deferred.replace(
                clip_id,
                DeferredClipAutostart::for_operation(
                    sequence_uid,
                    clip,
                    None,
                    None,
                    direction.deferred_operation(None),
                ),
            );

            tracing::debug!(
                clip_id = %clip_id,
                "Clip was not running; deferred autostart/{} for end-of-system flush",
                direction.verb()
            );
            context.outbound.succeed_cue(event.correlation_id);
        }
    }
}

/// Applies a `goto` to every selected clip.
pub(super) fn handle_goto(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_ids: &IdExpr,
    position: u32,
    timing: Option<PlaybackReconstructionTiming>,
) {
    for clip_id in clip_ids.expand() {
        goto_clip(context, tick, event, clip_id, position, timing);
    }
}

/// Jumps one clip's sequence playback to a validated cue position.
///
/// A same-tick deferred start records the jump and adopts its timing as the instance
/// clock seed; a live playback receives a delegated goto; an idle clip gets a new deferred
/// start seeded with the jump.
fn goto_clip(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_id: u32,
    position: u32,
    timing: Option<PlaybackReconstructionTiming>,
) {
    let Some(clip) = lookup_clip(
        &context.exec_query,
        &mut context.outbound,
        event.correlation_id,
        clip_id,
        PositionedOperation::Goto.command_name(),
    ) else {
        return;
    };
    let Some((sequence_uid, sequence_label)) = positioned_sequence_target(
        &mut context.outbound,
        &context.seq_data_provider,
        event.correlation_id,
        clip,
        position,
        PositionedOperation::Goto,
    ) else {
        return;
    };

    let operation = DeferredClipOperation::Goto { position, timing };
    if let Some(deferred) = tick.deferred.get_mut(clip_id) {
        deferred.push_operation(operation);
        if let Some(timing) = timing {
            deferred.set_instance_clock_timing(timing);
        }
        tracing::debug!(
            clip_id = %clip_id,
            position = %position,
            operation_count = deferred.operation_count(),
            "Coalescing GotoClip into deferred autostart in this tick"
        );
        context.outbound.succeed_cue(event.correlation_id);
        return;
    }

    match context.active_instance(clip_id, &tick.detaching_instances) {
        Some((_, instance_id)) => {
            context.clip_playback.delegate(
                event.envelope,
                SequencePlaybackOperation::Goto {
                    instance_id,
                    position,
                    timing,
                },
            );

            tracing::debug!(
                clip_id = %clip_id,
                instance_id = ?instance_id,
                position = %position,
                undo_id = ?event.undo_id,
                "Delegating GotoClip to SequencePlaybackOperation::Goto for sequence '{}'",
                sequence_label
            );
        }
        None => {
            tick.deferred.replace(
                clip_id,
                DeferredClipAutostart::for_operation(sequence_uid, clip, timing, None, operation),
            );

            tracing::debug!(
                clip_id = %clip_id,
                position = %position,
                "Clip was not running; deferred autostart/goto for sequence '{}'",
                sequence_label
            );
            context.outbound.succeed_cue(event.correlation_id);
        }
    }
}

/// Applies a `render-at` to every selected clip.
///
/// `lookahead_enabled` overrides the sequence's lookahead option when supplied.
pub(super) fn handle_render_at(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_ids: &IdExpr,
    position: u32,
    timing: PlaybackReconstructionTiming,
    lookahead_enabled: Option<bool>,
) {
    for clip_id in clip_ids.expand() {
        render_clip_at(
            context,
            tick,
            event,
            clip_id,
            position,
            timing,
            lookahead_enabled,
        );
    }
}

/// Renders one clip's sequence playback at a validated cue position and timing.
///
/// A same-tick deferred start records the render, adopts its timing as the instance clock
/// seed, and takes any lookahead override; a live playback receives a delegated render; an
/// idle clip gets a new deferred start seeded with the render.
fn render_clip_at(
    context: &mut ClipOperationContext,
    tick: &mut ClipTickState,
    event: &ClipEvent,
    clip_id: u32,
    position: u32,
    timing: PlaybackReconstructionTiming,
    lookahead_enabled: Option<bool>,
) {
    let Some(clip) = lookup_clip(
        &context.exec_query,
        &mut context.outbound,
        event.correlation_id,
        clip_id,
        PositionedOperation::RenderAt.command_name(),
    ) else {
        return;
    };
    let Some((sequence_uid, sequence_label)) = positioned_sequence_target(
        &mut context.outbound,
        &context.seq_data_provider,
        event.correlation_id,
        clip,
        position,
        PositionedOperation::RenderAt,
    ) else {
        return;
    };

    let operation = DeferredClipOperation::RenderAt { position, timing };
    if let Some(deferred) = tick.deferred.get_mut(clip_id) {
        if lookahead_enabled.is_some() {
            deferred.set_lookahead_enabled(lookahead_enabled);
        }
        deferred.push_operation(operation);
        deferred.set_instance_clock_timing(timing);
        tracing::debug!(
            clip_id = %clip_id,
            position = %position,
            operation_count = deferred.operation_count(),
            "Coalescing RenderClipAt into deferred autostart in this tick"
        );
        context.outbound.succeed_cue(event.correlation_id);
        return;
    }

    match context.active_instance(clip_id, &tick.detaching_instances) {
        Some((_, instance_id)) => {
            context.clip_playback.delegate(
                event.envelope,
                SequencePlaybackOperation::RenderAt {
                    instance_id,
                    position,
                    timing,
                },
            );

            tracing::debug!(
                clip_id = %clip_id,
                instance_id = ?instance_id,
                position = %position,
                undo_id = ?event.undo_id,
                "Delegating RenderClipAt to SequencePlaybackOperation::RenderAt for sequence '{}'",
                sequence_label
            );
        }
        None => {
            tick.deferred.replace(
                clip_id,
                DeferredClipAutostart::for_operation(
                    sequence_uid,
                    clip,
                    Some(timing),
                    lookahead_enabled,
                    operation,
                ),
            );

            tracing::debug!(
                clip_id = %clip_id,
                position = %position,
                "Clip was not running; deferred autostart/render for sequence '{}'",
                sequence_label
            );
            context.outbound.succeed_cue(event.correlation_id);
        }
    }
}
