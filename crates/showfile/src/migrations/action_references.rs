// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 18 → 19: timeline actions and controller mappings become bindable action references.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Converts timeline actions and controller mappings to bindable action references.
///
/// - Timeline `ActionKind` variants become the equivalent registered action reference.
/// - MIDI mappings gain a stable ID, a typed source decoded from their status byte, and the
///   behavior matching the edge they fired on.
/// - OSC mappings gain a stable ID.
/// - Action references drop the retired `control.set-external` ID and `target` clip argument.
///
/// Mapping IDs that are already valid UUIDs are kept, and values already in the v19 shape pass
/// through unchanged, so applying the step twice yields the same showfile. A mapping list that
/// is not an array, or that contains a non-object entry, fails the migration rather than
/// silently losing mappings.
pub(super) fn migrate_v18_to_v19(showfile: &mut Value) -> Result<(), String> {
    let clip_uids = clip_uids_by_id(showfile);
    let migrate_reference = |reference: &mut Value| migrate_action_reference(reference, &clip_uids);

    for action in timeline_actions(showfile) {
        let Some(kind) = action.get_mut("action") else {
            continue;
        };
        if is_action_reference(kind) {
            migrate_reference(kind);
            continue;
        }
        match timeline_action_kind_reference(kind, &clip_uids) {
            Some(reference) => *kind = reference,
            None => {
                tracing::warn!(action = %kind, "Unrecognized timeline action")
            }
        }
    }

    if let Some(mappings) = mapping_objects(showfile, "midiMappings")? {
        let mut bound_controls = HashSet::new();
        let mut migrated = Vec::with_capacity(mappings.len());
        for mut mapping in mappings {
            let legacy = Value::Object(mapping.clone());
            for field in ["device_name", "action"] {
                if !mapping.contains_key(field) {
                    return Err(format!(
                        "MIDI mapping {legacy} has no '{field}' and cannot be migrated"
                    ));
                }
            }
            if !migrate_midi_mapping(&mut mapping, &migrate_reference) {
                tracing::warn!(mapping = %legacy, "Dropping MIDI mapping with an unmappable status byte");
                continue;
            }
            // v19 binds one action per control edge, so the first legacy mapping on an edge
            // wins, matching the order lookups used.
            let control = json!([
                mapping["device_name"],
                mapping["source"],
                mapping["behavior"]
            ])
            .to_string();
            if !bound_controls.insert(control) {
                tracing::warn!(mapping = %legacy, "Dropping MIDI mapping that duplicates an earlier mapping on the same control");
                continue;
            }
            if legacy["velocity"]
                .as_u64()
                .is_some_and(|velocity| velocity > 0)
            {
                tracing::warn!(mapping = %legacy, "Dropping velocity filter from MIDI mapping");
            }
            migrated.push(Value::Object(mapping));
        }
        showfile["midiMappings"] = Value::Array(migrated);
    }

    if let Some(mappings) = mapping_objects(showfile, "oscMappings")? {
        for mapping in &mappings {
            for field in ["address", "action"] {
                if !mapping.contains_key(field) {
                    return Err(format!(
                        "OSC mapping {} has no '{field}' and cannot be migrated",
                        Value::Object(mapping.clone())
                    ));
                }
            }
        }
        let migrated = mappings
            .into_iter()
            .map(|mut mapping| {
                ensure_mapping_id(&mut mapping);
                if reads_osc_level_implicitly(&mapping) {
                    mapping.insert("arg_index".into(), json!(0));
                }
                if let Some(reference) = mapping.get_mut("action") {
                    migrate_reference(reference);
                }
                Value::Object(mapping)
            })
            .collect();
        showfile["oscMappings"] = Value::Array(migrated);
    }
    Ok(())
}

/// Takes a controller mapping list out of the showfile as JSON objects.
///
/// Returns `None` when the list is absent or null, and an error naming the list when it is not
/// an array or any entry is not an object, since such entries cannot be migrated faithfully.
fn mapping_objects(
    showfile: &mut Value,
    key: &str,
) -> Result<Option<Vec<Map<String, Value>>>, String> {
    let Some(mappings) = showfile.get_mut(key).map(Value::take) else {
        return Ok(None);
    };
    let entries = match mappings {
        Value::Null => return Ok(None),
        Value::Array(entries) => entries,
        other => {
            return Err(format!("{key} must be an array, found {other}"));
        }
    };
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| match entry {
            Value::Object(mapping) => Ok(mapping),
            other => Err(format!("{key}[{index}] must be an object, found {other}")),
        })
        .collect::<Result<_, _>>()
        .map(Some)
}

/// Keeps a mapping's existing UUID so references to it survive migration, or assigns a new one.
fn ensure_mapping_id(mapping: &mut Map<String, Value>) {
    let has_valid_id = mapping
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.parse::<Uuid>().is_ok());
    if !has_valid_id {
        mapping.insert("id".into(), json!(Uuid::new_v4()));
    }
}

/// Returns whether a timeline action is already a v19 action reference rather than a v18 kind.
fn is_action_reference(kind: &Value) -> bool {
    kind.get("id").is_some_and(Value::is_string) && kind.get("type").is_none()
}

/// Returns whether a v18 OSC mapping fed its first argument to a level action without naming it.
///
/// v18 read argument 0 as the level for `control.set-external`, its only absolute action. v19
/// treats a mapping without an argument index as a pulse, which cannot drive a level.
fn reads_osc_level_implicitly(mapping: &Map<String, Value>) -> bool {
    mapping.get("arg_index").is_none_or(Value::is_null)
        && mapping.get("arg_value").is_none_or(Value::is_null)
        && mapping
            .get("action")
            .and_then(|action| action.get("id"))
            .and_then(Value::as_str)
            == Some("control.set-external")
}

/// Indexes clip UIDs by their user-facing numeric ID, for resolving legacy numeric clip targets.
fn clip_uids_by_id(showfile: &Value) -> HashMap<u64, Value> {
    showfile
        .get("clips")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|clip| {
            let identifiers = clip.get("identifiers")?;
            Some((
                identifiers.get("id")?.as_u64()?,
                identifiers.get("uid")?.clone(),
            ))
        })
        .collect()
}

/// Returns every persisted action on every timeline track.
fn timeline_actions(showfile: &mut Value) -> impl Iterator<Item = &mut Value> {
    showfile
        .get_mut("timelines")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter_map(|timeline| timeline.get_mut("tracks")?.as_array_mut())
        .flatten()
        .filter_map(|track| track.get_mut("actions")?.as_array_mut())
        .flatten()
}

/// Translates one adjacently tagged v18 timeline `ActionKind` into an action reference.
fn timeline_action_kind_reference(kind: &Value, clip_uids: &HashMap<u64, Value>) -> Option<Value> {
    let data = kind.get("data").cloned().unwrap_or(Value::Null);
    let reference = match kind.get("type")?.as_str()? {
        "StartClip" => json!({"id": "clip.start", "arguments": {"clip": data}}),
        "StopClip" => json!({"id": "clip.stop", "arguments": {"clip": data}}),
        "AdvanceSequence" => json!({"id": "clip.go", "arguments": {"clip": data}}),
        "BackSequence" => json!({"id": "clip.back", "arguments": {"clip": data}}),
        "SetClipRate" => json!({
            "id": "clip.set-rate",
            "arguments": {"clip": data.get("uid")?, "rate": data.get("rate")?},
        }),
        "JumpToCue" => json!({
            "id": "clip.goto",
            "arguments": {"clip": data.get("uid")?, "cue_index": data.get("cue_index")?},
        }),
        "FireCue" => json!({"id": "timeline.fire-cue", "arguments": {"cue": data}}),
        "DeskEval" => json!({"id": "desk.eval", "arguments": {"command": data}}),
        "RegisteredAction" => {
            let mut reference = data;
            migrate_action_reference(&mut reference, clip_uids);
            reference
        }
        _ => return None,
    };
    Some(reference)
}

/// Rewrites retired action IDs and argument shapes inside one action reference.
fn migrate_action_reference(reference: &mut Value, clip_uids: &HashMap<u64, Value>) {
    let Some(reference) = reference.as_object_mut() else {
        return;
    };
    if reference.get("id").and_then(Value::as_str) == Some("control.set-external") {
        reference.insert("id".into(), json!("control.level"));
    }
    let Some(arguments) = reference
        .get_mut("arguments")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(target) = arguments.remove("target") else {
        return;
    };
    let clip = match target.get("type").and_then(Value::as_str) {
        Some("Uid") => target.get("data").cloned(),
        Some("Id") => target
            .get("data")
            .and_then(Value::as_u64)
            .and_then(|id| clip_uids.get(&id).cloned()),
        _ => None,
    };
    // An unresolvable target leaves the reference without a clip, which fails validation
    // when invoked instead of addressing the wrong clip.
    if let Some(clip) = clip {
        arguments.insert("clip".into(), clip);
    }
}

/// Converts one v18 MIDI mapping in place, returning false when its status byte has no typed source.
///
/// v18 stored the raw status byte in `channel`, the first data byte in `note`, and an
/// optional exact `velocity` filter, which typed sources no longer express. A mapping that
/// already has a typed source and no status byte is in the v19 shape and keeps its source and
/// behavior.
fn migrate_midi_mapping(
    mapping: &mut Map<String, Value>,
    migrate_reference: &impl Fn(&mut Value),
) -> bool {
    let is_typed =
        mapping.get("channel").is_none() && mapping.get("source").is_some_and(Value::is_object);
    if !is_typed {
        let Some(midi_source) = legacy_midi_source(mapping) else {
            return false;
        };
        let behavior = legacy_midi_behavior(mapping);
        for field in ["channel", "note", "velocity"] {
            mapping.remove(field);
        }
        mapping.insert("source".into(), midi_source);
        mapping.insert("behavior".into(), json!(behavior));
    }
    ensure_mapping_id(mapping);
    if let Some(reference) = mapping.get_mut("action") {
        migrate_reference(reference);
    }
    true
}

/// Returns the serialized `ControlBehavior` matching the edge a v18 mapping fired on.
///
/// Note-off statuses, and note-on or controller mappings matching an exact value of zero,
/// matched only releases; a controller button pair (127 to start, 0 to stop) keeps both.
fn legacy_midi_behavior(mapping: &Map<String, Value>) -> &'static str {
    let status = mapping.get("channel").and_then(Value::as_u64).unwrap_or(0);
    let velocity = mapping.get("velocity").and_then(Value::as_u64);
    match (status & 0xF0, velocity) {
        (0x80, _) | (0x90 | 0xB0, Some(0)) => "Release",
        _ => "Press",
    }
}

/// Decodes a v18 mapping's status and data bytes into a serialized `MidiSource`.
fn legacy_midi_source(mapping: &Map<String, Value>) -> Option<Value> {
    let status = u8::try_from(mapping.get("channel")?.as_u64()?).ok()?;
    let data = mapping.get("note").and_then(Value::as_u64).unwrap_or(0);
    let channel = status & 0x0F;
    Some(match status & 0xF0 {
        0x80 | 0x90 => json!({"type": "Note", "data": {"channel": channel, "note": data}}),
        0xB0 => json!({"type": "ControlChange", "data": {"channel": channel, "controller": data}}),
        0xE0 => json!({"type": "PitchBend", "data": {"channel": channel}}),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal v18 showfile exercising every migrated shape.
    fn v18_showfile() -> Value {
        json!({
            "metadata": {"showfileVersion": 18},
            "clips": [{"identifiers": {"id": 4, "uid": "cd19c920ae7c4d998ff431fade6dfa69"}}],
            "timelines": [{"tracks": [{"actions": [
                {"action": {"type": "StartClip", "data": "aa"}},
                {"action": {"type": "StopClip", "data": "aa"}},
                {"action": {"type": "AdvanceSequence", "data": "aa"}},
                {"action": {"type": "BackSequence", "data": "aa"}},
                {"action": {"type": "SetClipRate", "data": {"uid": "aa", "rate": 0.5}}},
                {"action": {"type": "JumpToCue", "data": {"uid": "aa", "cue_index": 3}}},
                {"action": {"type": "FireCue", "data": "bb"}},
                {"action": {"type": "DeskEval", "data": "clip 1 go"}},
                {"action": {"type": "RegisteredAction", "data": {
                    "id": "clip.start", "arguments": {"target": {"type": "Id", "data": 4}},
                }}},
            ]}]}],
            "midiMappings": [
                {"device_name": "Grid", "channel": 0xB1, "note": 36, "velocity": null,
                 "action": {"id": "control.set-external", "arguments": {"control_index": 1}}},
                {"device_name": "Grid", "channel": 0x92, "note": 60, "velocity": 127,
                 "action": {"id": "clip.go", "arguments": {"target": {"type": "Uid", "data": "aa"}}}},
                {"device_name": "Grid", "channel": 0xE3, "note": 0, "velocity": null,
                 "action": {"id": "control.set-external", "arguments": {"control_index": 2}}},
                {"device_name": "Grid", "channel": 0xC0, "note": 5, "velocity": null,
                 "action": {"id": "clip.go", "arguments": {}}},
                {"device_name": "Grid", "channel": 0x82, "note": 60, "velocity": null,
                 "action": {"id": "clip.stop", "arguments": {"target": {"type": "Uid", "data": "aa"}}}},
                {"device_name": "Grid", "channel": 0x92, "note": 60, "velocity": 0,
                 "action": {"id": "clip.start", "arguments": {"target": {"type": "Uid", "data": "aa"}}}},
            ],
            "oscMappings": [
                {"source": null, "address": "/fader", "arg_index": null, "arg_value": null,
                 "action": {"id": "control.set-external", "arguments": {"control_index": 3}}},
                {"source": null, "address": "/go", "arg_index": null, "arg_value": null,
                 "action": {"id": "clip.go", "arguments": {"target": {"type": "Uid", "data": "aa"}}}},
            ],
        })
    }

    /// Timeline action kinds become the registered action references the desk and timeline publish.
    #[test]
    fn timeline_action_kinds_become_action_references() {
        let mut showfile = v18_showfile();
        crate::migrations::migrate_showfile_json(&mut showfile, 18).unwrap();
        let actions: Vec<_> = showfile["timelines"][0]["tracks"][0]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| action["action"].clone())
            .collect();
        assert_eq!(
            actions,
            vec![
                json!({"id": "clip.start", "arguments": {"clip": "aa"}}),
                json!({"id": "clip.stop", "arguments": {"clip": "aa"}}),
                json!({"id": "clip.go", "arguments": {"clip": "aa"}}),
                json!({"id": "clip.back", "arguments": {"clip": "aa"}}),
                json!({"id": "clip.set-rate", "arguments": {"clip": "aa", "rate": 0.5}}),
                json!({"id": "clip.goto", "arguments": {"clip": "aa", "cue_index": 3}}),
                json!({"id": "timeline.fire-cue", "arguments": {"cue": "bb"}}),
                json!({"id": "desk.eval", "arguments": {"command": "clip 1 go"}}),
                json!({"id": "clip.start", "arguments": {"clip": "cd19c920ae7c4d998ff431fade6dfa69"}}),
            ]
        );
        assert_eq!(
            showfile["metadata"]["showfileVersion"],
            json!(crate::CURRENT_SHOWFILE_VERSION)
        );
    }

    /// MIDI mappings decode their status byte into a typed source.
    ///
    /// Note-off and zero-velocity note-on mappings become release bindings. Unmappable statuses
    /// are dropped, and so is a later mapping on an already bound control edge (here a
    /// zero-velocity note-on after a note-off), so the first binding keeps its behavior.
    #[test]
    fn midi_mappings_gain_ids_and_typed_sources() {
        let mut showfile = v18_showfile();
        migrate_v18_to_v19(&mut showfile).unwrap();
        let mappings = showfile["midiMappings"].as_array().unwrap();
        assert_eq!(mappings.len(), 4);
        for mapping in mappings {
            assert!(mapping["id"].as_str().unwrap().parse::<Uuid>().is_ok());
            assert!(mapping.get("channel").is_none() && mapping.get("velocity").is_none());
        }
        assert_eq!(
            mappings[0]["source"],
            json!({"type": "ControlChange", "data": {"channel": 1, "controller": 36}})
        );
        assert_eq!(
            mappings[0]["action"],
            json!({"id": "control.level", "arguments": {"control_index": 1}})
        );
        assert_eq!(
            mappings[1]["source"],
            json!({"type": "Note", "data": {"channel": 2, "note": 60}})
        );
        assert_eq!(
            mappings[1]["action"],
            json!({"id": "clip.go", "arguments": {"clip": "aa"}})
        );
        assert_eq!(
            mappings[2]["source"],
            json!({"type": "PitchBend", "data": {"channel": 3}})
        );
        assert_eq!(mappings[1]["behavior"], json!("Press"));
        assert_eq!(mappings[3]["source"], mappings[1]["source"]);
        assert_eq!(mappings[3]["behavior"], json!("Release"));
        assert_eq!(mappings[3]["action"]["id"], json!("clip.stop"));
    }

    /// Verifies a v18 controller button pair, one mapping on value 127 and one on value 0,
    /// keeps both as press and release bindings instead of dropping the release.
    #[test]
    fn controller_button_pairs_keep_their_release() {
        let mut showfile = v18_showfile();
        showfile["midiMappings"] = json!([
            {"device_name": "Grid", "channel": 0xB0, "note": 20, "velocity": 127,
             "action": {"id": "clip.start", "arguments": {"target": {"type": "Uid", "data": "aa"}}}},
            {"device_name": "Grid", "channel": 0xB0, "note": 20, "velocity": 0,
             "action": {"id": "clip.stop", "arguments": {"target": {"type": "Uid", "data": "aa"}}}},
        ]);
        migrate_v18_to_v19(&mut showfile).unwrap();

        let behaviors: Vec<_> = showfile["midiMappings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|mapping| (mapping["action"]["id"].clone(), mapping["behavior"].clone()))
            .collect();
        assert_eq!(
            behaviors,
            vec![
                (json!("clip.start"), json!("Press")),
                (json!("clip.stop"), json!("Release")),
            ]
        );
    }

    /// Verifies mappings missing fields they cannot be migrated without fail the migration
    /// with a message instead of panicking.
    #[test]
    fn mappings_missing_required_fields_fail_migration() {
        let mut midi = v18_showfile();
        midi["midiMappings"] = json!([{"channel": 0x90, "note": 60, "velocity": null}]);
        let error = migrate_v18_to_v19(&mut midi).unwrap_err();
        assert!(error.contains("device_name"), "{error}");

        let mut osc = v18_showfile();
        osc["oscMappings"] = json!([{"address": "/go", "arg_index": null}]);
        let error = migrate_v18_to_v19(&mut osc).unwrap_err();
        assert!(error.contains("action"), "{error}");
    }

    /// OSC mappings gain IDs, and level mappings name the argument v18 read implicitly.
    #[test]
    fn osc_mappings_gain_ids_and_keep_level_input() {
        let mut showfile = v18_showfile();
        migrate_v18_to_v19(&mut showfile).unwrap();
        let [fader, button] = showfile["oscMappings"].as_array().unwrap().as_slice() else {
            panic!("expected two OSC mappings");
        };
        for mapping in [fader, button] {
            assert!(mapping["id"].as_str().unwrap().parse::<Uuid>().is_ok());
        }
        assert_eq!(fader["action"]["id"], json!("control.level"));
        assert_eq!(fader["arg_index"], json!(0));
        assert_eq!(button["arg_index"], Value::Null);
        assert_eq!(button["action"]["arguments"], json!({"clip": "aa"}));
    }

    /// Migrated values deserialize as the current typed timeline actions and controller mappings.
    #[test]
    fn migrated_values_deserialize_as_current_types() {
        let mut showfile = v18_showfile();
        migrate_v18_to_v19(&mut showfile).unwrap();
        for action in showfile["timelines"][0]["tracks"][0]["actions"]
            .as_array()
            .unwrap()
        {
            let action = json!({
                "id": "1",
                "label": "",
                "position": {"secs": 0, "nanos": 0},
                "duration": {"secs": 0, "nanos": 0},
                "action": action["action"],
            });
            serde_json::from_value::<nightfall_timeline::prelude::Action>(action).unwrap();
        }
        #[cfg(feature = "midi")]
        serde_json::from_value::<Vec<nightfall_input_midi::prelude::MidiMapping>>(
            showfile["midiMappings"].clone(),
        )
        .unwrap();
        #[cfg(feature = "osc")]
        serde_json::from_value::<Vec<nightfall_input_osc::prelude::OscMapping>>(
            showfile["oscMappings"].clone(),
        )
        .unwrap();
    }

    /// Mappings that already carry a valid UUID keep it, so external references to them survive.
    #[test]
    fn existing_mapping_ids_are_kept() {
        let midi_id = "0b8e5c1e-9a4f-4a53-8d8e-3c0f2f0b7a11";
        let osc_id = "5f1d0a2c-7e3b-4c9d-a1e2-6b7c8d9e0f12";
        let mut showfile = v18_showfile();
        showfile["midiMappings"][0]["id"] = json!(midi_id);
        showfile["oscMappings"][0]["id"] = json!(osc_id);
        showfile["oscMappings"][1]["id"] = json!("not-a-uuid");
        migrate_v18_to_v19(&mut showfile).unwrap();
        assert_eq!(showfile["midiMappings"][0]["id"], json!(midi_id));
        assert_eq!(showfile["oscMappings"][0]["id"], json!(osc_id));
        let replaced = showfile["oscMappings"][1]["id"].as_str().unwrap();
        assert!(replaced.parse::<Uuid>().is_ok(), "{replaced}");
    }

    /// Mapping lists that are not arrays, or hold non-object entries, fail instead of losing mappings.
    #[test]
    fn malformed_mapping_lists_are_rejected() {
        for (key, mappings, expected) in [
            ("oscMappings", json!(5), "oscMappings must be an array"),
            (
                "oscMappings",
                json!({"address": "/go"}),
                "oscMappings must be an array",
            ),
            (
                "oscMappings",
                json!([{"address": "/go"}, "x"]),
                "oscMappings[1] must be an object",
            ),
            (
                "midiMappings",
                json!([1]),
                "midiMappings[0] must be an object",
            ),
            (
                "midiMappings",
                json!("mappings"),
                "midiMappings must be an array",
            ),
        ] {
            let mut showfile = v18_showfile();
            showfile[key] = mappings;
            let error = migrate_v18_to_v19(&mut showfile).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }

        let mut showfile = v18_showfile();
        showfile["oscMappings"] = Value::Null;
        migrate_v18_to_v19(&mut showfile).unwrap();
    }

    /// Reapplying the v18 to v19 step to its own output changes nothing.
    #[test]
    fn v18_to_v19_step_is_idempotent() {
        let mut once = v18_showfile();
        migrate_v18_to_v19(&mut once).unwrap();
        let mut twice = once.clone();
        migrate_v18_to_v19(&mut twice).unwrap();
        assert_eq!(twice, once);
    }

    /// Inflates the packaged browser demo show, stored gzip-compressed, into JSON.
    fn demo_showfile() -> Value {
        use std::io::Read;

        let mut json = String::new();
        flate2::read::GzDecoder::new(
            &include_bytes!(
                "../../../../webui/public/nightfall-demo.nightfall-show/showfile.json.gz"
            )[..],
        )
        .read_to_string(&mut json)
        .expect("demo showfile should be valid gzip-compressed UTF-8");
        serde_json::from_str(&json).unwrap()
    }

    /// A migrated v18 showfile survives save and reload through the real parse and serialize path.
    ///
    /// Starts from the browser test show with its timeline actions and controller mappings
    /// rewritten into v18 shapes, parses it (migrating), serializes it as a save would, and
    /// reloads the saved JSON as the current version.
    #[test]
    fn migrated_showfile_survives_save_and_reload() {
        let mut showfile: Value = demo_showfile();
        showfile["metadata"]["showfileVersion"] = json!(18);
        let legacy = v18_showfile();
        showfile["midiMappings"] = legacy["midiMappings"].clone();
        showfile["oscMappings"] = legacy["oscMappings"].clone();
        let mut legacy_actions = 0;
        for action in timeline_actions(&mut showfile) {
            let clip = action["action"]["arguments"]["clip"].clone();
            let kind = match action["action"]["id"].as_str() {
                Some("clip.start") => "StartClip",
                Some("clip.go") => "AdvanceSequence",
                _ => continue,
            };
            action["action"] = json!({"type": kind, "data": clip});
            legacy_actions += 1;
        }
        assert!(legacy_actions > 0, "fixture has no clip timeline actions");

        let migrated =
            crate::parse_showfile_snapshot_json(&showfile.to_string(), "v18 fixture").unwrap();
        assert_eq!(
            migrated.metadata.showfile_version,
            crate::CURRENT_SHOWFILE_VERSION
        );
        #[cfg(feature = "midi")]
        assert_eq!(migrated.midi_mappings.len(), 4);
        #[cfg(feature = "osc")]
        assert_eq!(migrated.osc_mappings.len(), 2);

        let saved = crate::serialize_showfile_snapshot_json(&migrated).unwrap();
        let reloaded = crate::parse_showfile_snapshot_json(&saved, "saved fixture").unwrap();
        let saved: Value = serde_json::from_str(&saved).unwrap();
        // Compared as JSON values because hash-map fields serialize in unspecified key order.
        let resaved: Value =
            serde_json::from_str(&crate::serialize_showfile_snapshot_json(&reloaded).unwrap())
                .unwrap();
        assert_eq!(resaved, saved);
        let original: Value = demo_showfile();
        assert_eq!(saved["timelines"], original["timelines"]);
    }
}
