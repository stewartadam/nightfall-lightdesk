// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Core waveform sampling algorithms.

use crate::types::{WaveformKind, WaveformSample};

const PI: f32 = std::f32::consts::PI;

/// Sample a waveform shape at a given phase in radians.
///
/// Returns a normalized value in the range [0.0, 1.0].
///
/// # Arguments
/// * `kind` - The waveform shape to sample
/// * `phase_radians` - Phase offset in radians (0 to 2π, but wraps automatically)
/// * `duty_cycle` - Duty cycle as a normalized value (0.0-1.0). Values < this return 0.0 (off),
///   values >= this return 0.0. The waveform is only active during [0, duty_cycle).
pub fn sample_waveform_radians(kind: WaveformKind, phase_radians: f32, duty_cycle: f32) -> f32 {
    let normalized_phase = (phase_radians / (2.0 * PI)).rem_euclid(1.0);
    sample_waveform_normalized(kind, normalized_phase, duty_cycle)
}

/// Sample a waveform shape at a given normalized phase.
///
/// Returns a normalized value in the range [0.0, 1.0].
///
/// # Arguments
/// * `kind` - The waveform shape to sample
/// * `phase_normalized` - Phase as a normalized value (0.0-1.0 for one complete cycle)
/// * `duty_cycle` - Duty cycle as a normalized value (0.0-1.0). The waveform is only active
///   during [0, duty_cycle). Outside this range, returns 0.0.
pub fn sample_waveform_normalized(
    kind: WaveformKind,
    phase_normalized: f32,
    duty_cycle: f32,
) -> f32 {
    // Clamp phase to [0, 1]
    let phase = phase_normalized.rem_euclid(1.0);

    // If we're beyond the duty cycle, return 0 (waveform is "off")
    if phase >= duty_cycle {
        return 0.0;
    }

    // Rescale the phase to [0, 1] within the duty cycle window
    let rescaled = phase / duty_cycle;

    match kind {
        WaveformKind::Sin => {
            // Compress sine wave into duty cycle period
            let compressed_phase = rescaled * 2.0 * PI;
            (compressed_phase.sin() + 1.0) * 0.5
        }
        WaveformKind::Triangle => {
            // Triangle: goes from 0 to 1 in first half, then 1 to 0 in second half
            if rescaled < 0.5 {
                2.0 * rescaled
            } else {
                2.0 * (1.0 - rescaled)
            }
        }
        WaveformKind::Sawtooth => {
            // Sawtooth: linear ramp from 0 to 1 over the period
            rescaled
        }
        WaveformKind::Square => {
            // Square: high for first half, low for second half
            if rescaled < 0.5 {
                1.0
            } else {
                0.0
            }
        }
        WaveformKind::Pulse => {
            // Pulse: high for first 25% (0.25), low for the rest
            // Note: this is relative to the duty_cycle, not absolute
            if rescaled < 0.25 {
                1.0
            } else {
                0.0
            }
        }
    }
}

/// Generate multiple waveform samples for visualization (e.g., SVG path generation).
///
/// # Arguments
/// * `kind` - The waveform shape to sample
/// * `phase_offset_radians` - Initial phase offset in radians
/// * `duty_cycle` - Duty cycle as a normalized value (0.0-1.0)
/// * `sample_count` - Number of samples to generate (samples will be from 0 to sample_count inclusive)
///
/// # Returns
/// A vector of `WaveformSample` values, with one sample per t in [0, sample_count]
pub fn generate_waveform_samples(
    kind: WaveformKind,
    phase_offset_radians: f32,
    duty_cycle: f32,
    sample_count: usize,
) -> Vec<WaveformSample> {
    (0..=sample_count)
        .map(|i| {
            let t = i as f32 / sample_count as f32;
            let phase = t * 2.0 * PI + phase_offset_radians;
            let value = sample_waveform_radians(kind, phase, duty_cycle);
            WaveformSample { value }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sin_wave_at_key_points() {
        // At phase 0, sin should be at center (0.5)
        let val = sample_waveform_normalized(WaveformKind::Sin, 0.0, 1.0);
        assert!((val - 0.5).abs() < 0.01);

        // At phase 0.25 (π/2), sin should be at max (1.0)
        let val = sample_waveform_normalized(WaveformKind::Sin, 0.25, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase 0.5 (π), sin should be at center (0.5)
        let val = sample_waveform_normalized(WaveformKind::Sin, 0.5, 1.0);
        assert!((val - 0.5).abs() < 0.01);

        // At phase 0.75 (3π/2), sin should be at min (0.0)
        let val = sample_waveform_normalized(WaveformKind::Sin, 0.75, 1.0);
        assert!((val - 0.0).abs() < 0.01);
    }

    #[test]
    fn test_triangle_wave_at_key_points() {
        // At phase 0, triangle should be at 0
        let val = sample_waveform_normalized(WaveformKind::Triangle, 0.0, 1.0);
        assert!((val - 0.0).abs() < 0.01);

        // At phase 0.25, triangle should be at 0.5
        let val = sample_waveform_normalized(WaveformKind::Triangle, 0.25, 1.0);
        assert!((val - 0.5).abs() < 0.01);

        // At phase 0.5, triangle should be at 1.0 (peak)
        let val = sample_waveform_normalized(WaveformKind::Triangle, 0.5, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase 0.75, triangle should be at 0.5
        let val = sample_waveform_normalized(WaveformKind::Triangle, 0.75, 1.0);
        assert!((val - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_sawtooth_wave_at_key_points() {
        // At phase 0, sawtooth should be at 0
        let val = sample_waveform_normalized(WaveformKind::Sawtooth, 0.0, 1.0);
        assert!((val - 0.0).abs() < 0.01);

        // At phase 0.5, sawtooth should be at 0.5
        let val = sample_waveform_normalized(WaveformKind::Sawtooth, 0.5, 1.0);
        assert!((val - 0.5).abs() < 0.01);

        // At phase 0.99, sawtooth should be close to 1.0
        let val = sample_waveform_normalized(WaveformKind::Sawtooth, 0.99, 1.0);
        assert!((val - 0.99).abs() < 0.01);
    }

    #[test]
    fn test_square_wave_at_key_points() {
        // At phase 0, square should be high (1.0)
        let val = sample_waveform_normalized(WaveformKind::Square, 0.0, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase 0.25, square should be high (1.0)
        let val = sample_waveform_normalized(WaveformKind::Square, 0.25, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase 0.5, square should be low (0.0)
        let val = sample_waveform_normalized(WaveformKind::Square, 0.5, 1.0);
        assert!((val - 0.0).abs() < 0.01);

        // At phase 0.75, square should be low (0.0)
        let val = sample_waveform_normalized(WaveformKind::Square, 0.75, 1.0);
        assert!((val - 0.0).abs() < 0.01);
    }

    #[test]
    fn test_pulse_wave_at_key_points() {
        // At phase 0, pulse should be high (1.0) [within 25% duty cycle]
        let val = sample_waveform_normalized(WaveformKind::Pulse, 0.0, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase 0.2, pulse should be high (1.0) [within 25% duty cycle]
        let val = sample_waveform_normalized(WaveformKind::Pulse, 0.2, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase 0.26, pulse should be low (0.0) [beyond 25% duty cycle]
        let val = sample_waveform_normalized(WaveformKind::Pulse, 0.26, 1.0);
        assert!((val - 0.0).abs() < 0.01);

        // At phase 0.75, pulse should be low (0.0)
        let val = sample_waveform_normalized(WaveformKind::Pulse, 0.75, 1.0);
        assert!((val - 0.0).abs() < 0.01);
    }

    #[test]
    fn test_duty_cycle_cutoff() {
        // With duty_cycle = 0.5, anything at phase >= 0.5 should be off
        let val = sample_waveform_normalized(WaveformKind::Sin, 0.6, 0.5);
        assert_eq!(val, 0.0);

        // Before duty_cycle cutoff should work normally
        let val = sample_waveform_normalized(WaveformKind::Sin, 0.3, 0.5);
        assert!(val > 0.0);
    }

    #[test]
    fn test_phase_wrapping() {
        // Phase values should wrap around [0, 1]
        let val1 = sample_waveform_normalized(WaveformKind::Sin, 0.25, 1.0);
        let val2 = sample_waveform_normalized(WaveformKind::Sin, 1.25, 1.0);
        assert!((val1 - val2).abs() < 0.001);
    }

    #[test]
    fn test_sample_waveform_radians() {
        // At phase 0, sin should be at center
        let val = sample_waveform_radians(WaveformKind::Sin, 0.0, 1.0);
        assert!((val - 0.5).abs() < 0.01);

        // At phase π/2, sin should be at max
        let val = sample_waveform_radians(WaveformKind::Sin, PI / 2.0, 1.0);
        assert!((val - 1.0).abs() < 0.01);

        // At phase π, sin should be at center
        let val = sample_waveform_radians(WaveformKind::Sin, PI, 1.0);
        assert!((val - 0.5).abs() < 0.01);
    }

    #[test]
    fn test_generate_samples_count() {
        let samples = generate_waveform_samples(WaveformKind::Sin, 0.0, 1.0, 10);
        assert_eq!(samples.len(), 11); // 0 to 10 inclusive
    }
}
