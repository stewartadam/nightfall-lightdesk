// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared color path types and deterministic color sampling helpers.

use std::{collections::HashMap, fmt};

use nightfall_dmx::prelude::Attribute;
use serde::{Deserialize, Serialize};
use serde_with::{DisplayFromStr, serde_as};
use typeshare::typeshare;
use uuid::Uuid;

use crate::{
    data::{FixtureRef, HasIdentifiers, Identifiers},
    transitions::FadeCurve,
};

/// Stable showfile identifier for a color path object.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare]
pub struct ColorPathId(pub u32);

impl fmt::Display for ColorPathId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// Interpolation space used by a color path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare]
pub enum ColorInterpolationSpace {
    /// Red, green, and blue additive components.
    #[default]
    Rgb,
    /// Hue, saturation, and value.
    Hsv,
    /// Cyan, magenta, and yellow subtractive components.
    Cmy,
    /// Placeholder for future CIE xyY support.
    XyY,
    /// Placeholder for future CIE-derived support.
    Cie,
}

/// Direction preference for hue interpolation in circular color spaces.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare]
pub enum HueDirection {
    /// Take the shortest angular route around the hue circle.
    #[default]
    Shortest,
    /// Increase hue around the circle.
    Clockwise,
    /// Decrease hue around the circle.
    CounterClockwise,
}

/// Timing controls for one color path component.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare]
pub struct ColorPathTimingComponent {
    /// Delay as a fraction of the parent cue fade.
    pub delay_percent: f32,
    /// Active fade duration as a fraction of the parent cue fade.
    pub time_percent: f32,
}

impl Default for ColorPathTimingComponent {
    fn default() -> Self {
        Self {
            delay_percent: 0.0,
            time_percent: 1.0,
        }
    }
}

/// Optional per-attribute timing override.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare]
pub struct ColorAttributeTiming {
    /// Delay as a fraction of the parent cue fade.
    pub delay_percent: f32,
    /// Active fade duration as a fraction of the parent cue fade.
    pub time_percent: f32,
    /// Curve used while this attribute moves.
    pub curve: FadeCurve,
}

impl Default for ColorAttributeTiming {
    fn default() -> Self {
        Self {
            delay_percent: 0.0,
            time_percent: 1.0,
            curve: FadeCurve::Linear,
        }
    }
}

/// Timing model for a color path transition.
#[serde_as]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[typeshare]
pub struct ColorPathTiming {
    /// Timing for the destination color entering.
    pub in_color: Option<ColorPathTimingComponent>,
    /// Timing for the source color leaving.
    pub out_color: Option<ColorPathTimingComponent>,
    /// Optional midpoint brightness scale for the interior of the fade.
    pub brightness_percent: Option<f32>,
    /// Optional timing overrides keyed by color attribute.
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<string, ColorAttributeTiming>")]
    pub attributes: HashMap<Attribute, ColorAttributeTiming>,
}

/// Reusable showfile color path definition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare]
pub struct ColorPath {
    /// Stable showfile object identity.
    pub identifiers: Identifiers,
    /// Interpolation space used by this path.
    pub interpolation_space: ColorInterpolationSpace,
    /// Hue route preference when using circular color spaces.
    pub hue_direction: HueDirection,
    /// Path timing controls.
    pub timing: ColorPathTiming,
    /// Default curve for the path sample.
    pub curve: FadeCurve,
}

impl ColorPath {
    /// Builds a path definition with a stable ID, label, and interpolation space.
    pub fn new(
        id: u32,
        label: impl Into<String>,
        interpolation_space: ColorInterpolationSpace,
    ) -> Self {
        Self {
            identifiers: Identifiers {
                id,
                label: label.into(),
                ..Default::default()
            },
            interpolation_space,
            hue_direction: HueDirection::Shortest,
            timing: ColorPathTiming::default(),
            curve: FadeCurve::Linear,
        }
    }

    /// Builds a built-in path definition with a deterministic showfile identity.
    fn builtin(
        id: u32,
        uid: Uuid,
        label: impl Into<String>,
        interpolation_space: ColorInterpolationSpace,
    ) -> Self {
        let mut path = Self::new(id, label, interpolation_space);
        path.identifiers.uid = uid;
        path
    }
}

impl Default for ColorPath {
    fn default() -> Self {
        Self::new(0, String::new(), ColorInterpolationSpace::Rgb)
    }
}

impl HasIdentifiers for ColorPath {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

/// Normalized RGB color used by color path sampling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[typeshare]
pub struct ColorPathRgb {
    /// Red component in the inclusive 0.0-1.0 range.
    pub red: f32,
    /// Green component in the inclusive 0.0-1.0 range.
    pub green: f32,
    /// Blue component in the inclusive 0.0-1.0 range.
    pub blue: f32,
}

impl ColorPathRgb {
    /// Multiplies all channels by one scalar.
    pub fn scaled(self, multiplier: f32) -> Self {
        Self {
            red: self.red * multiplier,
            green: self.green * multiplier,
            blue: self.blue * multiplier,
        }
    }

    /// Clamps all channels into the normalized color range.
    pub fn clamped(self) -> Self {
        Self {
            red: self.red.clamp(0.0, 1.0),
            green: self.green.clamp(0.0, 1.0),
            blue: self.blue.clamp(0.0, 1.0),
        }
    }
}

/// Default color path assignment for a fixture or fixture element.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare]
pub struct ColorPathDefault {
    /// Fixture or fixture element that receives the default color path.
    pub fixture: FixtureRef,
    /// Color path used when a cue instruction has no explicit color path.
    pub color_path_id: ColorPathId,
}

/// Returns the built-in color path definitions available in a new showfile.
pub fn builtin_color_paths() -> Vec<ColorPath> {
    vec![
        ColorPath::builtin(
            1,
            Uuid::from_u128(0x7275_7374_6c64_0000_0000_0000_0000_0001),
            "RGB",
            ColorInterpolationSpace::Rgb,
        ),
        ColorPath::builtin(
            2,
            Uuid::from_u128(0x7275_7374_6c64_0000_0000_0000_0000_0002),
            "HSV",
            ColorInterpolationSpace::Hsv,
        ),
        ColorPath::builtin(
            3,
            Uuid::from_u128(0x7275_7374_6c64_0000_0000_0000_0000_0003),
            "CMY",
            ColorInterpolationSpace::Cmy,
        ),
    ]
}

/// Samples a color path at a normalized progress ratio.
pub fn sample_color_path(
    path: &ColorPath,
    start: ColorPathRgb,
    end: ColorPathRgb,
    t: f32,
) -> ColorPathRgb {
    let ratio = path.curve.evaluate_at(t.clamp(0.0, 1.0));
    match resolved_interpolation_space(path) {
        ColorInterpolationSpace::Rgb
        | ColorInterpolationSpace::XyY
        | ColorInterpolationSpace::Cie => lerp_rgb(start, end, ratio),
        ColorInterpolationSpace::Hsv => sample_hsv(start, end, ratio, path.hue_direction),
        ColorInterpolationSpace::Cmy => sample_cmy(start, end, ratio),
    }
}

/// Resolves the interpolation space implied by a color path.
pub fn resolved_interpolation_space(path: &ColorPath) -> ColorInterpolationSpace {
    path.interpolation_space
}

/// Linearly interpolates two normalized RGB colors.
fn lerp_rgb(start: ColorPathRgb, end: ColorPathRgb, t: f32) -> ColorPathRgb {
    ColorPathRgb {
        red: lerp(start.red, end.red, t),
        green: lerp(start.green, end.green, t),
        blue: lerp(start.blue, end.blue, t),
    }
    .clamped()
}

/// Samples a subtractive CMY interpolation and converts the result back to RGB.
fn sample_cmy(start: ColorPathRgb, end: ColorPathRgb, t: f32) -> ColorPathRgb {
    let start_cmy = rgb_to_cmy(start);
    let end_cmy = rgb_to_cmy(end);
    cmy_to_rgb(ColorPathCmy {
        cyan: lerp(start_cmy.cyan, end_cmy.cyan, t),
        magenta: lerp(start_cmy.magenta, end_cmy.magenta, t),
        yellow: lerp(start_cmy.yellow, end_cmy.yellow, t),
    })
}

/// Samples an HSV interpolation and converts the result back to RGB.
fn sample_hsv(
    start: ColorPathRgb,
    end: ColorPathRgb,
    t: f32,
    direction: HueDirection,
) -> ColorPathRgb {
    let start_hsv = rgb_to_hsv(start);
    let end_hsv = rgb_to_hsv(end);
    hsv_to_rgb(ColorPathHsv {
        hue: interpolate_hue(start_hsv.hue, end_hsv.hue, t, direction),
        saturation: lerp(start_hsv.saturation, end_hsv.saturation, t),
        value: lerp(start_hsv.value, end_hsv.value, t),
    })
}

/// Interpolates two scalar values.
fn lerp(start: f32, end: f32, t: f32) -> f32 {
    start + (end - start) * t
}

/// Internal HSV representation.
#[derive(Clone, Copy)]
struct ColorPathHsv {
    hue: f32,
    saturation: f32,
    value: f32,
}

/// Internal CMY representation.
#[derive(Clone, Copy)]
struct ColorPathCmy {
    cyan: f32,
    magenta: f32,
    yellow: f32,
}

/// Converts RGB to HSV with hue normalized to 0.0-1.0.
fn rgb_to_hsv(color: ColorPathRgb) -> ColorPathHsv {
    let color = color.clamped();
    let max = color.red.max(color.green).max(color.blue);
    let min = color.red.min(color.green).min(color.blue);
    let delta = max - min;
    let hue = if delta == 0.0 {
        0.0
    } else if max == color.red {
        ((color.green - color.blue) / delta).rem_euclid(6.0) / 6.0
    } else if max == color.green {
        (((color.blue - color.red) / delta) + 2.0) / 6.0
    } else {
        (((color.red - color.green) / delta) + 4.0) / 6.0
    };
    let saturation = if max == 0.0 { 0.0 } else { delta / max };
    ColorPathHsv {
        hue,
        saturation,
        value: max,
    }
}

/// Converts HSV with hue normalized to 0.0-1.0 back to RGB.
fn hsv_to_rgb(color: ColorPathHsv) -> ColorPathRgb {
    let hue = color.hue.rem_euclid(1.0) * 6.0;
    let chroma = color.value * color.saturation;
    let x = chroma * (1.0 - ((hue % 2.0) - 1.0).abs());
    let m = color.value - chroma;
    let (red, green, blue) = if hue < 1.0 {
        (chroma, x, 0.0)
    } else if hue < 2.0 {
        (x, chroma, 0.0)
    } else if hue < 3.0 {
        (0.0, chroma, x)
    } else if hue < 4.0 {
        (0.0, x, chroma)
    } else if hue < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    ColorPathRgb {
        red: red + m,
        green: green + m,
        blue: blue + m,
    }
    .clamped()
}

/// Converts RGB to subtractive CMY.
fn rgb_to_cmy(color: ColorPathRgb) -> ColorPathCmy {
    let color = color.clamped();
    ColorPathCmy {
        cyan: 1.0 - color.red,
        magenta: 1.0 - color.green,
        yellow: 1.0 - color.blue,
    }
}

/// Converts subtractive CMY back to RGB.
fn cmy_to_rgb(color: ColorPathCmy) -> ColorPathRgb {
    ColorPathRgb {
        red: 1.0 - color.cyan,
        green: 1.0 - color.magenta,
        blue: 1.0 - color.yellow,
    }
    .clamped()
}

/// Interpolates normalized hue values using the requested route.
fn interpolate_hue(start: f32, end: f32, t: f32, direction: HueDirection) -> f32 {
    let start = start.rem_euclid(1.0);
    let end = end.rem_euclid(1.0);
    let delta = match direction {
        HueDirection::Shortest => {
            let raw = end - start;
            if raw > 0.5 {
                raw - 1.0
            } else if raw < -0.5 {
                raw + 1.0
            } else {
                raw
            }
        }
        HueDirection::Clockwise => (end - start).rem_euclid(1.0),
        HueDirection::CounterClockwise => -((start - end).rem_euclid(1.0)),
    };
    (start + delta * t).rem_euclid(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a path with the requested interpolation space.
    fn path(interpolation_space: ColorInterpolationSpace) -> ColorPath {
        ColorPath::new(101, "Test", interpolation_space)
    }

    /// Verifies built-in definitions have stable IDs and interpolation spaces.
    #[test]
    fn builtins_have_stable_ids() {
        let builtins = builtin_color_paths();
        let repeated_builtins = builtin_color_paths();
        assert_eq!(builtins[0].identifiers.id, 1);
        assert_eq!(
            builtins[0].identifiers.uid,
            repeated_builtins[0].identifiers.uid
        );
        assert_eq!(
            builtins[0].interpolation_space,
            ColorInterpolationSpace::Rgb
        );
        assert_eq!(builtins[2].identifiers.id, 3);
        assert_eq!(
            builtins[2].identifiers.uid,
            repeated_builtins[2].identifiers.uid
        );
        assert_eq!(
            builtins[2].interpolation_space,
            ColorInterpolationSpace::Cmy
        );
    }

    /// Verifies RGB sampling preserves the existing straight-line interpolation behavior.
    #[test]
    fn rgb_sampling_matches_linear_channel_interpolation() {
        let sampled = sample_color_path(
            &path(ColorInterpolationSpace::Rgb),
            ColorPathRgb {
                red: 0.0,
                green: 0.0,
                blue: 1.0,
            },
            ColorPathRgb {
                red: 1.0,
                green: 0.5,
                blue: 0.0,
            },
            0.5,
        );
        assert_eq!(
            sampled,
            ColorPathRgb {
                red: 0.5,
                green: 0.25,
                blue: 0.5,
            }
        );
    }

    /// Verifies HSV sampling can take a different route than RGB channel interpolation.
    #[test]
    fn hsv_sampling_uses_hue_route() {
        let sampled = sample_color_path(
            &path(ColorInterpolationSpace::Hsv),
            ColorPathRgb {
                red: 1.0,
                green: 0.0,
                blue: 0.0,
            },
            ColorPathRgb {
                red: 0.0,
                green: 0.0,
                blue: 1.0,
            },
            0.5,
        );
        assert!(sampled.red > 0.9, "expected red-heavy magenta midpoint");
        assert!(sampled.green < 0.1, "expected little green in HSV midpoint");
        assert!(sampled.blue > 0.9, "expected blue-heavy magenta midpoint");
    }

    /// Verifies hue direction can force the long route through green.
    #[test]
    fn hue_direction_can_force_clockwise_route() {
        let mut forced = path(ColorInterpolationSpace::Hsv);
        forced.hue_direction = HueDirection::Clockwise;
        let sampled = sample_color_path(
            &forced,
            ColorPathRgb {
                red: 1.0,
                green: 0.0,
                blue: 0.0,
            },
            ColorPathRgb {
                red: 0.0,
                green: 0.0,
                blue: 1.0,
            },
            0.5,
        );
        assert!(
            sampled.green > 0.9,
            "expected clockwise route through green"
        );
        assert!(sampled.red < 0.1, "expected little red on green midpoint");
        assert!(sampled.blue < 0.1, "expected little blue on green midpoint");
    }
}
