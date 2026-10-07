// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::completion_groups::contracts::CompletionGroupId;
use nightfall_cmd_parse::parser::analysis::{ExpectedToken, TokenId};
use nightfall_cmd_parse::slots::contracts::SlotId;
use nightfall_cmd_parse::slots::planner::BreadcrumbState;

use crate::common::{has_completion_group, plan, plan_has_expected_token};

/// FX identifiers and actions retain separate parser frontier paths within the same command.
#[test]
fn slot_planner_projects_fx_action_group() {
    let plan = plan("fx 1 ");

    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::FxAction
    ));
    assert!(matches!(
        plan.breadcrumb,
        BreadcrumbState::AmbiguousClausePath { ref paths } if paths.len() >= 2
    ));
    assert!(!plan.active_slots.is_empty());
}

#[test]
fn slot_planner_reports_ambiguous_completion_groups_for_rm_head() {
    let plan = plan("rm ");

    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::RmObjectType
    ));
    assert!(!has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::StoreObjectType
    ));
    assert!(matches!(
        plan.breadcrumb,
        BreadcrumbState::CurrentClausePath { .. }
    ));
}

#[test]
fn slot_planner_applies_filter_attribute_suppression() {
    let input = "store blueprint 9 filter red ";
    let plan = plan(input);

    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::StoreBlueprintFilter
    ));
    assert!(plan.suppression.iter().any(|record| record.slot
        == nightfall_cmd_parse::slots::contracts::SlotId::QualifierAttributeList));
}

#[test]
fn slot_planner_activates_flow_action_group() {
    let plan = plan("flow 1 ");
    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::FlowAction
    ));
}

#[test]
fn slot_planner_activates_timecode_and_timeline_action_groups() {
    let timecode_plan = plan("timecode 1 ");
    assert!(has_completion_group(
        &timecode_plan.completion_groups,
        CompletionGroupId::TimecodeAction
    ));

    let timeline_plan = plan("timeline 1 ");
    assert!(has_completion_group(
        &timeline_plan.completion_groups,
        CompletionGroupId::TimelineAction
    ));
}

#[test]
fn slot_planner_activates_log_recall_and_sleep_groups() {
    let log_plan = plan("log ");
    assert!(has_completion_group(
        &log_plan.completion_groups,
        CompletionGroupId::LogFilter
    ));

    let recall_plan = plan("recall ");
    assert!(has_completion_group(
        &recall_plan.completion_groups,
        CompletionGroupId::RecallCueRef
    ));

    let sleep_plan = plan("sleep ");
    assert!(has_completion_group(
        &sleep_plan.completion_groups,
        CompletionGroupId::SleepDuration
    ));
}

#[test]
fn slot_planner_treats_canonical_heads_without_space_as_committed() {
    let log_plan = plan("log");
    assert!(has_completion_group(
        &log_plan.completion_groups,
        CompletionGroupId::LogLevel
    ));

    let recall_plan = plan("recall");
    assert!(has_completion_group(
        &recall_plan.completion_groups,
        CompletionGroupId::RecallCueRef
    ));

    let sleep_plan = plan("sleep");
    assert!(has_completion_group(
        &sleep_plan.completion_groups,
        CompletionGroupId::SleepDuration
    ));
}

#[test]
fn slot_planner_activates_release_channel_group_without_following_value() {
    let plan = plan("release channel ");
    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::ReleaseChannel
    ));
}

#[test]
fn slot_planner_suppresses_duplicate_timing_keyword_after_fade_clause() {
    let input = "fix 311 red @ 100 fade 10";
    let plan = plan(input);

    assert!(
        plan.suppression.iter().any(|record| {
            record.slot == SlotId::TimingsKeyword
                && record.suppressed == ExpectedToken::Token(TokenId::Fade)
        }),
        "expected fade keyword suppression record once fade is already filled",
    );
    assert!(
        !plan
            .loose_candidates
            .contains(&ExpectedToken::Token(TokenId::Fade)),
        "duplicate fade should not remain in loose candidates",
    );
    assert!(
        plan_has_expected_token(&plan, ExpectedToken::Token(TokenId::Delay)),
        "delay should remain available when only fade has been filled",
    );
}

#[test]
fn slot_planner_suppresses_duplicate_timing_keyword_after_delay_clause() {
    let input = "fix 311 red @ 100 delay 10";
    let plan = plan(input);

    assert!(
        plan.suppression.iter().any(|record| {
            record.slot == SlotId::TimingsKeyword
                && record.suppressed == ExpectedToken::Token(TokenId::Delay)
        }),
        "expected delay keyword suppression record once delay is already filled",
    );
    assert!(
        !plan
            .loose_candidates
            .contains(&ExpectedToken::Token(TokenId::Delay)),
        "duplicate delay should not remain in loose candidates",
    );
    assert!(
        plan_has_expected_token(&plan, ExpectedToken::Token(TokenId::Fade)),
        "fade should remain available when only delay has been filled",
    );
}

#[test]
fn slot_planner_does_not_activate_cross_family_step_fx_group_for_programmer_attributes() {
    let input = "fix 311 zoom @ 100";
    let plan = plan(input);

    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::ProgrammerSetAttribute
    ));
    assert!(has_completion_group(
        &plan.completion_groups,
        CompletionGroupId::ProgrammerTimings
    ));
    assert!(
        !has_completion_group(&plan.completion_groups, CompletionGroupId::StepFxAttribute),
        "step-fx attribute group should not activate for programmer attribute continuations",
    );
    assert!(
        plan.active_slots.iter().any(|slot_ref| {
            matches!(
                slot_ref.slot,
                SlotId::SetAttrAttribute | SlotId::TimingsKeyword
            )
        }),
        "planner should keep active slots attached to programmer frontier slots only",
    );
}
