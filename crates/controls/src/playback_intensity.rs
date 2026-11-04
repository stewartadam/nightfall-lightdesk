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
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_instances::{InstanceControls, InstanceId};

use crate::faders::{HeldButtonEffect, HeldButtonEffects};

/// Attributes affected by playback intensity scaling.
const INTENSITY_ATTRIBUTES: &[Attribute] = &[Attribute::Intensity, Attribute::VirtualIntensity];

/// Scales a ParameterValue by a given intensity factor (0.0 - 1.0).
fn scale_parameter_value(value: &ParameterValue, scale: f32) -> ParameterValue {
    match value {
        ParameterValue::Absolute { value } => ParameterValue::Absolute {
            value: *value * scale,
        },
        ParameterValue::AbsolutePercent { value } => ParameterValue::AbsolutePercent {
            value: Percentage::from(value.as_f32() * scale),
        },
        ParameterValue::Relative { offset } => ParameterValue::Relative {
            offset: *offset * scale,
        },
        ParameterValue::RelativePercent { offset } => ParameterValue::RelativePercent {
            offset: Percentage::from(offset.as_f32() * scale),
        },
    }
}

/// Returns true when a playback's intensity scale applies to a parameter.
///
/// Intensity parameters scale, except virtual dimmers that do not use the
/// grand master: their light path is already scaled through another dimmer
/// (see the GDTF converter), so scaling them too would apply the fader twice.
fn scales_with_playback(metadata: &ParameterMetadata) -> bool {
    INTENSITY_ATTRIBUTES.contains(&metadata.attribute)
        && !(metadata.dmx_slots == DmxSlots::Virtual && !metadata.use_grandmaster)
}

/// Returns the intensity factor a playback renders with: its clamped fader scale, or full
/// while a held Flash or Swop plays it.
fn effective_intensity_scale(intensity_scale: f32, effect: Option<HeldButtonEffect>) -> f32 {
    match effect {
        Some(HeldButtonEffect::Flashed { .. } | HeldButtonEffect::Swopping { .. }) => 1.0,
        Some(HeldButtonEffect::SwoppedOut { .. }) => 0.0,
        None => intensity_scale.clamp(0.0, 1.0),
    }
}

/// System that applies per-playback intensity scaling to layers.
///
/// This runs after layer generation but before compositing, scaling Intensity and
/// VirtualIntensity parameters by the playback's intensity_scale. Playbacks a held fader Flash
/// or Swop plays render at full instead, and those a Swop takes out (see
/// [`HeldButtonEffects`]) drop out entirely.
pub fn apply_playback_intensity(
    mut layer_query: Query<(&mut Layer, &InstanceControls, Option<&InstanceId>)>,
    param_query: Query<InstanceRef<Parameter>>,
    held_buttons: Res<HeldButtonEffects>,
) {
    for (mut layer, instance_controls, instance_id) in layer_query.iter_mut() {
        let effect = instance_id.and_then(|instance_id| held_buttons.get(instance_id));
        if matches!(effect, Some(HeldButtonEffect::SwoppedOut { .. })) {
            // A swop silences every attribute, not only intensity, so colour or position looks
            // on other playbacks cannot cover the swopped one.
            layer.absolute = Default::default();
            layer.relative = Default::default();
            layer.transitioning = Default::default();
            continue;
        }
        let scale = effective_intensity_scale(instance_controls.intensity_scale, effect);
        // Skip if intensity is at full (1.0) - no scaling needed
        if (scale - 1.0).abs() < f32::EPSILON {
            continue;
        }

        // Scale absolute intensity parameters
        for (param_instance, (value, _transition)) in layer.absolute.iter_mut() {
            if let Ok(param) = param_query.get(param_instance.entity()) {
                if scales_with_playback(&param.metadata) {
                    *value = scale_parameter_value(value, scale);
                }
            }
        }

        // Scale relative intensity parameters
        for (param_instance, (value, _transition)) in layer.relative.iter_mut() {
            if let Ok(param) = param_query.get(param_instance.entity()) {
                if scales_with_playback(&param.metadata) {
                    *value = scale_parameter_value(value, scale);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies playback scaling skips only virtual dimmers that do not use
    /// the grand master, and keeps plain intensity parameters whatever their
    /// grand master flag.
    #[test]
    fn playback_scaling_skips_virtual_dimmers_on_another_path() {
        let intensity = ParameterMetadata::default();
        assert!(scales_with_playback(&intensity));
        let virtual_dimmer = ParameterMetadata {
            dmx_slots: DmxSlots::Virtual,
            ..Default::default()
        };
        assert!(!scales_with_playback(&virtual_dimmer));
        assert!(scales_with_playback(&ParameterMetadata {
            use_grandmaster: true,
            ..virtual_dimmer
        }));
        assert!(!scales_with_playback(&ParameterMetadata {
            attribute: Attribute::Red,
            ..Default::default()
        }));
    }

    /// Verifies a flashed or swopping playback renders at full whatever its fader, a playback a Swop takes
    /// out renders at zero, and others keep their clamped fader scale.
    #[test]
    fn held_buttons_override_the_fader_scale() {
        let flashed = Some(HeldButtonEffect::Flashed { fader_index: 1 });
        let swopped_out = Some(HeldButtonEffect::SwoppedOut { fader_index: 1 });
        assert_eq!(effective_intensity_scale(0.3, None), 0.3);
        assert_eq!(effective_intensity_scale(1.4, None), 1.0);
        assert_eq!(effective_intensity_scale(0.0, flashed), 1.0);
        assert_eq!(
            effective_intensity_scale(0.0, Some(HeldButtonEffect::Swopping { fader_index: 1 })),
            1.0
        );
        assert_eq!(effective_intensity_scale(0.8, swopped_out), 0.0);
    }

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
