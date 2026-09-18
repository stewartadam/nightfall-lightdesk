// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, time::Duration};

use nightfall_dmx::prelude::*;
use partially::Partial;
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use typeshare::typeshare;

#[typeshare::typeshare]
#[typeshare(serialized_as = "Record<String, PartialTransition>")]
pub type AttributeTransitions = HashMap<Attribute, PartialTransition>;

/// Timing distribution used to resolve a delay or fade duration for each target.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TransitionMode {
    #[default]
    Fixed(Duration), // apply a single transition to all
    Interpolated {
        start: Duration,
        end: Duration,
    }, // apply a fanned transition across the targets
    Manual(Vec<Duration>), // envelope with interpolated waypoints across the selection
}
impl TransitionMode {
    /// Offset is zero-indexed
    pub fn resolve(&self, offset: usize, total: usize) -> Duration {
        match self {
            TransitionMode::Fixed(duration) => *duration,
            TransitionMode::Interpolated { start, end } => {
                if total <= 1 {
                    *start
                } else {
                    let factor = offset as f32 / (total - 1).max(1) as f32;
                    let interpolated =
                        start.as_secs_f32() + factor * (end.as_secs_f32() - start.as_secs_f32());
                    Duration::from_secs_f32(interpolated)
                }
            }
            TransitionMode::Manual(durations) => {
                if durations.is_empty() {
                    return Duration::from_millis(0);
                }
                if durations.len() == 1 || total <= 1 {
                    return durations[0];
                }

                // Calculate the position in the range [0.0, 1.0]
                // This matches resolve_fanned_value semantics in materialized_cue.rs
                let t = offset as f32 / (total - 1).max(1) as f32;

                // Map t to a position in the durations array (envelope interpolation)
                let max_segment = durations.len() - 1;
                let segment_position = t * max_segment as f32;
                let segment_idx = (segment_position as usize).min(max_segment - 1);
                let segment_t = segment_position - segment_idx as f32;

                // Interpolate between adjacent waypoints
                let start = durations[segment_idx].as_secs_f32();
                let end = durations[segment_idx + 1].as_secs_f32();
                Duration::from_secs_f32(start + segment_t * (end - start))
            }
        }
    }

    /// Returns the longest duration this timing mode can resolve to.
    pub fn duration_ceiling(&self) -> Duration {
        match self {
            TransitionMode::Fixed(duration) => *duration,
            TransitionMode::Interpolated { start, end } => (*start).max(*end),
            TransitionMode::Manual(durations) => {
                durations.iter().copied().max().unwrap_or_default()
            }
        }
    }
}

/// Defines how a cue will be triggered.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum CueTriggerType {
    /// Cue will advance only on a "Go" command to the associated clip.
    Manual,
    /// Cue will advance when all delays+fades of previous cue are completed.
    #[default]
    FollowPrevious,
    /// Cue will advance a predetermined amount of time after the previous cue's
    /// start (delay tracks immediately after prior cue start, regardless of its
    /// fade/delay configuration).
    AfterDelay(
        /// Amount of time to wait, in milliseconds, after previous cue starts.
        Duration,
    ),
    /// Cue will advance at a predetermined amount of time after the sequence
    /// starts, regardless of earlier cue timing.
    At(
        /// Amount of time to wait after sequence activation.
        Duration,
    ),
}

/// Delay, fade, and curve settings applied when values enter or leave a state.
#[derive(Partial, Debug, Default, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[partially(derive(Default, Serialize, Deserialize, Debug, Clone))]
pub struct Transition {
    pub delay_in: TransitionMode,
    pub fade_in: TransitionMode,
    pub curve_in: FadeCurve,
    pub delay_out: TransitionMode,
    pub fade_out: TransitionMode,
    pub curve_out: FadeCurve,
}

impl Transition {
    /// Returns the source-local span occupied while values assert.
    pub fn assertion_duration(&self) -> Duration {
        self.delay_in
            .duration_ceiling()
            .saturating_add(self.fade_in.duration_ceiling())
    }

    /// Returns the source-local span occupied while values release.
    pub fn release_duration(&self) -> Duration {
        self.delay_out
            .duration_ceiling()
            .saturating_add(self.fade_out.duration_ceiling())
    }

    /// Returns the larger assertion or release span for this transition.
    pub fn authored_duration(&self) -> Duration {
        self.assertion_duration().max(self.release_duration())
    }
}

impl PartialTransition {
    /// Returns a transition whose missing fields inherit from another partial transition.
    pub fn inheriting(&self, inherited: &PartialTransition) -> PartialTransition {
        PartialTransition {
            delay_in: self.delay_in.clone().or_else(|| inherited.delay_in.clone()),
            fade_in: self.fade_in.clone().or_else(|| inherited.fade_in.clone()),
            curve_in: self.curve_in.or(inherited.curve_in),
            delay_out: self
                .delay_out
                .clone()
                .or_else(|| inherited.delay_out.clone()),
            fade_out: self.fade_out.clone().or_else(|| inherited.fade_out.clone()),
            curve_out: self.curve_out.or(inherited.curve_out),
        }
    }

    /// Returns a transition whose missing fields inherit from sequence default timing.
    pub fn with_default_timing(&self, default_timing: &Transition) -> PartialTransition {
        PartialTransition {
            delay_in: self
                .delay_in
                .clone()
                .or_else(|| Some(default_timing.delay_in.clone())),
            fade_in: self
                .fade_in
                .clone()
                .or_else(|| Some(default_timing.fade_in.clone())),
            curve_in: self.curve_in.or(Some(default_timing.curve_in)),
            delay_out: self
                .delay_out
                .clone()
                .or_else(|| Some(default_timing.delay_out.clone())),
            fade_out: self
                .fade_out
                .clone()
                .or_else(|| Some(default_timing.fade_out.clone())),
            curve_out: self.curve_out.or(Some(default_timing.curve_out)),
        }
    }

    /// Returns the larger authored assertion or release span for this transition.
    pub fn authored_duration(&self) -> Duration {
        let mut resolved = Transition::default();
        resolved.apply_some(self.clone());
        resolved.authored_duration()
    }
}

/// Returns the authored duration of a cue-level transition and its part transitions.
pub fn cue_authored_duration<'a>(
    cue_transition: &PartialTransition,
    part_transitions: impl IntoIterator<Item = &'a PartialTransition>,
) -> Duration {
    let mut duration = cue_transition.authored_duration();
    for part_transition in part_transitions {
        duration = duration.max(
            part_transition
                .inheriting(cue_transition)
                .authored_duration(),
        );
    }
    duration
}

/// Resolved cue-step timing used by sequence scheduling helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SequenceStepTiming {
    /// Trigger policy on this cue step.
    pub trigger: CueTriggerType,
    /// Source-local transition span for this cue after defaults are applied.
    pub assertion_duration: Duration,
}

/// Computed source-local timing for one sequence step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SequenceStepTimingSummary {
    /// Step start time, absent after manual timing makes it unknowable.
    pub start_time: Option<Duration>,
    /// Retained display duration for this step, absent across manual boundaries.
    pub duration: Option<Duration>,
}

/// Computed source-local timing summary for a sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SequenceTimingSummary {
    /// Computed values for each step in request order.
    pub steps: Vec<SequenceStepTimingSummary>,
    /// Total sequence duration, absent when a manual boundary makes it unknowable.
    pub total: Option<Duration>,
}

/// Returns the source-local activation position for an automatic next cue.
pub fn sequence_next_activation_position(
    current_timing: SequenceStepTiming,
    next_timing: SequenceStepTiming,
    current_activation: Duration,
    playback_start_position: Duration,
    is_wraparound: bool,
) -> Option<Duration> {
    match next_timing.trigger {
        CueTriggerType::Manual => None,
        CueTriggerType::FollowPrevious => {
            Some(current_activation.saturating_add(current_timing.assertion_duration))
        }
        CueTriggerType::AfterDelay(delay) => {
            Some(current_activation.saturating_add(if is_wraparound {
                delay.max(current_timing.assertion_duration)
            } else {
                delay
            }))
        }
        CueTriggerType::At(delay) => {
            let absolute_activation = playback_start_position.saturating_add(delay);
            if is_wraparound {
                Some(
                    absolute_activation
                        .max(current_activation.saturating_add(current_timing.assertion_duration)),
                )
            } else {
                Some(absolute_activation)
            }
        }
    }
}

/// Returns the source-local interval from one cue activation to the next.
pub fn sequence_activation_interval(
    current_timing: SequenceStepTiming,
    next_timing: SequenceStepTiming,
    current_activation: Duration,
    playback_start_position: Duration,
    is_wraparound: bool,
) -> Option<Duration> {
    sequence_next_activation_position(
        current_timing,
        next_timing,
        current_activation,
        playback_start_position,
        is_wraparound,
    )
    .map(|next_activation| next_activation.saturating_sub(current_activation))
}

/// Computes sequence step start offsets, retained display durations, and total duration.
pub fn sequence_timing_summary(
    step_timings: &[SequenceStepTiming],
    wrap: bool,
) -> SequenceTimingSummary {
    let mut steps = Vec::with_capacity(step_timings.len());
    let mut next_start_time = Duration::ZERO;
    let mut next_start_time_is_known = true;
    let mut total_is_known = !step_timings.is_empty();
    let mut total = (!step_timings.is_empty()).then_some(Duration::ZERO);

    for (index, timing) in step_timings.iter().copied().enumerate() {
        let next_index = if index + 1 < step_timings.len() {
            Some(index + 1)
        } else if wrap && !step_timings.is_empty() {
            Some(0)
        } else {
            None
        };
        let start_time = next_start_time_is_known.then_some(next_start_time);
        let interval = next_index.and_then(|next_index| {
            sequence_activation_interval(
                timing,
                *step_timings.get(next_index)?,
                next_start_time,
                Duration::ZERO,
                wrap && index + 1 == step_timings.len() && next_index == 0,
            )
        });
        let duration = if next_index.is_none() {
            Some(timing.assertion_duration)
        } else {
            interval.map(|interval| timing.assertion_duration.max(interval))
        };

        steps.push(SequenceStepTimingSummary {
            start_time,
            duration,
        });

        if let (true, Some(duration)) = (next_start_time_is_known, duration) {
            total = Some(
                total
                    .unwrap_or_default()
                    .max(next_start_time.saturating_add(duration)),
            );
        }

        if next_index.is_some() {
            match (next_start_time_is_known, interval) {
                (true, Some(interval)) => {
                    next_start_time = next_start_time.saturating_add(interval);
                }
                _ => {
                    total_is_known = false;
                    next_start_time_is_known = false;
                }
            }
        }
    }

    SequenceTimingSummary {
        steps,
        total: total_is_known.then_some(total).flatten(),
    }
}

/// Easing curve used to map transition progress to output intensity.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum FadeCurve {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    //Custom(Arc<dyn Fn(f32) -> f32 + Send + Sync>),
}

/// Evaluates one normalized CSS-style cubic Bézier timing function.
///
/// The horizontal control points must be within `0.0..=1.0` so elapsed
/// progress maps to one unambiguous curve parameter. Vertical control points
/// may extend beyond that range when an overshooting curve is desired.
pub fn evaluate_cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, progress: f32) -> f32 {
    let progress = progress.clamp(0.0, 1.0);
    if progress == 0.0 || progress == 1.0 {
        return progress;
    }

    let mut parameter = progress;
    for _ in 0..8 {
        let error = cubic_bezier_component(x1, x2, parameter) - progress;
        if error.abs() <= 1e-6 {
            return cubic_bezier_component(y1, y2, parameter);
        }
        let derivative = cubic_bezier_component_derivative(x1, x2, parameter);
        if derivative.abs() <= 1e-6 {
            break;
        }
        let next = parameter - error / derivative;
        if !(0.0..=1.0).contains(&next) {
            break;
        }
        parameter = next;
    }

    let mut lower = 0.0;
    let mut upper = 1.0;
    for _ in 0..20 {
        parameter = (lower + upper) * 0.5;
        if cubic_bezier_component(x1, x2, parameter) < progress {
            lower = parameter;
        } else {
            upper = parameter;
        }
    }
    cubic_bezier_component(y1, y2, parameter)
}

/// Evaluates one cubic Bézier axis with normalized zero and one endpoints.
fn cubic_bezier_component(control1: f32, control2: f32, parameter: f32) -> f32 {
    let inverse = 1.0 - parameter;
    3.0 * control1 * inverse * inverse * parameter
        + 3.0 * control2 * inverse * parameter * parameter
        + parameter * parameter * parameter
}

/// Evaluates the parameter derivative for one normalized cubic Bézier axis.
fn cubic_bezier_component_derivative(control1: f32, control2: f32, parameter: f32) -> f32 {
    let inverse = 1.0 - parameter;
    3.0 * control1 * (inverse * inverse - 2.0 * inverse * parameter)
        + 3.0 * control2 * (2.0 * inverse * parameter - parameter * parameter)
        + 3.0 * parameter * parameter
}

impl FadeCurve {
    /// Maps normalized transition progress through the selected easing curve.
    pub fn evaluate_at(&self, ratio: f32) -> f32 {
        let evaluated = match self {
            FadeCurve::Linear => ratio,
            FadeCurve::EaseIn => evaluate_cubic_bezier(0.32, 0.0, 0.67, 0.0, ratio),
            FadeCurve::EaseOut => 1.0 - evaluate_cubic_bezier(0.32, 0.0, 0.67, 0.0, 1.0 - ratio),
            FadeCurve::EaseInOut => {
                if ratio < 0.5 {
                    0.5 * evaluate_cubic_bezier(0.32, 0.0, 0.67, 0.0, 2.0 * ratio)
                } else {
                    1.0 - 0.5 * evaluate_cubic_bezier(0.32, 0.0, 0.67, 0.0, 2.0 * (1.0 - ratio))
                }
            }
        };

        assert!((0.0..=1.0).contains(&evaluated));
        evaluated
    }
}

/// Stores transition timing information for a single parameter and to be
/// resolved by compositor since the base layer is known, we cannot yet
/// resolve into a specific (delay/fade/curve) tuple.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializedTransition {
    /// Source-local delay before the transition-in fade starts.
    pub delay_in: Duration,
    /// Source-local transition-in fade duration.
    pub fade_in: Duration,
    /// Curve used for transition-in fade progress.
    pub curve_in: FadeCurve,
    /// Source-local delay before the transition-out or release fade starts.
    pub delay_out: Duration,
    /// Source-local transition-out or release fade duration.
    pub fade_out: Duration,
    /// Curve used for transition-out or release fade progress.
    pub curve_out: FadeCurve,
    /// Source-local playback position where this transition's assertion began.
    pub start_position: Duration,
    /// Source-local playback position where this transition began releasing.
    ///
    /// This per-transition anchor is the canonical release timing source. Layer-level release
    /// anchors are compatibility/context fallbacks for producers that cannot yet stamp every
    /// transition.
    pub release_position: Option<Duration>,
}
impl MaterializedTransition {
    /// Resolves a fade progress ratio for an explicit elapsed transition duration.
    pub fn fade_ratio_at_elapsed(elapsed: Duration, fade: Duration, delay: Duration) -> f32 {
        if elapsed < delay {
            return 0.0;
        }

        if fade.is_zero() {
            1.0
        } else {
            (elapsed.saturating_sub(delay).as_secs_f32() / fade.as_secs_f32()).clamp(0.0, 1.0)
        }
    }

    /// Resolves a curved parameter ratio for an explicit elapsed transition duration.
    pub fn parameter_ratio_at_elapsed(
        elapsed: Duration,
        fade: Duration,
        delay: Duration,
        curve: FadeCurve,
    ) -> f32 {
        let progress = Self::fade_ratio_at_elapsed(elapsed, fade, delay);
        let ratio = curve.evaluate_at(progress);

        assert!((0.0..=1.0).contains(&ratio));
        ratio
    }

    /// Returns elapsed time between a source-local evaluation position and transition anchor.
    pub fn elapsed(evaluation_position: Duration, started_at: Duration) -> Duration {
        evaluation_position.saturating_sub(started_at)
    }

    /// Returns elapsed assertion time at a source-local playback position.
    pub fn elapsed_from_start(&self, evaluation_position: Duration) -> Duration {
        Self::elapsed(evaluation_position, self.start_position)
    }

    pub fn from_transition(
        transition: &Transition,
        offset: usize,
        total: usize,
    ) -> MaterializedTransition {
        Self::from_transition_at_position(transition, offset, total, Duration::ZERO)
    }

    /// Materializes a transition at a source-local playback position.
    pub fn from_transition_at_position(
        transition: &Transition,
        offset: usize,
        total: usize,
        start_position: Duration,
    ) -> MaterializedTransition {
        MaterializedTransition {
            delay_in: transition.delay_in.resolve(offset, total),
            fade_in: transition.fade_in.resolve(offset, total),
            delay_out: transition.delay_out.resolve(offset, total),
            fade_out: transition.fade_out.resolve(offset, total),
            curve_in: transition.curve_in,
            curve_out: transition.curve_out,
            start_position,
            release_position: None,
        }
    }

    /// Materializes a release-only transition at a source-local release position.
    pub fn release_from_timing_at_position(
        timing: &MaterializedTransition,
        release_position: Duration,
    ) -> MaterializedTransition {
        MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: timing.delay_out,
            fade_out: timing.fade_out,
            curve_out: timing.curve_out,
            start_position: release_position,
            release_position: Some(release_position),
        }
    }

    /// Calculates transition-in progress for an explicit elapsed duration.
    pub fn transition_in_parameter_ratio_at_elapsed(&self, elapsed: Duration) -> f32 {
        Self::parameter_ratio_at_elapsed(elapsed, self.fade_in, self.delay_in, self.curve_in)
    }

    /// Calculates transition-in progress at a source-local playback position.
    pub fn transition_in_parameter_ratio_at_position(
        &self,
        evaluation_position: Duration,
        started_at: Duration,
    ) -> f32 {
        self.transition_in_parameter_ratio_at_elapsed(Self::elapsed(
            evaluation_position,
            started_at,
        ))
    }

    /// Calculates transition-out progress for an explicit elapsed duration.
    pub fn transition_out_parameter_ratio_at_elapsed(&self, elapsed: Duration) -> f32 {
        Self::parameter_ratio_at_elapsed(elapsed, self.fade_out, self.delay_out, self.curve_out)
    }

    /// Calculates transition-out progress at a source-local playback position.
    pub fn transition_out_parameter_ratio_at_position(
        &self,
        evaluation_position: Duration,
        started_at: Duration,
    ) -> f32 {
        self.transition_out_parameter_ratio_at_elapsed(Self::elapsed(
            evaluation_position,
            started_at,
        ))
    }

    /// Calculates release progress for an explicit elapsed release duration.
    pub fn transition_release_parameter_ratio_at_elapsed(&self, elapsed: Duration) -> f32 {
        Self::parameter_ratio_at_elapsed(elapsed, self.fade_out, self.delay_out, self.curve_out)
    }

    /// Calculates release progress at a source-local playback position.
    pub fn transition_release_parameter_ratio_at_position(
        &self,
        evaluation_position: Duration,
        released_at: Duration,
    ) -> f32 {
        self.transition_release_parameter_ratio_at_elapsed(Self::elapsed(
            evaluation_position,
            released_at,
        ))
    }

    /// Returns the full duration a release needs before the parameter reaches its target.
    pub fn release_duration(&self) -> Duration {
        self.delay_out + self.fade_out
    }

    /// Returns whether this transition has started release in any clock domain.
    pub fn is_released(&self) -> bool {
        self.release_position.is_some()
    }

    /// Sets this transition's release anchor to a source-local playback position.
    pub fn set_released_at_position(&mut self, release_position: Duration) {
        self.release_position = Some(release_position);
    }

    /// Marks this transition released if it does not already have a release anchor.
    pub fn mark_released_at_position_if_unset(&mut self, release_position: Duration) {
        self.release_position.get_or_insert(release_position);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fixed_returns_same_duration_for_all() {
        let mode = TransitionMode::Fixed(Duration::from_secs(2));
        assert_eq!(mode.resolve(0, 10), Duration::from_secs(2));
        assert_eq!(mode.resolve(5, 10), Duration::from_secs(2));
        assert_eq!(mode.resolve(9, 10), Duration::from_secs(2));
    }

    #[test]
    fn test_interpolated_linear_fan() {
        let mode = TransitionMode::Interpolated {
            start: Duration::ZERO,
            end: Duration::from_secs(2),
        };

        assert_eq!(mode.resolve(0, 4), Duration::ZERO);
        assert_eq!(mode.resolve(1, 4), Duration::from_secs_f32(2.0 / 3.0));
        assert_eq!(mode.resolve(2, 4), Duration::from_secs_f32(4.0 / 3.0));
        assert_eq!(mode.resolve(3, 4), Duration::from_secs(2));
    }

    #[test]
    fn test_manual_single_value_returns_same_for_all() {
        let mode = TransitionMode::Manual(vec![Duration::from_secs(5)]);
        assert_eq!(mode.resolve(0, 10), Duration::from_secs(5));
        assert_eq!(mode.resolve(5, 10), Duration::from_secs(5));
        assert_eq!(mode.resolve(9, 10), Duration::from_secs(5));
    }

    #[test]
    fn test_manual_envelope_interpolation_two_values() {
        // Two values should behave like Interpolated
        let mode = TransitionMode::Manual(vec![Duration::from_secs(0), Duration::from_secs(10)]);

        // 10 fixtures: positions 0..9, t = offset / 9
        assert_eq!(mode.resolve(0, 10), Duration::from_secs(0)); // t=0
        assert_eq!(mode.resolve(9, 10), Duration::from_secs(10)); // t=1

        // Middle fixture should interpolate
        let mid = mode.resolve(4, 10); // t ≈ 0.44
        assert!(mid > Duration::from_secs(4) && mid < Duration::from_secs(5));
    }

    #[test]
    fn test_manual_envelope_interpolation_three_values() {
        // fade 0>3>1 scenario from the feedback
        let mode = TransitionMode::Manual(vec![
            Duration::from_secs(0),
            Duration::from_secs(3),
            Duration::from_secs(1),
        ]);

        // 10 fixtures: first gets 0, last gets 1, middle gets 3
        assert_eq!(mode.resolve(0, 10), Duration::from_secs(0)); // t=0, first waypoint
        assert_eq!(mode.resolve(9, 10), Duration::from_secs(1)); // t=1, last waypoint

        // Middle fixture (offset 4-5) should be near the peak of 3s
        let mid = mode.resolve(4, 10); // t ≈ 0.44, in first segment
        assert!(mid > Duration::from_secs(2));

        // Verify all fixtures get reasonable values (not 0 for out-of-range)
        for i in 0..10 {
            let dur = mode.resolve(i, 10);
            // Should be between 0 and 3 (the min and max waypoints)
            assert!(dur <= Duration::from_secs(3));
        }
    }

    /// Verifies a three-point manual fan places the center target on the middle waypoint.
    #[test]
    fn test_manual_envelope_interpolation_center_waypoint() {
        let mode = TransitionMode::Manual(vec![
            Duration::from_secs(0),
            Duration::from_secs(5),
            Duration::from_secs(0),
        ]);

        assert_eq!(mode.resolve(0, 3), Duration::from_secs(0));
        assert_eq!(mode.resolve(1, 3), Duration::from_secs(5));
        assert_eq!(mode.resolve(2, 3), Duration::from_secs(0));
        assert_eq!(mode.resolve(1, 5), Duration::from_secs_f32(2.5));
        assert_eq!(mode.resolve(3, 5), Duration::from_secs_f32(2.5));
    }

    #[test]
    fn test_manual_exact_match_count() {
        // When fixture count equals value count, values map 1:1 to positions
        let mode = TransitionMode::Manual(vec![
            Duration::from_secs(1),
            Duration::from_secs(5),
            Duration::from_secs(2),
        ]);

        // 3 fixtures, 3 values
        assert_eq!(mode.resolve(0, 3), Duration::from_secs(1));
        assert_eq!(mode.resolve(1, 3), Duration::from_secs(5));
        assert_eq!(mode.resolve(2, 3), Duration::from_secs(2));
    }

    #[test]
    fn test_manual_empty_returns_zero() {
        let mode = TransitionMode::Manual(vec![]);
        assert_eq!(mode.resolve(0, 10), Duration::from_millis(0));
        assert_eq!(mode.resolve(5, 10), Duration::from_millis(0));
    }

    #[test]
    fn test_manual_single_fixture() {
        let mode = TransitionMode::Manual(vec![
            Duration::from_secs(1),
            Duration::from_secs(3),
            Duration::from_secs(2),
        ]);
        // Single fixture should get first value
        assert_eq!(mode.resolve(0, 1), Duration::from_secs(1));
    }

    // Tests for MaterializedTransition fade progress methods

    fn create_transition(
        delay_in: Duration,
        fade_in: Duration,
        curve_in: FadeCurve,
    ) -> MaterializedTransition {
        MaterializedTransition {
            delay_in,
            fade_in,
            curve_in,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        }
    }

    /// Verifies explicit elapsed-duration evaluation preserves sub-millisecond progress.
    #[test]
    fn fade_ratio_at_elapsed_preserves_sub_millisecond_progress() {
        let ratio = MaterializedTransition::fade_ratio_at_elapsed(
            Duration::from_micros(500),
            Duration::from_millis(1),
            Duration::ZERO,
        );

        assert!(
            (ratio - 0.5).abs() < f32::EPSILON,
            "expected half-progress for 500us of a 1ms fade, got {ratio}"
        );
    }

    /// Verifies source-local transition positions evaluate without wall-clock instants.
    #[test]
    fn transition_ratio_at_position_uses_duration_anchors() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        assert_eq!(
            transition.transition_in_parameter_ratio_at_position(
                Duration::from_millis(750),
                Duration::from_millis(250),
            ),
            0.5
        );
    }

    /// Verifies source-local release positions saturate before release starts.
    #[test]
    fn release_ratio_at_position_saturates_before_release_anchor() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        assert_eq!(
            transition.transition_release_parameter_ratio_at_position(
                Duration::from_millis(250),
                Duration::from_millis(500),
            ),
            0.0
        );
    }

    /// Verifies source-local release anchors can be overwritten explicitly.
    #[test]
    fn set_released_at_position_overwrites_release_anchor() {
        let mut transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        transition.set_released_at_position(Duration::from_millis(250));
        transition.set_released_at_position(Duration::from_millis(500));

        assert_eq!(
            transition.release_position,
            Some(Duration::from_millis(500))
        );
        assert!(transition.is_released());
    }

    /// Verifies idempotent release marking preserves the first source-local anchor.
    #[test]
    fn mark_released_at_position_if_unset_preserves_existing_anchor() {
        let mut transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        transition.mark_released_at_position_if_unset(Duration::from_millis(250));
        transition.mark_released_at_position_if_unset(Duration::from_millis(500));

        assert_eq!(
            transition.release_position,
            Some(Duration::from_millis(250))
        );
    }

    #[test]
    fn test_fade_in_progress_at_start() {
        // No time elapsed, should be 0.0
        let transition = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::ZERO);
        assert!(ratio < 0.1, "Expected ~0.0 at start, got {}", ratio);
    }

    #[test]
    fn test_fade_in_progress_at_midpoint() {
        // 50ms elapsed, 100ms fade, should be ~0.5
        let transition = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(50));
        assert!(
            (0.4..=0.6).contains(&ratio),
            "Expected ~0.5 at midpoint, got {}",
            ratio
        );
    }

    #[test]
    fn test_fade_in_progress_at_end() {
        // 100ms+ elapsed, 100ms fade, should be 1.0
        let transition = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(150));
        assert_eq!(ratio, 1.0, "Expected 1.0 after fade complete");
    }

    #[test]
    fn test_fade_in_with_delay_during_delay_period() {
        // 50ms elapsed, but delay is 100ms, so should still be 0.0
        let transition = create_transition(
            Duration::from_millis(100),
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(50));
        assert_eq!(ratio, 0.0, "Expected 0.0 during delay period");
    }

    #[test]
    fn test_fade_in_with_delay_after_delay_period() {
        // 150ms elapsed, delay 100ms, fade 100ms
        // Effective fade progress: (150-100)/100 = 0.5
        let transition = create_transition(
            Duration::from_millis(100),
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(150));
        assert!(
            (0.4..=0.6).contains(&ratio),
            "Expected ~0.5 after delay, got {}",
            ratio
        );
    }

    #[test]
    fn test_fade_in_zero_duration_immediate() {
        // Zero fade should be 1.0 immediately regardless of elapsed time
        let transition = create_transition(Duration::ZERO, Duration::ZERO, FadeCurve::Linear);
        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::ZERO);
        assert_eq!(ratio, 1.0, "Expected 1.0 for zero-duration fade");
    }

    #[test]
    fn test_zero_duration_fade_respects_delay() {
        let transition = MaterializedTransition {
            delay_in: Duration::from_secs(1),
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let ratio = transition.transition_in_parameter_ratio_at_elapsed(Duration::ZERO);
        assert_eq!(ratio, 0.0, "Expected zero fade to wait for delay");
    }

    #[test]
    fn test_release_zero_duration_fade_respects_delay_out() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::from_secs(1),
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let ratio = transition.transition_release_parameter_ratio_at_elapsed(Duration::ZERO);
        assert_eq!(
            ratio, 0.0,
            "Expected zero fade release to wait for delay-out"
        );
    }

    #[test]
    fn test_fade_out_progress_at_midpoint() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };
        let ratio = transition.transition_out_parameter_ratio_at_elapsed(Duration::from_millis(50));
        assert!(
            (0.4..=0.6).contains(&ratio),
            "Expected ~0.5 at midpoint, got {}",
            ratio
        );
    }

    #[test]
    fn test_release_transition_at_start() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };
        let ratio = transition.transition_release_parameter_ratio_at_elapsed(Duration::ZERO);
        assert!(ratio < 0.1, "Expected ~0.0 at release start, got {}", ratio);
    }

    #[test]
    fn test_release_transition_at_midpoint() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };
        let ratio =
            transition.transition_release_parameter_ratio_at_elapsed(Duration::from_millis(50));
        assert!(
            (0.4..=0.6).contains(&ratio),
            "Expected ~0.5 at release midpoint, got {}",
            ratio
        );
    }

    #[test]
    fn test_release_transition_respects_delay_out() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::from_millis(100),
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };
        let ratio =
            transition.transition_release_parameter_ratio_at_elapsed(Duration::from_millis(50));
        assert_eq!(ratio, 0.0, "Expected release to wait for delay-out");
    }

    #[test]
    fn test_release_transition_complete() {
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };
        let ratio =
            transition.transition_release_parameter_ratio_at_elapsed(Duration::from_millis(150));
        assert_eq!(ratio, 1.0, "Expected 1.0 after release complete");
    }

    #[test]
    fn test_ease_in_curve_slower_at_start() {
        // EaseIn should be slower at the start (lower values for same linear progress)
        let linear = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ease_in = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::EaseIn,
        );

        let linear_ratio =
            linear.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(25));
        let ease_in_ratio =
            ease_in.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(25));

        // EaseIn should be slower at the start
        assert!(
            ease_in_ratio < linear_ratio,
            "EaseIn ({}) should be less than linear ({}) at 25%",
            ease_in_ratio,
            linear_ratio
        );
    }

    #[test]
    fn test_ease_out_curve_faster_at_start() {
        // EaseOut should be faster at the start (higher values for same linear progress)
        let linear = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::Linear,
        );
        let ease_out = create_transition(
            Duration::ZERO,
            Duration::from_millis(100),
            FadeCurve::EaseOut,
        );

        let linear_ratio =
            linear.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(25));
        let ease_out_ratio =
            ease_out.transition_in_parameter_ratio_at_elapsed(Duration::from_millis(25));

        // EaseOut should be faster at the start
        assert!(
            ease_out_ratio > linear_ratio,
            "EaseOut ({}) should be greater than linear ({}) at 25%",
            ease_out_ratio,
            linear_ratio
        );
    }

    #[test]
    fn test_fade_curves_reach_endpoints() {
        // All curves should reach 0.0 at start and 1.0 at end
        for curve in [
            FadeCurve::Linear,
            FadeCurve::EaseIn,
            FadeCurve::EaseOut,
            FadeCurve::EaseInOut,
        ] {
            assert_eq!(
                curve.evaluate_at(0.0),
                0.0,
                "{:?} should be 0.0 at start",
                curve
            );
            assert_eq!(
                curve.evaluate_at(1.0),
                1.0,
                "{:?} should be 1.0 at end",
                curve
            );
        }
    }

    #[test]
    fn test_fade_curves_monotonic() {
        // All curves should be monotonically increasing
        for curve in [
            FadeCurve::Linear,
            FadeCurve::EaseIn,
            FadeCurve::EaseOut,
            FadeCurve::EaseInOut,
        ] {
            let mut prev = 0.0;
            for i in 0..=10 {
                let t = i as f32 / 10.0;
                let val = curve.evaluate_at(t);
                assert!(
                    val >= prev,
                    "{:?} not monotonic at t={}: {} < {}",
                    curve,
                    t,
                    val,
                    prev
                );
                prev = val;
            }
        }
    }

    /// Verifies CSS-style curve evaluation inverts the horizontal component.
    #[test]
    fn cubic_bezier_control_point_x_changes_timing() {
        let linear = evaluate_cubic_bezier(0.0, 0.0, 1.0, 1.0, 0.5);
        let ease_in = evaluate_cubic_bezier(0.42, 0.0, 1.0, 1.0, 0.5);
        let ease_out = evaluate_cubic_bezier(0.0, 0.0, 0.58, 1.0, 0.5);

        assert!((linear - 0.5).abs() < 1e-5);
        assert!(ease_in < linear);
        assert!(ease_out > linear);
    }
}
