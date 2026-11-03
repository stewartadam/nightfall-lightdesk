// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 24 → 25: settings are saved as one map of sections, each owned by one crate.

use serde_json::{Map, Value};

/// Where each flat v24 desk setting moves: its section key and field name in that section.
const MOVED_FIELDS: &[(&str, &str, &str)] = &[
    ("programmer_auto_select", "programming", "auto_select"),
    (
        "selection_flatten_policy",
        "programming",
        "selection_flatten_policy",
    ),
    ("audio_device", "audio", "output_device"),
    ("time_display_preference", "ui", "time_display"),
    ("timeline_placement_preference", "ui", "timeline_placement"),
    (
        "sequence_reorder_renumber_policy",
        "ui",
        "sequence_reorder_renumber_policy",
    ),
    ("showfile_backup_retention", "showfile", "backup_retention"),
    (
        "parameter_keyframes_only",
        "parameterStream",
        "keyframes_only",
    ),
    ("panel_layouts", "panelLayouts", "layouts"),
    (
        "default_panel_layout_id",
        "panelLayouts",
        "default_layout_id",
    ),
];

/// Splits the flat `settings` object into sections and moves `ioSettings` into the `io` section.
///
/// Each known field moves to the section that now owns it, keeping its value. Fields the v24
/// schema did not define are dropped, as loading them already did. A document without settings
/// gets an empty map, and missing fields stay missing so each section loads its defaults.
pub(super) fn migrate_v24_to_v25(showfile: &mut Value) -> Result<(), String> {
    let Some(root) = showfile.as_object_mut() else {
        return Err("showfile root must be an object".to_string());
    };
    let mut flat = match root.remove("settings") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(flat)) => flat,
        Some(_) => return Err("showfile settings must be an object".to_string()),
    };
    let mut sections = Map::new();
    for (old_field, section, new_field) in MOVED_FIELDS {
        let Some(value) = flat.remove(*old_field) else {
            continue;
        };
        let section = sections
            .entry(section.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        section
            .as_object_mut()
            .expect("sections are created as objects")
            .insert((*new_field).to_string(), value);
    }
    if let Some(io_settings) = root.remove("ioSettings")
        && !io_settings.is_null()
    {
        sections.insert("io".to_string(), io_settings);
    }
    root.insert("settings".to_string(), Value::Object(sections));
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Every flat desk setting lands in its owner's section, and IO settings become a section.
    #[test]
    fn splits_flat_settings_into_sections() {
        let mut showfile = json!({
            "settings": {
                "programmer_auto_select": true,
                "selection_flatten_policy": "Prompt",
                "audio_device": "USB DAC",
                "time_display_preference": "Milliseconds",
                "timeline_placement_preference": "Cursor",
                "sequence_reorder_renumber_policy": "AutoRenumber",
                "showfile_backup_retention": 4,
                "parameter_keyframes_only": true,
                "panel_layouts": [{ "id": "main" }],
                "default_panel_layout_id": "main"
            },
            "ioSettings": { "network_interface": "en0" }
        });

        migrate_v24_to_v25(&mut showfile).unwrap();

        assert_eq!(
            showfile,
            json!({
                "settings": {
                    "programming": { "auto_select": true, "selection_flatten_policy": "Prompt" },
                    "audio": { "output_device": "USB DAC" },
                    "ui": {
                        "time_display": "Milliseconds",
                        "timeline_placement": "Cursor",
                        "sequence_reorder_renumber_policy": "AutoRenumber"
                    },
                    "showfile": { "backup_retention": 4 },
                    "parameterStream": { "keyframes_only": true },
                    "panelLayouts": { "layouts": [{ "id": "main" }], "default_layout_id": "main" },
                    "io": { "network_interface": "en0" }
                }
            })
        );
    }

    /// A show saved before any of these settings existed gets an empty map, so every section
    /// loads its defaults.
    #[test]
    fn missing_settings_become_an_empty_map() {
        let mut showfile = json!({ "fixtures": [] });
        migrate_v24_to_v25(&mut showfile).unwrap();
        assert_eq!(showfile, json!({ "fixtures": [], "settings": {} }));
    }

    /// Settings that are not an object cannot be split.
    #[test]
    fn rejects_non_object_settings() {
        let mut showfile = json!({ "settings": [] });
        assert!(migrate_v24_to_v25(&mut showfile).is_err());
    }
}
