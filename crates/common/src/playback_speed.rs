// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Playback speed limits and panic-free duration scaling shared by every playback clock.
//!
//! Operator-typed speeds reach `Duration` arithmetic, where `Duration::mul_f64` and
//! `Duration::from_secs_f64` panic on overflow, negative or NaN values. Speeds are clamped on
//! entry with [`normalized_playback_speed`], and positions are scaled with the saturating helpers
//! so a speed or tempo multiplier can never take down the engine.

use std::time::Duration;

/// Fastest playback speed multiplier an operator can set on a clip, FX or master scale. Far
/// beyond any useful speed, it keeps clock positions well inside `Duration`'s range however
/// long a show runs.
pub const MAX_PLAYBACK_SPEED: f32 = 1000.0;

/// Normalizes an operator-supplied playback speed before it reaches timing math: non-finite
/// values stop playback and the rest clamp to `0..=MAX_PLAYBACK_SPEED`.
pub fn normalized_playback_speed(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, MAX_PLAYBACK_SPEED)
    } else {
        0.0
    }
}

/// Scales `duration` by `factor` like `Duration::mul_f64`, saturating instead of panicking.
///
/// See [`saturating_duration_from_secs_f64`] for how out-of-range products clamp.
pub fn saturating_scale_duration(duration: Duration, factor: f64) -> Duration {
    saturating_duration_from_secs_f64(duration.as_secs_f64() * factor)
}

/// Converts seconds to a `Duration` like `Duration::from_secs_f64`, without its panics.
///
/// Values past `Duration::MAX` (including positive infinity) clamp to it, and negative or NaN
/// values yield zero.
pub fn saturating_duration_from_secs_f64(seconds: f64) -> Duration {
    if seconds.is_nan() || seconds <= 0.0 {
        return Duration::ZERO;
    }
    Duration::try_from_secs_f64(seconds).unwrap_or(Duration::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies operator speeds clamp to the supported range and non-finite values stop playback.
    #[test]
    fn normalized_speed_clamps_to_supported_range() {
        assert_eq!(normalized_playback_speed(2.5), 2.5);
        assert_eq!(normalized_playback_speed(-1.0), 0.0);
        assert_eq!(normalized_playback_speed(f32::MAX), MAX_PLAYBACK_SPEED);
        assert_eq!(normalized_playback_speed(f32::INFINITY), 0.0);
        assert_eq!(normalized_playback_speed(f32::NAN), 0.0);
    }

    /// Verifies seconds-to-duration conversion clamps overflow, negative and NaN inputs.
    #[test]
    fn saturating_conversion_clamps_out_of_range_seconds() {
        assert_eq!(
            saturating_duration_from_secs_f64(1.5),
            Duration::from_millis(1500)
        );
        assert_eq!(saturating_duration_from_secs_f64(f64::MAX), Duration::MAX);
        assert_eq!(
            saturating_duration_from_secs_f64(f64::INFINITY),
            Duration::MAX
        );
        assert_eq!(saturating_duration_from_secs_f64(-1.0), Duration::ZERO);
        assert_eq!(saturating_duration_from_secs_f64(f64::NAN), Duration::ZERO);
    }

    /// Verifies scaling saturates where `Duration::mul_f64` would overflow and panic.
    #[test]
    fn saturating_scale_matches_mul_in_range_and_saturates_past_it() {
        assert_eq!(
            saturating_scale_duration(Duration::from_millis(250), 2.0),
            Duration::from_millis(500)
        );
        assert_eq!(
            saturating_scale_duration(Duration::from_secs(1), 1e30),
            Duration::MAX
        );
        assert_eq!(saturating_scale_duration(Duration::MAX, 2.0), Duration::MAX);
    }
}
