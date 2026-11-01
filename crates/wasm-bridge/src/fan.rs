// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Numeric fans resolved with the engine's fan rules, for fanned cell edits in the web UI.

use nightfall::prelude::resolve_fan_number;
use wasm_bindgen::prelude::*;

/// Spreads numeric fan waypoints such as `0>50>0` across `total` ordered targets, returning one
/// value per target. Targets on a waypoint receive it exactly; the rest interpolate linearly
/// through the surrounding segment. An empty waypoint list returns no values.
#[wasm_bindgen]
pub fn fan_numbers(waypoints: &[f64], total: u32) -> Vec<f64> {
    let total = total as usize;
    (0..total)
        .filter_map(|offset| resolve_fan_number(waypoints, offset, total))
        .collect()
}
