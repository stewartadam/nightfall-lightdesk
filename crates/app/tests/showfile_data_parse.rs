// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::path::Path;

/// Remove persisted native-unit fields recursively to reproduce pre-unit showfiles.
fn remove_native_units(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                remove_native_units(value);
            }
        }
        serde_json::Value::Object(values) => {
            values.remove("native_unit");
            for value in values.values_mut() {
                remove_native_units(value);
            }
        }
        _ => {}
    }
}

/// Assert every top-level persisted collection has representative parser data.
fn assert_showfile_collections_are_populated(value: &serde_json::Value) {
    const ARRAY_PATHS: &[&str] = &[
        "/fixtures",
        "/bindings/input",
        "/bindings/output",
        "/bindings/disabled",
        "/midiMappings",
        "/oscMappings",
        "/sceneObjects",
        "/cues",
        "/sequences",
        "/groups",
        "/masters",
        "/blueprints",
        "/color_paths",
        "/color_path_defaults",
        "/fx",
        "/fxModule",
        "/stepFx",
        "/flows",
        "/timecodes",
        "/timelines",
        "/clips",
    ];

    for path in ARRAY_PATHS {
        let collection = value
            .pointer(path)
            .and_then(serde_json::Value::as_array)
            .unwrap_or_else(|| panic!("showfile parser fixture must contain array {path}"));
        assert!(
            !collection.is_empty(),
            "showfile parser fixture collection {path} must not be empty"
        );
    }

    let variables = value
        .pointer("/variables")
        .and_then(serde_json::Value::as_object)
        .expect("showfile parser fixture must contain variables");
    assert!(
        !variables.is_empty(),
        "showfile parser fixture variables must not be empty"
    );
}

/// Verify that procedural showfile parser data parses through the runtime loader path.
#[test]
fn parses_procedural_showfile_test_data() {
    let showfile_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/procedural-showfile-parse-data.json");
    let showfile_json =
        std::fs::read_to_string(&showfile_path).expect("read procedural showfile test data");
    let showfile_value: serde_json::Value =
        serde_json::from_str(&showfile_json).expect("parse procedural showfile test data");
    assert_showfile_collections_are_populated(&showfile_value);

    nightfall_app_lib::validate_showfile_snapshot_json(
        &showfile_json,
        &showfile_path.display().to_string(),
    )
    .expect("procedural showfile test data should parse");
}

/// Verify that showfiles saved before native parameter units were added remain readable.
#[test]
fn parses_showfile_test_data_without_native_units() {
    let showfile_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/procedural-showfile-parse-data.json");
    let showfile_json =
        std::fs::read_to_string(&showfile_path).expect("read procedural showfile test data");
    let mut showfile_value: serde_json::Value =
        serde_json::from_str(&showfile_json).expect("parse procedural showfile test data");
    remove_native_units(&mut showfile_value);
    let legacy_showfile_json =
        serde_json::to_string(&showfile_value).expect("serialize showfile without native units");

    nightfall_app_lib::validate_showfile_snapshot_json(
        &legacy_showfile_json,
        &showfile_path.display().to_string(),
    )
    .expect("showfile without native units should parse");
}
