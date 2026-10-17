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

use std::collections::HashSet;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_instances::{
    EditorPreviewInstance, InstanceControls, InstanceId, InstanceKind, InstanceMetadata,
};

use crate::{clips::MaterializedClip, controls::Controls};

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

/// How a held slot Flash or Swop affects one playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeldButtonEffect {
    /// No held button concerns the playback.
    None,
    /// A held Flash or Swop plays the playback at full intensity.
    Flashed,
    /// A Swop held on another playback silences every attribute of this one.
    Muted,
}

impl HeldButtonEffect {
    /// Decides how held buttons affect one playback: flashed playbacks play at full, and
    /// while any Swop is held every other playback is muted unless it is `swop_exempt`.
    fn for_instance(
        instance_id: Option<&InstanceId>,
        swop_exempt: bool,
        flashed: &HashSet<InstanceId>,
        swopped: &HashSet<InstanceId>,
    ) -> Self {
        if instance_id.is_some_and(|instance_id| flashed.contains(instance_id)) {
            Self::Flashed
        } else if !swopped.is_empty() && !swop_exempt {
            Self::Muted
        } else {
            Self::None
        }
    }
}

/// Returns the intensity factor a playback renders with: its fader scale, full while flashed,
/// or zero while another playback is swopped (whose layer is silenced outright anyway).
fn effective_intensity_scale(intensity_scale: f32, effect: HeldButtonEffect) -> f32 {
    match effect {
        HeldButtonEffect::None => intensity_scale.clamp(0.0, 1.0),
        HeldButtonEffect::Flashed => 1.0,
        HeldButtonEffect::Muted => 0.0,
    }
}

/// System that applies per-playback intensity scaling to layers.
///
/// This runs after layer generation but before compositing, scaling Intensity and
/// VirtualIntensity parameters by the playback's intensity_scale. Clips held by a slot Flash
/// or Swop play at full instead, and while any Swop is held every other show playback except the
/// Programmer drops out entirely; editor previews keep playing.
pub fn apply_playback_intensity(
    mut layer_query: Query<(
        &mut Layer,
        &InstanceControls,
        Option<&InstanceId>,
        Option<&InstanceMetadata>,
        Has<EditorPreviewInstance>,
    )>,
    param_query: Query<InstanceRef<Parameter>>,
    controls: Res<Controls>,
    materialized_clips: Query<&MaterializedClip>,
) {
    let mut flashed = HashSet::new();
    let mut swopped = HashSet::new();
    for (clip_id, swop) in controls.flashed_clips() {
        for materialized in materialized_clips
            .iter()
            .filter(|materialized| materialized.clip_id == clip_id)
        {
            flashed.insert(materialized.attached_instance);
            if swop {
                swopped.insert(materialized.attached_instance);
            }
        }
    }

    for (mut layer, instance_controls, instance_id, metadata, is_preview) in layer_query.iter_mut()
    {
        // The Programmer stays live so the operator can keep working during a swop, and
        // editor previews and layers that are not show playbacks are not the swop's to mute.
        let swop_exempt =
            is_preview || metadata.is_none_or(|metadata| metadata.kind == InstanceKind::Programmer);
        let effect = HeldButtonEffect::for_instance(instance_id, swop_exempt, &flashed, &swopped);
        if effect == HeldButtonEffect::Muted {
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

    /// Verifies a Swop mutes every playback that is neither flashed nor the Programmer, and
    /// that a plain Flash mutes nothing.
    #[test]
    fn swop_mutes_other_playbacks_but_not_the_programmer() {
        let swopped_id = InstanceId::new();
        let flashed_id = InstanceId::new();
        let other_id = InstanceId::new();
        let flashed = HashSet::from([swopped_id, flashed_id]);
        let swopped = HashSet::from([swopped_id]);
        let effect = |id, swop_exempt, swopped: &HashSet<InstanceId>| {
            HeldButtonEffect::for_instance(id, swop_exempt, &flashed, swopped)
        };

        assert_eq!(
            effect(Some(&swopped_id), false, &swopped),
            HeldButtonEffect::Flashed
        );
        assert_eq!(
            effect(Some(&flashed_id), false, &swopped),
            HeldButtonEffect::Flashed
        );
        assert_eq!(
            effect(Some(&other_id), false, &swopped),
            HeldButtonEffect::Muted
        );
        assert_eq!(
            effect(Some(&other_id), true, &swopped),
            HeldButtonEffect::None
        );
        assert_eq!(
            effect(Some(&other_id), false, &HashSet::new()),
            HeldButtonEffect::None
        );
    }

    /// Verifies a flashed playback renders at full whatever its fader, a playback muted by
    /// another's Swop renders at zero, and others keep their clamped fader scale.
    #[test]
    fn held_buttons_override_the_fader_scale() {
        assert_eq!(effective_intensity_scale(0.3, HeldButtonEffect::None), 0.3);
        assert_eq!(effective_intensity_scale(1.4, HeldButtonEffect::None), 1.0);
        assert_eq!(
            effective_intensity_scale(0.0, HeldButtonEffect::Flashed),
            1.0
        );
        assert_eq!(effective_intensity_scale(0.8, HeldButtonEffect::Muted), 0.0);
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
