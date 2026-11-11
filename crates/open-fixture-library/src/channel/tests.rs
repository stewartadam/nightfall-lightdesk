// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;
use crate::schema::OflDmxValueResolution;

/// Parses a channel object from JSON.
fn channel(json: serde_json::Value) -> OflChannel {
    serde_json::from_value(json).expect("channel JSON should parse")
}

/// Verifies a single `capability` and a `capabilities` list are both exposed as the
/// channel's capabilities.
#[test]
fn single_capability_counts_as_the_capability_list() {
    let single = channel(serde_json::json!({ "capability": { "type": "Intensity" } }));
    assert_eq!(single.capabilities().len(), 1);
    assert_eq!(single.capabilities()[0].capability_type, "Intensity");
    assert_eq!(single.capabilities()[0].dmx_range, None);

    let list = channel(serde_json::json!({
        "capabilities": [
            { "dmxRange": [0, 127], "type": "Intensity" },
            { "dmxRange": [128, 255], "type": "NoFunction" }
        ]
    }));
    assert_eq!(list.capabilities().len(), 2);
}

/// Verifies `dmxValueResolution` parses OFL's resolution strings and defaults to the
/// channel's full width from its fine aliases.
#[test]
fn value_resolution_parses_strings_and_defaults_to_full_width() {
    let declared = channel(serde_json::json!({
        "fineChannelAliases": ["Pan fine"],
        "dmxValueResolution": "8bit",
        "capability": { "type": "Pan", "angleStart": "0deg", "angleEnd": "540deg" }
    }));
    assert_eq!(
        declared.dmx_value_resolution,
        Some(OflDmxValueResolution::Bits8)
    );
    assert_eq!(declared.max_resolution(), 2);
    assert_eq!(declared.value_resolution(), 1);

    let implicit = channel(serde_json::json!({
        "fineChannelAliases": ["Pan fine", "Pan fine^2"],
        "capability": { "type": "Pan" }
    }));
    assert_eq!(implicit.value_resolution(), 3);

    for (text, bytes) in [("8bit", 1), ("16bit", 2), ("24bit", 3)] {
        let resolution: OflDmxValueResolution =
            serde_json::from_value(serde_json::json!(text)).unwrap();
        assert_eq!(resolution.bytes(), bytes);
    }
    assert!(serde_json::from_value::<OflDmxValueResolution>(serde_json::json!(16)).is_err());
}

/// Verifies default and highlight values are read in the declared resolution and
/// rescaled to the width a mode uses, with percentages resolved against the maximum.
#[test]
fn default_and_highlight_values_rescale_to_the_mode_width() {
    let fine = channel(serde_json::json!({
        "fineChannelAliases": ["Dimmer fine"],
        "defaultValue": 32768,
        "highlightValue": "100%",
        "capability": { "type": "Intensity" }
    }));
    assert_eq!(fine.default_value_at(2), Some(32768));
    assert_eq!(fine.default_value_at(1), Some(128));
    assert_eq!(fine.highlight_value_at(1), Some(255));
    assert_eq!(fine.highlight_value_at(2), Some(65535));

    let coarse_values = channel(serde_json::json!({
        "fineChannelAliases": ["Tilt fine"],
        "dmxValueResolution": "8bit",
        "defaultValue": "50%",
        "capability": { "type": "Tilt" }
    }));
    assert_eq!(coarse_values.default_value_at(1), Some(127));
    assert_eq!(coarse_values.default_value_at(2), Some(0x7F7F));
    assert_eq!(coarse_values.highlight_value_at(2), None);
}

/// Verifies OFL's byte-repeating rescale in both directions and its clamping of
/// out-of-range values and widths.
#[test]
fn scale_dmx_value_repeats_and_drops_low_bytes() {
    assert_eq!(scale_dmx_value(255, 1, 2), 65535);
    assert_eq!(scale_dmx_value(0x12, 1, 3), 0x12_12_12);
    assert_eq!(scale_dmx_value(0x1234, 2, 1), 0x12);
    assert_eq!(scale_dmx_value(0x12_34_56, 3, 2), 0x12_34);
    assert_eq!(scale_dmx_value(300, 1, 1), 255);
    assert_eq!(scale_dmx_value(0xFF, 1, 6), u32::MAX);
}

/// Verifies a switching channel alias resolves to the channel selected by the
/// capability holding the trigger channel's default value.
#[test]
fn switching_alias_follows_the_default_capability() {
    let trigger = channel(serde_json::json!({
        "defaultValue": 200,
        "capabilities": [
            { "dmxRange": [0, 127], "type": "Generic", "switchChannels": { "Mode Speed": "Strobe", "Macro": null } },
            { "dmxRange": [128, 255], "type": "Generic", "switchChannels": { "Mode Speed": "Program Speed", "Macro": "Programs" } }
        ]
    }));
    assert_eq!(
        trigger.default_switch_target("Mode Speed"),
        Some(Some("Program Speed"))
    );
    assert_eq!(
        trigger.default_switch_target("Macro"),
        Some(Some("Programs"))
    );
    assert_eq!(trigger.default_switch_target("Unknown"), None);

    let resting_at_zero = channel(serde_json::json!({
        "capabilities": [
            { "dmxRange": [0, 127], "type": "Generic", "switchChannels": { "Macro": null } },
            { "dmxRange": [128, 255], "type": "Generic", "switchChannels": { "Macro": "Programs" } }
        ]
    }));
    assert_eq!(resting_at_zero.default_switch_target("Macro"), Some(None));
}

/// Verifies Pan and Tilt angles are read in degrees, while percentages and keywords
/// give no range.
#[test]
fn capability_angles_parse_degrees_only() {
    let angles = |json: serde_json::Value| {
        let capability: OflCapability = serde_json::from_value(json).unwrap();
        capability.angle_range_degrees()
    };
    assert_eq!(
        angles(serde_json::json!({ "type": "Pan", "angleStart": "0deg", "angleEnd": "540deg" })),
        Some((0.0, 540.0))
    );
    assert_eq!(
        angles(
            serde_json::json!({ "type": "Tilt", "angleStart": "135deg", "angleEnd": "-135deg" })
        ),
        Some((135.0, -135.0))
    );
    assert_eq!(
        angles(serde_json::json!({ "type": "Pan", "angle": "90deg" })),
        Some((90.0, 90.0))
    );
    assert_eq!(
        angles(serde_json::json!({ "type": "Pan", "angleStart": "0%", "angleEnd": "100%" })),
        None
    );
}
