// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 21 → 22: playback "rate" becomes "speed", and waveform "rate" becomes cycle length.

use nightfall_cmd_parse::statement_ranges;
use serde_json::{Map, Value};

/// Renames persisted playback-rate and waveform-rate names to their speed and cycle-length names.
///
/// - Masters of kind `PlaybackRate` become `PlaybackSpeed`.
/// - `clip.set-rate` action references become `clip.set-speed`, with `rate` argument `speed`.
/// - Timeline `RateMaster` parameter lanes become `ClipSpeed` lanes.
/// - FX waveforms rename `rate` to `cycle_length`, and flow waveforms rename `rate_secs` to
///   `cycle_length_secs`; the flow Waveform node's stored port label follows.
/// - Stored `desk.eval` command text using `clip … rate` or `fx … rate` switches to `speed`.
///
/// Action references, lanes and waveforms are found wherever they are nested (timelines,
/// controller mappings, boards, flows), so no persisted location is missed. Values already in
/// the v22 shape pass through unchanged.
pub(super) fn migrate_v21_to_v22(showfile: &mut Value) -> Result<(), String> {
    if let Some(Value::Array(masters)) = showfile.get_mut("masters") {
        for master in masters {
            if master["kind"] == "PlaybackRate" {
                master["kind"] = Value::from("PlaybackSpeed");
            }
        }
    }
    rename_nested(showfile);
    Ok(())
}

/// Recursively applies the object-level renames to `value` and everything nested in it.
fn rename_nested(value: &mut Value) {
    match value {
        Value::Object(object) => {
            rename_object(object);
            for child in object.values_mut() {
                rename_nested(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(rename_nested),
        _ => {}
    }
}

/// Renames the fields of one object when it is a clip speed action, speed lane or waveform.
fn rename_object(object: &mut Map<String, Value>) {
    if object.get("id").and_then(Value::as_str) == Some("clip.set-rate") {
        object.insert("id".to_string(), Value::from("clip.set-speed"));
        if let Some(Value::Object(arguments)) = object.get_mut("arguments") {
            rename_key(arguments, "rate", "speed");
        }
    }
    if object.get("id").and_then(Value::as_str) == Some("desk.eval")
        && let Some(Value::String(command)) = object
            .get_mut("arguments")
            .and_then(|arguments| arguments.get_mut("command"))
    {
        *command = speed_keyword_command(command);
    }
    if object.get("type").and_then(Value::as_str) == Some("RateMaster") {
        object.insert("type".to_string(), Value::from("ClipSpeed"));
    }
    if object.contains_key("params") && object.contains_key("width") {
        rename_key(object, "rate", "cycle_length");
    }
    if object.contains_key("amplitude") && object.contains_key("phase") {
        rename_key(object, "rate_secs", "cycle_length_secs");
    }
    if object.get("port_id") == Some(&Value::from(2))
        && object.get("name") == Some(&Value::from("Rate (s)"))
    {
        object.insert("name".to_string(), Value::from("Cycle length (s)"));
    }
}

/// Rewrites the retired `rate` keyword of `clip` and `fx` statements in command text to `speed`.
///
/// Stored command text such as `clip 1 rate 0.5` would otherwise stop parsing. The text may
/// hold several `;`-separated statements, as `desk.eval` runs each in turn, so each statement
/// is checked on its own and the separators and spacing between them are kept.
fn speed_keyword_command(command: &str) -> String {
    let mut rewritten = String::with_capacity(command.len());
    let mut copied = 0;
    for range in statement_ranges(command) {
        rewritten.push_str(&command[copied..range.start]);
        rewritten.push_str(&speed_keyword_statement(&command[range.start..range.end]));
        copied = range.end;
    }
    rewritten.push_str(&command[copied..]);
    rewritten
}

/// Rewrites whole `rate` words of one statement to `speed` when the statement starts with
/// `clip` or `fx`, and returns any other statement unchanged.
fn speed_keyword_statement(statement: &str) -> String {
    let first_word = statement.split_whitespace().next().unwrap_or_default();
    if !first_word.eq_ignore_ascii_case("clip") && !first_word.eq_ignore_ascii_case("fx") {
        return statement.to_string();
    }
    let mut rewritten = String::with_capacity(statement.len());
    let mut rest = statement;
    while let Some(start) = rest.find(|character: char| !character.is_whitespace()) {
        rewritten.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..end];
        rewritten.push_str(if word.eq_ignore_ascii_case("rate") {
            "speed"
        } else {
            word
        });
        rest = &rest[end..];
    }
    rewritten.push_str(rest);
    rewritten
}

/// Moves `from` to `to` in `object` when `from` is present.
fn rename_key(object: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = object.remove(from) {
        object.insert(to.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Builds a minimal v21 showfile holding every renamed shape, nested where a real show nests it.
    ///
    /// The waveform omits `phase_range`, which older shows may not have stored.
    fn v21_showfile() -> Value {
        json!({
            "metadata": {"showfileVersion": 21},
            "masters": [
                {"kind": "PlaybackRate", "levelPercent": 50.0},
                {"kind": "InhibitiveIntensity", "levelPercent": 100.0}
            ],
            "fx": [{
                "attributes": {
                    "Dimmer": {
                        "params": {"kind": "sin"},
                        "rate": {"secs": 2, "nanos": 0},
                        "width": 1.0
                    }
                }
            }],
            "flows": [{
                "nodes": [{
                    "ports": [{"port_id": 2, "name": "Rate (s)"}, {"port_id": 2, "name": "Rate (BPM)"}],
                    "value": {"type": "Waveform", "data": {
                        "kind": "Sine", "rate_secs": 4.0, "amplitude": 1.0, "phase": 0.0, "base": 0.0
                    }}
                }]
            }],
            "timelines": [{
                "tracks": [{
                    "actions": [{"action": {"id": "clip.set-rate", "arguments": {"clip": "aa", "rate": 0.5}}}],
                    "parameters": [{"parameter_type": {"type": "RateMaster", "data": "aa"}}]
                }]
            }],
            "midiMappings": [
                {"action": {"id": "clip.set-rate", "arguments": {"clip": "bb", "rate": 2.0}}},
                {"action": {"id": "desk.eval", "arguments": {"command": "clip 3 rate 0.5"}}},
                {"action": {"id": "desk.eval", "arguments": {"command": "FX 2  Rate 2"}}},
                {"action": {"id": "desk.eval", "arguments": {"command": "group rate"}}},
                {"action": {"id": "desk.eval", "arguments": {"command": "group 1 at 50; clip 2 rate 0.5;fx 1 rate 2"}}}
            ]
        })
    }

    /// Every renamed shape takes its v22 name and keeps its value.
    #[test]
    fn renames_rate_shapes_to_speed_and_cycle_length() {
        let mut showfile = v21_showfile();
        migrate_v21_to_v22(&mut showfile).unwrap();

        assert_eq!(showfile["masters"][0]["kind"], "PlaybackSpeed");
        assert_eq!(showfile["masters"][1]["kind"], "InhibitiveIntensity");
        let waveform = &showfile["fx"][0]["attributes"]["Dimmer"];
        assert_eq!(waveform["cycle_length"], json!({"secs": 2, "nanos": 0}));
        assert!(waveform.get("rate").is_none());
        let flow_waveform = &showfile["flows"][0]["nodes"][0]["value"]["data"];
        assert_eq!(flow_waveform["cycle_length_secs"], 4.0);
        let ports = &showfile["flows"][0]["nodes"][0]["ports"];
        assert_eq!(ports[0]["name"], "Cycle length (s)");
        assert_eq!(ports[1]["name"], "Rate (BPM)");
        assert!(flow_waveform.get("rate_secs").is_none());
        let track = &showfile["timelines"][0]["tracks"][0];
        assert_eq!(
            track["actions"][0]["action"],
            json!({"id": "clip.set-speed", "arguments": {"clip": "aa", "speed": 0.5}})
        );
        assert_eq!(
            track["parameters"][0]["parameter_type"],
            json!({"type": "ClipSpeed", "data": "aa"})
        );
        assert_eq!(
            showfile["midiMappings"][0]["action"],
            json!({"id": "clip.set-speed", "arguments": {"clip": "bb", "speed": 2.0}})
        );
        assert_eq!(
            showfile["midiMappings"][1]["action"]["arguments"]["command"],
            "clip 3 speed 0.5"
        );
        assert_eq!(
            showfile["midiMappings"][2]["action"]["arguments"]["command"],
            "FX 2  speed 2"
        );
        assert_eq!(
            showfile["midiMappings"][3]["action"]["arguments"]["command"],
            "group rate"
        );
        assert_eq!(
            showfile["midiMappings"][4]["action"]["arguments"]["command"],
            "group 1 at 50; clip 2 speed 0.5;fx 1 speed 2"
        );
    }

    /// Applying the step to an already migrated showfile changes nothing.
    #[test]
    fn migration_is_idempotent() {
        let mut once = v21_showfile();
        migrate_v21_to_v22(&mut once).unwrap();
        let mut twice = once.clone();
        migrate_v21_to_v22(&mut twice).unwrap();
        assert_eq!(once, twice);
    }

    /// Unrelated objects that only share a field name with a renamed shape are left alone.
    #[test]
    fn leaves_unrelated_rate_fields_untouched() {
        let mut showfile = json!({
            "timecodes": [{"rate": "Fps30", "source": "Internal"}],
            "settings": {"type": "Other", "rate": 44}
        });
        let expected = showfile.clone();
        migrate_v21_to_v22(&mut showfile).unwrap();
        assert_eq!(showfile, expected);
    }
}
