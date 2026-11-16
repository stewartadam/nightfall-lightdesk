// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Color path previews sampled with the engine's color path rules.

use nightfall::prelude::{color_path_preview_samples, ColorPath, ColorPathRgb};
use wasm_bindgen::prelude::*;

/// Returns `count` (at least two) evenly spaced preview colors for a color path between two
/// RGB anchors, with the path's interpolation space, curve, timing and midpoint brightness
/// applied the same way cue playback applies them to RGB fixtures.
#[wasm_bindgen]
pub fn color_path_samples(
    path: JsValue,
    start: JsValue,
    end: JsValue,
    count: u32,
) -> Result<JsValue, JsValue> {
    let path: ColorPath = serde_wasm_bindgen::from_value(path)
        .map_err(|error| JsValue::from_str(&format!("Invalid color path: {error}")))?;
    let start: ColorPathRgb = serde_wasm_bindgen::from_value(start)
        .map_err(|error| JsValue::from_str(&format!("Invalid start color: {error}")))?;
    let end: ColorPathRgb = serde_wasm_bindgen::from_value(end)
        .map_err(|error| JsValue::from_str(&format!("Invalid end color: {error}")))?;
    let samples = color_path_preview_samples(&path, start, end, count as usize);
    serde_wasm_bindgen::to_value(&samples)
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize samples: {error:?}")))
}
