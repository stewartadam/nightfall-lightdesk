// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Per-playback intensity scaling system.
//!
//! This system applies `InstanceControls::intensity_scale` to Intensity and VirtualIntensity
//! parameters in each playback's layer BEFORE compositing. This allows individual instances
//! to have their own control/intensity control.

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_instances::InstanceControls;

/// Attributes affected by playback intensity scaling.
const INTENSITY_ATTRIBUTES: &[Attribute] = &[Attribute::Intensity, Attribute::VirtualIntensity];

/// Scales a ParameterValue by a given intensity factor (0.0 - 1.0).
fn scale_parameter_value(value: &ParameterValue, scale: f32) -> ParameterValue {
    let scale = f64::from(scale);
    match value {
        ParameterValue::Absolute { value } => ParameterValue::Absolute {
            value: *value * scale,
        },
        ParameterValue::AbsolutePercent { value } => ParameterValue::AbsolutePercent {
            value: Percentage::from(value.as_f64() * scale),
        },
        ParameterValue::Relative { offset } => ParameterValue::Relative {
            offset: *offset * scale,
        },
        ParameterValue::RelativePercent { offset } => ParameterValue::RelativePercent {
            offset: Percentage::from(offset.as_f64() * scale),
        },
    }
}

/// System that applies per-playback intensity scaling to layers.
///
/// This runs after layer generation but before compositing, scaling
/// Intensity and VirtualIntensity parameters by the playback's intensity_scale.
pub fn apply_playback_intensity(
    mut layer_query: Query<(&mut Layer, &InstanceControls)>,
    param_query: Query<InstanceRef<Parameter>>,
) {
    for (mut layer, controls) in layer_query.iter_mut() {
        // Skip if intensity is at full (1.0) - no scaling needed
        if (controls.intensity_scale - 1.0).abs() < f32::EPSILON {
            continue;
        }

        let scale = controls.intensity_scale.clamp(0.0, 1.0);

        // Scale absolute intensity parameters
        for (param_instance, (value, _transition)) in layer.absolute.iter_mut() {
            if let Ok(param) = param_query.get(param_instance.entity()) {
                if INTENSITY_ATTRIBUTES.contains(&param.metadata.attribute) {
                    *value = scale_parameter_value(value, scale);
                }
            }
        }

        // Scale relative intensity parameters
        for (param_instance, (value, _transition)) in layer.relative.iter_mut() {
            if let Ok(param) = param_query.get(param_instance.entity()) {
                if INTENSITY_ATTRIBUTES.contains(&param.metadata.attribute) {
                    *value = scale_parameter_value(value, scale);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_absolute_value() {
        let value = ParameterValue::Absolute { value: 200.0 };
        let scaled = scale_parameter_value(&value, 0.5);
        assert_eq!(scaled, ParameterValue::Absolute { value: 100.0 });
    }

    #[test]
    fn scale_absolute_percent() {
        let value = ParameterValue::AbsolutePercent {
            value: Percentage::from(80.0),
        };
        let scaled = scale_parameter_value(&value, 0.5);
        if let ParameterValue::AbsolutePercent { value } = scaled {
            assert_eq!(value, Percentage::from(40.0));
        } else {
            panic!("Expected AbsolutePercent");
        }
    }

    #[test]
    fn scale_relative_value() {
        let value = ParameterValue::Relative { offset: 100.0 };
        let scaled = scale_parameter_value(&value, 0.25);
        assert_eq!(scaled, ParameterValue::Relative { offset: 25.0 });
    }

    #[test]
    fn scale_relative_percent() {
        let value = ParameterValue::RelativePercent {
            offset: Percentage::from(50.0),
        };
        let scaled = scale_parameter_value(&value, 0.5);
        if let ParameterValue::RelativePercent { offset } = scaled {
            assert_eq!(offset, Percentage::from(25.0));
        } else {
            panic!("Expected RelativePercent");
        }
    }

    #[test]
    fn scale_at_full_intensity() {
        let value = ParameterValue::Absolute { value: 255.0 };
        let scaled = scale_parameter_value(&value, 1.0);
        assert_eq!(scaled, ParameterValue::Absolute { value: 255.0 });
    }

    #[test]
    fn scale_at_zero_intensity() {
        let value = ParameterValue::Absolute { value: 255.0 };
        let scaled = scale_parameter_value(&value, 0.0);
        assert_eq!(scaled, ParameterValue::Absolute { value: 0.0 });
    }
}
