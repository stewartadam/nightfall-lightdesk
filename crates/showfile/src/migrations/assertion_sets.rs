// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 23 → 24: bound cue instructions are saved as bound assertion sets.

use serde_json::Value;

/// Renames the `cue_instruction` field of every bound instruction to `assertions`.
///
/// Bound instructions are saved in cues, cue parts, and the setup and release cues of
/// sequences. The whole document is walked, as the other renaming migrations do, so a cue held
/// anywhere is covered. Only objects shaped like a bound instruction, a `cue_instruction` next
/// to a `selection`, are rewritten. Values already in the v24 shape pass through unchanged.
pub(super) fn migrate_v23_to_v24(showfile: &mut Value) -> Result<(), String> {
    rename_bound_instructions(showfile);
    Ok(())
}

/// Recursively renames `cue_instruction` to `assertions` on bound instruction objects.
fn rename_bound_instructions(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.contains_key("selection")
                && let Some(assertions) = object.remove("cue_instruction")
            {
                object.insert("assertions".to_string(), assertions);
            }
            object.values_mut().for_each(rename_bound_instructions);
        }
        Value::Array(items) => items.iter_mut().for_each(rename_bound_instructions),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Builds a v23 document holding bound instructions in a cue, a cue part, and a sequence's
    /// setup cue.
    fn v23_showfile() -> Value {
        json!({
            "cues": [{
                "instructions": [{
                    "selection": { "source": "All" },
                    "cue_instruction": { "values": { "Dimmer": 1.0 } }
                }],
                "parts": [{
                    "instructions": [{
                        "selection": { "source": "All" },
                        "cue_instruction": { "values": {} }
                    }]
                }]
            }],
            "sequences": [{
                "setup_cue": {
                    "instructions": [{ "selection": {}, "cue_instruction": { "values": {} } }]
                }
            }]
        })
    }

    /// Checks that every nested bound instruction gets an `assertions` field.
    #[test]
    fn renames_nested_bound_instructions() {
        let mut showfile = v23_showfile();
        migrate_v23_to_v24(&mut showfile).unwrap();

        let cue = &showfile["cues"][0];
        assert_eq!(
            cue["instructions"][0]["assertions"],
            json!({ "values": { "Dimmer": 1.0 } })
        );
        assert!(cue["instructions"][0].get("cue_instruction").is_none());
        assert!(
            cue["parts"][0]["instructions"][0]
                .get("assertions")
                .is_some()
        );
        assert!(
            showfile["sequences"][0]["setup_cue"]["instructions"][0]
                .get("assertions")
                .is_some()
        );
    }

    /// Checks that running the migration twice leaves the document unchanged.
    #[test]
    fn migration_is_idempotent() {
        let mut once = v23_showfile();
        migrate_v23_to_v24(&mut once).unwrap();
        let mut twice = once.clone();
        migrate_v23_to_v24(&mut twice).unwrap();
        assert_eq!(once, twice);
    }

    /// Checks that a `cue_instruction` key without a sibling selection is not renamed.
    #[test]
    fn leaves_objects_without_a_selection_untouched() {
        let mut showfile = json!({ "notes": { "cue_instruction": "free text" } });
        migrate_v23_to_v24(&mut showfile).unwrap();
        assert_eq!(showfile["notes"]["cue_instruction"], json!("free text"));
    }
}
