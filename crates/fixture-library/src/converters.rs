// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Converters from GDTF/OFL to nightfall-fixtures types

use nightfall_dmx::prelude::{Attribute, ParameterUnit};
use nightfall_fixtures::prelude::ParameterMetadata;

pub mod gdtf;
pub mod gdtf_resolve;
#[cfg(test)]
mod gdtf_wire_tests;
pub mod ofl;

/// Apply a physical angular range to position metadata, or retain percentage semantics.
fn apply_position_physical_range(
    metadata: &mut ParameterMetadata,
    physical_range: Option<(f32, f32)>,
) {
    if !matches!(metadata.attribute, Attribute::Pan | Attribute::Tilt) {
        return;
    }

    let Some((first, second)) = physical_range.filter(|(first, second)| {
        first.is_finite() && second.is_finite() && (*first - *second).abs() > f32::EPSILON
    }) else {
        metadata.native_unit = ParameterUnit::Percent;
        return;
    };

    metadata.native_unit = ParameterUnit::Degrees;
    metadata.min = first.min(second);
    metadata.max = first.max(second);
    metadata.is_inverted ^= first > second;
}

#[cfg(test)]
mod tests;
