// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Upgrades older showfile JSON to the current schema before typed deserialization.
//!
//! Each step rewrites the raw JSON of one version into the next and bumps
//! `metadata.showfileVersion`, so steps compose from any supported version.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::CURRENT_SHOWFILE_VERSION;

/// Oldest showfile version that can still be migrated to the current schema.
pub(crate) const OLDEST_MIGRATABLE_SHOWFILE_VERSION: u32 = 17;

/// Rewrites a showfile of a supported older version in place until it matches the current schema.
///
/// Returns an error naming the source when the version is outside the supported range.
pub(crate) fn migrate_showfile_json(
    showfile: &mut Value,
    mut version: u32,
    source: &str,
) -> Result<(), String> {
    if !(OLDEST_MIGRATABLE_SHOWFILE_VERSION..=CURRENT_SHOWFILE_VERSION).contains(&version) {
        return Err(format!(
            "unsupported showfile version {version} in {source}; this nightfall build requires version {CURRENT_SHOWFILE_VERSION}"
        ));
    }
    while version < CURRENT_SHOWFILE_VERSION {
        match version {
            17 => migrate_v17_to_v18(showfile, source),
            _ => unreachable!("every version in the supported range has a migration step"),
        }
        version += 1;
        showfile["metadata"]["showfileVersion"] = json!(version);
        tracing::info!(filename = source, version, "Migrated showfile schema");
    }
    Ok(())
}

/// Converts timeline actions and controller mappings to bindable action references.
///
/// - Timeline `ActionKind` variants become the equivalent registered action reference.
/// - MIDI mappings gain a stable ID, a typed source decoded from their status byte, and the
///   edge they fired on.
/// - OSC mappings gain a stable ID.
/// - Action references drop the retired `control.set-external` ID and `target` clip argument.
fn migrate_v17_to_v18(showfile: &mut Value, source: &str) {
    let clip_uids = clip_uids_by_id(showfile);
    let migrate_reference = |reference: &mut Value| migrate_action_reference(reference, &clip_uids);

    for action in timeline_actions(showfile) {
        let Some(kind) = action.get_mut("action") else {
            continue;
        };
        match timeline_action_kind_reference(kind, &clip_uids) {
            Some(reference) => *kind = reference,
            None => {
                tracing::warn!(filename = source, action = %kind, "Unrecognized timeline action")
            }
        }
    }

    if let Some(mappings) = showfile
        .get_mut("midiMappings")
        .and_then(Value::as_array_mut)
    {
        let mut bound_controls = HashSet::new();
        mappings.retain_mut(|mapping| {
            let legacy = mapping.clone();
            if !migrate_midi_mapping(mapping, &migrate_reference) {
                tracing::warn!(filename = source, mapping = %legacy, "Dropping MIDI mapping with an unmappable status byte");
                return false;
            }
            // v18 binds one action per control edge, so the first legacy mapping on an edge
            // wins, matching the order lookups used.
            let control =
                json!([mapping["device_name"], mapping["source"], mapping["edge"]]).to_string();
            if !bound_controls.insert(control) {
                tracing::warn!(filename = source, mapping = %legacy, "Dropping MIDI mapping that duplicates an earlier mapping on the same control");
                return false;
            }
            if legacy["velocity"].as_u64().is_some_and(|velocity| velocity > 0) {
                tracing::warn!(filename = source, mapping = %legacy, "Dropping velocity filter from MIDI mapping");
            }
            true
        });
    }

    if let Some(mappings) = showfile
        .get_mut("oscMappings")
        .and_then(Value::as_array_mut)
    {
        for mapping in mappings.iter_mut().filter_map(Value::as_object_mut) {
            mapping.insert("id".into(), json!(Uuid::new_v4()));
            if reads_osc_level_implicitly(mapping) {
                mapping.insert("arg_index".into(), json!(0));
            }
            if let Some(reference) = mapping.get_mut("action") {
                migrate_reference(reference);
            }
        }
    }
}

/// Returns whether a v17 OSC mapping fed its first argument to a level action without naming it.
///
/// v17 read argument 0 as the level for `control.set-external`, its only absolute action. v18
/// treats a mapping without an argument index as a pulse, which cannot drive a level.
fn reads_osc_level_implicitly(mapping: &Map<String, Value>) -> bool {
    mapping.get("arg_index").is_none_or(Value::is_null)
        && mapping.get("arg_value").is_none_or(Value::is_null)
        && mapping["action"]["id"] == "control.set-external"
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

/// Translates one adjacently tagged v17 timeline `ActionKind` into an action reference.
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

/// Converts one v17 MIDI mapping in place, returning false when its status byte has no typed source.
///
/// v17 stored the raw status byte in `channel`, the first data byte in `note`, and an
/// optional exact `velocity` filter, which typed sources no longer express.
fn migrate_midi_mapping(mapping: &mut Value, migrate_reference: &impl Fn(&mut Value)) -> bool {
    let Some(mapping) = mapping.as_object_mut() else {
        return false;
    };
    let Some(midi_source) = legacy_midi_source(mapping) else {
        return false;
    };
    let edge = legacy_midi_edge(mapping);
    for field in ["channel", "note", "velocity"] {
        mapping.remove(field);
    }
    mapping.insert("id".into(), json!(Uuid::new_v4()));
    mapping.insert("source".into(), midi_source);
    mapping.insert("edge".into(), json!(edge));
    if let Some(reference) = mapping.get_mut("action") {
        migrate_reference(reference);
    }
    true
}

/// Returns the serialized `SourceEdge` a v17 mapping fired on.
///
/// Note-off statuses and note-on with an exact velocity of zero matched only releases.
fn legacy_midi_edge(mapping: &Map<String, Value>) -> &'static str {
    let status = mapping.get("channel").and_then(Value::as_u64).unwrap_or(0);
    let velocity = mapping.get("velocity").and_then(Value::as_u64);
    match (status & 0xF0, velocity) {
        (0x80, _) | (0x90, Some(0)) => "Release",
        _ => "Press",
    }
}

/// Decodes a v17 mapping's status and data bytes into a serialized `MidiSource`.
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

    /// Builds a minimal v17 showfile exercising every migrated shape.
    fn v17_showfile() -> Value {
        json!({
            "metadata": {"showfileVersion": 17},
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
        let mut showfile = v17_showfile();
        migrate_showfile_json(&mut showfile, 17, "v17").unwrap();
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
            json!(CURRENT_SHOWFILE_VERSION)
        );
    }

    /// MIDI mappings decode their status byte into a typed source.
    ///
    /// Note-off and zero-velocity note-on mappings become release bindings. Unmappable statuses
    /// are dropped, and so is a later mapping on an already bound control edge (here a
    /// zero-velocity note-on after a note-off), so the first binding keeps its behavior.
    #[test]
    fn midi_mappings_gain_ids_and_typed_sources() {
        let mut showfile = v17_showfile();
        migrate_showfile_json(&mut showfile, 17, "v17").unwrap();
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
        assert_eq!(mappings[1]["edge"], json!("Press"));
        assert_eq!(mappings[3]["source"], mappings[1]["source"]);
        assert_eq!(mappings[3]["edge"], json!("Release"));
        assert_eq!(mappings[3]["action"]["id"], json!("clip.stop"));
    }

    /// OSC mappings gain IDs, and level mappings name the argument v17 read implicitly.
    #[test]
    fn osc_mappings_gain_ids_and_keep_level_input() {
        let mut showfile = v17_showfile();
        migrate_showfile_json(&mut showfile, 17, "v17").unwrap();
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
        let mut showfile = v17_showfile();
        migrate_showfile_json(&mut showfile, 17, "v17").unwrap();
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

    /// Versions outside the migratable range are rejected rather than parsed as the current schema.
    #[test]
    fn unmigratable_versions_are_rejected() {
        for version in [
            OLDEST_MIGRATABLE_SHOWFILE_VERSION - 1,
            CURRENT_SHOWFILE_VERSION + 1,
        ] {
            let error = migrate_showfile_json(&mut v17_showfile(), version, "old").unwrap_err();
            assert!(
                error.contains(&format!("unsupported showfile version {version}")),
                "{error}"
            );
        }
    }
}
