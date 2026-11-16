// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fans: spreading a list of waypoints such as `0>50>0` evenly across an ordered set of targets.
//!
//! The first target receives the first waypoint and the last target the last waypoint. Targets in
//! between are interpolated linearly through each waypoint segment. Value fans, timing fans and
//! the web UI's fanned cell edits all resolve through [`resolve_fan`], so a fan typed anywhere
//! lands on the same values.

use std::time::Duration;

use nightfall_dmx::prelude::ParameterValue;

/// Resolves the waypoint value for the target at `offset` of `total` evenly spaced targets.
///
/// Targets that land exactly on a waypoint receive that waypoint unchanged, so authored values
/// never pick up interpolation rounding. Other targets call `interpolate(start, end, factor)` with
/// the surrounding waypoints and a factor in `(0, 1)`. Offsets past the last target resolve to the
/// last waypoint. Returns `None` when there are no waypoints.
pub fn resolve_fan<T: Copy>(
    waypoints: &[T],
    offset: usize,
    total: usize,
    interpolate: impl FnOnce(T, T, f64) -> T,
) -> Option<T> {
    let (&first, rest) = waypoints.split_first()?;
    if rest.is_empty() || total <= 1 {
        return Some(first);
    }

    let segments = waypoints.len() - 1;
    let last_offset = total - 1;
    let position = offset.min(last_offset) * segments;
    let segment = position / last_offset;
    let remainder = position % last_offset;
    if remainder == 0 {
        return Some(waypoints[segment]);
    }
    Some(interpolate(
        waypoints[segment],
        waypoints[segment + 1],
        remainder as f64 / last_offset as f64,
    ))
}

/// Resolves a numeric fan for one target, interpolating linearly between waypoints.
pub fn resolve_fan_number(waypoints: &[f64], offset: usize, total: usize) -> Option<f64> {
    resolve_fan(waypoints, offset, total, |start, end, factor| {
        start + factor * (end - start)
    })
}

/// Resolves a timing fan for one target, interpolating at nanosecond precision.
pub fn resolve_fan_duration(
    waypoints: &[Duration],
    offset: usize,
    total: usize,
) -> Option<Duration> {
    resolve_fan(waypoints, offset, total, |start, end, factor| {
        let start = start.as_nanos() as f64;
        let end = end.as_nanos() as f64;
        Duration::from_nanos((start + factor * (end - start)).round() as u64)
    })
}

/// Resolves a fanned parameter value for one target.
///
/// Waypoints of the same kind interpolate (raw DMX values round to whole steps). A segment that
/// mixes kinds keeps its start waypoint. An empty fan resolves to 0% absolute.
pub fn resolve_fanned_parameter_value(
    waypoints: &[ParameterValue],
    offset: usize,
    total: usize,
) -> ParameterValue {
    resolve_fan(waypoints, offset, total, interpolate_fanned_parameter_value)
        .unwrap_or(ParameterValue::AbsolutePercent { value: 0.0.into() })
}

/// Interpolates between two fan waypoints of the same value kind.
fn interpolate_fanned_parameter_value(
    start: ParameterValue,
    end: ParameterValue,
    factor: f64,
) -> ParameterValue {
    let factor = factor as f32;
    match (start, end) {
        (
            ParameterValue::AbsolutePercent { value: start },
            ParameterValue::AbsolutePercent { value: end },
        ) => ParameterValue::AbsolutePercent {
            value: (start.as_f32() + factor * (end.as_f32() - start.as_f32())).into(),
        },
        (
            ParameterValue::RelativePercent { offset: start },
            ParameterValue::RelativePercent { offset: end },
        ) => ParameterValue::RelativePercent {
            offset: (start.as_f32() + factor * (end.as_f32() - start.as_f32())).into(),
        },
        (ParameterValue::Absolute { value: start }, ParameterValue::Absolute { value: end }) => {
            ParameterValue::Absolute {
                value: (start + factor * (end - start)).round(),
            }
        }
        _ => start,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two waypoints spread evenly from the first target to the last.
    #[test]
    fn two_waypoints_spread_linearly() {
        let values: Vec<_> = (0..4)
            .map(|offset| resolve_fan_number(&[0.0, 3.0], offset, 4).unwrap())
            .collect();
        assert_eq!(values, vec![0.0, 1.0, 2.0, 3.0]);
    }

    /// A middle waypoint is reached exactly by the target that sits on it.
    #[test]
    fn middle_waypoint_is_hit_exactly() {
        let values: Vec<_> = (0..5)
            .map(|offset| resolve_fan_number(&[0.0, 10.0, 0.0], offset, 5).unwrap())
            .collect();
        assert_eq!(values, vec![0.0, 5.0, 10.0, 5.0, 0.0]);
    }

    /// Targets on waypoints keep authored decimals without binary rounding noise.
    #[test]
    fn waypoint_targets_keep_authored_values() {
        let values: Vec<_> = (0..3)
            .map(|offset| resolve_fan_number(&[0.1, 0.2, 0.3], offset, 3).unwrap())
            .collect();
        assert_eq!(values, vec![0.1, 0.2, 0.3]);
    }

    /// A single target, a single waypoint, and an empty fan have well-defined results.
    #[test]
    fn degenerate_fans() {
        assert_eq!(resolve_fan_number(&[4.0, 8.0], 0, 1), Some(4.0));
        assert_eq!(resolve_fan_number(&[4.0], 3, 5), Some(4.0));
        assert_eq!(resolve_fan_number(&[], 0, 5), None);
        assert_eq!(resolve_fan_number(&[0.0, 1.0], 9, 3), Some(1.0));
    }

    /// Timing fans interpolate at nanosecond precision instead of through `f32` seconds.
    #[test]
    fn duration_fans_keep_millisecond_precision() {
        let waypoints = [Duration::from_millis(0), Duration::from_millis(1000)];
        assert_eq!(
            resolve_fan_duration(&waypoints, 1, 4),
            Some(Duration::from_nanos(333_333_333))
        );
        assert_eq!(
            resolve_fan_duration(&waypoints, 3, 4),
            Some(Duration::from_millis(1000))
        );
    }

    /// Raw DMX fans round to whole steps and mixed segments keep their start waypoint.
    #[test]
    fn parameter_value_fans() {
        let dmx = [
            ParameterValue::Absolute { value: 0.0 },
            ParameterValue::Absolute { value: 255.0 },
        ];
        assert_eq!(
            resolve_fanned_parameter_value(&dmx, 1, 3),
            ParameterValue::Absolute { value: 128.0 }
        );

        let mixed = [
            ParameterValue::Absolute { value: 10.0 },
            ParameterValue::AbsolutePercent { value: 1.0.into() },
        ];
        assert_eq!(
            resolve_fanned_parameter_value(&mixed, 1, 3),
            ParameterValue::Absolute { value: 10.0 }
        );
        assert_eq!(
            resolve_fanned_parameter_value(&[], 0, 3),
            ParameterValue::AbsolutePercent { value: 0.0.into() }
        );
    }
}
