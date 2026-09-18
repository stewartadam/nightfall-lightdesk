// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parameters are logical representation of DMX channels that hold values to
//! eventually be sent to fixtures during output.

use bevy_ecs::prelude::*;
use nightfall_compositor::types::CompositorParameter;
use nightfall_dmx::prelude::*;
use nightfall_io::OutputTransport;
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;

/// Merge strategies for combining parameter values
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub enum MergeStrategy {
    /// Highest Take Priority - the highest value will be used
    HTP,
    /// Last Takes Priority - the most recent value will be used
    LTP,
}

/// Metadata for a parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParameterMetadata {
    /// The DMX channel width of this logical parameter
    pub resolution: DmxValueResolution,
    /// Which attribute this parameter controls
    pub attribute: Attribute,
    /// Unit used for values entered and displayed by operators.
    #[serde(default)]
    pub native_unit: ParameterUnit,
    /// Whether this parameter's logical values are unsigned or centered around zero.
    #[serde(default)]
    pub value_polarity: ParameterValuePolarity,
    /// The minimum value of this parameter. The parameter can hold values
    /// outside this bound in individual layers, but final output will be
    /// clamped to this value.
    pub min: ParameterDmxValue,
    /// The maximum value of this parameter. The parameter can hold values
    /// outside this bound in individual layers, but final output will be
    /// clamped to this value.
    pub max: ParameterDmxValue,
    /// Fixed offset applied after merging and before clamping.
    /// Can be specified as a raw DMX value or as a percentage of the parameter's range.
    pub offset: ParameterValue,
    /// Whether low and high values should be inverted upon output. This
    /// can be useful for pan/tilt if a fixture was mounted rotated 180 degrees,
    /// for example.
    pub is_inverted: bool,
    /// Whether this parameter is a 'snap' parameter (not fade-able)
    pub is_snap: bool,
    /// The merge strategy for this parameter
    pub merge_type: MergeStrategy,
    /// Whether this parameter should respond to grandmaster intensity
    pub use_grandmaster: bool,
}

impl Default for ParameterMetadata {
    fn default() -> Self {
        Self {
            resolution: DmxValueResolution::Coarse,
            attribute: Attribute::Intensity,
            native_unit: ParameterUnit::Percent,
            value_polarity: ParameterValuePolarity::Unsigned,
            min: 0.0,
            max: ChannelDmxValue::MAX as ParameterDmxValue,
            offset: ParameterValue::Absolute { value: 0.0 },
            is_inverted: false,
            is_snap: false,
            merge_type: MergeStrategy::HTP,
            use_grandmaster: false,
        }
    }
}

impl ParameterMetadata {
    /// Returns the minimum logical value operators should use for this parameter.
    pub fn logical_min(&self) -> ParameterDmxValue {
        if self.value_polarity == ParameterValuePolarity::Signed && self.min >= 0.0 {
            -(self.max - self.min) / 2.0
        } else {
            self.min
        }
    }

    /// Returns the maximum logical value operators should use for this parameter.
    pub fn logical_max(&self) -> ParameterDmxValue {
        if self.value_polarity == ParameterValuePolarity::Signed && self.min >= 0.0 {
            (self.max - self.min) / 2.0
        } else {
            self.max
        }
    }

    /// Returns the logical value span for this parameter.
    pub fn logical_range(&self) -> ParameterDmxValue {
        self.logical_max() - self.logical_min()
    }

    /// Converts an absolute logical parameter value into an absolute percentage.
    pub fn absolute_value_to_percent(&self, value: ParameterDmxValue) -> Percentage {
        let min = self.logical_min();
        let range = self.logical_range();
        if range <= 0.0 {
            return 0.0.into();
        }

        let normalized = ((value.clamp(min, self.logical_max()) - min) / range).clamp(0.0, 1.0);
        match self.value_polarity {
            ParameterValuePolarity::Unsigned => normalized.into(),
            ParameterValuePolarity::Signed => (normalized * 2.0 - 1.0).into(),
        }
    }

    /// Converts an absolute percentage into an absolute logical parameter value.
    pub fn absolute_percent_to_value(&self, value: Percentage) -> ParameterDmxValue {
        let min = self.logical_min();
        let range = self.logical_range();
        match self.value_polarity {
            ParameterValuePolarity::Unsigned => {
                let clamped_percent = value.clamp(0.0.into(), 1.0.into());
                min + range * clamped_percent.as_f32()
            }
            ParameterValuePolarity::Signed => {
                let percent = value.clamp((-1.0).into(), 1.0.into()).as_f32();
                min + range * ((percent + 1.0) / 2.0)
            }
        }
    }

    /// Converts absolute parameter values to raw logical-value representation.
    pub fn parameter_value_as_absolute(&self, value: &ParameterValue) -> ParameterValue {
        match value {
            ParameterValue::AbsolutePercent { value } => ParameterValue::Absolute {
                value: self.absolute_percent_to_value(*value),
            },
            _ => *value,
        }
    }

    /// Converts absolute parameter values to percentage representation.
    pub fn parameter_value_as_absolute_percent(&self, value: &ParameterValue) -> ParameterValue {
        match value {
            ParameterValue::Absolute { value } => ParameterValue::AbsolutePercent {
                value: self.absolute_value_to_percent(*value),
            },
            _ => *value,
        }
    }
}

/// Store current values for a parameter.
#[derive(Clone, Debug, Serialize, Deserialize, SmartDefault)]
pub struct ParameterValues {
    /// Value to fall back to when no layers are asserting values on this parameter.
    pub default_value: ParameterDmxValue,
    /// Value to output when the owning fixture element is in highlight mode.
    #[default(255.0)]
    pub highlight_value: ParameterDmxValue,
    /// The current value of the parameter is the value that will be sent to the fixture.
    pub current_value: ParameterDmxValue,
}

/// Legacy patch payload for UI compatibility, mapping a parameter to a DMX universe and address.
#[derive(Debug, Clone, SmartDefault, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Patch {
    /// The ID of the DMX universe to which the parameter is patched
    #[default = 1]
    pub universe: u16,
    /// The DMX address (1-512) to which the parameter is patched
    #[default = 1]
    pub address: u16,
    /// The output transport for this patch
    #[serde(default)]
    pub transport: OutputTransport,
}

/// Entity-component used to spawn parameters.
#[derive(Component, Clone)]
pub struct Parameter {
    /// Metadata for the parameter
    pub metadata: ParameterMetadata,
    /// Current values for the parameter
    pub values: ParameterValues,
}

impl Parameter {
    /// Determines the value after merging a parameter value.
    pub fn apply_value(&self, value: &ParameterValue) -> ParameterDmxValue {
        let new_value = self.resolve_value(value);
        let should_update_value = match self.metadata.merge_type {
            MergeStrategy::HTP => !value.is_relative() && new_value > self.values.current_value,
            MergeStrategy::LTP => true,
        };

        if should_update_value {
            tracing::trace!(
                ?new_value,
                attribute = ?self.metadata.attribute,
                "Merged value on parameter"
            );
            new_value
        } else {
            tracing::trace!(
                ?new_value,
                attribute = ?self.metadata.attribute,
                retained_value = ?self.values.current_value,
                "Merged value to parameter, retained existing value"
            );
            self.values.current_value
        }
    }

    /// Merges a value into a parameter, setting the value if necessary
    /// according to the parameter's merge strategy.
    pub fn merge_value(&mut self, value: &ParameterValue) {
        self.values.current_value = self.apply_value(value);
    }

    /// Sets a parameter to the specified value, regardless of its merge strategy.
    pub fn set_value(&mut self, value: &ParameterValue) {
        self.values.current_value = self.resolve_value(value);

        tracing::trace!(
            attribute = ?self.metadata.attribute,
            value = %self.values.current_value,
            "Setting parameter",
        );
    }

    /// Gets the logical output value (without calibration offset).
    /// Clamps to valid range and applies inversion if configured.
    /// Use this for UI display that shows logical/conceptual values.
    pub fn get_logical_value(&self) -> ParameterDmxValue {
        let min = self.metadata.logical_min();
        let max = self.metadata.logical_max();
        let value = self.values.current_value.clamp(min, max);
        if self.metadata.is_inverted {
            min + max - value
        } else {
            value
        }
    }

    /// Gets the physical output value for DMX output.
    /// Applies the calibration offset and clamps to valid range.
    /// Use this for actual DMX output where offsets should be applied.
    pub fn get_raw_value(&self) -> ParameterDmxValue {
        let min = self.metadata.logical_min();
        let max = self.metadata.logical_max();
        let offset = self.metadata.offset.resolve_as_dmx_offset(min, max);
        let value = (self.values.current_value + offset).clamp(min, max);
        if self.metadata.is_inverted {
            min + max - value
        } else {
            value
        }
    }

    /// Sets the effective output value, honoring parameter metadata settings
    pub fn set_raw_value(&mut self, value: ParameterDmxValue) {
        self.values.current_value = value;
    }

    /// Gets the default output value, honoring parameter metadata settings
    pub fn get_default_value(&self) -> ParameterDmxValue {
        let min = self.metadata.logical_min();
        let max = self.metadata.logical_max();
        if self.metadata.is_inverted {
            min + max - self.values.default_value
        } else {
            self.values.default_value
        }
    }

    /// Resolves a ParameterValue instruction to a raw DmxValue (e.g. 0-255 for
    /// coarse parameters) using the current value. This method is stateful and
    /// depends on the current state of the parameter's value when calculating
    /// relative offsets.
    pub fn resolve_value(&self, value: &ParameterValue) -> ParameterDmxValue {
        self.resolve_value_with_current(value, self.values.current_value)
    }

    /// Resolves a ParameterValue instruction against an explicit current value.
    pub fn resolve_value_with_current(
        &self,
        value: &ParameterValue,
        current_value: ParameterDmxValue,
    ) -> ParameterDmxValue {
        match value {
            ParameterValue::Absolute { value } => *value,
            ParameterValue::AbsolutePercent { value } => {
                self.metadata.absolute_percent_to_value(*value)
            }
            ParameterValue::Relative { offset } => current_value + *offset,
            ParameterValue::RelativePercent { offset } => {
                let range = self.metadata.logical_range();
                let delta = range * offset.as_f32();
                current_value + delta
            }
        }

        // We don't clamp here yet - that's done during DMX output so that
        // intermediate layers can set negative relative offsets on parameters
    }
}

impl CompositorParameter for Parameter {
    fn attribute(&self) -> Attribute {
        self.metadata.attribute.clone()
    }

    fn uses_htp_merge(&self) -> bool {
        matches!(self.metadata.merge_type, MergeStrategy::HTP)
    }

    fn logical_min(&self) -> ParameterDmxValue {
        self.metadata.logical_min()
    }

    fn current_value(&self) -> ParameterDmxValue {
        self.values.current_value
    }

    fn default_value(&self) -> ParameterDmxValue {
        self.values.default_value
    }

    fn set_raw_value(&mut self, value: ParameterDmxValue) {
        Parameter::set_raw_value(self, value);
    }

    fn resolve_value(&self, value: &ParameterValue) -> ParameterDmxValue {
        Parameter::resolve_value(self, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies showfiles written before native units were introduced remain readable.
    #[test]
    fn parameter_metadata_defaults_missing_native_unit() {
        let metadata: ParameterMetadata = serde_json::from_value(serde_json::json!({
            "resolution": "Coarse",
            "attribute": { "type": "Intensity" },
            "value_polarity": "Unsigned",
            "min": 0.0,
            "max": 255.0,
            "offset": { "type": "Absolute", "data": { "value": 0.0 } },
            "is_inverted": false,
            "is_snap": false,
            "merge_type": "HTP",
            "use_grandmaster": true
        }))
        .expect("deserialize legacy parameter metadata");

        assert_eq!(metadata.native_unit, ParameterUnit::Percent);
    }

    /// Builds parameter metadata with overridable polarity for value-resolution tests.
    fn metadata(value_polarity: ParameterValuePolarity) -> ParameterMetadata {
        ParameterMetadata {
            value_polarity,
            max: 540.0,
            merge_type: MergeStrategy::LTP,
            ..Default::default()
        }
    }

    /// Verifies signed absolute percentages resolve around the parameter midpoint.
    #[test]
    fn signed_absolute_percent_resolves_around_zero() {
        let parameter = Parameter {
            metadata: metadata(ParameterValuePolarity::Signed),
            values: ParameterValues::default(),
        };

        assert_eq!(
            parameter.resolve_value(&ParameterValue::AbsolutePercent {
                value: (-1.0).into()
            }),
            -270.0
        );
        assert_eq!(
            parameter.resolve_value(&ParameterValue::AbsolutePercent { value: 0.0.into() }),
            0.0
        );
        assert_eq!(
            parameter.resolve_value(&ParameterValue::AbsolutePercent { value: 1.0.into() }),
            270.0
        );
    }

    /// Verifies unsigned absolute percentages keep the existing zero-to-max behavior.
    #[test]
    fn unsigned_absolute_percent_resolves_from_zero_to_max() {
        let parameter = Parameter {
            metadata: metadata(ParameterValuePolarity::Unsigned),
            values: ParameterValues::default(),
        };

        assert_eq!(
            parameter.resolve_value(&ParameterValue::AbsolutePercent { value: 0.0.into() }),
            0.0
        );
        assert_eq!(
            parameter.resolve_value(&ParameterValue::AbsolutePercent { value: 1.0.into() }),
            540.0
        );
    }

    /// Verifies temporary current values resolve relative assertions without mutating the parameter.
    #[test]
    fn resolve_value_with_current_uses_explicit_relative_base() {
        let parameter = Parameter {
            metadata: metadata(ParameterValuePolarity::Unsigned),
            values: ParameterValues {
                current_value: 10.0,
                ..Default::default()
            },
        };

        assert_eq!(
            parameter.resolve_value_with_current(&ParameterValue::Relative { offset: 5.0 }, 100.0),
            105.0
        );
        assert_eq!(parameter.values.current_value, 10.0);
    }

    /// Verifies metadata conversion preserves unsigned absolute values through percentage form.
    #[test]
    fn unsigned_absolute_values_round_trip_through_absolute_percent() {
        let metadata = metadata(ParameterValuePolarity::Unsigned);
        let percent = metadata
            .parameter_value_as_absolute_percent(&ParameterValue::Absolute { value: 270.0 });
        assert_eq!(
            percent,
            ParameterValue::AbsolutePercent { value: 0.5.into() }
        );

        assert_eq!(
            metadata.parameter_value_as_absolute(&percent),
            ParameterValue::Absolute { value: 270.0 }
        );
    }

    /// Verifies metadata conversion preserves signed absolute values through percentage form.
    #[test]
    fn signed_absolute_values_round_trip_through_absolute_percent() {
        let metadata = metadata(ParameterValuePolarity::Signed);
        let percent = metadata
            .parameter_value_as_absolute_percent(&ParameterValue::Absolute { value: 135.0 });
        assert_eq!(
            percent,
            ParameterValue::AbsolutePercent { value: 0.5.into() }
        );

        assert_eq!(
            metadata.parameter_value_as_absolute(&percent),
            ParameterValue::Absolute { value: 135.0 }
        );
    }
}
