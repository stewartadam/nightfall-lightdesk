// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::autocomplete::{ParseStatus, complete_command};
use nightfall_cmd_parse::completion_groups::contracts::CompletionGroupId;
use nightfall_cmd_parse::parser::analysis::{ExpectedToken, TokenId, ValueKind};
use nightfall_cmd_parse::slots::contracts::ClauseId;
use nightfall_cmd_parse::slots::planner::BreadcrumbState;

use crate::common::{
    candidate_by_insert, committed_breadcrumb_label, completion_group_by_id, has_candidate_insert,
    has_completion_group as groups_have_completion_group,
};

fn has_completion_group(
    response: &nightfall_cmd_parse::autocomplete::CommandCompletionResponse,
    intent: CompletionGroupId,
) -> bool {
    groups_have_completion_group(&response.slot_plan.completion_groups, intent)
}

fn group_by_id(
    response: &nightfall_cmd_parse::autocomplete::CommandCompletionResponse,
    intent: CompletionGroupId,
) -> &nightfall_cmd_parse::slots::planner::CompletionGroup {
    completion_group_by_id(&response.slot_plan.completion_groups, intent)
}

/// Named attribute values do not also advertise the implicit intensity shortcut.
#[test]
fn complete_command_scopes_intensity_to_implicit_attribute_values() {
    for input in [
        "fix 311 red @",
        "fix 311 int @",
        "fix 311 int @ 100 red @",
        "fix 311 red @ 100 green @",
        "red @",
    ] {
        let response = complete_command(input, input.len());
        assert!(
            has_completion_group(&response, CompletionGroupId::ProgrammerSetAttribute),
            "{input}"
        );
        assert!(
            !has_completion_group(&response, CompletionGroupId::ProgrammerIntensity),
            "{input}"
        );
    }
    for input in ["fix 311", "fix 311 @", "@"] {
        let response = complete_command(input, input.len());
        assert!(
            has_completion_group(&response, CompletionGroupId::ProgrammerIntensity),
            "{input}"
        );
    }
}

/// Completed selections retain both expression and following-clause paths in the breadcrumb.
#[test]
fn complete_command_emits_completion_groups_and_breadcrumb() {
    let response = complete_command("fix 311", "fix 311".len());
    assert_eq!(response.parse.status, ParseStatus::Ok);
    assert!(has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSelectionIdentifier
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSelection
    ));
    assert!(!response.slot_plan.completion_groups.is_empty());
    assert!(matches!(
        response.slot_plan.breadcrumb,
        BreadcrumbState::AmbiguousClausePath { ref paths }
            if paths.iter().any(|path| path.iter().map(|clause| clause.clause).collect::<Vec<_>>()
                == vec![
                    ClauseId::Programmer,
                    ClauseId::ProgrammerSelection,
                    ClauseId::ProgrammerSelectionIdentifier,
                ])
    ));
}

#[test]
fn complete_command_accepts_compact_cue_part_references() {
    for input in ["store cue 1.5p2", "recall cue 1.5p2"] {
        let response = complete_command(input, input.len());
        assert_eq!(response.parse.status, ParseStatus::Ok, "{input}");
    }
}

/// Verifies block and unblock cue targets are accepted as complete commands.
#[test]
fn complete_command_accepts_block_and_unblock_cue_targets() {
    for input in [
        "block cue 1.5",
        "block cue 1.5 /overwrite",
        "block cue 1.5p2",
        "block cue 1.5p2 /overwrite",
        "unblock cue 1.5",
        "unblock cue 1.5p2",
    ] {
        let response = complete_command(input, input.len());
        assert_eq!(response.parse.status, ParseStatus::Ok, "{input}");
    }
}

/// Verifies cue tracking marker values are accepted for explicit and active selections.
#[test]
fn complete_command_accepts_cue_tracking_marker_values() {
    for input in [
        "fix 311 red @ release",
        "fix 311 red @ Release",
        "fix 311 red @ R",
        "tilt @ hold",
        "tilt @ Hold",
        "tilt @ H",
    ] {
        let response = complete_command(input, input.len());
        assert_eq!(response.parse.status, ParseStatus::Ok, "{input}");
    }
}

/// Verifies append-style cue store targets are complete commands.
#[test]
fn complete_command_accepts_store_append_cue_reference_after_dot() {
    let input = "store cue 1.";
    let response = complete_command(input, input.len());
    assert_eq!(response.parse.status, ParseStatus::Ok);
}

/// Verifies store mode flags are accepted after cue targets.
#[test]
fn complete_command_accepts_store_cue_mode_flags() {
    for input in [
        "store cue 1.5 /merge",
        "store cue 1.5 /update",
        "store cue 1.5 /remove",
    ] {
        let response = complete_command(input, input.len());
        assert_eq!(response.parse.status, ParseStatus::Ok, "{input}");
    }
}

/// Verifies nested cue ranges are complete store targets, including mode flags.
#[test]
fn complete_command_accepts_store_cue_ranges() {
    for input in ["store cue 11.(1>5)", "store cue 11.(1>5) /merge"] {
        let response = complete_command(input, input.len());
        assert_eq!(response.parse.status, ParseStatus::Ok, "{input}");
    }
}

/// Verifies recall cue select flags are accepted after cue targets.
#[test]
fn complete_command_accepts_recall_cue_select_flags() {
    for input in ["recall cue 1.5 /select", "recall cue 1.5p2 /select"] {
        let response = complete_command(input, input.len());
        assert_eq!(response.parse.status, ParseStatus::Ok, "{input}");
    }
}

/// Verifies append-style cue-part store targets are complete commands.
#[test]
fn complete_command_accepts_store_append_cue_part_reference_after_p() {
    let input = "store cue 1.5p";
    let response = complete_command(input, input.len());
    assert_eq!(response.parse.status, ParseStatus::Ok);
}

/// Verifies recall cue-part references still require an explicit part ID.
#[test]
fn complete_command_keeps_recall_cue_part_reference_live_after_p() {
    let input = "recall cue 1.5p";
    let response = complete_command(input, input.len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(
        response
            .parse
            .frontier
            .expected_tokens
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit)),
        "{:?}",
        response.parse
    );
}

#[test]
fn complete_command_emits_typed_expected_tokens() {
    let response = complete_command("fx 1 ", "fx 1 ".len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(
        response
            .parse
            .frontier
            .expected_tokens
            .iter()
            .any(|token| matches!(
                token,
                ExpectedToken::Token(TokenId::Step)
                    | ExpectedToken::Token(TokenId::Start)
                    | ExpectedToken::Token(TokenId::Stop)
                    | ExpectedToken::Token(TokenId::Rate)
            ))
    );
}

#[test]
fn complete_command_keeps_identifier_group_live_after_fx_identifier_space() {
    let input = "fx 1 ";
    let response = complete_command(input, input.len());
    let identifier = group_by_id(&response, CompletionGroupId::FxIdentifier);

    assert!(has_completion_group(&response, CompletionGroupId::FxAction));
    assert!(
        identifier
            .candidates
            .contains(&ExpectedToken::Token(TokenId::Plus))
    );
    assert!(
        identifier
            .candidates
            .contains(&ExpectedToken::Token(TokenId::Minus))
    );
    assert!(
        identifier
            .candidates
            .contains(&ExpectedToken::Token(TokenId::GreaterThan))
    );
    assert!(
        identifier
            .candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(
        !response.slot_plan.loose_candidates.iter().any(|candidate| {
            matches!(
                candidate,
                ExpectedToken::Token(TokenId::Plus | TokenId::Minus | TokenId::GreaterThan)
                    | ExpectedToken::Placeholder(ValueKind::NumericDigit)
            )
        })
    );
}

#[test]
fn complete_command_groups_fix_head_numeric_placeholder_with_selection_identifier() {
    let input = "fix ";
    let response = complete_command(input, input.len());
    let identifier = group_by_id(&response, CompletionGroupId::ProgrammerSelectionIdentifier);

    assert!(
        identifier
            .candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(
        !response
            .slot_plan
            .loose_candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
}

#[test]
fn complete_command_activates_fx_step_selection_after_step_keyword() {
    let input = "store fx 211 step ";
    let response = complete_command(input, input.len());

    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxSelection
    ));
    assert!(has_candidate_insert(&response, "fixture"));
    assert!(has_candidate_insert(&response, "group"));
    assert!(
        response
            .parse
            .frontier
            .expected_tokens
            .contains(&ExpectedToken::Token(TokenId::Fixture))
    );
    assert!(
        response
            .parse
            .frontier
            .expected_tokens
            .contains(&ExpectedToken::Token(TokenId::Group))
    );
}

/// Verifies partial Step FX prefixes remain live and offer the `step` keyword.
#[test]
fn complete_command_offers_step_for_partial_store_fx_prefixes() {
    for input in ["store fx 1 s", "store fx 1 st", "store fx 1 ste"] {
        let response = complete_command(input, input.len());

        assert!(
            has_candidate_insert(&response, "step"),
            "expected a step completion for {input}: {response:?}"
        );
    }
}

#[test]
fn complete_command_keeps_fx_step_selection_group_after_selection_head() {
    let input = "store fx 211 step fixture";
    let response = complete_command(input, input.len());

    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxSelection
    ));
}

#[test]
fn complete_command_activates_fx_step_duration_group_after_selection_identifier() {
    let input = "store fx 211 step fixture 1";
    let response = complete_command(input, input.len());

    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxDuration
    ));
}

#[test]
fn complete_command_exposes_numeric_step_selection_after_selection_head_commit() {
    let input = "store fx 1 step fixture ";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxSelection
    ));
    assert!(
        completion_group_by_id(
            &response.slot_plan.completion_groups,
            CompletionGroupId::StepFxSelection
        )
        .candidates
        .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(has_candidate_insert(&response, "0..9"));
}

#[test]
fn complete_command_advances_fx_step_attribute_controls_after_attribute_token() {
    let input = "store fx 1 step fixture 311 5s int";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxAttributeBaseline
    ));
    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxValues
    ));
    assert!(has_candidate_insert(&response, "@"));
    assert!(has_candidate_insert(&response, "steps"));
}

#[test]
fn complete_command_advances_fx_step_values_after_steps_keyword() {
    let input = "store fx 1 step fixture 311 5s int steps ";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxValues
    ));
    assert!(has_candidate_insert(&response, "0..9"));
}

/// Verifies Step FX scalar assignment offers the shared Blueprint source keyword after `@`.
#[test]
fn complete_command_offers_blueprint_for_fx_step_value() {
    let input = "store fx 1 step fixture 311 5s red steps @ ";
    let response = complete_command(input, input.len());

    assert!(has_candidate_insert(&response, "blueprint"));
}

#[test]
fn complete_command_advances_fx_step_attribute_after_completed_duration() {
    let input = "store fx 1 step g 14 1bpm ";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxAttribute
    ));
    assert!(has_candidate_insert(&response, "int"));
    assert!(has_candidate_insert(&response, "red"));
}

/// Verifies Step FX shaping completion exposes ramp without the old terminology.
#[test]
fn complete_command_offers_fx_step_ramp_shaping_after_first_step_value() {
    let input = "store fx 1 step fixture 311 5s int steps 100 ";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::StepFxShaping
    ));
    assert!(has_candidate_insert(&response, "width"));
    assert!(has_candidate_insert(&response, "ramp"));
    assert!(!has_candidate_insert(&response, "transition"));
    assert!(has_candidate_insert(&response, "0..9"));
    assert!(!has_candidate_insert(&response, "int"));
}

#[test]
fn complete_command_keeps_uncovered_raw_candidates() {
    let response = complete_command("patch sacn", "patch sacn".len());
    assert!(has_completion_group(
        &response,
        CompletionGroupId::PatchSource
    ));
    assert!(
        response
            .candidates
            .iter()
            .any(|candidate| candidate.insert_text == ":" || candidate.insert_text == "@")
    );
}

#[test]
fn complete_command_uses_value_placeholder_for_numeric_entry() {
    let response = complete_command("channel 1.100 @", "channel 1.100 @".len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(
        response
            .parse
            .frontier
            .expected_tokens
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
}

/// A filled filter attribute may replace its active token but cannot be appended again.
#[test]
fn complete_command_applies_attribute_suppression_for_filter_lists() {
    let response = complete_command(
        "store blueprint 9 filter red",
        "store blueprint 9 filter red".len(),
    );
    assert!(
        response
            .candidates
            .iter()
            .any(|candidate| candidate.insert_text == "red"
                && candidate.replace.start == 25
                && candidate.replace.end == 28)
    );
    let committed = "store blueprint 9 filter red ";
    assert!(!has_candidate_insert(
        &complete_command(committed, committed.len()),
        "red"
    ));
    assert!(
        !response
            .slot_plan
            .completion_groups
            .iter()
            .find(|group| group.group_id == CompletionGroupId::StoreBlueprintFilter)
            .expect("expected store blueprint filter group")
            .candidates
            .contains(&ExpectedToken::Token(TokenId::AtSign))
    );
    assert!(
        !response
            .candidates
            .iter()
            .any(|candidate| candidate.insert_text == "@")
    );
}

#[test]
fn complete_command_suppresses_already_used_programmer_attributes() {
    let response = complete_command("fix 311 red @ 100", "fix 311 red @ 100".len());
    assert!(!has_candidate_insert(&response, "red"));
    assert!(has_candidate_insert(&response, "green"));
    assert!(has_candidate_insert(&response, "blue"));
    assert!(has_candidate_insert(&response, "white"));
    assert!(has_candidate_insert(&response, "int"));
}

#[test]
fn complete_command_suppresses_already_used_step_fx_attributes() {
    let response = complete_command(
        "store fx 1 step fixture 311 5s red steps 100 ",
        "store fx 1 step fixture 311 5s red steps 100 ".len(),
    );
    assert!(!has_candidate_insert(&response, "red"));
    assert!(has_candidate_insert(&response, "green"));
    assert!(has_candidate_insert(&response, "blue"));
    assert!(has_candidate_insert(&response, "white"));
    assert!(has_candidate_insert(&response, "int"));
}

#[test]
fn complete_command_keeps_partial_head_isolated_to_command_candidates() {
    let response = complete_command("f", "f".len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(&response, CompletionGroupId::Command));
    let command_group = response
        .slot_plan
        .completion_groups
        .iter()
        .find(|group| group.group_id == CompletionGroupId::Command)
        .expect("expected command group");
    assert!(command_group.candidates.iter().all(|candidate| matches!(
        candidate,
        ExpectedToken::Token(TokenId::Fixture)
            | ExpectedToken::Token(TokenId::Fx)
            | ExpectedToken::Token(TokenId::Flow)
            | ExpectedToken::Token(TokenId::Fps)
    )));
    assert!(!command_group.candidates.is_empty());
    assert!(response.candidates.iter().all(|candidate| {
        ["fixture", "fx", "flow", "fps"].contains(&candidate.insert_text.as_str())
    }));
    assert!(
        !response
            .candidates
            .iter()
            .any(|candidate| candidate.insert_text == "(")
    );
    let fixture = candidate_by_insert(&response, "fixture");
    assert_eq!(fixture.replace.start, 0);
    assert_eq!(fixture.replace.end, 1);
    assert_eq!(fixture.apply_text, "fixture ");
}

#[test]
fn complete_command_keeps_partial_head_alias_isolated_to_matching_commands() {
    let response = complete_command("pa", "pa".len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(&response, CompletionGroupId::Command));
    let inserts = response
        .candidates
        .iter()
        .map(|candidate| candidate.insert_text.as_str())
        .collect::<Vec<_>>();
    assert!(inserts.contains(&"patch"));
    assert!(inserts.contains(&"parameter"));
    assert!(!inserts.contains(&"@"));
}

#[test]
fn complete_command_treats_canonical_head_as_committed_without_space() {
    let response = complete_command("log", "log".len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(&response, CompletionGroupId::LogLevel));
    assert!(has_completion_group(
        &response,
        CompletionGroupId::LogFilter
    ));
    assert!(has_completion_group(
        &response,
        CompletionGroupId::LogFixture
    ));
    let inserts = response
        .candidates
        .iter()
        .map(|candidate| candidate.insert_text.as_str())
        .collect::<Vec<_>>();
    assert!(inserts.contains(&"level"));
    assert!(inserts.contains(&"filter"));
    assert!(inserts.contains(&"fixture"));
    assert!(!inserts.contains(&"log"));
}

#[test]
fn complete_command_activates_release_channel_frontier() {
    let response = complete_command("release channel ", "release channel ".len());
    assert_eq!(response.parse.status, ParseStatus::Error);
    assert!(has_completion_group(
        &response,
        CompletionGroupId::ReleaseChannel
    ));
    assert!(
        response
            .parse
            .frontier
            .expected_tokens
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(has_candidate_insert(&response, "0..9"));
    assert!(!has_candidate_insert(&response, "+"));
    assert!(!has_candidate_insert(&response, "-"));
}

#[test]
fn complete_command_keeps_identifier_and_action_groups_populated_without_trailing_space() {
    let flow = complete_command("flow 1", "flow 1".len());
    let flow_identifier = completion_group_by_id(
        &flow.slot_plan.completion_groups,
        CompletionGroupId::FlowIdentifier,
    );
    let flow_action = completion_group_by_id(
        &flow.slot_plan.completion_groups,
        CompletionGroupId::FlowAction,
    );
    assert!(
        flow_identifier
            .candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(
        flow_action
            .candidates
            .contains(&ExpectedToken::Token(TokenId::Start))
    );

    let timecode = complete_command("timecode 1", "timecode 1".len());
    let timecode_identifier = completion_group_by_id(
        &timecode.slot_plan.completion_groups,
        CompletionGroupId::TimecodeIdentifier,
    );
    let timecode_action = completion_group_by_id(
        &timecode.slot_plan.completion_groups,
        CompletionGroupId::TimecodeAction,
    );
    assert!(
        timecode_identifier
            .candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(
        timecode_action
            .candidates
            .contains(&ExpectedToken::Token(TokenId::Pause))
    );

    let timeline = complete_command("timeline 1", "timeline 1".len());
    let timeline_identifier = completion_group_by_id(
        &timeline.slot_plan.completion_groups,
        CompletionGroupId::TimelineIdentifier,
    );
    let timeline_action = completion_group_by_id(
        &timeline.slot_plan.completion_groups,
        CompletionGroupId::TimelineAction,
    );
    assert!(
        timeline_identifier
            .candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
    assert!(
        timeline_action
            .candidates
            .contains(&ExpectedToken::Token(TokenId::Start))
    );
}

#[test]
fn complete_command_appends_continuations_after_exact_committed_keyword() {
    let log = complete_command("log", "log".len());
    let filter = candidate_by_insert(&log, "filter");
    assert_eq!(filter.replace.start, 3);
    assert_eq!(filter.replace.end, 3);
    assert_eq!(filter.apply_text, " filter ");

    let programmer = complete_command("fix 311 red", "fix 311 red".len());
    let at_sign = candidate_by_insert(&programmer, "@");
    assert_eq!(at_sign.replace.start, "fix 311 red".len());
    assert_eq!(at_sign.replace.end, "fix 311 red".len());
    assert_eq!(at_sign.apply_text, " @ ");

    let fade_input = "fix 311 f";
    let fade_response = complete_command(fade_input, fade_input.len());
    let fade = candidate_by_insert(&fade_response, "fade");
    assert_eq!(fade.replace.start, 8);
    assert_eq!(fade.replace.end, 9);
    assert_eq!(fade.apply_text, "fade ");
}

#[test]
fn complete_command_keeps_duration_unit_candidates_tightly_joined_to_numeric_values() {
    let input = "store fx 1 step group 14 5";
    let response = complete_command(input, input.len());
    for token in ["s", "ms", "hz", "bpm"] {
        let candidate = candidate_by_insert(&response, token);
        assert_eq!(candidate.replace.start, input.len());
        assert_eq!(candidate.replace.end, input.len());
        assert_eq!(candidate.apply_text, format!("{token} "));
    }
}

#[test]
fn complete_command_keeps_same_token_completion_replacing_current_word() {
    let response = complete_command("flow 1 start", "flow 1 start".len());
    let start = candidate_by_insert(&response, "start");
    assert_eq!(start.replace.start, 7);
    assert_eq!(start.replace.end, 12);
    assert_eq!(start.apply_text, "start ");
}

/// Initial value frontiers preserve the signs supported by each command's grammar.
#[test]
fn complete_command_surfaces_raw_frontier_tokens_for_recall_sleep_and_fps() {
    let recall = complete_command("recall", "recall".len());
    assert!(has_candidate_insert(&recall, "cue"));
    assert!(has_candidate_insert(&recall, "blueprint"));

    let sleep = complete_command("sleep", "sleep".len());
    assert!(has_candidate_insert(&sleep, "0..9"));
    assert!(has_candidate_insert(&sleep, "+"));
    assert!(has_candidate_insert(&sleep, "-"));

    let fps = complete_command("fps", "fps".len());
    assert!(has_candidate_insert(&fps, "0..9"));
    assert!(has_candidate_insert(&fps, "+"));
    assert!(has_candidate_insert(&fps, "-"));
}

#[test]
fn complete_command_prefers_family_action_tokens_for_partial_action_prefixes() {
    let flow = complete_command("flow 1 st", "flow 1 st".len());
    assert!(has_candidate_insert(&flow, "start"));
    assert!(has_candidate_insert(&flow, "stop"));
    assert!(!has_candidate_insert(&flow, "create"));

    let timecode = complete_command("timecode 1 pa", "timecode 1 pa".len());
    assert!(has_candidate_insert(&timecode, "pause"));
    assert!(!has_candidate_insert(&timecode, "start"));

    let timeline = complete_command("timeline 1 st", "timeline 1 st".len());
    assert!(has_candidate_insert(&timeline, "start"));
    assert!(has_candidate_insert(&timeline, "stop"));

    let clip = complete_command("clip 1 go", "clip 1 go".len());
    assert!(has_candidate_insert(&clip, "go"));
    assert!(has_candidate_insert(&clip, "goto"));
}

#[test]
fn complete_command_prefers_family_keyword_tokens_for_partial_second_token_prefixes() {
    let log = complete_command("log fi", "log fi".len());
    assert!(has_candidate_insert(&log, "filter"));
    assert!(has_candidate_insert(&log, "fixture"));
    assert!(!has_candidate_insert(&log, "level"));

    let recall = complete_command("recall bl", "recall bl".len());
    assert!(has_candidate_insert(&recall, "blueprint"));
    assert!(!has_candidate_insert(&recall, "cue"));

    let release = complete_command("release cha", "release cha".len());
    assert!(has_candidate_insert(&release, "channel"));
    assert!(!has_candidate_insert(&release, "attribute"));

    let store = complete_command("store bl", "store bl".len());
    assert!(has_candidate_insert(&store, "blueprint"));
    assert!(!has_candidate_insert(&store, "cue"));

    let rm = complete_command("rm pat", "rm pat".len());
    assert!(has_candidate_insert(&rm, "patch"));
    assert!(!has_candidate_insert(&rm, "parameter"));
}

#[test]
fn complete_command_scopes_timing_override_to_programmer_timing_group() {
    let response = complete_command(
        "fix 311 red @ 100 fade 10 red 1",
        "fix 311 red @ 100 fade 10 red 1".len(),
    );

    assert!(has_completion_group(
        &response,
        CompletionGroupId::ProgrammerTimings
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSelection
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSelectionIdentifier
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSetAttribute
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerIntensity
    ));
    assert!(
        !group_by_id(&response, CompletionGroupId::ProgrammerTimings)
            .candidates
            .contains(&ExpectedToken::Token(TokenId::Red))
    );
    assert!(!has_candidate_insert(&response, "red"));
}

#[test]
fn complete_command_suppresses_used_timing_override_attribute() {
    let input = "fix 311 fade red 1";
    let response = complete_command(input, input.len());

    assert!(!has_candidate_insert(&response, "red"));
}

#[test]
fn complete_command_does_not_suggest_3d_after_attribute_value() {
    let response = complete_command("fix 311 red @ 100", "fix 311 red @ 100".len());

    assert!(!has_candidate_insert(&response, "3d"));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerPlacement3d
    ));
}

#[test]
fn complete_command_does_not_suggest_attribute_tokens_after_3d_commit() {
    let response = complete_command("fix 311 3d", "fix 311 3d".len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::ProgrammerPlacement3d
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSetAttribute
    ));
    assert!(!has_candidate_insert(&response, "int"));
    assert!(!has_candidate_insert(&response, "red"));
    assert!(!has_candidate_insert(&response, "fade"));
}

/// Active-token frontier merging must not restore candidates from an abandoned sibling clause.
#[test]
fn complete_command_keeps_active_3d_value_frontier_within_placement_clause() {
    let input = "fix 311 3d pos x 1";
    let response = complete_command(input, input.len());

    assert!(!has_candidate_insert(&response, "red"));
    assert!(!has_candidate_insert(&response, "@"));
}

#[test]
fn complete_command_does_not_offer_blueprint_filter_tokens_for_non_blueprint_store() {
    let response = complete_command("store cue 1 filter", "store cue 1 filter".len());

    assert!(!has_candidate_insert(&response, "type"));
    assert!(!has_candidate_insert(&response, "red"));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::StoreBlueprintFilter
    ));
}

#[test]
fn complete_command_steps_out_of_selection_after_3d_branch_commit() {
    let response = complete_command("fix 311 3d", "fix 311 3d".len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::ProgrammerPlacement3d
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSelection
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::ProgrammerSelectionIdentifier
    ));
    assert!(matches!(
        response.slot_plan.breadcrumb,
        BreadcrumbState::CurrentClausePath { ref path, .. }
            if path.iter().map(|clause| clause.clause).collect::<Vec<_>>()
                == vec![ClauseId::Programmer, ClauseId::ProgrammerPlacement3d]
    ));
}

#[test]
fn complete_command_suggests_remaining_axes_for_3d_rotation_clause() {
    let input = "fix 311 3d rot x 2 ";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::ProgrammerPlacement3d
    ));
    assert!(has_candidate_insert(&response, "y"));
    assert!(has_candidate_insert(&response, "z"));
    assert!(!has_candidate_insert(&response, "x"));
}

#[test]
fn complete_command_suppresses_used_axes_within_3d_rotation_clause() {
    let input = "fix 311 3d rot x 2 y 3 ";
    let response = complete_command(input, input.len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::ProgrammerPlacement3d
    ));
    assert!(has_candidate_insert(&response, "z"));
    assert!(!has_candidate_insert(&response, "x"));
    assert!(!has_candidate_insert(&response, "y"));
}

#[test]
fn complete_command_suppresses_signed_prefix_between_3d_axis_pairs() {
    let input = "fix 311 3d pos x 1 y 3 ";
    let response = complete_command(input, input.len());

    assert!(!has_candidate_insert(&response, "+"));
    assert!(!has_candidate_insert(&response, "-"));
}

#[test]
fn complete_command_keeps_signed_prefix_for_3d_axis_value_entry() {
    let input = "fix 311 3d pos x ";
    let response = complete_command(input, input.len());

    assert!(has_candidate_insert(&response, "+"));
    assert!(has_candidate_insert(&response, "-"));
}

/// Presentation retains the committed attribute item and exposes all viable continuation paths.
#[test]
fn complete_command_preserves_attribute_commit_and_frontier_breadcrumb() {
    let input = "fix 311 red @ 1";
    let response = complete_command(input, input.len());

    assert_eq!(
        committed_breadcrumb_label(&response).as_deref(),
        Some("Programmer > Attributes > Set Attribute")
    );
    assert!(matches!(
        response.slot_plan.breadcrumb,
        BreadcrumbState::AmbiguousClausePath { ref paths }
            if paths.iter().any(|path| path.last().is_some_and(|clause| clause.clause == ClauseId::ProgrammerSetAttributeItem))
                && paths.iter().any(|path| path.last().is_some_and(|clause| clause.clause == ClauseId::ProgrammerTimings))
    ));
}

#[test]
fn complete_command_does_not_activate_fx_step_value_groups_at_fx_identifier_frontier() {
    let response = complete_command("fx 1", "fx 1".len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::FxIdentifier
    ));
    assert!(has_completion_group(&response, CompletionGroupId::FxAction));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::StepFxAttributeBaseline
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::StepFxValues
    ));
    assert!(!has_completion_group(
        &response,
        CompletionGroupId::StepFxShaping
    ));
}

#[test]
fn complete_command_activates_rm_object_id_after_object_type() {
    let response = complete_command("rm cue", "rm cue".len());

    assert!(has_completion_group(
        &response,
        CompletionGroupId::RmObjectIdentifier
    ));
    assert!(
        group_by_id(&response, CompletionGroupId::RmObjectIdentifier)
            .candidates
            .contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
    );
}

#[test]
fn complete_command_handles_mixed_case_command_heads() {
    let response = complete_command("LoG", "LoG".len());

    assert!(has_completion_group(&response, CompletionGroupId::LogLevel));
    assert!(has_completion_group(
        &response,
        CompletionGroupId::LogFilter
    ));
    assert!(has_completion_group(
        &response,
        CompletionGroupId::LogFixture
    ));
    assert!(has_candidate_insert(&response, "level"));
    assert!(has_candidate_insert(&response, "filter"));
    assert!(has_candidate_insert(&response, "fixture"));
}
