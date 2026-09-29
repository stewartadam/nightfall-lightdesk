// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parameters are logical representation of DMX channels that hold values to
//! eventually be sent to fixtures during output.
//!
//! The profile-level model of a parameter lives in `nightfall_fixture_model`
//! so the web visualizer can share it; this module adds its runtime values
//! and ECS component.

use bevy_ecs::prelude::*;
use nightfall_compositor::types::{AbsolutePercentScale, CompositorParameter, ParameterTraits};
use nightfall_dmx::prelude::*;
use nightfall_fixture_model::parameter::*;
use nightfall_io::OutputTransport;
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;

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
        self.metadata.logical_output(self.values.current_value)
    }

    /// Gets the physical output value for DMX output.
    /// Applies the calibration offset and clamps to valid range.
    /// Use this for actual DMX output where offsets should be applied.
    pub fn get_raw_value(&self) -> ParameterDmxValue {
        self.metadata.raw_value(self.values.current_value)
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
    fn attribute(&self) -> &Attribute {
        &self.metadata.attribute
    }

    fn compositing_traits(&self) -> ParameterTraits {
        let logical_min = self.metadata.logical_min();
        let logical_range = self.metadata.logical_range();
        ParameterTraits {
            default_value: self.values.default_value,
            logical_min,
            uses_htp_merge: matches!(self.metadata.merge_type, MergeStrategy::HTP),
            is_virtual_intensity: matches!(self.metadata.attribute, Attribute::VirtualIntensity),
            absolute_percent: AbsolutePercentScale {
                min: logical_min,
                range: logical_range,
                signed: self.metadata.value_polarity == ParameterValuePolarity::Signed,
            },
            relative_percent_range: logical_range,
        }
    }

    fn current_value(&self) -> ParameterDmxValue {
        self.values.current_value
    }

    fn set_raw_value(&mut self, value: ParameterDmxValue) {
        Parameter::set_raw_value(self, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Verifies the compositor's trait snapshot resolves every value kind exactly as the parameter
    /// does, for both polarities and for percentages outside the valid span.
    #[test]
    fn compositing_traits_resolve_values_like_the_parameter() {
        let values = [
            ParameterValue::Absolute { value: 42.0 },
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            ParameterValue::AbsolutePercent {
                value: (-0.5).into(),
            },
            ParameterValue::AbsolutePercent { value: 1.5.into() },
            ParameterValue::Relative { offset: -7.0 },
            ParameterValue::RelativePercent { offset: 0.1.into() },
        ];
        for polarity in [
            ParameterValuePolarity::Unsigned,
            ParameterValuePolarity::Signed,
        ] {
            let parameter = Parameter {
                metadata: metadata(polarity),
                values: ParameterValues::default(),
            };
            let traits = parameter.compositing_traits();
            for value in &values {
                assert_eq!(
                    traits.resolve_value_with_current(value, 100.0),
                    parameter.resolve_value_with_current(value, 100.0),
                    "{polarity:?} {value:?}"
                );
            }
        }
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
}
