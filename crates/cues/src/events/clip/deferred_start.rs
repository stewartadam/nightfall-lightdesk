// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Same-tick coalescing of clip starts and transport operations into one deferred
//! sequence materialization per clip.

use super::*;

/// Ordered operation to apply when a deferred clip start is flushed.
#[derive(Clone, Copy)]
pub(super) enum DeferredClipOperation {
    /// Advance to the next cue, anchored at an optional source-local playback position.
    Go { playback_position: Option<Duration> },
    /// Return to the previous cue, anchored at an optional source-local playback position.
    Back { playback_position: Option<Duration> },
    /// Jump to a one-based cue position, optionally at a transition timing.
    Goto {
        position: u32,
        timing: Option<PlaybackReconstructionTiming>,
    },
    /// Render at a one-based cue position and reconstruction timing.
    RenderAt {
        position: u32,
        timing: PlaybackReconstructionTiming,
    },
}

impl DeferredClipOperation {
    /// Replays the operation on a freshly materialized sequence, extending the materialized
    /// prefix through the target step before moving the playback cursor.
    fn apply(&self, msequence: &mut MaterializedSequence, sources: &ClipMaterializationSources) {
        match self {
            Self::Go { playback_position } => {
                sources.materialize_next_step(msequence);
                msequence.next_at_playback_position(*playback_position);
            }
            Self::Back { playback_position } => {
                sources.materialize_previous_step(msequence);
                msequence.prev_at_playback_position(*playback_position);
            }
            Self::Goto { position, timing } => {
                sources.materialize_through_position(msequence, *position);
                if let Some(timing) = timing {
                    msequence.set_position_at_playback_position(*position, Some(timing.started_at));
                } else {
                    msequence.set_position(*position);
                }
            }
            Self::RenderAt { position, timing } => {
                sources.materialize_through_position(msequence, *position);
                msequence.set_position_at_playback_position(*position, Some(timing.started_at));
            }
        }
    }
}

/// How a flushed deferred start seeds its sequence's start timing.
#[derive(Clone, Copy)]
enum DeferredSpawnMode {
    /// Spawn running playback whose sequence starts at the deferred start timing.
    Autostart,
    /// Spawn playback already releasing, positioned at the deferred start timing.
    Release,
}

/// Deferred request to start an clip after cue handling completes.
pub(super) struct DeferredClipAutostart {
    sequence_uid: Uuid,
    clip_uid: Uuid,
    clip_priority: Priority,
    start_timing: Option<PlaybackReconstructionTiming>,
    instance_clock_timing: Option<PlaybackReconstructionTiming>,
    lookahead_enabled: Option<bool>,
    operations: Vec<DeferredClipOperation>,
}

impl DeferredClipAutostart {
    /// Creates a deferred start for an idle clip, seeded with the transport operation that
    /// triggered it.
    pub(super) fn for_operation(
        sequence_uid: Uuid,
        clip: &Clip,
        instance_clock_timing: Option<PlaybackReconstructionTiming>,
        lookahead_enabled: Option<bool>,
        operation: DeferredClipOperation,
    ) -> Self {
        Self {
            sequence_uid,
            clip_uid: clip.identifiers().uid,
            clip_priority: clip.priority,
            start_timing: None,
            instance_clock_timing,
            lookahead_enabled,
            operations: vec![operation],
        }
    }

    /// Source-local playback position of the start timing, used to anchor coalesced steps.
    pub(super) fn start_playback_position(&self) -> Option<Duration> {
        self.start_timing.map(|timing| timing.position)
    }

    /// Appends an operation to replay, in order, when the start is flushed.
    pub(super) fn push_operation(&mut self, operation: DeferredClipOperation) {
        self.operations.push(operation);
    }

    /// Number of operations recorded for replay.
    pub(super) fn operation_count(&self) -> usize {
        self.operations.len()
    }

    /// Seeds the spawned instance clock from a reconstruction timing.
    pub(super) fn set_instance_clock_timing(&mut self, timing: PlaybackReconstructionTiming) {
        self.instance_clock_timing = Some(timing);
    }

    /// Sets the lookahead override applied to the spawned instance's options.
    pub(super) fn set_lookahead_enabled(&mut self, lookahead_enabled: Option<bool>) {
        self.lookahead_enabled = lookahead_enabled;
    }

    /// Materializes the sequence at its priority and start timing, replays every recorded
    /// operation, and derives the instance options.
    fn materialize(
        &self,
        sequence: &Sequence,
        sources: &ClipMaterializationSources,
        mode: DeferredSpawnMode,
    ) -> (MaterializedSequence, InstanceOptions) {
        let mut msequence = sources.materialize_initial(sequence);
        msequence.set_priority(self.clip_priority);
        if let Some(timing) = self.start_timing {
            match mode {
                DeferredSpawnMode::Autostart => msequence.set_sequence_start_timing(timing),
                DeferredSpawnMode::Release => {
                    msequence.set_current_transition_position(timing.started_at);
                }
            }
        }
        let instance_options = instance_options_for_sequence(sequence, self.lookahead_enabled);

        for operation in &self.operations {
            operation.apply(&mut msequence, sources);
        }
        (msequence, instance_options)
    }
}

/// Clip starts awaiting materialization at the end of a clip handling run.
#[derive(Default)]
pub(super) struct DeferredClipStarts {
    /// Starts to spawn as running playback, keyed by clip ID.
    autostarts: HashMap<u32, DeferredClipAutostart>,
    /// Starts stopped with a timing in the same run, to spawn as releasing playback.
    releases: Vec<(u32, DeferredClipAutostart, PlaybackReconstructionTiming)>,
}

impl DeferredClipStarts {
    /// Returns the pending start for a clip so a transport operation can coalesce into it.
    pub(super) fn get_mut(&mut self, clip_id: u32) -> Option<&mut DeferredClipAutostart> {
        self.autostarts.get_mut(&clip_id)
    }

    /// Records a start request, retargeting and reseeding any pending start for the clip
    /// while keeping the operations already coalesced into it.
    pub(super) fn defer_start(
        &mut self,
        clip_id: u32,
        clip: &Clip,
        sequence_uid: Uuid,
        start_timing: Option<PlaybackReconstructionTiming>,
        lookahead_enabled: Option<bool>,
    ) {
        self.autostarts
            .entry(clip_id)
            .and_modify(|deferred| {
                deferred.sequence_uid = sequence_uid;
                deferred.clip_uid = clip.identifiers().uid;
                deferred.clip_priority = clip.priority;
                deferred.start_timing = start_timing;
                deferred.instance_clock_timing = start_timing;
                deferred.lookahead_enabled = lookahead_enabled;
            })
            .or_insert(DeferredClipAutostart {
                sequence_uid,
                clip_uid: clip.identifiers().uid,
                clip_priority: clip.priority,
                start_timing,
                instance_clock_timing: start_timing,
                lookahead_enabled,
                operations: Vec::new(),
            });
    }

    /// Sets the pending start for a clip, discarding any previous one.
    pub(super) fn replace(&mut self, clip_id: u32, deferred: DeferredClipAutostart) {
        self.autostarts.insert(clip_id, deferred);
    }

    /// Resolves a clip's pending start against a same-run stop: an untimed stop cancels
    /// it, while a timed stop keeps it to be spawned already releasing at `stop_timing`.
    pub(super) fn cancel_for_stop(
        &mut self,
        clip_id: u32,
        stop_timing: Option<PlaybackReconstructionTiming>,
    ) {
        let Some(deferred) = self.autostarts.remove(&clip_id) else {
            return;
        };
        if let Some(timing) = stop_timing {
            tracing::debug!(
                clip_id = %clip_id,
                "Materializing deferred autostart/go as releasing sequence due to timed stop in same tick"
            );
            self.releases.push((clip_id, deferred, timing));
        } else {
            tracing::debug!(
                clip_id = %clip_id,
                "Cancelling deferred autostart/go due to stop in same tick"
            );
        }
    }

    /// Spawns every pending start: running playback with a materialized clip link for each
    /// autostart, then releasing playback for each start stopped with a timing.
    pub(super) fn flush(self, context: &mut ClipOperationContext) {
        for (clip_id, deferred) in self.autostarts {
            flush_autostart(context, clip_id, &deferred);
        }
        for (clip_id, deferred, stop_timing) in self.releases {
            flush_release(context, clip_id, &deferred, stop_timing);
        }
    }
}

/// Builds the identity components shared by every playback spawned from a deferred start.
fn instance_identity(
    msequence: &MaterializedSequence,
    sequence: &Sequence,
    deferred: &DeferredClipAutostart,
) -> (ObjectRefMarker, Owner, InstanceId, InstanceMetadata) {
    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Sequence,
        uid: msequence.identifiers().uid,
    });
    let owner = Owner(deferred.clip_uid);
    let instance_id = InstanceId::new();
    let instance_metadata = InstanceMetadata::new(InstanceKind::Sequence)
        .with_name(sequence.identifiers().label.clone());
    (marker, owner, instance_id, instance_metadata)
}

/// Spawns running sequence playback for a deferred start and links it to its clip.
fn flush_autostart(
    context: &mut ClipOperationContext,
    clip_id: u32,
    deferred: &DeferredClipAutostart,
) {
    let sequence = match context.seq_data_provider.get(deferred.sequence_uid) {
        Ok(sequence) => sequence,
        Err(err) => {
            tracing::warn!(
                clip_id = %clip_id,
                sequence_uid = %deferred.sequence_uid,
                error = %err,
                "Skipping deferred clip autostart because the sequence target is missing"
            );
            return;
        }
    };
    let (msequence, instance_options) =
        deferred.materialize(&sequence, &context.sources, DeferredSpawnMode::Autostart);
    let (marker, owner, instance_id, instance_metadata) =
        instance_identity(&msequence, &sequence, deferred);
    let instance_controls = InstanceControls::default();
    let instance_clock = deferred
        .instance_clock_timing
        .map(instance_clock_from_reconstruction_timing)
        .unwrap_or_default();
    let instance_status = msequence.runtime_status_at_clock(Some(&instance_clock));

    context.commands.spawn((
        msequence,
        marker,
        owner,
        instance_id,
        instance_metadata,
        instance_controls,
        instance_options,
        instance_status,
        instance_clock,
    ));
    context.commands.spawn(MaterializedClip {
        clip_id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    tracing::debug!(
        clip_id = %clip_id,
        instance_id = ?instance_id,
        operation_count = deferred.operation_count(),
        "Flushed deferred autostart/go for clip"
    );
}

/// Spawns sequence playback for a deferred start that a timed stop already released.
fn flush_release(
    context: &mut ClipOperationContext,
    clip_id: u32,
    deferred: &DeferredClipAutostart,
    stop_timing: PlaybackReconstructionTiming,
) {
    let sequence = match context.seq_data_provider.get(deferred.sequence_uid) {
        Ok(sequence) => sequence,
        Err(err) => {
            tracing::warn!(
                clip_id = %clip_id,
                sequence_uid = %deferred.sequence_uid,
                error = %err,
                "Skipping deferred clip release because the sequence target is missing"
            );
            return;
        }
    };
    let (msequence, instance_options) =
        deferred.materialize(&sequence, &context.sources, DeferredSpawnMode::Release);
    let (marker, owner, instance_id, instance_metadata) =
        instance_identity(&msequence, &sequence, deferred);
    let instance_controls = InstanceControls::default();
    let instance_clock = instance_clock_from_reconstruction_timing(stop_timing);
    let instance_status = msequence.runtime_status_at_clock(Some(&instance_clock));

    context.commands.spawn((
        msequence,
        marker,
        owner,
        instance_id,
        instance_metadata,
        instance_controls,
        instance_options,
        instance_status,
        ReleaseMarker::default(),
        instance_clock,
        PlaybackReleaseTiming {
            released_at: stop_timing.started_at,
        },
    ));

    tracing::debug!(
        clip_id = %clip_id,
        instance_id = ?instance_id,
        operation_count = deferred.operation_count(),
        "Flushed deferred autostart/go as releasing sequence for clip"
    );
}
