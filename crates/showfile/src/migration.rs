// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Historical wire-schema conversions, independent of enabled transport plugins.

use serde_json::{Value, json};
use uuid::Uuid;

/// Adds mapping identities and explicit input conversions while retaining authored data.
pub(super) fn migrate_v17(document: &mut Value) -> Result<(), String> {
    for key in ["midiMappings", "oscMappings"] {
        let Some(mappings) = document.get_mut(key) else {
            continue;
        };
        let mappings = mappings
            .as_array_mut()
            .ok_or_else(|| format!("{key} must be an array"))?;
        for (index, mapping) in mappings.iter_mut().enumerate() {
            let mapping = mapping
                .as_object_mut()
                .ok_or_else(|| format!("{key}[{index}] must be an object"))?;
            mapping.entry("id").or_insert_with(|| json!(Uuid::new_v4()));
            if mapping.contains_key("input") {
                continue;
            }
            // This was the only scalar action in schema 17. Keep historical IDs
            // here rather than consult the current, extensible runtime catalog.
            let scalar = mapping
                .get("action")
                .and_then(|action| action.get("id"))
                .and_then(Value::as_str)
                == Some("control.set-external");
            let input = if key == "oscMappings" {
                json!({"type": if scalar { "LegacyContinuous" } else { "Pulse" }})
            } else if scalar {
                json!("Continuous")
            } else {
                let channel = mapping.get("channel").and_then(Value::as_u64).unwrap_or(0);
                let release = channel & 0xf0 == 0x80 || mapping.get("velocity") == Some(&json!(0));
                if channel & 0xf0 == 0x80 {
                    mapping.insert("channel".into(), json!(0x90 | (channel & 0x0f)));
                    mapping.insert("velocity".into(), json!(0));
                }
                json!(if release { "Release" } else { "Press" })
            };
            mapping.insert("input".into(), input);
        }
    }
    document["metadata"]["showfileVersion"] = json!(super::CURRENT_SHOWFILE_VERSION);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(feature = "midi", feature = "osc"))]
    use crate::{parse_showfile_snapshot_json, serialize_showfile_snapshot_json};

    /// Builds a minimal complete old snapshot without relying on current mapping serializers.
    fn legacy_document() -> Value {
        let mut document =
            serde_json::to_value(crate::contributors::collect_save_contributions(&[])).unwrap();
        document["metadata"]["showfileVersion"] = json!(17);
        document["midiMappings"] = json!([{
            "device_name": "Grid", "channel": 176, "note": 36, "velocity": null,
            "action": {"id": "control.set-external", "arguments": {"control_index": 1}}
        }, {
            "device_name": "Keys", "channel": 128, "note": 10, "velocity": 42,
            "action": {"id": "clip.go", "arguments": {"target": {"type": "Id", "data": 2}}}
        }]);
        document["oscMappings"] = json!([{
            "source": "127.0.0.1:9000", "address": "/fader", "arg_index": 1, "arg_value": null,
            "action": {"id": "control.set-external", "arguments": {"control_index": 1}}
        }, {
            "source": null, "address": "/go", "arg_index": null, "arg_value": "go",
            "action": {"id": "desk.eval", "arguments": {"command": "clear", "metadata": null}}
        }]);
        document
    }

    /// Migration preserves selectors and opaque arguments, assigns unique identities, and is idempotent.
    #[test]
    fn migrates_mapping_fields_without_rewriting_authored_actions() {
        let mut document = legacy_document();
        let original = document.clone();
        migrate_v17(&mut document).unwrap();
        assert_eq!(document["metadata"]["showfileVersion"], 18);
        assert_eq!(document["midiMappings"][0]["input"], "Continuous");
        assert_eq!(document["midiMappings"][1]["input"], "Release");
        assert_eq!(document["midiMappings"][1]["channel"], 144);
        assert_eq!(document["midiMappings"][1]["velocity"], 0);
        assert_eq!(
            document["oscMappings"][0]["input"],
            json!({"type": "LegacyContinuous"})
        );
        assert_eq!(
            document["oscMappings"][1]["input"],
            json!({"type": "Pulse"})
        );
        let mut ids = std::collections::HashSet::new();
        for key in ["midiMappings", "oscMappings"] {
            for index in 0..2 {
                let id = Uuid::parse_str(document[key][index]["id"].as_str().unwrap()).unwrap();
                assert!(!id.is_nil());
                assert!(ids.insert(id));
                assert_eq!(
                    document[key][index]["action"],
                    original[key][index]["action"]
                );
            }
        }
        assert_eq!(document["oscMappings"][0]["arg_index"], 1);
        assert_eq!(document["oscMappings"][0]["source"], "127.0.0.1:9000");
        let migrated = document.clone();
        migrate_v17(&mut document).unwrap();
        assert_eq!(document, migrated);
    }

    /// Public parsing converts old files once; saving and reopening retains the generated identities.
    #[cfg(all(feature = "midi", feature = "osc"))]
    #[test]
    fn old_mapping_snapshot_loads_and_round_trips_as_current_schema() {
        let source = legacy_document().to_string();
        let parsed = parse_showfile_snapshot_json(&source, "legacy").unwrap();
        assert_eq!(parsed.metadata.showfile_version, 18);
        assert_eq!(parsed.midi_mappings.len(), 2);
        assert_eq!(parsed.osc_mappings.len(), 2);
        let saved = serialize_showfile_snapshot_json(&parsed).unwrap();
        let reloaded = parse_showfile_snapshot_json(&saved, "saved").unwrap();
        assert_eq!(parsed.midi_mappings, reloaded.midi_mappings);
        assert_eq!(parsed.osc_mappings, reloaded.osc_mappings);
        let mut incomplete: Value = serde_json::from_str(&saved).unwrap();
        incomplete["midiMappings"][0]
            .as_object_mut()
            .unwrap()
            .remove("id");
        assert!(parse_showfile_snapshot_json(&incomplete.to_string(), "invalid-current").is_err());
    }

    /// Branch-era version-17 records that already have IDs/input retain those exact settings.
    #[test]
    fn already_upgraded_records_keep_their_identity_and_range() {
        let mut document = legacy_document();
        let id = Uuid::new_v4();
        document["oscMappings"][0]["id"] = json!(id);
        document["oscMappings"][0]["input"] =
            json!({"type": "Continuous", "data": {"minimum": -1.0, "maximum": 1.0}});
        let original = document["oscMappings"][0].clone();
        migrate_v17(&mut document).unwrap();
        assert_eq!(document["oscMappings"][0], original);
        for malformed in [json!(null), json!({}), json!([1])] {
            document["midiMappings"] = malformed;
            assert!(migrate_v17(&mut document).is_err());
        }
    }
}
