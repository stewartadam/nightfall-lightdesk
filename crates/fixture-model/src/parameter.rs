// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Profile-declared metadata of a fixture parameter and its value mappings.

use nightfall_dmx::prelude::*;
use serde::{Deserialize, Serialize};

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

/// Physical quantity of a function's physical values, from the profile's attribute definition.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum PhysicalUnit {
    /// No physical unit, or the attribute definition could not be resolved.
    #[default]
    None,
    /// Percentage (%).
    Percent,
    /// Meters (m).
    Length,
    /// Kilograms (kg).
    Mass,
    /// Seconds (s).
    Time,
    /// Kelvin (K).
    Temperature,
    /// Candela (cd).
    LuminousIntensity,
    /// Degrees.
    Angle,
    /// Newtons (N).
    Force,
    /// Hertz (Hz).
    Frequency,
    /// Amperes (A).
    Current,
    /// Volts (V).
    Voltage,
    /// Watts (W).
    Power,
    /// Joules (J).
    Energy,
    /// Square meters (m²).
    Area,
    /// Cubic meters (m³).
    Volume,
    /// Meters per second (m/s).
    Speed,
    /// Meters per second squared (m/s²).
    Acceleration,
    /// Degrees per second.
    AngularSpeed,
    /// Degrees per second squared.
    AngularAcceleration,
    /// Nanometers (nm).
    WaveLength,
    /// Abstract color component intensity from 0 to 1.
    ColorComponent,
}

/// One facet of a prism wheel slot: how it displaces the beam and the color it transmits.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct PrismFacet {
    /// Column-major homogeneous 2D facet transform: `[0..3]` and `[3..6]` are the scaled x
    /// and y axes, `[6]`/`[7]` the translation, and `[2]`, `[5]`, `[8]` are `0, 0, 1`.
    pub transform: [f32; 9],
    /// Transmission color of the facet.
    pub color: CieColor,
}

/// A named DMX sub-range within a parameter function, e.g. one gobo or color slot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    /// Facets of the selected wheel slot when it is a prism; empty means the beam is not split.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facets: Vec<PrismFacet>,
    /// Physical value at `dmx_from` when the set overrides its function's scale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_from: Option<f32>,
    /// Physical value at `dmx_to` when the set overrides its function's scale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_to: Option<f32>,
}

/// Another parameter of the same fixture, by element position and attribute.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ElementParameterRef {
    /// 0-based index into the fixture's elements.
    pub element: u32,
    /// Attribute of the referenced parameter within that element.
    pub attribute: Attribute,
}

/// Activates a function only while another parameter outputs a DMX value in range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ModeMasterCondition {
    /// Parameter whose DMX value selects the mode.
    pub master: ElementParameterRef,
    /// First master DMX value activating the function, at the master's resolution.
    pub dmx_from: u32,
    /// Last master DMX value activating the function, inclusive.
    pub dmx_to: u32,
}

/// How a relation's master combines with its follower function.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum RelationKind {
    /// The follower's level is scaled by the master's level.
    Multiply,
    /// The follower's level is replaced by the master's level.
    Override,
}

/// A master parameter that modifies a function's output level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FunctionRelation {
    /// Master parameter.
    pub master: ElementParameterRef,
    /// How the master combines with the function.
    pub kind: RelationKind,
}

/// One segment start of a piecewise cubic DMX-to-physical curve.
///
/// From `dmx_percent` up to the next point, the physical percentage is
/// `cfc0 + cfc1·d + cfc2·d² + cfc3·d³`, where `d` is the DMX percentage past
/// `dmx_percent`. Percentages are of the function's DMX and physical spans.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ProfilePoint {
    /// DMX percentage (0-100) where the segment starts.
    pub dmx_percent: f32,
    /// Constant coefficient.
    pub cfc0: f32,
    /// Linear coefficient.
    pub cfc1: f32,
    /// Quadratic coefficient.
    pub cfc2: f32,
    /// Cubic coefficient.
    pub cfc3: f32,
}

/// Evaluates a DMX profile at a DMX percentage (0-100), returning a physical percentage.
///
/// Positions before the first point use the first segment. An empty profile
/// is linear.
pub fn evaluate_profile(points: &[ProfilePoint], dmx_percent: f32) -> f32 {
    let Some(point) = points
        .iter()
        .rev()
        .find(|point| point.dmx_percent <= dmx_percent)
        .or_else(|| points.first())
    else {
        return dmx_percent;
    };
    let d = dmx_percent - point.dmx_percent;
    point.cfc0 + d * (point.cfc1 + d * (point.cfc2 + d * point.cfc3))
}

/// A DMX range of a parameter with one meaning, e.g. a GDTF channel function.
///
/// A single DMX channel can select a gobo in one range and rotate it in
/// another; each range keeps its own attribute and physical scale.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    /// Unit of the physical values; values with [`PhysicalUnit::None`] must not be read as
    /// metres or degrees.
    #[serde(default)]
    pub physical_unit: PhysicalUnit,
    /// Wheel the range indexes into, when it selects wheel slots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel: Option<String>,
    /// Measured color of the emitter this range drives, for additive color mixing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emitter_color: Option<CieColor>,
    /// Named sub-ranges in ascending DMX order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sets: Vec<ParameterFunctionSet>,
    /// Condition under which this function applies. Functions with different
    /// conditions may overlap in DMX range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_master: Option<ModeMasterCondition>,
    /// Masters that modify this function's level.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<FunctionRelation>,
    /// DMX-to-physical curve; empty means linear.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profile: Vec<ProfilePoint>,
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

    /// Returns true when the profile places the parameter in no DMX slot, so
    /// it exists only in the console and only the console can apply relations
    /// involving it.
    pub fn is_virtual(&self) -> bool {
        self.dmx_slots == DmxSlots::Virtual
    }

    /// Returns true for parameters that dim an element.
    pub fn is_dimmer(&self) -> bool {
        matches!(
            self.attribute,
            Attribute::Intensity | Attribute::VirtualIntensity
        )
    }

    /// Returns true for parameters that emit light of their own color: color
    /// attributes and any parameter with a function driving a measured emitter.
    pub fn is_emitter(&self) -> bool {
        self.attribute.category() == AttributeCategory::Color
            || self
                .functions
                .iter()
                .any(|function| function.emitter_color.is_some())
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
        let max_dmx = self.resolution.dmx_max() as ParameterDmxValue;
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

    /// Returns the value operators see for a logical `value`: clamped to the
    /// logical range and inverted when configured, without calibration offset.
    ///
    /// Inversion mirrors the range, so applying this to a logical output
    /// recovers the value that produced it.
    pub fn logical_output(&self, value: ParameterDmxValue) -> ParameterDmxValue {
        let min = self.logical_min();
        let max = self.logical_max();
        let value = value.clamp(min, max);
        if self.is_inverted {
            min + max - value
        } else {
            value
        }
    }

    /// Returns the physical output value for a logical `value`: applies the
    /// calibration offset, clamps to the logical range and applies inversion.
    pub fn raw_value(&self, value: ParameterDmxValue) -> ParameterDmxValue {
        let min = self.logical_min();
        let max = self.logical_max();
        let offset = self.offset.resolve_as_dmx_offset(min, max);
        let value = (value + offset).clamp(min, max);
        if self.is_inverted {
            min + max - value
        } else {
            value
        }
    }

    /// Returns the DMX integer at this parameter's resolution that a logical
    /// `value` outputs, the forward mapping of [`Self::logical_value_from_dmx`].
    pub fn dmx_value(&self, value: ParameterDmxValue) -> u32 {
        let min = self.logical_min();
        let range = self.logical_max() - min;
        let normalized = if range > 0.0 {
            ((self.raw_value(value) - min) / range).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (normalized * self.resolution.dmx_max() as ParameterDmxValue).round() as u32
    }

    /// Returns a logical value as a 0-1 level of this parameter's logical range.
    pub fn level(&self, value: ParameterDmxValue) -> ParameterDmxValue {
        let range = self.logical_range();
        if range <= 0.0 {
            return 0.0;
        }
        ((value - self.logical_min()) / range).clamp(0.0, 1.0)
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
                assert_eq!(
                    metadata.dmx_value(metadata.logical_value_from_dmx(dmx)),
                    dmx,
                    "inverted={is_inverted} range={min}..{max}"
                );
            }
        }
    }

    /// Verifies the logical output of an inverted parameter maps back to the
    /// value that produced it.
    #[test]
    fn logical_output_inverts_itself() {
        let metadata = ParameterMetadata {
            is_inverted: true,
            ..Default::default()
        };
        assert_eq!(metadata.logical_output(51.0), 204.0);
        assert_eq!(metadata.logical_output(metadata.logical_output(51.0)), 51.0);
        assert_eq!(metadata.logical_output(300.0), 0.0);
    }

    /// Verifies only virtual slots make a parameter virtual; a virtual
    /// intensity on footprint slots masters its fixture like a real dimmer.
    #[test]
    fn virtual_slots_make_parameters_virtual() {
        let virtual_intensity = ParameterMetadata {
            attribute: Attribute::VirtualIntensity,
            ..Default::default()
        };
        assert!(!virtual_intensity.is_virtual());
        assert!(!ParameterMetadata::default().is_virtual());
        let virtual_slots = ParameterMetadata {
            dmx_slots: DmxSlots::Virtual,
            ..Default::default()
        };
        assert!(virtual_slots.is_virtual());
    }

    /// Verifies color attributes and measured emitters emit light, while
    /// dimmers and beam attributes do not.
    #[test]
    fn emitters_are_color_attributes_or_measured_emitters() {
        let of = |attribute| ParameterMetadata {
            attribute,
            ..Default::default()
        };
        assert!(of(Attribute::Red).is_emitter());
        assert!(of(Attribute::Cyan).is_emitter());
        assert!(!of(Attribute::Intensity).is_emitter());
        assert!(!of(Attribute::Zoom).is_emitter());
        let measured = ParameterMetadata {
            functions: vec![ParameterFunction {
                emitter_color: Some(CieColor {
                    x: 0.3,
                    y: 0.3,
                    luminance: 100.0,
                }),
                ..Default::default()
            }],
            ..of(Attribute::Custom {
                label: "Lime".to_string(),
            })
        };
        assert!(measured.is_emitter());
    }

    /// Verifies profiles evaluate each point's cubic from its own start, and
    /// that an empty profile is linear.
    #[test]
    fn profiles_evaluate_piecewise_cubics() {
        let point = |dmx_percent, cfc0, cfc1| ProfilePoint {
            dmx_percent,
            cfc0,
            cfc1,
            cfc2: 0.0,
            cfc3: 0.0,
        };
        // Flat at 0% until half-way, then rising to 100%.
        let profile = [point(0.0, 0.0, 0.0), point(50.0, 0.0, 2.0)];
        assert_eq!(evaluate_profile(&profile, 25.0), 0.0);
        assert_eq!(evaluate_profile(&profile, 75.0), 50.0);
        assert_eq!(evaluate_profile(&profile, 100.0), 100.0);
        assert_eq!(evaluate_profile(&[], 40.0), 40.0);
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
            ..Default::default()
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
