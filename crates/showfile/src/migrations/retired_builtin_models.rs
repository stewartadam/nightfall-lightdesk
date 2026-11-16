// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 25 → 26: fixtures of retired built-in models become modes of their replacement.
//!
//! The "Strobe Matrix 308ch" and "Strobe Matrix 312ch" built-ins are now the 308ch and 312ch
//! modes of the single "Strobe Matrix" profile. Each mode builds the same elements the retired
//! model did, so only the fixture's library identity changes.

use nightfall_fixtures::library::catalog::{
    RetiredBuiltinModel, find_builtin_fixture_profile, retired_builtin_models,
};
use serde_json::Value;

/// Points every saved fixture of a retired built-in model at the mode that replaced it.
///
/// A fixture matches on make and model when it records no library version or the retired
/// built-in's version. A fixture with any other version came from an imported file that
/// happens to share the name, so it is left alone. Matching fixtures get the replacement
/// model, mode, and, when they recorded one, the replacement profile's version.
pub(super) fn migrate_v25_to_v26(showfile: &mut Value) -> Result<(), String> {
    let fixtures = match showfile.get_mut("fixtures") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::Array(fixtures)) => fixtures,
        Some(_) => return Err("showfile fixtures must be an array".to_string()),
    };
    let mut migrated = 0;
    for fixture in fixtures.iter_mut() {
        let Some(fixture) = fixture.as_object_mut() else {
            return Err("showfile fixture must be an object".to_string());
        };
        let Some(retired) = retired_builtin_models()
            .iter()
            .find(|retired| is_retired_fixture(fixture, retired))
        else {
            continue;
        };
        let replacement = find_builtin_fixture_profile(retired.make, retired.replacement_model)
            .ok_or_else(|| {
                format!(
                    "built-in fixture {} {} replacing {} is missing",
                    retired.make, retired.replacement_model, retired.model
                )
            })?;
        fixture.insert("model".to_string(), Value::from(replacement.model));
        fixture.insert("mode".to_string(), Value::from(retired.replacement_mode));
        if fixture
            .get("library_asset_etag")
            .is_some_and(|etag| !etag.is_null())
        {
            fixture.insert(
                "library_asset_etag".to_string(),
                Value::from(replacement.asset_etag),
            );
        }
        migrated += 1;
    }
    if migrated > 0 {
        tracing::info!(migrated, "Migrated fixtures of retired built-in models");
    }
    Ok(())
}

/// Returns whether a saved fixture was created from the retired built-in `retired`.
fn is_retired_fixture(
    fixture: &serde_json::Map<String, Value>,
    retired: &RetiredBuiltinModel,
) -> bool {
    let etag_matches = match fixture.get("library_asset_etag") {
        None | Some(Value::Null) => true,
        Some(etag) => etag == retired.asset_etag,
    };
    fixture.get("make").is_some_and(|make| make == retired.make)
        && fixture
            .get("model")
            .is_some_and(|model| model == retired.model)
        && etag_matches
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Builds a v25 document with both retired strobe models, one recording the built-in
    /// version and one recording none, beside an unrelated fixture.
    fn v25_showfile() -> Value {
        json!({
            "fixtures": [
                {
                    "make": "Generic",
                    "model": "Strobe Matrix 308ch",
                    "mode": "Strobe",
                    "library_asset_etag": "builtin:generic-strobe-matrix-308ch:v1"
                },
                {
                    "make": "Generic",
                    "model": "Strobe Matrix 312ch",
                    "mode": "Strobe",
                    "library_asset_etag": null
                },
                {
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "mode": "Spot",
                    "library_asset_etag": "builtin:generic-moving-head-spot-16ch:v1"
                }
            ]
        })
    }

    /// Checks that each retired model becomes the matching mode of the Strobe Matrix profile
    /// and that a recorded built-in version follows it, while other fixtures are untouched.
    #[test]
    fn retired_strobe_models_become_strobe_matrix_modes() {
        let mut showfile = v25_showfile();
        migrate_v25_to_v26(&mut showfile).unwrap();

        assert_eq!(
            showfile["fixtures"],
            json!([
                {
                    "make": "Generic",
                    "model": "Strobe Matrix",
                    "mode": "308ch",
                    "library_asset_etag": "builtin:generic-strobe-matrix:v1"
                },
                {
                    "make": "Generic",
                    "model": "Strobe Matrix",
                    "mode": "312ch",
                    "library_asset_etag": null
                },
                {
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "mode": "Spot",
                    "library_asset_etag": "builtin:generic-moving-head-spot-16ch:v1"
                }
            ])
        );
    }

    /// Checks that a fixture without a `library_asset_etag` field is migrated without
    /// gaining one.
    #[test]
    fn fixture_without_recorded_version_gains_none() {
        let mut showfile = json!({
            "fixtures": [{ "make": "Generic", "model": "Strobe Matrix 308ch", "mode": "Strobe" }]
        });
        migrate_v25_to_v26(&mut showfile).unwrap();
        assert_eq!(
            showfile["fixtures"][0],
            json!({ "make": "Generic", "model": "Strobe Matrix", "mode": "308ch" })
        );
    }

    /// Checks that a fixture imported from a file that shares a retired name keeps its identity,
    /// because its version is a file fingerprint rather than the retired built-in's.
    #[test]
    fn imported_profile_with_retired_name_is_untouched() {
        let imported = json!({
            "make": "Generic",
            "model": "Strobe Matrix 312ch",
            "mode": "Strobe",
            "library_asset_etag": "sha256:0123"
        });
        let mut showfile = json!({ "fixtures": [imported.clone()] });
        migrate_v25_to_v26(&mut showfile).unwrap();
        assert_eq!(showfile["fixtures"][0], imported);
    }

    /// Checks that running the migration twice leaves the document unchanged.
    #[test]
    fn migration_is_idempotent() {
        let mut once = v25_showfile();
        migrate_v25_to_v26(&mut once).unwrap();
        let mut twice = once.clone();
        migrate_v25_to_v26(&mut twice).unwrap();
        assert_eq!(once, twice);
    }

    /// Checks that a document without fixtures migrates and a malformed fixture list fails.
    #[test]
    fn missing_fixtures_pass_and_malformed_fixtures_fail() {
        let mut empty = json!({});
        migrate_v25_to_v26(&mut empty).unwrap();
        assert_eq!(empty, json!({}));

        let mut malformed = json!({ "fixtures": { "make": "Generic" } });
        assert!(migrate_v25_to_v26(&mut malformed).is_err());
    }
}
