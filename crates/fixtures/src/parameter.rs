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

/// Placement of a parameter's bytes within its fixture's DMX footprint.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DmxSlots {
    /// Bytes directly follow the previous parameter in fixture DMX order.
    #[default]
    Sequential,
    /// Bytes occupy the given footprint slots.
    Explicit {
        /// DMX break (1-based) the slots belong to. Each break has its own start address.
        dmx_break: u16,
        /// 1-based footprint slots of every byte, most significant first.
        offsets: Vec<u16>,
    },
    /// The parameter is computed by the desk and never occupies a DMX slot.
    Virtual,
}

/// A CIE 1931 color: chromaticity `x`, `y` and relative luminance `Y` (0-100).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CieColor {
    /// Chromaticity x.
    pub x: f32,
    /// Chromaticity y.
    pub y: f32,
    /// Relative luminance, 100 for a white reference.
    #[serde(rename = "Y")]
    pub luminance: f32,
}

/// A named DMX sub-range within a parameter function, e.g. one gobo or color slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParameterFunctionSet {
    /// Display name, e.g. "Open" or "Gobo 3".
    pub name: String,
    /// First DMX value of the set, at the parameter's resolution.
    pub dmx_from: u32,
    /// Last DMX value of the set, inclusive.
    pub dmx_to: u32,
    /// 1-based slot of the function's wheel selected by this set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_slot: Option<u32>,
    /// Filter color of the selected wheel slot, when it colors the beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<CieColor>,
    /// Image of the selected wheel slot (e.g. a gobo), as its archive media name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
}

/// A DMX range of a parameter with one meaning, e.g. a GDTF channel function.
///
/// A single DMX channel can select a gobo in one range and rotate it in
/// another; each range keeps its own attribute and physical scale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParameterFunction {
    /// Function name.
    pub name: String,
    /// Profile attribute name the range controls, e.g. "Gobo1" or "Gobo1PosRotate".
    pub attribute: String,
    /// First DMX value of the range, at the parameter's resolution.
    pub dmx_from: u32,
    /// Last DMX value of the range, inclusive.
    pub dmx_to: u32,
    /// Physical value at `dmx_from`.
    pub physical_from: f32,
    /// Physical value at `dmx_to`.
    pub physical_to: f32,
    /// Wheel the range indexes into, when it selects wheel slots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel: Option<String>,
    /// Measured color of the emitter this range drives, for additive color mixing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emitter_color: Option<CieColor>,
    /// Named sub-ranges in ascending DMX order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sets: Vec<ParameterFunctionSet>,
}

/// Metadata for a parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParameterMetadata {
    /// Where this parameter's bytes are placed in the fixture footprint.
    #[serde(default)]
    pub dmx_slots: DmxSlots,
    /// DMX ranges with distinct meanings, in ascending DMX order. Empty means
    /// the whole range is one linear function.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub functions: Vec<ParameterFunction>,
    /// DMX value the fixture rests at when nothing controls it, at the parameter's resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_dmx: Option<u32>,
    /// DMX value to output while the element is highlighted, at the parameter's resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight_dmx: Option<u32>,
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
            dmx_slots: DmxSlots::Sequential,
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
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
    /// Returns the DMX break this parameter writes bytes to, or `None` for virtual parameters.
    ///
    /// Sequential parameters always belong to the primary break 1.
    pub fn dmx_break(&self) -> Option<u16> {
        if self.attribute == Attribute::VirtualIntensity {
            return None;
        }
        match &self.dmx_slots {
            DmxSlots::Sequential => Some(1),
            DmxSlots::Explicit { dmx_break, .. } => Some(*dmx_break),
            DmxSlots::Virtual => None,
        }
    }

    /// Returns the function whose DMX range contains `dmx`.
    pub fn function_at(&self, dmx: u32) -> Option<&ParameterFunction> {
        self.functions
            .iter()
            .find(|function| (function.dmx_from..=function.dmx_to).contains(&dmx))
    }

    /// Converts a DMX integer at this parameter's resolution to the logical
    /// value that outputs it, inverting the output mapping (range and inversion).
    pub fn logical_value_from_dmx(&self, dmx: u32) -> ParameterDmxValue {
        let max_dmx = crate::wire_layout::dmx_max(self.resolution) as ParameterDmxValue;
        let normalized = (dmx as ParameterDmxValue / max_dmx).clamp(0.0, 1.0);
        let min = self.logical_min();
        let max = self.logical_max();
        let value = min + normalized * (max - min);
        if self.is_inverted {
            min + max - value
        } else {
            value
        }
    }

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

impl ParameterValues {
    /// Derives initial runtime values for a parameter spawned from profile metadata.
    ///
    /// Profile defaults and highlight values are used when declared. Otherwise
    /// virtual intensity starts at full so it does not black out its element,
    /// and other parameters start at zero with a full-scale highlight.
    pub fn from_metadata(metadata: &ParameterMetadata) -> Self {
        let fallback = Self::default();
        let default_value = match metadata.default_dmx {
            Some(dmx) => metadata.logical_value_from_dmx(dmx),
            None if metadata.attribute == Attribute::VirtualIntensity => metadata.max,
            None => fallback.default_value,
        };
        let highlight_value = match metadata.highlight_dmx {
            Some(dmx) => metadata.logical_value_from_dmx(dmx),
            None if metadata.attribute == Attribute::VirtualIntensity => metadata.max,
            None => fallback.highlight_value,
        };
        Self {
            default_value,
            highlight_value,
            current_value: default_value,
        }
    }
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

    /// Returns the logical value the parameter rests at, in the same space as
    /// `current_value` and layer values.
    ///
    /// The stored default is already the logical value that outputs the
    /// profile's default DMX, so inversion is applied once, on output.
    pub fn get_default_value(&self) -> ParameterDmxValue {
        self.values.default_value
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

    /// Verifies the DMX-to-logical inverse reproduces the same DMX on output, including inversion.
    #[test]
    fn logical_value_from_dmx_round_trips_through_output() {
        for (is_inverted, min, max) in [
            (false, -125.0, 125.0),
            (true, -270.0, 270.0),
            (false, 0.0, 65_535.0),
        ] {
            let metadata = ParameterMetadata {
                attribute: Attribute::Tilt,
                value_polarity: ParameterValuePolarity::Signed,
                resolution: DmxValueResolution::Fine,
                min,
                max,
                is_inverted,
                merge_type: MergeStrategy::LTP,
                ..Default::default()
            };
            for dmx in [0u32, 1, 12_345, 32_768, 65_535] {
                let parameter = Parameter {
                    values: ParameterValues {
                        current_value: metadata.logical_value_from_dmx(dmx),
                        ..Default::default()
                    },
                    metadata: metadata.clone(),
                };
                assert_eq!(
                    crate::universe::parameter_to_dmx_value(&parameter),
                    dmx,
                    "inverted={is_inverted} range={min}..{max}"
                );
            }
        }
    }

    /// Verifies an inverted parameter's declared default is inverted once:
    /// the default value a cue transition starts from outputs the declared DMX.
    #[test]
    fn inverted_default_outputs_declared_dmx() {
        let metadata = ParameterMetadata {
            is_inverted: true,
            default_dmx: Some(64),
            ..Default::default()
        };
        let values = ParameterValues::from_metadata(&metadata);
        let mut parameter = Parameter {
            values: values.clone(),
            metadata,
        };
        assert_eq!(parameter.get_default_value(), values.default_value);
        parameter.values.current_value = parameter.get_default_value();
        assert_eq!(crate::universe::parameter_to_dmx_value(&parameter), 64);
    }

    /// Verifies profile defaults and highlights seed runtime values, with legacy fallbacks otherwise.
    #[test]
    fn values_from_metadata_use_profile_defaults() {
        let tilt = ParameterMetadata {
            attribute: Attribute::Tilt,
            value_polarity: ParameterValuePolarity::Signed,
            resolution: DmxValueResolution::Fine,
            min: -125.0,
            max: 125.0,
            default_dmx: Some(32_768),
            highlight_dmx: Some(65_535),
            ..Default::default()
        };
        let values = ParameterValues::from_metadata(&tilt);
        assert!(values.default_value.abs() < 0.01);
        assert_eq!(values.current_value, values.default_value);
        assert_eq!(values.highlight_value, 125.0);

        let virtual_intensity = ParameterMetadata {
            attribute: Attribute::VirtualIntensity,
            ..Default::default()
        };
        assert_eq!(
            ParameterValues::from_metadata(&virtual_intensity).current_value,
            255.0
        );
        let plain = ParameterValues::from_metadata(&ParameterMetadata::default());
        assert_eq!((plain.default_value, plain.highlight_value), (0.0, 255.0));
    }

    /// Verifies function lookup finds the range containing a DMX value.
    #[test]
    fn function_at_finds_containing_range() {
        let function = |name: &str, dmx_from, dmx_to| ParameterFunction {
            name: name.to_string(),
            attribute: name.to_string(),
            dmx_from,
            dmx_to,
            physical_from: 0.0,
            physical_to: 1.0,
            wheel: None,
            emitter_color: None,
            sets: Vec::new(),
        };
        let metadata = ParameterMetadata {
            functions: vec![
                function("Gobo1", 0, 127),
                function("Gobo1PosRotate", 128, 255),
            ],
            ..Default::default()
        };
        assert_eq!(metadata.function_at(10).unwrap().name, "Gobo1");
        assert_eq!(metadata.function_at(200).unwrap().name, "Gobo1PosRotate");
        assert!(ParameterMetadata::default().function_at(10).is_none());
    }
}
