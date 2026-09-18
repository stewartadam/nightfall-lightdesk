// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::autocomplete::{ParseStatus, validate_command};

/// Human diagnostics count Unicode characters while the parser API preserves byte offsets.
#[test]
fn validation_message_distinguishes_character_and_byte_positions() {
    let response = validate_command("recall blueprint \"é😀\"; fps x");
    assert_eq!(response.furthest_pos, 31);
    assert!(
        response
            .message
            .as_deref()
            .unwrap()
            .contains("near character 28.")
    );
}

#[test]
fn validate_command_reports_ok_for_valid_command() {
    let response = validate_command("fix 1 red @ 100");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
    assert!(response.expected_tokens.is_empty());
}

#[test]
fn validate_command_accepts_compact_cue_part_references() {
    for input in ["store cue 1.5p2", "recall cue 1.5p2"] {
        let response = validate_command(input);
        assert_eq!(response.status, ParseStatus::Ok, "{input}");
        assert!(response.message.is_none(), "{input}");
        assert!(response.expected_tokens.is_empty(), "{input}");
    }
}

/// Verifies block and unblock cue targets validate as complete commands.
#[test]
fn validate_command_accepts_block_and_unblock_cue_targets() {
    for input in [
        "block cue 1.5",
        "block cue 1.5 /overwrite",
        "block cue 1.5p2",
        "block cue 1.5p2 /overwrite",
        "unblock cue 1.5",
        "unblock cue 1.5p2",
    ] {
        let response = validate_command(input);
        assert_eq!(response.status, ParseStatus::Ok, "{input}");
        assert!(response.message.is_none(), "{input}");
        assert!(response.expected_tokens.is_empty(), "{input}");
    }
}

/// Verifies cue tracking marker values validate for explicit and active selections.
#[test]
fn validate_command_accepts_cue_tracking_marker_values() {
    for input in [
        "fix 311 red @ release",
        "fix 311 red @ Release",
        "fix 311 red @ R",
        "tilt @ hold",
        "tilt @ Hold",
        "tilt @ H",
    ] {
        let response = validate_command(input);
        assert_eq!(response.status, ParseStatus::Ok, "{input}");
        assert!(response.message.is_none(), "{input}");
        assert!(response.expected_tokens.is_empty(), "{input}");
    }
}

/// Verifies append-style cue store targets validate as complete commands.
#[test]
fn validate_command_accepts_store_append_cue_reference_after_dot() {
    let response = validate_command("store cue 1.");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none(), "{:?}", response);
    assert!(response.expected_tokens.is_empty(), "{:?}", response);
}

/// Verifies store mode flags validate after cue store targets.
#[test]
fn validate_command_accepts_store_cue_mode_flags() {
    for input in [
        "store cue 1.5 /merge",
        "store cue 1.5 /update",
        "store cue 1.5 /remove",
    ] {
        let response = validate_command(input);
        assert_eq!(response.status, ParseStatus::Ok, "{input}");
        assert!(response.message.is_none(), "{input}");
        assert!(response.expected_tokens.is_empty(), "{input}");
    }
}

/// Verifies nested cue ranges validate as complete store targets.
#[test]
fn validate_command_accepts_store_cue_ranges() {
    for input in ["store cue 11.(1>5)", "store cue 11.(1>5) /update"] {
        let response = validate_command(input);
        assert_eq!(response.status, ParseStatus::Ok, "{input}");
        assert!(response.message.is_none(), "{input}");
        assert!(response.expected_tokens.is_empty(), "{input}");
    }
}

/// Verifies recall cue accepts the select flag after cue targets.
#[test]
fn validate_command_accepts_recall_cue_select_flag() {
    for input in ["recall cue 1.5 /select", "recall cue 1.5p2 /select"] {
        let response = validate_command(input);
        assert_eq!(response.status, ParseStatus::Ok, "{input}");
        assert!(response.message.is_none(), "{input}");
        assert!(response.expected_tokens.is_empty(), "{input}");
    }
}

/// Verifies append-style cue-part store targets validate as complete commands.
#[test]
fn validate_command_accepts_store_append_cue_part_reference_after_p() {
    let response = validate_command("store cue 1.5p");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none(), "{:?}", response);
    assert!(response.expected_tokens.is_empty(), "{:?}", response);
}

/// Verifies recall cue-part references still require an explicit part ID.
#[test]
fn validate_command_keeps_recall_cue_part_reference_live_after_p() {
    let response = validate_command("recall cue 1.5p");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(
        response.expected_tokens.contains(&"0..9".to_string()),
        "{:?}",
        response
    );
}

#[test]
fn validate_command_accepts_semicolon_separated_commands() {
    let response = validate_command(
        "store fx 1 step fix 311 5s int @ 50 steps ~25 ~-25 red steps @100 0; sleep 1; fx 1 start",
    );
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
    assert!(response.expected_tokens.is_empty());
}

/// Verifies statement validation does not split semicolons inside quoted attributes.
#[test]
fn validate_command_preserves_quoted_semicolons() {
    let response = validate_command("fix 1 \"custom;attr\" @ 10; sleep 1");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
    assert!(response.expected_tokens.is_empty());
}

#[test]
fn validate_command_reports_absolute_position_for_later_semicolon_segment() {
    let input = "fix 1 red @ 100; fx 1 @";
    let response = validate_command(input);
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.furthest_pos > input.find(';').expect("semicolon present"));
}

#[test]
fn validate_command_reports_expected_tokens_for_incomplete_command() {
    let response = validate_command("fix ");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.expected_tokens.contains(&"0..9".to_string()));
    assert!(!response.expected_tokens.contains(&"@".to_string()));
    assert!(!response.expected_tokens.contains(&"+".to_string()));
}

#[test]
fn validate_command_suggests_top_level_heads_for_partial_first_token() {
    let response = validate_command("pa");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.expected_tokens.contains(&"patch".to_string()));
}

#[test]
fn validate_command_keeps_partial_head_prefix_constrained() {
    let response = validate_command("f");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.expected_tokens.contains(&"fixture".to_string()));
    assert!(!response.expected_tokens.contains(&"?".to_string()));
    assert!(!response.expected_tokens.contains(&"@".to_string()));
}

#[test]
fn validate_command_reports_error_for_invalid_token_sequence() {
    let response = validate_command("fix 1 @");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.furthest_pos <= "fix 1 @".len());
}

#[test]
fn validate_command_rejects_rm_alias_without_object_type() {
    let response = validate_command("rm @ 0");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.expected_tokens.contains(&"patch".to_string()));
    assert!(!response.expected_tokens.contains(&"@".to_string()));
}

#[test]
fn validate_command_rejects_signed_range_endpoint_in_selection() {
    let response = validate_command("fix 2 > +1");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.expected_tokens.contains(&"0..9".to_string()));
    assert!(!response.expected_tokens.contains(&"+".to_string()));
}

#[test]
fn validate_command_rejects_element_reference_without_index() {
    let response = validate_command("fix 133.");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.expected_tokens.contains(&"0..9".to_string()));
    assert!(!response.expected_tokens.contains(&"+".to_string()));
    assert!(!response.expected_tokens.contains(&"-".to_string()));
}

#[test]
fn validate_command_rejects_fade_without_timing_argument() {
    let response = validate_command("fix 133 red @ 100 fade");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
}

#[test]
fn validate_command_does_not_surface_bare_sign_after_fade() {
    let response = validate_command("fix 133 red @ 100 fade +");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.expected_tokens.contains(&"0..9".to_string()));
    assert!(!response.expected_tokens.contains(&"+".to_string()));
    assert!(!response.expected_tokens.contains(&"-".to_string()));
}

#[test]
fn validate_command_rejects_trailing_dot_value_literal() {
    let response = validate_command("fix 133 red @ 1.");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
}

#[test]
fn validate_command_rejects_trailing_dot_duration_literal() {
    let response = validate_command("fix 133 red @ 100 fade 1.");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
}

#[test]
fn validate_command_rejects_reserved_fx_head_in_active_attribute_command() {
    let response = validate_command("fx @ 2");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
}

#[test]
fn validate_command_rejects_reserved_fps_head_in_active_attribute_command() {
    let response = validate_command("fps @ 2");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
}

#[test]
fn validate_command_rejects_reserved_store_head_as_attribute() {
    let response = validate_command("fix 1 store @ 50");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
}

/// Verifies partial playback actions exclude the Step FX creation keyword.
#[test]
fn validate_command_prefers_fx_action_tokens_for_partial_action_prefix() {
    let response = validate_command("fx 1 s");
    assert_eq!(response.status, ParseStatus::Error);
    assert!(response.message.is_some());
    assert!(response.expected_tokens.contains(&"start".to_string()));
    assert!(response.expected_tokens.contains(&"stop".to_string()));
    assert!(!response.expected_tokens.contains(&"step".to_string()));
    assert!(!response.expected_tokens.contains(&"+".to_string()));
    assert!(!response.expected_tokens.contains(&"-".to_string()));
    assert!(!response.expected_tokens.contains(&">".to_string()));
}

#[test]
fn validate_command_accepts_mixed_case_keywords() {
    let response = validate_command("FiX 1 ReD @ 100");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
}

#[test]
fn validate_command_accepts_mixed_case_release_channel() {
    let response = validate_command("ReLeAsE ChAnNeL 1.13");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
}

#[test]
fn validate_command_accepts_standalone_spatial_selection_command() {
    let response = validate_command("group 1>4|wings 2");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
    assert!(response.expected_tokens.is_empty());
}

#[test]
fn validate_command_accepts_valid_multi_branch_timing_override_parse() {
    let response = validate_command("fix 311 red @ 100 fade 10 red 1");
    assert_eq!(response.status, ParseStatus::Ok);
    assert!(response.message.is_none());
    assert!(response.expected_tokens.is_empty());
}
