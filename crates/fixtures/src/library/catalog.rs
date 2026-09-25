// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Catalog of compiled built-in fixture profiles offered by every runtime.

use super::commands::AvailableFixtureInfo;
use super::create_fixture_from_library;
use crate::prelude::Fixture;

/// Source-format label reported to clients for compiled built-in profiles.
pub const BUILTIN_SOURCE_FORMAT: &str = "Built-in";

/// One compiled fixture profile exposed through the patch wizard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinFixtureProfile {
    /// Manufacturer name.
    pub make: &'static str,
    /// Model name.
    pub model: &'static str,
    /// The single user-facing mode offered by the profile.
    pub mode: &'static str,
    /// Deterministic version string for the built-in definition.
    pub asset_etag: &'static str,
}

impl BuiltinFixtureProfile {
    /// Returns the mode names clients may request for this profile.
    pub fn mode_names(&self) -> Vec<String> {
        vec![self.mode.to_string()]
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
        if mode != self.mode {
            return None;
        }
        let mut fixture = create_fixture_from_library(id, self.make, self.model, mode)?;
        fixture.mode = mode.to_string();
        Some(fixture)
    }
}

/// Built-in profiles available even when no fixture files are installed.
const BUILTIN_FIXTURE_PROFILES: [BuiltinFixtureProfile; 12] = [
    builtin(
        "100-segment LED Bar",
        "RGB",
        "builtin:generic-100-segment-led-bar:v1",
    ),
    builtin(
        "10-segment Rotating RGBW Bar",
        "RGBW",
        "builtin:generic-10-segment-rotating-rgbw-bar:v1",
    ),
    builtin(
        "12-segment RGBW Bar",
        "RGBW",
        "builtin:generic-12-segment-rgbw-bar:v1",
    ),
    builtin(
        "RGBPixelTape 180ch",
        "RGB",
        "builtin:generic-rgb-pixeltape-180ch:v1",
    ),
    builtin(
        "RGBPixelTape 120ch GRB",
        "GRB",
        "builtin:generic-rgb-pixeltape-120ch-grb:v1",
    ),
    builtin(
        "RGBPixelTape 120ch RGB",
        "RGB",
        "builtin:generic-rgb-pixeltape-120ch-rgb:v1",
    ),
    builtin(
        "Strobe Matrix 308ch",
        "Strobe",
        "builtin:generic-strobe-matrix-308ch:v1",
    ),
    builtin(
        "Strobe Matrix 312ch",
        "Strobe",
        "builtin:generic-strobe-matrix-312ch:v1",
    ),
    builtin(
        "RGB Strobe Bar 168ch",
        "Strobe",
        "builtin:generic-rgb-strobe-bar-168ch:v1",
    ),
    builtin(
        "12-segment Rotating Wash Beam",
        "Beam",
        "builtin:generic-12-segment-rotating-wash-beam:v1",
    ),
    builtin(
        "Moving Head Spot 16ch",
        "Spot",
        "builtin:generic-moving-head-spot-16ch:v1",
    ),
    builtin(
        "Moving Head RGBW",
        "Spot",
        "builtin:generic-moving-head-rgbw:v1",
    ),
];

/// Declares one generic built-in catalog entry.
const fn builtin(
    model: &'static str,
    mode: &'static str,
    asset_etag: &'static str,
) -> BuiltinFixtureProfile {
    BuiltinFixtureProfile {
        make: "Generic",
        model,
        mode,
        asset_etag,
    }
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
