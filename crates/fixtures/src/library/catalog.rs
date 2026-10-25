// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Catalog of compiled built-in fixture profiles offered by every runtime.

use super::commands::AvailableFixtureInfo;
use super::{moving_heads, normalize_fixture_profile, pixel_bars, strobes};
use crate::prelude::Fixture;

/// Source-format label reported to clients for compiled built-in profiles.
pub const BUILTIN_SOURCE_FORMAT: &str = "Built-in";

/// Constructor for one built-in fixture definition from its ID, make, and model.
type BuiltinFixtureBuilder = fn(u32, &str, &str) -> Fixture;

/// One user-facing mode of a built-in profile and the definition it builds.
#[derive(Debug, Clone, Copy)]
pub struct BuiltinFixtureMode {
    /// Mode name shown in the patch wizard and recorded on patched fixtures.
    pub name: &'static str,
    /// Builds the fixture definition this mode describes.
    build: BuiltinFixtureBuilder,
}

/// One compiled fixture profile exposed through the patch wizard.
#[derive(Debug, Clone, Copy)]
pub struct BuiltinFixtureProfile {
    /// Manufacturer name.
    pub make: &'static str,
    /// Model name.
    pub model: &'static str,
    /// Modes offered by the profile; the first is the default.
    pub modes: &'static [BuiltinFixtureMode],
    /// Deterministic version string for the built-in definition.
    pub asset_etag: &'static str,
}

impl BuiltinFixtureProfile {
    /// Returns the mode names clients may request for this profile, default first.
    pub fn mode_names(&self) -> Vec<String> {
        self.modes
            .iter()
            .map(|mode| mode.name.to_string())
            .collect()
    }

    /// Returns the mode a fixture gets when no mode is requested.
    pub fn default_mode(&self) -> &'static str {
        self.modes[0].name
    }

    /// Builds the transport-facing summary advertised in fixture-library listings.
    pub fn info(&self) -> AvailableFixtureInfo {
        AvailableFixtureInfo {
            make: self.make.to_string(),
            model: self.model.to_string(),
            modes: self.mode_names(),
            source_format: BUILTIN_SOURCE_FORMAT.to_string(),
            asset_etag: self.asset_etag.to_string(),
        }
    }

    /// Instantiates this profile as a fixture with the given ID in the requested mode.
    ///
    /// Returns `None` when `mode` is not one of the profile's advertised modes, so
    /// callers cannot persist a fixture labelled with a mode the profile never offered.
    pub fn create_fixture(&self, id: u32, mode: &str) -> Option<Fixture> {
        let offered = self.modes.iter().find(|offered| offered.name == mode)?;
        let mut fixture = (offered.build)(id, self.make, self.model);
        normalize_fixture_profile(&mut fixture);
        fixture.mode = mode.to_string();
        Some(fixture)
    }
}

/// Built-in profiles available even when no fixture files are installed.
static BUILTIN_FIXTURE_PROFILES: [BuiltinFixtureProfile; 12] = [
    builtin(
        "100-segment LED Bar",
        "builtin:generic-100-segment-led-bar:v1",
        &[mode("RGB", pixel_bars::create_rgb_bar_100)],
    ),
    builtin(
        "10-segment Rotating RGBW Bar",
        "builtin:generic-10-segment-rotating-rgbw-bar:v1",
        &[mode("RGBW", moving_heads::create_linear_wash_bar)],
    ),
    builtin(
        "12-segment RGBW Bar",
        "builtin:generic-12-segment-rgbw-bar:v1",
        &[
            mode("Segments", pixel_bars::create_rgbw_bar_12),
            mode("Single", pixel_bars::create_rgbw_bar_single),
        ],
    ),
    builtin(
        "RGBPixelTape 180ch",
        "builtin:generic-rgb-pixeltape-180ch:v1",
        &[mode("RGB", pixel_bars::create_rgb_bar_60)],
    ),
    builtin(
        "RGBPixelTape 120ch GRB",
        "builtin:generic-rgb-pixeltape-120ch-grb:v1",
        &[mode("GRB", pixel_bars::create_grb_bar_40)],
    ),
    builtin(
        "RGBPixelTape 120ch RGB",
        "builtin:generic-rgb-pixeltape-120ch-rgb:v1",
        &[mode("RGB", pixel_bars::create_rgb_bar_40)],
    ),
    builtin(
        "Strobe Matrix 308ch",
        "builtin:generic-strobe-matrix-308ch:v1",
        &[mode("Strobe", strobes::create_strobe_matrix_308)],
    ),
    builtin(
        "Strobe Matrix 312ch",
        "builtin:generic-strobe-matrix-312ch:v1",
        &[mode("Strobe", strobes::create_strobe_matrix_312)],
    ),
    builtin(
        "RGB Strobe Bar 168ch",
        "builtin:generic-rgb-strobe-bar-168ch:v1",
        &[mode("Strobe", strobes::create_rgb_strobe_bar_168)],
    ),
    builtin(
        "12-segment Rotating Wash Beam",
        "builtin:generic-12-segment-rotating-wash-beam:v1",
        &[mode("Beam", moving_heads::create_rotating_wash_beam_194)],
    ),
    builtin(
        "Moving Head Spot 16ch",
        "builtin:generic-moving-head-spot-16ch:v1",
        &[mode("Spot", moving_heads::create_moving_spot_16ch)],
    ),
    builtin(
        "Moving Head RGBW",
        "builtin:generic-moving-head-rgbw:v1",
        &[mode("Spot", moving_heads::create_moving_spot)],
    ),
];

/// Declares one generic built-in catalog entry; its first mode is the default.
const fn builtin(
    model: &'static str,
    asset_etag: &'static str,
    modes: &'static [BuiltinFixtureMode],
) -> BuiltinFixtureProfile {
    BuiltinFixtureProfile {
        make: "Generic",
        model,
        modes,
        asset_etag,
    }
}

/// Declares one mode of a built-in catalog entry.
const fn mode(name: &'static str, build: BuiltinFixtureBuilder) -> BuiltinFixtureMode {
    BuiltinFixtureMode { name, build }
}

/// Returns every compiled built-in fixture profile in catalog order.
pub fn builtin_fixture_profiles() -> &'static [BuiltinFixtureProfile] {
    &BUILTIN_FIXTURE_PROFILES
}

/// Looks up one compiled built-in profile by its exact make and model.
pub fn find_builtin_fixture_profile(
    make: &str,
    model: &str,
) -> Option<&'static BuiltinFixtureProfile> {
    BUILTIN_FIXTURE_PROFILES
        .iter()
        .find(|profile| profile.make == make && profile.model == model)
}
