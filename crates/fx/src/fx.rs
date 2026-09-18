// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, time::Duration};

use nightfall::prelude::*;
use nightfall_dmx::PercentageAsF64;
use nightfall_dmx::prelude::*;
use nightfall_selection::{
    SelectionValidatedEntity, SpatialSelectionResolution, selection_validation_warnings,
};
use nightfall_waveform::prelude::*;
use serde::{Deserialize, Serialize};
use serde_with::DisplayFromStr;

/// Definition of an procedural effect (fx)
#[serde_with::serde_as]
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Fx {
    /// Identifiers for the fx
    pub identifiers: Identifiers,
    /// Spatial selection of fixtures to apply the fx to
    pub selection: SpatialSelection,
    /// Map of attributes to animate with which waveform
    #[typeshare(serialized_as = "Record<String, FxWaveform>")]
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    pub attributes: HashMap<Attribute, FxWaveform>,
}

impl HasIdentifiers for Fx {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl SelectionValidatedEntity for Fx {
    /// Return validation warnings for this FX selection.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        selection_validation_warnings(&self.selection, resolver)
    }
}

/// Waveform parameters for FX.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxWaveformParams {
    /// The waveform kind (shape)
    pub kind: WaveformKind,
    /// The minimum output value (0-255 DMX)
    pub min: ParameterDmxValue,
    /// The maximum output value (0-255 DMX)
    pub max: ParameterDmxValue,
    /// The duty cycle (0.0-1.0, for Square/Pulse waves)
    #[serde(default = "default_duty_cycle")]
    pub duty_cycle: f32,
}

fn default_duty_cycle() -> f32 {
    1.0
}

impl FxWaveformParams {
    /// Sample the waveform at a given phase in radians.
    pub fn sample(&self, phase_radians: f32) -> ParameterDmxValue {
        let normalized = sample_waveform_radians(self.kind, phase_radians, self.duty_cycle);
        let scaled = self.min + normalized * (self.max - self.min);
        scaled.clamp(0.0, 255.0)
    }
}

/// Default phase range: distribute fixtures over one complete waveform cycle (0 to 2π radians).
fn default_phase_range() -> (f32, f32) {
    (0.0, 2.0 * std::f32::consts::PI)
}

/// Definition of a waveform with timing and scaling
#[serde_with::serde_as]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxWaveform {
    /// The waveform parameters (kind, min, max, duty_cycle)
    pub params: FxWaveformParams,
    /// The phase range (start, end) in radians for distributing fixtures.
    /// - (0, 2π): Full waveform distribution (default, current behavior)
    /// - (0, π): Fixtures clustered in first half of waveform
    /// - (0, 4π): Fixtures spread over two complete waveform cycles
    #[serde(default = "default_phase_range")]
    #[typeshare(serialized_as = "Array<number>")]
    pub phase_range: (f32, f32),
    /// The duration one complete cycle of the waveform should take
    pub rate: Duration,
    /// The width of the waveform (0-100%), scales amplitude around midpoint (127.5).
    #[serde_as(as = "PercentageAsF64")]
    pub width: Percentage,
    /// Whether the waveform should output relative values instead of absolute values.
    pub is_relative: bool,
}

impl FxWaveform {
    /// Samples the waveform value at the phase offset indicated by the
    /// percentage, for each fixture in the given selection.
    /// The `width` field scales the amplitude around the midpoint (127.5).
    ///
    /// Fixtures are distributed across the `phase_range`:
    /// - `phase_range = (0, 2π)`: Full waveform distribution (default)
    /// - `phase_range = (0, π)`: Fixtures clustered in first half
    /// - `phase_range = (0, 4π)`: Fixtures spread over two cycles
    pub fn sample(
        &self,
        selection: &ResolvedSelection,
        percent: Percentage,
    ) -> Vec<ParameterDmxValue> {
        let fixture_count = selection.indexes().len();
        if fixture_count == 0 {
            return Vec::new();
        }

        let (phase_start, phase_end) = self.phase_range;
        let phase_span = phase_end - phase_start;
        let spacing = phase_span / fixture_count as f32;
        let width_scale = self.width.as_f32();

        selection
            .indexes()
            .iter()
            .enumerate()
            .map(|(index, _)| {
                // Start at phase_start, distribute fixtures across phase_span
                // Time offset advances through one complete cycle (2π) per rate period
                let phase = phase_start
                    + (index as f32 * spacing)
                    + 2.0 * std::f32::consts::PI * percent.as_f32();
                let raw_value = self.params.sample(phase);
                // Scale amplitude around midpoint (127.5)
                let midpoint = 127.5_f32;
                let deviation = raw_value - midpoint;
                let scaled = midpoint + (deviation * width_scale);
                scaled.clamp(0.0, 255.0)
            })
            .collect()
    }

    /// Calculate the phase for a specific fixture index given the phase_range and fixture count.
    /// Useful for testing phase distribution without needing a SelectionResolver.
    pub fn calculate_phase_for_fixture(
        &self,
        index: usize,
        fixture_count: usize,
        time_percent: Percentage,
    ) -> f32 {
        let (phase_start, phase_end) = self.phase_range;
        let phase_span = phase_end - phase_start;
        let spacing = phase_span / fixture_count as f32;
        phase_start + (index as f32 * spacing) + 2.0 * std::f32::consts::PI * time_percent.as_f32()
    }
}

#[cfg(test)]
mod tests {
    use std::f32::consts::PI;

    use super::*;

    fn make_test_waveform(phase_range: (f32, f32)) -> FxWaveform {
        FxWaveform {
            params: FxWaveformParams {
                kind: WaveformKind::Sin,
                min: 0.0,
                max: 255.0,
                duty_cycle: 1.0,
            },
            phase_range,
            rate: Duration::from_secs(1),
            width: Percentage::from(1.0),
            is_relative: false,
        }
    }

    #[test]
    fn test_default_phase_range_full_cycle() {
        // Default: 0 to 2π - fixtures distributed over one full waveform cycle
        let waveform = make_test_waveform((0.0, 2.0 * PI));
        let fixture_count = 4;

        // At time=0, fixtures should be at phases: 0, π/2, π, 3π/2
        let phase0 = waveform.calculate_phase_for_fixture(0, fixture_count, 0.0.into());
        let phase1 = waveform.calculate_phase_for_fixture(1, fixture_count, 0.0.into());
        let phase2 = waveform.calculate_phase_for_fixture(2, fixture_count, 0.0.into());
        let phase3 = waveform.calculate_phase_for_fixture(3, fixture_count, 0.0.into());

        assert!(
            (phase0 - 0.0).abs() < 0.001,
            "Fixture 0 should be at phase 0"
        );
        assert!(
            (phase1 - PI / 2.0).abs() < 0.001,
            "Fixture 1 should be at phase π/2"
        );
        assert!(
            (phase2 - PI).abs() < 0.001,
            "Fixture 2 should be at phase π"
        );
        assert!(
            (phase3 - 3.0 * PI / 2.0).abs() < 0.001,
            "Fixture 3 should be at phase 3π/2"
        );
    }

    #[test]
    fn test_half_cycle_phase_range() {
        // 0 to π - fixtures clustered in first half of waveform
        let waveform = make_test_waveform((0.0, PI));
        let fixture_count = 4;

        // At time=0, fixtures should be at phases: 0, π/4, π/2, 3π/4
        let phase0 = waveform.calculate_phase_for_fixture(0, fixture_count, 0.0.into());
        let phase1 = waveform.calculate_phase_for_fixture(1, fixture_count, 0.0.into());
        let phase2 = waveform.calculate_phase_for_fixture(2, fixture_count, 0.0.into());
        let phase3 = waveform.calculate_phase_for_fixture(3, fixture_count, 0.0.into());

        assert!(
            (phase0 - 0.0).abs() < 0.001,
            "Fixture 0 should be at phase 0"
        );
        assert!(
            (phase1 - PI / 4.0).abs() < 0.001,
            "Fixture 1 should be at phase π/4"
        );
        assert!(
            (phase2 - PI / 2.0).abs() < 0.001,
            "Fixture 2 should be at phase π/2"
        );
        assert!(
            (phase3 - 3.0 * PI / 4.0).abs() < 0.001,
            "Fixture 3 should be at phase 3π/4"
        );
    }

    #[test]
    fn test_offset_phase_range() {
        // π to 2π - fixtures in second half of waveform
        let waveform = make_test_waveform((PI, 2.0 * PI));
        let fixture_count = 4;

        // At time=0, fixtures should be at phases: π, 5π/4, 3π/2, 7π/4
        let phase0 = waveform.calculate_phase_for_fixture(0, fixture_count, 0.0.into());
        let phase1 = waveform.calculate_phase_for_fixture(1, fixture_count, 0.0.into());
        let phase2 = waveform.calculate_phase_for_fixture(2, fixture_count, 0.0.into());
        let phase3 = waveform.calculate_phase_for_fixture(3, fixture_count, 0.0.into());

        assert!(
            (phase0 - PI).abs() < 0.001,
            "Fixture 0 should be at phase π"
        );
        assert!(
            (phase1 - 5.0 * PI / 4.0).abs() < 0.001,
            "Fixture 1 should be at phase 5π/4"
        );
        assert!(
            (phase2 - 3.0 * PI / 2.0).abs() < 0.001,
            "Fixture 2 should be at phase 3π/2"
        );
        assert!(
            (phase3 - 7.0 * PI / 4.0).abs() < 0.001,
            "Fixture 3 should be at phase 7π/4"
        );
    }

    #[test]
    fn test_double_cycle_phase_range() {
        // 0 to 4π - fixtures spread over two complete cycles
        let waveform = make_test_waveform((0.0, 4.0 * PI));
        let fixture_count = 4;

        // At time=0, fixtures should be at phases: 0, π, 2π, 3π
        let phase0 = waveform.calculate_phase_for_fixture(0, fixture_count, 0.0.into());
        let phase1 = waveform.calculate_phase_for_fixture(1, fixture_count, 0.0.into());
        let phase2 = waveform.calculate_phase_for_fixture(2, fixture_count, 0.0.into());
        let phase3 = waveform.calculate_phase_for_fixture(3, fixture_count, 0.0.into());

        assert!(
            (phase0 - 0.0).abs() < 0.001,
            "Fixture 0 should be at phase 0"
        );
        assert!(
            (phase1 - PI).abs() < 0.001,
            "Fixture 1 should be at phase π"
        );
        assert!(
            (phase2 - 2.0 * PI).abs() < 0.001,
            "Fixture 2 should be at phase 2π"
        );
        assert!(
            (phase3 - 3.0 * PI).abs() < 0.001,
            "Fixture 3 should be at phase 3π"
        );
    }

    #[test]
    fn test_time_advancement() {
        // Verify that time advances correctly (2π per cycle)
        let waveform = make_test_waveform((0.0, 2.0 * PI));
        let fixture_count = 4;

        // At time=0.5 (50%), each fixture should advance by π radians
        let phase0_t0 = waveform.calculate_phase_for_fixture(0, fixture_count, 0.0.into());
        let phase0_t50 = waveform.calculate_phase_for_fixture(0, fixture_count, 0.5.into());

        assert!(
            (phase0_t50 - phase0_t0 - PI).abs() < 0.001,
            "Phase should advance by π at 50% time"
        );
    }
}
