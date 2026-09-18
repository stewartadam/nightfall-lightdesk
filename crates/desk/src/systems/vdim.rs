// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Virtual dimmer processing for RGB fixtures without native intensity control.
//!
//! Virtual dimmers (vdim) provide intensity control for RGB fixtures that lack native dimmer
//! channels. The vdim is exposed as a `VirtualIntensity` parameter on fixtures and post-processes
//! R,G,B color channels by scaling their values according to the vdim level, applying gamma
//! correction to achieve perceptually linear dimming.

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;

/// Default gamma value for perceptually linear LED dimming
/// TODO: 2.2 is the sRGB standard, but until we can add dithering to smooth out
/// low-brightness values, a lower gamma provides better usability.
pub const DEFAULT_GAMMA: f32 = 1.6;

/// Color attributes affected by virtual dimmer scaling.
pub const VDIM_AFFECTED_ATTRIBUTES: &[Attribute] = &[
    Attribute::Red,
    Attribute::Green,
    Attribute::Blue,
    Attribute::Amber,
    Attribute::White,
    Attribute::WarmWhite,
    Attribute::CoolWhite,
    Attribute::Cyan,
    Attribute::Magenta,
    Attribute::Yellow,
    Attribute::UV,
];

/// Apply gamma correction to a dimmer value for perceptually linear control.
///
/// Human brightness perception follows Stevens' power law. Gamma correction
/// compensates so that 50% dimmer appears as half brightness.
#[inline]
pub fn gamma_correct(value: f32, gamma: f32) -> f32 {
    value.powf(gamma)
}

/// System that applies virtual dimmer scaling to color channels.
///
/// For each element with a VirtualIntensity parameter, scales all color
/// channel values by the gamma-corrected vdim level.
pub fn apply_vdim(
    mut param_query: Query<InstanceMut<Parameter>>,
    data_provider: Res<FixtureDataProviderExt>,
) {
    // Collect vdim parameters and their corrected values.
    // We collect first because we'll mutably borrow params later.
    let vdim_entries: Vec<_> = param_query
        .iter()
        .filter(|p| p.metadata.attribute == Attribute::VirtualIntensity)
        .filter_map(|p| {
            let fixture_ref = data_provider.try_fixture_ref_for_parameter(&p.instance())?;
            let vdim_normalized = (p.values.current_value / p.metadata.max).clamp(0.0, 1.0);
            let corrected = gamma_correct(vdim_normalized, DEFAULT_GAMMA);
            Some((fixture_ref, corrected))
        })
        .collect();

    // Apply vdim to color channels on same element
    for (fixture_ref, corrected_vdim) in vdim_entries {
        for attr in VDIM_AFFECTED_ATTRIBUTES {
            if let Some(param_instance) =
                data_provider.try_parameter_for_element_attribute(&fixture_ref, attr)
                && let Ok(mut param) = param_query.get_mut(param_instance.entity())
            {
                let scaled = param.values.current_value * corrected_vdim;
                param.values.current_value = scaled;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gamma_correct_zero() {
        assert_eq!(gamma_correct(0.0, DEFAULT_GAMMA), 0.0);
    }

    #[test]
    fn test_gamma_correct_full() {
        assert_eq!(gamma_correct(1.0, DEFAULT_GAMMA), 1.0);
    }

    #[test]
    fn test_gamma_correct_half() {
        // 0.5^2.2 ≈ 0.2176
        let result = gamma_correct(0.5, 2.2);
        assert!((result - 0.217_637_64).abs() < 0.0001);
    }

    #[test]
    fn test_gamma_correct_quarter() {
        // 0.25^2.2 ≈ 0.0473
        let result = gamma_correct(0.25, 2.2);
        assert!((result - 0.047_377_035).abs() < 0.0001);
    }

    #[test]
    fn test_gamma_correct_custom_gamma() {
        // gamma=1.0 should be linear
        assert_eq!(gamma_correct(0.5, 1.0), 0.5);

        // gamma=2.0 should be simple square
        let result = gamma_correct(0.5, 2.0);
        assert!((result - 0.25).abs() < 0.0001);
    }

    #[test]
    fn test_gamma_correct_monotonic() {
        // Gamma correction should be monotonic increasing for positive gamma
        let values = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
        let corrected: Vec<f32> = values
            .iter()
            .map(|&v| gamma_correct(v, DEFAULT_GAMMA))
            .collect();

        for i in 1..corrected.len() {
            assert!(
                corrected[i] >= corrected[i - 1],
                "Gamma correction should be monotonic: {} >= {}",
                corrected[i],
                corrected[i - 1]
            );
        }
    }

    #[test]
    fn test_vdim_affected_attributes_contains_rgb() {
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Red));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Green));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Blue));
    }

    #[test]
    fn test_vdim_affected_attributes_contains_white_variants() {
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::White));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::WarmWhite));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::CoolWhite));
    }

    #[test]
    fn test_vdim_affected_attributes_contains_cmy() {
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Cyan));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Magenta));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Yellow));
    }

    #[test]
    fn test_vdim_affected_attributes_contains_amber_and_uv() {
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Amber));
        assert!(VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::UV));
    }

    #[test]
    fn test_vdim_affected_attributes_excludes_non_color() {
        assert!(!VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Intensity));
        assert!(!VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::VirtualIntensity));
        assert!(!VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Pan));
        assert!(!VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Tilt));
        assert!(!VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::StrobeShutter));
        assert!(!VDIM_AFFECTED_ATTRIBUTES.contains(&Attribute::Gobo));
    }
}
