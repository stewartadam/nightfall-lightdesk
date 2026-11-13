// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 26 → 27: FX waveform bounds become fractions of each parameter's range.
//!
//! Classic waveform FX stored their `min` and `max` as DMX-style values from 0 to 255 and
//! output them unconverted. They now hold a fraction (0-1) of the range of whichever
//! parameter the FX drives, so a full-range waveform sweeps a signed Pan end to end.

use serde_json::{Map, Value};

/// The DMX-style scale FX waveform bounds were stored on before schema 27.
const LEGACY_WAVEFORM_SCALE: f64 = 255.0;

/// Rescales the `min` and `max` of every FX waveform from 0-255 to a 0-1 fraction.
///
/// FX waveforms are found wherever they are nested, recognised by their `params`, `width`
/// and `cycle_length` fields, so FX stored anywhere in the document are converted.
pub(super) fn migrate_v26_to_v27(showfile: &mut Value) -> Result<(), String> {
    rescale_nested(showfile)
}

/// Recursively rescales FX waveform bounds in `value` and everything nested in it.
fn rescale_nested(value: &mut Value) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            if is_fx_waveform(object) {
                rescale_waveform_params(object)?;
            }
            object.values_mut().try_for_each(rescale_nested)
        }
        Value::Array(items) => items.iter_mut().try_for_each(rescale_nested),
        _ => Ok(()),
    }
}

/// Returns whether `object` has the shape of a persisted FX waveform.
fn is_fx_waveform(object: &Map<String, Value>) -> bool {
    object.get("params").is_some_and(Value::is_object)
        && object.contains_key("width")
        && object.contains_key("cycle_length")
}

/// Divides one waveform's `params.min` and `params.max` by 255, clamped to 0-1.
fn rescale_waveform_params(waveform: &mut Map<String, Value>) -> Result<(), String> {
    let Some(Value::Object(params)) = waveform.get_mut("params") else {
        return Ok(());
    };
    for key in ["min", "max"] {
        let Some(bound) = params.get_mut(key) else {
            continue;
        };
        let legacy = bound
            .as_f64()
            .ok_or_else(|| format!("FX waveform {key} must be a number"))?;
        *bound = Value::from((legacy / LEGACY_WAVEFORM_SCALE).clamp(0.0, 1.0));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Builds a schema 26 FX waveform with the given DMX-style bounds.
    fn v26_waveform(min: f64, max: f64) -> Value {
        json!({
            "params": { "kind": "Sin", "min": min, "max": max, "duty_cycle": 1.0 },
            "phase_range": [0.0, 1.0],
            "cycle_length": { "secs": 2, "nanos": 0 },
            "width": 1.0,
            "is_relative": false
        })
    }

    /// Checks that FX waveform bounds become fractions of the range, and that unrelated
    /// objects with `min` and `max` are left alone.
    #[test]
    fn fx_waveform_bounds_become_fractions() {
        let mut showfile = json!({
            "fx": [{
                "identifiers": { "id": 1 },
                "attributes": {
                    "Pan": v26_waveform(0.0, 255.0),
                    "Red": v26_waveform(51.0, 102.0)
                }
            }],
            "fixtures": [{ "elements": [{ "parameters": [{ "min": 0.0, "max": 255.0 }] }] }]
        });
        migrate_v26_to_v27(&mut showfile).unwrap();

        let pan = &showfile["fx"][0]["attributes"]["Pan"]["params"];
        assert_eq!(
            (pan["min"].as_f64(), pan["max"].as_f64()),
            (Some(0.0), Some(1.0))
        );
        let red = &showfile["fx"][0]["attributes"]["Red"]["params"];
        assert_eq!(
            (red["min"].as_f64(), red["max"].as_f64()),
            (Some(0.2), Some(0.4))
        );
        assert_eq!(
            showfile["fixtures"][0]["elements"][0]["parameters"][0],
            json!({ "min": 0.0, "max": 255.0 })
        );
    }

    /// Checks that a waveform bound that is not a number fails the migration.
    #[test]
    fn malformed_waveform_bound_fails() {
        let mut showfile = json!({ "fx": [{ "attributes": { "Pan": v26_waveform(0.0, 255.0) } }] });
        showfile["fx"][0]["attributes"]["Pan"]["params"]["max"] = json!("full");
        assert!(migrate_v26_to_v27(&mut showfile).is_err());
    }
}
