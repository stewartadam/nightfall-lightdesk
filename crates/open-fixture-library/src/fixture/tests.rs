// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Builds a template-only pixel bar with two pixel groups and the given modes.
fn pixel_bar(modes: serde_json::Value) -> OflFixture {
    let json = serde_json::json!({
        "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
        "name": "Test Bar",
        "categories": ["Pixel Bar"],
        "meta": {
            "authors": ["Test"],
            "createDate": "2024-01-01",
            "lastModifyDate": "2024-01-01",
            "importPlugin": { "plugin": "qlcplus_4.12.1", "date": "2024-01-01", "comment": "imported" }
        },
        "physical": { "DMXconnector": "3-pin", "matrixPixels": { "spacing": [50, 0, 0] } },
        "matrix": {
            "pixelCount": [3, 1, 1],
            "pixelGroups": { "Left": ["1", "2"], "Right": ["3"] }
        },
        "templateChannels": {
            "Red $pixelKey": { "capability": { "type": "ColorIntensity", "color": "Red" } },
            "Green $pixelKey": { "capability": { "type": "ColorIntensity", "color": "Green" } }
        },
        "modes": modes
    });
    OflFixture::from_json(&json.to_string()).expect("pixel bar should parse")
}

/// Verifies a template-only matrix fixture parses with the spec's field names for the
/// DMX connector and import plugin.
#[test]
fn template_only_fixture_parses_spec_fields() {
    let fixture = pixel_bar(serde_json::json!([{ "name": "3px", "channels": ["Red 1"] }]));
    assert!(fixture.available_channels().is_empty());
    assert_eq!(fixture.template_channels().len(), 2);
    assert_eq!(
        fixture
            .physical()
            .and_then(|physical| physical.dmx_connector.as_deref()),
        Some("3-pin")
    );
    assert_eq!(
        fixture
            .meta()
            .import_plugin
            .as_ref()
            .map(|plugin| plugin.plugin.as_str()),
        Some("qlcplus_4.12.1")
    );
}

/// Verifies `matrixChannels` inserts expand per pixel or per channel, for pixel groups
/// and explicit keys, and keep `null` entries as unused slots.
#[test]
fn matrix_channel_inserts_expand_in_channel_order() {
    let fixture = pixel_bar(serde_json::json!([
        {
            "name": "Per pixel",
            "channels": [
                null,
                {
                    "insert": "matrixChannels",
                    "repeatFor": "eachPixelXYZ",
                    "channelOrder": "perPixel",
                    "templateChannels": ["Red $pixelKey", null, "Green $pixelKey"]
                }
            ]
        },
        {
            "name": "Per channel",
            "channels": [{
                "insert": "matrixChannels",
                "repeatFor": "eachPixelGroup",
                "channelOrder": "perChannel",
                "templateChannels": ["Red $pixelKey", "Green $pixelKey"]
            }]
        },
        {
            "name": "Listed",
            "channels": [{
                "insert": "matrixChannels",
                "repeatFor": ["3", "1"],
                "channelOrder": "perPixel",
                "templateChannels": ["Green $pixelKey"]
            }, "Red 2"]
        }
    ]));
    let keys = |mode: usize| fixture.mode_channel_keys(&fixture.modes()[mode]);
    let expected = |keys: &[Option<&str>]| -> Vec<Option<String>> {
        keys.iter().map(|key| key.map(str::to_string)).collect()
    };
    assert_eq!(
        keys(0),
        expected(&[
            None,
            Some("Red 1"),
            None,
            Some("Green 1"),
            Some("Red 2"),
            None,
            Some("Green 2"),
            Some("Red 3"),
            None,
            Some("Green 3"),
        ])
    );
    assert_eq!(
        keys(1),
        expected(&[
            Some("Red Left"),
            Some("Red Right"),
            Some("Green Left"),
            Some("Green Right"),
        ])
    );
    assert_eq!(
        keys(2),
        expected(&[Some("Green 3"), Some("Green 1"), Some("Red 2")])
    );
}
