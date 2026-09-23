// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime continuity across Step FX definition replacements.

use std::time::Duration;

use nightfall_instances::{
    InstanceClock, InstanceClockDiscontinuity, InstanceDisplayKind, InstanceKind, InstanceMetadata,
};

use crate::prelude::*;

/// Refreshes operator-facing Step FX metadata while preserving runtime tags.
pub(super) fn refreshed_step_fx_playback_metadata(
    existing: Option<&InstanceMetadata>,
    name: String,
) -> InstanceMetadata {
    let mut metadata = existing
        .cloned()
        .unwrap_or_else(|| InstanceMetadata::new(InstanceKind::Fx));
    metadata.name = Some(name);
    metadata.kind = InstanceKind::Fx;
    metadata.display_kind = InstanceDisplayKind::StepFx;
    metadata
}

/// Re-anchors a playback clock so a definition replacement preserves normalized cycle phase.
fn reanchored_step_fx_clock(
    clock: Option<&InstanceClock>,
    rate: f32,
    old_step_fx: &StepFx,
    new_step_fx: &StepFx,
) -> InstanceClock {
    let mut clock = clock.cloned().unwrap_or_default();
    let Some(old_duration) = old_step_fx.cycle_duration() else {
        return clock;
    };
    let Some(new_duration) = new_step_fx.cycle_duration() else {
        return clock;
    };
    let rate = f64::from(rate);
    if rate <= 0.0 || !rate.is_finite() {
        return clock;
    }
    let old_seconds = old_duration.as_secs_f64();
    let normalized = (clock.position.as_secs_f64() * rate / old_seconds).rem_euclid(1.0);
    let new_position = Duration::from_secs_f64(normalized * new_duration.as_secs_f64() / rate);
    clock.seek_to(new_position);
    clock.discontinuity = InstanceClockDiscontinuity::Continuous;
    clock
}

/// Computes one contribution's continuity correction across a definition replacement.
fn reanchored_track_phase_offset(
    old_duration: Option<Duration>,
    new_duration: Option<Duration>,
    old_elapsed: f64,
    new_elapsed: f64,
    previous_offset: f32,
) -> f32 {
    let (Some(old_duration), Some(new_duration)) = (old_duration, new_duration) else {
        return 0.0;
    };
    let old_normalized = (old_elapsed / old_duration.as_secs_f64()).rem_euclid(1.0) as f32;
    let new_normalized = (new_elapsed / new_duration.as_secs_f64()).rem_euclid(1.0) as f32;
    (old_normalized - new_normalized + previous_offset).rem_euclid(1.0)
}

/// Re-anchors a shared clock and retains normalized continuity for every existing lane.
pub(super) fn reanchored_step_fx_runtime(
    clock: Option<&InstanceClock>,
    lane_phase_offsets: Option<&StepFxLanePhaseOffsets>,
    rate: f32,
    old_step_fx: &StepFx,
    new_step_fx: &StepFx,
) -> (InstanceClock, StepFxLanePhaseOffsets) {
    let old_clock = clock.cloned().unwrap_or_default();
    let new_clock = reanchored_step_fx_clock(clock, rate, old_step_fx, new_step_fx);
    let rate = f64::from(rate);
    if rate <= 0.0 || !rate.is_finite() {
        return (new_clock, lane_phase_offsets.cloned().unwrap_or_default());
    }

    let old_elapsed = old_clock.position.as_secs_f64() * rate;
    let new_elapsed = new_clock.position.as_secs_f64() * rate;
    let previous_offsets = lane_phase_offsets.cloned().unwrap_or_default();
    let offsets = new_step_fx
        .lanes
        .iter()
        .map(|lane| {
            let (old_absolute, old_relative) = old_step_fx.lane_cycle_durations(&lane.attribute);
            let (new_absolute, new_relative) = new_step_fx.lane_cycle_durations(&lane.attribute);
            let previous = previous_offsets.get(&lane.attribute);
            let offsets = StepFxTrackPhaseOffsets {
                absolute: reanchored_track_phase_offset(
                    old_absolute,
                    new_absolute,
                    old_elapsed,
                    new_elapsed,
                    previous.absolute,
                ),
                relative: reanchored_track_phase_offset(
                    old_relative,
                    new_relative,
                    old_elapsed,
                    new_elapsed,
                    previous.relative,
                ),
            };
            (lane.attribute.clone(), offsets)
        })
        .collect();
    let last_clock_position = new_clock.position;
    let mut offsets = StepFxLanePhaseOffsets::new(offsets, last_clock_position);
    offsets.color = reanchored_track_phase_offset(
        old_step_fx.color_cycle_duration(),
        new_step_fx.color_cycle_duration(),
        old_elapsed,
        new_elapsed,
        previous_offsets.color,
    );
    (new_clock, offsets)
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::*;
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use uuid::Uuid;

    use super::super::test_support::valid_step_fx;
    use super::*;

    /// Verifies lane timing edits retain continuity independently of the shared clock lane.
    #[test]
    fn store_step_fx_preserves_overridden_lane_phase() {
        let mut old = valid_step_fx(8, Uuid::from_u128(0x625), SpatialSelection::default());
        old.lanes.push(FxLane {
            attribute: Attribute::Pan,
            timing_override: Some(StepFxTiming::from_bpm(60.0).unwrap()),
            phase_override: None,
            absolute: Some(FxTrack {
                steps: vec![
                    FxStep::new(
                        ParameterValue::AbsolutePercent { value: 0.0.into() },
                        1.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                    FxStep::new(
                        ParameterValue::AbsolutePercent { value: 1.0.into() },
                        1.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                ],
            }),
            relative: Some(FxTrack {
                steps: vec![
                    FxStep::new(
                        ParameterValue::RelativePercent { offset: 0.0.into() },
                        2.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                    FxStep::new(
                        ParameterValue::RelativePercent { offset: 1.0.into() },
                        2.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                ],
            }),
        });
        let mut new = old.clone();
        new.lanes[1].timing_override = Some(StepFxTiming::from_bpm(30.0).unwrap());
        let clock = InstanceClock {
            position: Duration::from_millis(250),
            ..Default::default()
        };

        let (new_clock, offsets) = reanchored_step_fx_runtime(Some(&clock), None, 1.0, &old, &new);

        assert_eq!(new_clock.position, clock.position);
        let pan_offsets = offsets.get(&Attribute::Pan);
        assert!((pan_offsets.absolute - 0.0625).abs() < 0.0001);
        assert!((pan_offsets.relative - 0.03125).abs() < 0.0001);
    }
}
