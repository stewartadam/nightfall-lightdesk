// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Safety cap for clocked autonomous sequence advancement in one engine tick.
pub(super) const MAX_AUTONOMOUS_SEQUENCE_ADVANCES_PER_TICK: usize = 10_000;

impl MaterializedSequence {
    /// Returns the position of the current cue
    pub fn position(&self) -> u32 {
        self.position_index as u32 + 1
    }

    /// Returns the inspectable instance runtime status for this sequence.
    pub fn runtime_status(&self) -> InstanceStatus {
        self.runtime_status_at_clock(None)
    }

    /// Returns the inspectable instance runtime status using the playback clock when available.
    pub fn runtime_status_at_clock(&self, clock: Option<&InstanceClock>) -> InstanceStatus {
        let cue_count = self.steps.len() as u32;
        let current_position = if cue_count == 0 { 0 } else { self.position() };
        let current = self.steps.get(self.position_index);
        let current_cue_uid = current.map(|cue| cue.identifiers.uid);
        let current_label = current.map(|cue| cue.identifiers.label.clone());
        let current_part_count = current.map_or(0, |cue| cue.parts.len() as u32);
        let next = self.peek_next();
        let next_position = next.as_ref().map(|_| {
            if current_position == cue_count {
                1
            } else {
                current_position + 1
            }
        });
        let next_part_count = next.as_ref().map(|cue| cue.parts.len() as u32);
        let next_cue_uid = next.as_ref().map(|cue| cue.identifiers.uid);
        let next_label = next.map(|cue| cue.identifiers.label);

        InstanceStatus {
            position: InstancePosition::Sequence {
                sequence_uid: self.sequence.identifiers.uid,
                current_position,
                cue_count,
                current_cue_uid,
                current_label,
                current_part_count,
                next_position,
                next_cue_uid,
                next_label,
                next_part_count,
                retained_cues: self.retained_cue_runtime_statuses(clock),
            },
            source_activation_epoch_ms: clock
                .and_then(|clock| clock.activation_epoch_ms)
                .or_else(|| Some(activation_epoch_ms(self.activation_time))),
            transition_elapsed: clock.map(|clock| {
                let activated_at = self
                    .cue_activation_positions
                    .get(self.position_index)
                    .and_then(|position| *position)
                    .unwrap_or(self.playback_start_position);
                clock.position.saturating_sub(activated_at)
            }),
        }
    }

    /// Returns runtime status rows for retained cue instances that can still render transitions.
    fn retained_cue_runtime_statuses(
        &self,
        clock: Option<&InstanceClock>,
    ) -> Vec<InstanceSequenceCueStatus> {
        self.retained_step_indices()
            .into_iter()
            .filter_map(|index| {
                let cue = self.steps.get(index)?;
                let activated_at = self
                    .cue_activation_positions
                    .get(index)
                    .and_then(|position| *position)
                    .or_else(|| {
                        (index == self.position_index).then_some(self.last_activation_position)
                    });
                Some(InstanceSequenceCueStatus {
                    position: index as u32 + 1,
                    cue_uid: cue.identifiers.uid,
                    transition_elapsed: clock
                        .zip(activated_at)
                        .map(|(clock, activated_at)| clock.position.saturating_sub(activated_at)),
                })
            })
            .collect()
    }

    /// Returns the cue at the current position
    pub fn current(&self) -> Cue {
        self.step(self.position())
    }

    /// Sets the position to the next cue
    pub fn next(&mut self) {
        self.next_at_playback_position(None);
    }

    /// Sets the position to the next cue at a source-local playback position.
    pub fn next_at_playback_position(&mut self, playback_position: Option<Duration>) {
        if self.steps.is_empty() || (!self.wrap && self.position() == self.steps.len() as u32) {
            return;
        }

        let next_pos = if self.position() == self.steps.len() as u32 {
            1_u32
        } else {
            self.position() + 1
        };
        self.advance_to_position(next_pos, playback_position);
    }

    /// Returns the next cue without advancing the sequence
    pub fn peek_next(&self) -> Option<Cue> {
        let is_at_end_without_wrap = !self.wrap && self.position() == self.steps.len() as u32;
        if self.steps.is_empty() || is_at_end_without_wrap {
            None
        } else {
            let next_pos = (self.position() % self.steps.len() as u32) + 1;
            Some(self.step(next_pos))
        }
    }

    /// Returns whether this non-wrapping sequence has completed its final cue.
    pub fn has_terminated(&self) -> bool {
        self.has_terminated_at_clock(None)
    }

    /// Returns whether this non-wrapping sequence has completed using an optional playback clock.
    pub fn has_terminated_at_clock(&self, clock: Option<&InstanceClock>) -> bool {
        if !self.is_at_non_wrapping_final_step() {
            return false;
        }

        let Some(termination_position) = self.termination_position() else {
            return false;
        };
        clock
            .map(|clock| clock.position > termination_position)
            .unwrap_or_else(|| self.activation_elapsed(None) > self.current_completion_duration())
    }

    /// Returns whether automatic sequence-end release is due at the current playback clock.
    pub(super) fn auto_end_release_due_at_clock(&self, clock: Option<&InstanceClock>) -> bool {
        let Some(release_position) = self.auto_end_release_position() else {
            return false;
        };
        clock
            .map(|clock| clock.position > release_position)
            .unwrap_or_else(|| self.activation_elapsed(None) > release_position)
    }

    /// Returns the source-local playback position where automatic sequence-end release starts.
    pub(super) fn auto_end_release_position(&self) -> Option<Duration> {
        self.termination_position()
    }

    /// Returns the source-local playback position where this non-wrapping sequence completes.
    pub(super) fn termination_position(&self) -> Option<Duration> {
        if !self.is_at_non_wrapping_final_step() {
            return None;
        }

        self.retained_cue_completion_position()
    }

    /// Returns the latest cue completion point across retained cue instances.
    fn retained_cue_completion_position(&self) -> Option<Duration> {
        self.retained_step_indices()
            .into_iter()
            .filter_map(|index| {
                let mcue = self.mcues.get(index)?;
                let activated_at = self
                    .cue_activation_positions
                    .get(index)
                    .and_then(|position| *position)
                    .or_else(|| {
                        (index == self.position_index).then_some(self.last_activation_position)
                    })?;
                Some(activated_at.saturating_add(mcue.cue_duration()))
            })
            .max()
    }

    /// Returns retained cue indices that can contribute assertion transition timing.
    fn retained_step_indices(&self) -> Vec<usize> {
        if self.composition_order.is_empty() {
            return vec![self.position_index];
        }

        self.composition_order
            .iter()
            .copied()
            .filter(|index| *index < self.mcues.len())
            .collect()
    }

    /// Returns whether sequence-end behavior may run for the current cue position.
    fn is_at_non_wrapping_final_step(&self) -> bool {
        !self.wrap && !self.steps.is_empty() && self.position() == self.steps.len() as u32
    }

    /// Returns the completion span for the active cue step.
    fn current_completion_duration(&self) -> Duration {
        self.mcues
            .get(self.position_index)
            .map(MaterializedCue::cue_duration)
            .unwrap_or_default()
    }

    /// Sets the position to the previous cue
    pub fn prev(&mut self) {
        self.prev_at_playback_position(None);
    }

    /// Sets the position to the previous cue at a source-local playback position.
    pub fn prev_at_playback_position(&mut self, playback_position: Option<Duration>) {
        let is_at_start_without_wrap = !self.wrap && self.position() == 1;
        if self.steps.is_empty() || is_at_start_without_wrap {
            return;
        }

        let prev_pos = if self.position() == 1 {
            self.steps.len() as u32
        } else {
            self.position() - 1
        };

        self.set_position_at_playback_position(prev_pos, playback_position);
    }

    /// Sets the position to the provided cue
    pub fn set_position(&mut self, position: u32) {
        self.set_position_at_playback_position(position, None);
    }

    /// Sets the position to the provided cue at a source-local playback position.
    pub fn set_position_at_playback_position(
        &mut self,
        position: u32,
        playback_position: Option<Duration>,
    ) {
        self.set_position_resetting_order(position, playback_position);
    }

    /// Sets the current cue and reconstructs source-local anchors for retained prior cues.
    pub fn set_position_reconstructing_prefix_at_playback_position(
        &mut self,
        position: u32,
        playback_position: Duration,
    ) {
        self.set_position_resetting_order(position, Some(playback_position));
        self.reconstruct_prefix_activation_positions();
    }

    /// Applies source-local transition timing to the active cue without changing host-time anchors.
    pub fn set_current_transition_position(&mut self, started_at: Duration) {
        self.release_layer = None;
        self.invalidate_render_prefix_cache();
        self.playback_start_position = started_at;
        self.last_activation_position = started_at;
        self.setup_cue.set_start_position(started_at);
        if let Some(position) = self.cue_activation_positions.get_mut(self.position_index) {
            *position = Some(started_at);
        }
        if let Some(mcue) = self.mcues.get_mut(self.position_index) {
            mcue.set_start_position(started_at);
        }
    }

    /// Applies source-local sequence start timing to setup and active cue anchors.
    pub fn set_sequence_start_timing(&mut self, timing: PlaybackReconstructionTiming) {
        self.set_current_transition_position(timing.started_at);
    }

    /// Advances to a cue position and makes that step the newest retained layer.
    fn advance_to_position(&mut self, position: u32, playback_position: Option<Duration>) {
        self.set_position_internal(position, true, playback_position);
    }

    /// Jumps to a cue position and rebuilds retained layers as a linear prefix.
    fn set_position_resetting_order(&mut self, position: u32, playback_position: Option<Duration>) {
        self.set_position_internal(position, false, playback_position);
    }

    /// Sets the active cue position and updates retained layer ordering.
    fn set_position_internal(
        &mut self,
        position: u32,
        preserve_existing_order: bool,
        playback_position: Option<Duration>,
    ) {
        tracing::trace!(
            uid = %self.identifiers().uid,
            "Setting sequence '{}' to position {}",
            self.identifiers().label,
            position
        );

        self.release_layer = None;
        self.invalidate_render_prefix_cache();

        if self.mcues.is_empty() {
            return;
        }

        let activation_time = Instant::now();
        let activation_position = playback_position.unwrap_or(self.last_activation_position);
        self.transition_source_layers
            .resize_with(self.mcues.len(), || None);
        self.cue_activation_positions
            .resize_with(self.mcues.len(), || None);

        // Trigger the out transition on current cue
        let index = self.position_index;
        let next_index = position as usize - 1;
        self.transition_source_layers[next_index] = None;

        let mcue = &mut self.mcues[index];
        mcue.release_position = Some(activation_position);

        // Update current cue
        self.position_index = next_index;
        if playback_position.is_none() {
            self.activation_time = activation_time;
        }
        self.last_activation_position = activation_position;
        self.cue_activation_positions[next_index] = Some(activation_position);
        if preserve_existing_order {
            self.move_step_to_newest(next_index);
        } else {
            self.reset_composition_order_to_prefix();
        }

        // (Re-)Trigger fade in transition on next cue and unset end time
        let index = self.position_index;
        let mcue = &mut self.mcues[index];
        mcue.set_start_position(activation_position);
        mcue.release_position = None;
    }

    /// Rebuilds activation and release anchors for a linear retained cue prefix.
    fn reconstruct_prefix_activation_positions(&mut self) {
        if self.mcues.is_empty() {
            return;
        }

        self.transition_source_layers
            .resize_with(self.mcues.len(), || None);
        self.cue_activation_positions
            .resize_with(self.mcues.len(), || None);
        self.cue_activation_positions.fill(None);
        for mcue in &mut self.mcues {
            mcue.release_position = None;
        }

        let active_index = self.position_index.min(self.mcues.len() - 1);
        let mut next_activation = self.last_activation_position;
        let mut retained_indices = Vec::with_capacity(active_index + 1);
        self.cue_activation_positions[active_index] = Some(next_activation);
        self.mcues[active_index].set_start_position(next_activation);
        self.mcues[active_index].release_position = None;
        retained_indices.push(active_index);

        for index in (0..active_index).rev() {
            let Some(due_after) =
                self.autonomous_due_after_for_step(index, index + 1, next_activation)
            else {
                break;
            };
            let current_activation = next_activation.saturating_sub(due_after);
            self.cue_activation_positions[index] = Some(current_activation);
            self.mcues[index].set_start_position(current_activation);
            self.mcues[index].release_position = Some(next_activation);
            retained_indices.push(index);
            next_activation = current_activation;
        }

        retained_indices.reverse();
        self.composition_order = retained_indices;
        self.invalidate_render_prefix_cache();
    }

    /// Returns the autonomous delay from one retained cue step to the next.
    fn autonomous_due_after_for_step(
        &self,
        current_index: usize,
        next_index: usize,
        next_activation: Duration,
    ) -> Option<Duration> {
        let next_cue = self.steps.get(next_index)?;
        let current_timing = SequenceStepTiming {
            trigger: self.steps.get(current_index)?.trigger,
            assertion_duration: self
                .mcues
                .get(current_index)
                .map(MaterializedCue::cue_duration)?,
        };
        let next_timing = SequenceStepTiming {
            trigger: next_cue.trigger,
            assertion_duration: Duration::ZERO,
        };
        if matches!(next_timing.trigger, CueTriggerType::At(_)) {
            self.reconstructed_activation_position_for_step(current_index)
                .map(|current_activation| next_activation.saturating_sub(current_activation))
        } else {
            sequence_activation_interval(
                current_timing,
                next_timing,
                Duration::ZERO,
                self.playback_start_position,
                false,
            )
        }
    }

    /// Replays trigger timing from sequence start to derive one retained step anchor.
    fn reconstructed_activation_position_for_step(&self, target_index: usize) -> Option<Duration> {
        if target_index >= self.steps.len() {
            return None;
        }

        let mut activation = self.playback_start_position;
        for next_index in 1..=target_index {
            let current_index = next_index - 1;
            let next_cue = self.steps.get(next_index)?;
            activation = sequence_next_activation_position(
                SequenceStepTiming {
                    trigger: self.steps.get(current_index)?.trigger,
                    assertion_duration: self
                        .mcues
                        .get(current_index)
                        .map(MaterializedCue::cue_duration)?,
                },
                SequenceStepTiming {
                    trigger: next_cue.trigger,
                    assertion_duration: Duration::ZERO,
                },
                activation,
                self.playback_start_position,
                false,
            )?;
        }
        Some(activation)
    }

    /// Moves the step to the newest end of the retained composition order.
    fn move_step_to_newest(&mut self, step_index: usize) {
        self.composition_order.retain(|index| *index != step_index);
        self.composition_order.push(step_index);
        self.invalidate_render_prefix_cache();
    }

    /// Resets retained composition order to cue order through the current position.
    pub(super) fn reset_composition_order_to_prefix(&mut self) {
        self.composition_order = (0..=self.position_index).collect();
        self.invalidate_render_prefix_cache();
    }

    /// Returns the cue at the provided position
    pub fn step(&self, position: u32) -> Cue {
        self.steps[position as usize - 1].clone()
    }

    /// Returns elapsed source-local time since the current cue was activated.
    fn activation_elapsed(&self, clock: Option<&InstanceClock>) -> Duration {
        clock
            .map(|clock| clock.position.saturating_sub(self.last_activation_position))
            .unwrap_or_default()
    }

    /// Returns the source-local activation position for the next autonomous cue, when due.
    pub(super) fn next_autonomous_activation_position(
        &self,
        clock: Option<&InstanceClock>,
    ) -> Option<Option<Duration>> {
        let is_at_end_without_wrap = !self.wrap && self.position() == self.steps.len() as u32;
        if self.steps.is_empty() || is_at_end_without_wrap {
            return None;
        }

        let current_index = self.position_index;
        let current_position = self.position();
        let current_cue_duration = self
            .mcues
            .get(current_index)
            .map(MaterializedCue::cue_duration)?;
        // A cue trigger controls entry into that cue. Cue 1 is already active
        // on materialization, so its trigger is considered only after wrapping.
        let next_position = if current_position == self.steps.len() as u32 {
            1
        } else {
            current_position + 1
        };
        let next_index = next_position.saturating_sub(1) as usize;
        let next_cue = self.steps.get(next_index)?;
        let is_wraparound =
            self.wrap && next_position == 1 && current_position == self.steps.len() as u32;
        let next_activation_position = sequence_next_activation_position(
            SequenceStepTiming {
                trigger: self.steps.get(current_index)?.trigger,
                assertion_duration: current_cue_duration,
            },
            SequenceStepTiming {
                trigger: next_cue.trigger,
                assertion_duration: Duration::ZERO,
            },
            self.last_activation_position,
            self.playback_start_position,
            is_wraparound,
        )?;

        let clock = clock?;

        // Defer only while the clock is strictly before the activation point.
        // Equality means the next cue is due on this tick, so treating it as
        // not-yet-due would make exact-boundary activations run one frame late.
        if clock.position < next_activation_position {
            return None;
        }

        Some(Some(next_activation_position))
    }

    /// Advances through every autonomous cue transition due at the provided clock position.
    pub(super) fn advance_autonomous_at_clock(&mut self, clock: Option<&InstanceClock>) -> usize {
        let mut autonomous_advances = 0;
        while autonomous_advances < MAX_AUTONOMOUS_SEQUENCE_ADVANCES_PER_TICK {
            let Some(next_activation_position) = self.next_autonomous_activation_position(clock)
            else {
                break;
            };
            self.next_at_playback_position(next_activation_position);
            autonomous_advances += 1;
        }
        autonomous_advances
    }
}
