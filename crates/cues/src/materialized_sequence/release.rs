// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::materialize::cue_has_scoped_instructions;
use super::*;

impl MaterializedSequence {
    /// Starts release transitions from the frozen last rendered sequence look.
    pub fn release_from_rendered_assertions(
        &mut self,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) {
        self.release_from_rendered_assertions_at_position(data_provider, parameter_query, None);
    }

    /// Freezes rendered assertions and starts release transitions at a source-local position.
    pub fn release_from_rendered_assertions_at_position(
        &mut self,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        release_position: Option<Duration>,
    ) {
        let release_position = release_position.unwrap_or_default();
        if self.release_layer.is_some() {
            if self.release_started_position.is_none() {
                self.release_started_position = Some(release_position);
            }
            if let Some(release_layer) = &mut self.release_layer {
                mark_layer_released_at_position(release_layer, release_position);
            }
            return;
        }

        let Some(last_rendered_layer) = self.last_rendered_layer.clone() else {
            return;
        };

        self.release_started_position = Some(release_position);
        self.release_duration_floor = self.release_cue_timing_duration();
        let release_timings = self.release_cue.release_timings_by_parameter();
        let preserve_unmatched_parameters =
            !cue_has_scoped_instructions(&self.release_cue.cue) || release_timings.is_empty();
        let scoped_unmatched_hold_transition =
            self.scoped_unmatched_release_hold_transition(release_position);
        let mut release_layer = Layer::new(self.identifiers().label.clone(), self.priority);
        release_layer.activation_time = last_rendered_layer.activation_time;

        for (parameter, (value, _)) in last_rendered_layer.absolute.iter() {
            let transition = release_timings
                .get(parameter)
                .map(|timing| {
                    release_transition_from_release_cue_timing(
                        &parameter,
                        timing,
                        parameter_query,
                        release_position,
                    )
                })
                .or_else(|| {
                    self.global_release_transition(&parameter, parameter_query, release_position)
                })
                .or_else(|| scoped_unmatched_hold_transition.clone())
                .map(Some)
                .or_else(|| preserve_unmatched_parameters.then_some(None));
            if let Some(transition) = transition {
                release_layer
                    .absolute
                    .insert(parameter, (*value, transition));
            }
        }
        for (parameter, (value, _)) in last_rendered_layer.relative.iter() {
            let transition = release_timings
                .get(parameter)
                .map(|timing| {
                    release_transition_from_release_cue_timing(
                        &parameter,
                        timing,
                        parameter_query,
                        release_position,
                    )
                })
                .or_else(|| {
                    self.global_release_transition(&parameter, parameter_query, release_position)
                })
                .or_else(|| scoped_unmatched_hold_transition.clone())
                .map(Some)
                .or_else(|| preserve_unmatched_parameters.then_some(None));
            if let Some(transition) = transition {
                release_layer
                    .relative
                    .insert(parameter, (*value, transition));
            }
        }

        let mut release_cue = MaterializedCue {
            cue: self.release_cue.cue.clone(),
            values: release_layer,
            priority: self.priority,
            activation_time: last_rendered_layer.activation_time,
            start_position: release_position,
            ..Default::default()
        };
        release_cue.delay_ltp_release_until_htp_release_complete(data_provider, parameter_query);
        [
            &mut release_cue.values.absolute,
            &mut release_cue.values.relative,
        ]
        .iter_mut()
        .for_each(|layer| {
            layer.iter_mut().for_each(|(_, (_, transition))| {
                if let Some(transition) = transition.as_mut() {
                    transition.mark_released_at_position_if_unset(release_position);
                }
            });
        });

        self.release_layer = Some(release_cue.values);
    }

    /// Builds the sequence release cue's global timing as a release-layer entry transition.
    fn global_release_transition(
        &self,
        parameter: &ParameterRef,
        parameter_query: &Query<InstanceRef<Parameter>>,
        release_position: Duration,
    ) -> Option<MaterializedTransition> {
        if cue_has_scoped_instructions(&self.release_cue.cue) {
            return None;
        }
        if !global_release_timing_applies_to_parameter(
            parameter,
            &self.release_cue.cue.transitions,
            parameter_query,
        ) {
            return None;
        }

        let mut transition = Transition::default();
        transition.apply_some(self.release_cue.cue.transitions.clone());
        let timing = MaterializedTransition::from_transition(&transition, 0, 1);
        Some(release_transition_from_release_cue_timing(
            parameter,
            &timing,
            parameter_query,
            release_position,
        ))
    }

    /// Builds a hold-only transition placeholder for values outside a scoped release cue's instructions.
    fn scoped_unmatched_release_hold_transition(
        &self,
        release_position: Duration,
    ) -> Option<MaterializedTransition> {
        if !cue_has_scoped_instructions(&self.release_cue.cue) {
            return None;
        }

        if self.release_cue_timing_duration().is_zero() {
            return None;
        }

        Some(MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: release_position,
            release_position: Some(release_position),
        })
    }

    /// Renders the sequence state that should be frozen as a source-local release snapshot.
    pub fn render_release_snapshot_at_position(
        &mut self,
        param_query: &mut Query<InstanceMut<Parameter>>,
        release_position: Duration,
    ) {
        let mut release_clock = InstanceClock::default();
        release_clock.seek_to(release_position);
        self.advance_autonomous_at_clock(Some(&release_clock));
        self.render_release_snapshot_at_current_position(param_query, release_position);
    }

    /// Freezes the already-advanced materialized state at a source-local release position.
    pub(super) fn render_release_snapshot_at_current_position(
        &mut self,
        param_query: &mut Query<InstanceMut<Parameter>>,
        release_position: Duration,
    ) {
        let mut release_clock = InstanceClock::default();
        release_clock.seek_to(release_position);
        self.to_layer_at_clock(param_query, Some(&release_clock));
    }

    /// Returns whether this sequence has started rendering its frozen release layer.
    pub fn is_releasing(&self) -> bool {
        self.release_layer.is_some()
    }

    /// Returns whether this sequence has the release anchor required by its clock domain.
    pub(super) fn has_release_anchor_for_clock(&self, _clock: Option<&InstanceClock>) -> bool {
        self.release_started_position.is_some()
    }

    /// Returns the source-local playback position where release began, if known.
    pub fn release_started_position(&self) -> Option<Duration> {
        self.release_started_position
    }

    /// Returns the longest release duration across sequence release output.
    pub fn max_release_duration(&self) -> Duration {
        if let Some(release_layer) = &self.release_layer {
            return self.release_duration_floor.max(
                release_layer
                    .absolute
                    .iter()
                    .chain(release_layer.relative.iter())
                    .filter_map(|(_, (_, transition))| {
                        transition
                            .as_ref()
                            .map(MaterializedTransition::release_duration)
                    })
                    .max()
                    .unwrap_or_default(),
            );
        }

        self.release_duration_floor.max(
            self.mcues
                .iter()
                .map(MaterializedCue::max_release_duration)
                .max()
                .unwrap_or_default(),
        )
    }

    /// Returns whether the frozen release output has fully completed its release transitions.
    pub(super) fn release_complete(&self, grace: Duration, release_elapsed: Duration) -> bool {
        let Some(release_layer) = &self.release_layer else {
            return release_elapsed > self.max_release_duration() + grace;
        };

        let max_release_duration = self.max_release_duration();
        if release_elapsed <= max_release_duration + grace {
            return false;
        }
        if !max_release_duration.is_zero() {
            return true;
        }

        let has_transition = release_layer
            .absolute
            .values()
            .chain(release_layer.relative.values())
            .filter_map(|(_, transition)| transition.as_ref())
            .next()
            .is_some();

        has_transition || release_elapsed > grace
    }

    /// Returns the release cue timing span that must elapse even when no output changes.
    fn release_cue_timing_duration(&self) -> Duration {
        self.release_cue
            .duration_profile
            .cue_entry_duration()
            .max(self.sequence.release_cue.authored_duration())
    }
}

/// Choose whether explicit global release timing applies to the parameter merge strategy.
fn global_release_timing_applies_to_parameter(
    parameter: &ParameterRef,
    transition: &PartialTransition,
    parameter_query: &Query<InstanceRef<Parameter>>,
) -> bool {
    if parameter_query
        .get(parameter.entity())
        .is_ok_and(|parameter| matches!(parameter.metadata.merge_type, MergeStrategy::HTP))
    {
        selected_out_timing_is_explicit(transition)
    } else {
        selected_in_timing_is_explicit(transition)
    }
}

fn release_transition_from_release_cue_timing(
    parameter: &ParameterRef,
    timing: &MaterializedTransition,
    parameter_query: &Query<InstanceRef<Parameter>>,
    release_position: Duration,
) -> MaterializedTransition {
    let use_out_timing = parameter_query
        .get(parameter.entity())
        .is_ok_and(|parameter| matches!(parameter.metadata.merge_type, MergeStrategy::HTP));
    let (delay_out, fade_out, curve_out) = if use_out_timing {
        (timing.delay_out, timing.fade_out, timing.curve_out)
    } else {
        (timing.delay_in, timing.fade_in, timing.curve_in)
    };

    MaterializedTransition {
        delay_in: Duration::ZERO,
        fade_in: Duration::ZERO,
        curve_in: FadeCurve::Linear,
        delay_out,
        fade_out,
        curve_out,
        start_position: release_position,
        release_position: Some(release_position),
    }
}

fn selected_in_timing_is_explicit(transition: &PartialTransition) -> bool {
    transition.delay_in.is_some() || transition.fade_in.is_some() || transition.curve_in.is_some()
}

fn selected_out_timing_is_explicit(transition: &PartialTransition) -> bool {
    transition.delay_out.is_some()
        || transition.fade_out.is_some()
        || transition.curve_out.is_some()
}

/// Marks every transition in a layer released at a source-local playback position.
fn mark_layer_released_at_position(layer: &mut Layer, release_position: Duration) {
    [&mut layer.absolute, &mut layer.relative]
        .into_iter()
        .for_each(|values| {
            values.iter_mut().for_each(|(_, (_, maybe_transition))| {
                if let Some(transition) = maybe_transition {
                    transition.mark_released_at_position_if_unset(release_position);
                }
            });
        });
}

/// Marks every transition in a materialized cue released at its preserved source-local position.
pub(super) fn mark_materialized_cue_released_at_position(
    cue: &mut MaterializedCue,
    release_position: Option<Duration>,
) {
    let Some(release_position) = release_position else {
        return;
    };
    for transition in cue
        .values
        .absolute
        .values_mut()
        .chain(cue.values.relative.values_mut())
        .filter_map(|(_, transition)| transition.as_mut())
        .chain(cue.release_timing_overrides.values_mut())
    {
        transition.mark_released_at_position_if_unset(release_position);
    }
}
