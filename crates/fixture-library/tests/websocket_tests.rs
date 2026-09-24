// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tests for WebSocket commands and responses

use nightfall_fixture_library::commands::*;

#[test]
fn test_list_available_fixtures_command_serialization() {
    let command = FixtureLibraryCommand::ListAvailableFixtures;
    let json = serde_json::to_value(&command).unwrap();

    assert_eq!(json["type"], "ListAvailableFixtures");

    // Should deserialize back correctly
    let deserialized: FixtureLibraryCommand = serde_json::from_value(json).unwrap();
    assert!(matches!(
        deserialized,
        FixtureLibraryCommand::ListAvailableFixtures
    ));
}

#[test]
fn test_get_fixture_profile_command_serialization() {
    let command = FixtureLibraryCommand::GetFixtureProfile {
        asset_etag: None,
        make: "Chauvet".to_string(),
        model: "ColorDash Par".to_string(),
        mode: None,
    };

    let json = serde_json::to_value(&command).unwrap();

    assert_eq!(json["type"], "GetFixtureProfile");
    assert_eq!(json["data"]["make"], "Chauvet");
    assert_eq!(json["data"]["model"], "ColorDash Par");

    // Should deserialize back correctly
    let deserialized: FixtureLibraryCommand = serde_json::from_value(json).unwrap();
    if let FixtureLibraryCommand::GetFixtureProfile { make, model, .. } = deserialized {
        assert_eq!(make, "Chauvet");
        assert_eq!(model, "ColorDash Par");
    } else {
        panic!("Wrong command variant");
    }
}

#[test]
fn test_refresh_library_command_serialization() {
    let command = FixtureLibraryCommand::RefreshLibrary;
    let json = serde_json::to_value(&command).unwrap();

    assert_eq!(json["type"], "RefreshLibrary");

    // Should deserialize back correctly
    let deserialized: FixtureLibraryCommand = serde_json::from_value(json).unwrap();
    assert!(matches!(
        deserialized,
        FixtureLibraryCommand::RefreshLibrary
    ));
}

#[test]
fn test_create_fixture_command_serialization() {
    let command = FixtureLibraryCommand::CreateFixtureFromLibrary {
        asset_etag: None,
        id: 42,
        make: "Chauvet".to_string(),
        model: "ColorDash Par".to_string(),
        mode: "6 Channel".to_string(),
        label: Some("My Fixture".to_string()),
        update_existing_ids: vec![1, 2],
        update_existing_only: true,
    };

    let json = serde_json::to_value(&command).unwrap();

    assert_eq!(json["type"], "CreateFixtureFromLibrary");
    assert_eq!(json["data"]["id"], 42);
    assert_eq!(json["data"]["make"], "Chauvet");
    assert_eq!(json["data"]["model"], "ColorDash Par");
    assert_eq!(json["data"]["mode"], "6 Channel");
    assert_eq!(json["data"]["label"], "My Fixture");
    assert_eq!(json["data"]["update_existing_ids"][0], 1);
    assert_eq!(json["data"]["update_existing_ids"][1], 2);
    assert_eq!(json["data"]["update_existing_only"], true);

    // Should deserialize back correctly
    let deserialized: FixtureLibraryCommand = serde_json::from_value(json).unwrap();
    if let FixtureLibraryCommand::CreateFixtureFromLibrary {
        id,
        make,
        model,
        mode,
        label,
        update_existing_ids,
        update_existing_only,
        ..
    } = deserialized
    {
        assert_eq!(id, 42);
        assert_eq!(make, "Chauvet");
        assert_eq!(model, "ColorDash Par");
        assert_eq!(mode, "6 Channel");
        assert_eq!(label, Some("My Fixture".to_string()));
        assert_eq!(update_existing_ids, vec![1, 2]);
        assert!(update_existing_only);
    } else {
        panic!("Wrong command variant");
    }
}

#[test]
fn test_available_fixture_info_serialization() {
    let info = AvailableFixtureInfo {
        make: "Chauvet".to_string(),
        model: "ColorDash Par".to_string(),
        modes: vec!["3 Channel".to_string(), "6 Channel".to_string()],
        source_format: "GDTF".to_string(),
        asset_etag: "v1".to_string(),
    };

    let json = serde_json::to_value(&info).unwrap();

    assert_eq!(json["make"], "Chauvet");
    assert_eq!(json["model"], "ColorDash Par");
    assert_eq!(json["modes"][0], "3 Channel");
    assert_eq!(json["modes"][1], "6 Channel");
    assert_eq!(json["source_format"], "GDTF");
    assert_eq!(json["asset_etag"], "v1");

    // Should deserialize back correctly
    let deserialized: AvailableFixtureInfo = serde_json::from_value(json).unwrap();
    assert_eq!(deserialized.make, "Chauvet");
    assert_eq!(deserialized.model, "ColorDash Par");
    assert_eq!(deserialized.modes.len(), 2);
    assert_eq!(deserialized.source_format, "GDTF");
    assert_eq!(deserialized.asset_etag, "v1");
}

#[test]
fn test_list_available_fixtures_response_serialization() {
    let response = ListAvailableFixturesResponse {
        fixtures: vec![
            AvailableFixtureInfo {
                make: "Chauvet".to_string(),
                model: "ColorDash Par".to_string(),
                modes: vec!["6 Channel".to_string()],
                source_format: "GDTF".to_string(),
                asset_etag: "v1".to_string(),
            },
            AvailableFixtureInfo {
                make: "Generic".to_string(),
                model: "RGB LED".to_string(),
                modes: vec!["3 Channel".to_string()],
                source_format: "OFL".to_string(),
                asset_etag: "v2".to_string(),
            },
        ],
    };

    let json = serde_json::to_value(&response).unwrap();

    assert_eq!(json["fixtures"].as_array().unwrap().len(), 2);
    assert_eq!(json["fixtures"][0]["make"], "Chauvet");
    assert_eq!(json["fixtures"][1]["make"], "Generic");

    // Should deserialize back correctly
    let deserialized: ListAvailableFixturesResponse = serde_json::from_value(json).unwrap();
    assert_eq!(deserialized.fixtures.len(), 2);
    assert_eq!(deserialized.fixtures[0].make, "Chauvet");
    assert_eq!(deserialized.fixtures[1].make, "Generic");
}

#[test]
fn test_get_fixture_profile_response_serialization() {
    let response = GetFixtureProfileResponse {
        info: AvailableFixtureInfo {
            make: "Chauvet".to_string(),
            model: "ColorDash Par".to_string(),
            modes: vec!["3 Channel".to_string(), "6 Channel".to_string()],
            source_format: "GDTF".to_string(),
            asset_etag: "v1".to_string(),
        },
        requested_mode: Some("6 Channel".to_string()),
        fixture: None,
        geometry: None,
    };

    let json = serde_json::to_value(&response).unwrap();

    assert_eq!(json["info"]["make"], "Chauvet");
    assert_eq!(json["requested_mode"], "6 Channel");
    assert_eq!(json["info"]["model"], "ColorDash Par");
    assert_eq!(json["info"]["modes"].as_array().unwrap().len(), 2);

    // Should deserialize back correctly
    let deserialized: GetFixtureProfileResponse = serde_json::from_value(json).unwrap();
    assert_eq!(deserialized.info.make, "Chauvet");
    assert_eq!(deserialized.info.model, "ColorDash Par");
    assert_eq!(deserialized.info.modes.len(), 2);
}

#[test]
fn test_command_roundtrip() {
    // Test that all commands can be serialized and deserialized correctly
    let commands = vec![
        FixtureLibraryCommand::ListAvailableFixtures,
        FixtureLibraryCommand::GetFixtureProfile {
            asset_etag: None,
            make: "Test".to_string(),
            model: "Fixture".to_string(),
            mode: None,
        },
        FixtureLibraryCommand::RefreshLibrary,
        FixtureLibraryCommand::CreateFixtureFromLibrary {
            asset_etag: None,
            id: 1,
            make: "Test".to_string(),
            model: "Fixture".to_string(),
            mode: "Default".to_string(),
            label: None,
            update_existing_ids: vec![],
            update_existing_only: false,
        },
    ];

    for command in commands {
        let json = serde_json::to_string(&command).unwrap();
        let deserialized: FixtureLibraryCommand = serde_json::from_str(&json).unwrap();

        // Commands should match after round-trip
        let json1 = serde_json::to_value(&command).unwrap();
        let json2 = serde_json::to_value(&deserialized).unwrap();
        assert_eq!(json1, json2);
    }
}

#[test]
fn test_command_type_discrimination() {
    // Test that commands are properly discriminated by their type field
    let json = serde_json::json!({
        "type": "ListAvailableFixtures"
    });

    let command: FixtureLibraryCommand = serde_json::from_value(json).unwrap();
    assert!(matches!(
        command,
        FixtureLibraryCommand::ListAvailableFixtures
    ));

    let json = serde_json::json!({
        "type": "RefreshLibrary"
    });

    let command: FixtureLibraryCommand = serde_json::from_value(json).unwrap();
    assert!(matches!(command, FixtureLibraryCommand::RefreshLibrary));
}

#[test]
fn test_invalid_command_deserialization() {
    // Test that invalid JSON fails gracefully
    let json = serde_json::json!({
        "type": "InvalidCommand"
    });

    let result: Result<FixtureLibraryCommand, _> = serde_json::from_value(json);
    assert!(result.is_err());

    // Missing required fields should fail
    let json = serde_json::json!({
        "type": "GetFixtureProfile",
        "data": {
            "make": "Test"
            // Missing "model" field
        }
    });

    let result: Result<FixtureLibraryCommand, _> = serde_json::from_value(json);
    assert!(result.is_err());
}
