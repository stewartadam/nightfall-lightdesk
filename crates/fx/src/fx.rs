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
use nightfall_fixture_model::prelude::ParameterMetadata;
use nightfall_instances::Timebase;
use nightfall_selection::{
    HeldReference, ReferenceSource, SelectionValidatedEntity, SpatialSelectionResolution,
    selection_validation_warnings,
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
    /// Whether waveform cycle lengths are seconds or beats of the show tempo.
    #[serde(default)]
    pub timebase: Timebase,
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

/// Reports the FX selection.
impl ReferenceSource for Fx {
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>)) {
        visit("selection", HeldReference::Selection(&self.selection));
    }

    fn visit_selections_mut(&mut self, visit: &mut dyn FnMut(&mut SpatialSelection)) {
        visit(&mut self.selection);
    }
}

/// Waveform parameters for FX.
#[serde_with::serde_as]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxWaveformParams {
    /// The waveform kind (shape)
    pub kind: WaveformKind,
    /// The lowest output, as a fraction (0-1) of each parameter's range
    #[serde_as(as = "PercentageAsF64")]
    pub min: Percentage,
    /// The highest output, as a fraction (0-1) of each parameter's range
    #[serde_as(as = "PercentageAsF64")]
    pub max: Percentage,
    /// The duty cycle (0.0-1.0, for Square/Pulse waves)
    #[serde(default = "default_duty_cycle")]
    pub duty_cycle: f32,
}

fn default_duty_cycle() -> f32 {
    1.0
}

impl FxWaveformParams {
    /// Samples the waveform at a phase in radians, scaled between `min` and `max`.
    ///
    /// Returns a fraction (0-1) of the parameter range; [`FxWaveform::output_value`]
    /// turns it into a value for a concrete parameter.
    pub fn sample(&self, phase_radians: f32) -> f32 {
        let normalized = sample_waveform_radians(self.kind, phase_radians, self.duty_cycle);
        let (min, max) = (self.min.as_f32(), self.max.as_f32());
        (min + normalized * (max - min)).clamp(0.0, 1.0)
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
    pub cycle_length: Duration,
    /// The width of the waveform (0-100%), scales amplitude around the middle of the range.
    #[serde_as(as = "PercentageAsF64")]
    pub width: Percentage,
    /// Whether the waveform should output relative values instead of absolute values.
    ///
    /// A relative waveform is centred: the middle of its range leaves the parameter
    /// unchanged, and the waveform swings it up and down from there.
    pub is_relative: bool,
}

impl FxWaveform {
    /// Samples the waveform at the phase offset indicated by the percentage, for each fixture
    /// in the given selection, as a fraction (0-1) of the parameter range.
    ///
    /// The `width` field scales the amplitude around the middle of the range (0.5).
    ///
    /// Fixtures are distributed across the `phase_range`:
    /// - `phase_range = (0, 2π)`: Full waveform distribution (default)
    /// - `phase_range = (0, π)`: Fixtures clustered in first half
    /// - `phase_range = (0, 4π)`: Fixtures spread over two cycles
    pub fn sample(&self, selection: &ResolvedSelection, percent: Percentage) -> Vec<f32> {
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
                // Time offset advances through one complete cycle (2π) per cycle length
                let phase = phase_start
                    + (index as f32 * spacing)
                    + 2.0 * std::f32::consts::PI * percent.as_f32();
                let fraction = self.params.sample(phase);
                (0.5 + (fraction - 0.5) * width_scale).clamp(0.0, 1.0)
            })
            .collect()
    }

    /// Converts a sampled fraction of the range into the value this waveform outputs for a
    /// parameter, in that parameter's logical units.
    ///
    /// An absolute waveform maps the fraction across the parameter's logical range, so a
    /// full-range waveform sweeps a signed Pan from its negative to its positive end. A
    /// relative waveform outputs an offset centred on 0.5, so a full-range waveform moves the
    /// parameter up to half its range either way.
    pub fn output_value(&self, fraction: f32, metadata: &ParameterMetadata) -> ParameterValue {
        let range = metadata.logical_range();
        if self.is_relative {
            ParameterValue::Relative {
                offset: (fraction - 0.5) * range,
            }
        } else {
            ParameterValue::Absolute {
                value: metadata.logical_min() + fraction * range,
            }
        }
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
                min: Percentage::from(0.0),
                max: Percentage::from(1.0),
                duty_cycle: 1.0,
            },
            phase_range,
            cycle_length: Duration::from_secs(1),
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

    /// Builds 8-bit metadata for `attribute` with its own polarity over raw `min..max`.
    fn metadata(attribute: Attribute, min: f32, max: f32) -> ParameterMetadata {
        ParameterMetadata {
            value_polarity: attribute.value_polarity(),
            native_unit: attribute.native_unit(),
            attribute,
            min,
            max,
            ..Default::default()
        }
    }

    /// Verifies a full-range absolute waveform reaches both ends of a signed parameter, so a
    /// Pan sweep covers the negative side instead of stopping at centre.
    #[test]
    fn absolute_output_spans_signed_logical_range() {
        let waveform = make_test_waveform((0.0, 2.0 * PI));
        let pan = metadata(Attribute::Pan, 0.0, 255.0);

        assert_eq!(
            waveform.output_value(0.0, &pan),
            ParameterValue::Absolute { value: -127.5 }
        );
        assert_eq!(
            waveform.output_value(0.5, &pan),
            ParameterValue::Absolute { value: 0.0 }
        );
        assert_eq!(
            waveform.output_value(1.0, &pan),
            ParameterValue::Absolute { value: 127.5 }
        );
    }

    /// Verifies an absolute waveform scales to a parameter whose range is not 0-255.
    #[test]
    fn absolute_output_scales_to_parameter_range() {
        let waveform = make_test_waveform((0.0, 2.0 * PI));
        let wide = metadata(Attribute::Intensity, 0.0, 65535.0);

        assert_eq!(
            waveform.output_value(0.5, &wide),
            ParameterValue::Absolute { value: 32767.5 }
        );
    }

    /// Verifies a relative waveform is centred, so it subtracts below the middle of its range
    /// and adds above it.
    #[test]
    fn relative_output_is_centred_on_no_change() {
        let mut waveform = make_test_waveform((0.0, 2.0 * PI));
        waveform.is_relative = true;
        let intensity = metadata(Attribute::Intensity, 0.0, 255.0);

        assert_eq!(
            waveform.output_value(0.0, &intensity),
            ParameterValue::Relative { offset: -127.5 }
        );
        assert_eq!(
            waveform.output_value(0.5, &intensity),
            ParameterValue::Relative { offset: 0.0 }
        );
        assert_eq!(
            waveform.output_value(1.0, &intensity),
            ParameterValue::Relative { offset: 127.5 }
        );
    }

    /// Verifies `min` and `max` bound the sampled fraction of the parameter range.
    #[test]
    fn sample_scales_between_min_and_max() {
        let mut waveform = make_test_waveform((0.0, 2.0 * PI));
        waveform.params.min = Percentage::from(0.2);
        waveform.params.max = Percentage::from(0.6);
        // Sine peaks at a quarter cycle and bottoms out at three quarters.
        assert!((waveform.params.sample(PI / 2.0) - 0.6).abs() < 1e-6);
        assert!((waveform.params.sample(3.0 * PI / 2.0) - 0.2).abs() < 1e-6);
    }
}
