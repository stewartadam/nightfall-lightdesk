// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Registry facade for explicit built-in fixture profiles.
//!
//! These profiles support sample data and direct fixture creation for a small set
//! of exact make/model identifiers. User-imported GDTF and OFL definitions are
//! scanned and converted by the separate `nightfall-fixture-library` crate; this
//! module intentionally does not duplicate that general profile system.

mod moving_heads;
mod pixel_bars;
mod strobes;

#[cfg(test)]
mod tests;

use crate::prelude::Fixture;

/// Updates known built-in fixture profiles that may have been persisted before profile fixes.
pub fn normalize_fixture_profile(fixture: &mut Fixture) {
    moving_heads::normalize_fixture_profile(fixture);
}

/// Creates an explicit built-in fixture for an exact make/model identifier.
///
/// The mode is accepted to match the fixture creation command contract but is
/// currently ignored by built-in profiles. Returns `None` for identifiers owned
/// by imported fixture-library sources or otherwise unknown to this registry.
pub fn create_fixture_from_library(
    id: u32,
    make: &str,
    model: &str,
    _mode: &str,
) -> Option<Fixture> {
    let mut fixture = match (make, model) {
        ("Generic", "100-segment LED Bar") => Some(pixel_bars::create_rgb_bar_100(id, make, model)),
        ("Generic", "10-segment Rotating RGBW Bar") => {
            Some(moving_heads::create_linear_wash_bar(id, make, model))
        }
        ("Generic", "12-segment RGBW Bar") => Some(pixel_bars::create_rgbw_bar_12(id, make, model)),
        ("Generic", "RGBPixelTape 180ch") => Some(pixel_bars::create_rgb_bar_60(id, make, model)),
        ("Generic", "RGBPixelTape 120ch GRB") => {
            Some(pixel_bars::create_grb_bar_40(id, make, model))
        }
        ("Generic", "RGBPixelTape 120ch RGB") => {
            Some(pixel_bars::create_rgb_bar_40(id, make, model))
        }
        ("Generic", "Strobe Matrix 308ch") => Some(strobes::create_strobe(id, make, model, 16)),
        ("Generic", "Strobe Matrix 312ch") => Some(strobes::create_strobe(id, make, model, 20)),
        ("Generic", "RGB Strobe Bar 168ch") => {
            Some(strobes::create_rgb_strobe_bar_168(id, make, model))
        }
        ("Generic", "12-segment Rotating Wash Beam") => {
            Some(moving_heads::create_rotating_wash_beam_194(id, make, model))
        }
        ("Generic", "Moving Head Spot 16ch") => {
            Some(moving_heads::create_moving_spot_16ch(id, make, model))
        }
        ("Generic", "Moving Head RGBW") => Some(moving_heads::create_moving_spot(id, make, model)),
        _ => None,
    }?;

    normalize_fixture_profile(&mut fixture);
    Some(fixture)
}
