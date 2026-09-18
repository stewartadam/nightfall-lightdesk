// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[path = "common.rs"]
mod common;

use nightfall_cmd_parse::parser::analysis::{
    ExpectedToken, GrammarRuleId, ParseStatus, TokenId, ValueKind,
};
use nightfall_cmd_parse::parser::query::{
    expected_rules as snapshot_expected_rules, expected_tokens as snapshot_expected_tokens,
    projected_expectations as snapshot_projected_expectations,
};
use nightfall_cmd_parse::slots::contracts::{ClauseId, SlotId};

use crate::common::snapshot;

fn has_numeric_placeholder_or_literal(input: &str) -> bool {
    let expected_tokens = snapshot_expected_tokens(&snapshot(input));
    expected_tokens.contains(&ExpectedToken::Placeholder(ValueKind::NumericDigit))
        || expected_tokens.contains(&ExpectedToken::Literal("0..9".into()))
}

#[test]
fn prefix_analysis_programmer_emits_value_expectations() {
    let input = "fix 311 red @";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert!(snapshot_expected_rules(&snapshot).contains(&GrammarRuleId::ValueRange));
    assert!(has_numeric_placeholder_or_literal(input));
}

#[test]
fn prefix_analysis_active_selection_attribute_builds_structural_branch() {
    let input = "red @ 100 fade 1";
    let snapshot = snapshot(input);

    assert_eq!(snapshot.status(), ParseStatus::Ok);
    assert!(snapshot.branches.iter().any(|branch| {
        branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == SlotId::SetAttrAttribute)
            && branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == SlotId::TimingsKeyword)
            && !branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == SlotId::CommandHead)
            && branch
                .clause_tree
                .nodes
                .iter()
                .any(|node| node.clause.clause == ClauseId::ProgrammerAttributeActions)
    }));
}

/// Verifies the shared attribute clause exposes Blueprint addresses before source modifiers.
#[test]
fn prefix_analysis_orders_blueprint_address_and_absolute_slots() {
    let incomplete = snapshot("color @ blueprint ");
    let incomplete_tokens = snapshot_expected_tokens(&incomplete);
    assert!(!incomplete_tokens.contains(&ExpectedToken::Token(TokenId::Absolute)));
    assert!(incomplete.consumed_items().iter().any(|item| {
        item.slot.slot == SlotId::SetAttrValue
            && item.surface.to_ascii_lowercase().contains("blueprint")
    }));

    let addressed = snapshot("color @ blueprint 5 ");
    assert!(
        snapshot_expected_tokens(&addressed).contains(&ExpectedToken::Token(TokenId::Absolute))
    );
}

#[test]
fn prefix_analysis_fx_emits_action_expectations() {
    let input = "fx 1 ";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    let expected_rules = snapshot_expected_rules(&snapshot);
    let expected_tokens = snapshot_expected_tokens(&snapshot);
    assert!(expected_rules.contains(&GrammarRuleId::FxActions));
    assert!(
        expected_tokens.contains(&ExpectedToken::Token(TokenId::Step))
            || expected_tokens.contains(&ExpectedToken::Token(TokenId::Start))
            || expected_tokens.contains(&ExpectedToken::Token(TokenId::Stop))
            || expected_tokens.contains(&ExpectedToken::Token(TokenId::Rate))
    );
}

#[test]
fn prefix_analysis_patch_emits_transport_expectations() {
    let input = "patch ";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    let expected_rules = snapshot_expected_rules(&snapshot);
    let expected_tokens = snapshot_expected_tokens(&snapshot);
    assert!(expected_rules.contains(&GrammarRuleId::TransportName));
    assert!(
        expected_tokens.contains(&ExpectedToken::Token(TokenId::Console))
            || expected_tokens.contains(&ExpectedToken::Token(TokenId::Sacn))
            || expected_tokens.contains(&ExpectedToken::Token(TokenId::Artnet))
            || expected_tokens.contains(&ExpectedToken::Token(TokenId::Udmx))
    );
}

#[test]
fn prefix_analysis_release_channel_emits_numeric_placeholder() {
    let input = "release channel ";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert!(has_numeric_placeholder_or_literal(input));
}

#[test]
fn prefix_analysis_channel_value_emits_value_expectations() {
    let input = "channel 1.100 @";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert!(snapshot_expected_rules(&snapshot).contains(&GrammarRuleId::ValueRange));
    assert!(has_numeric_placeholder_or_literal(input));
}

#[test]
fn prefix_analysis_tracks_rule_path_for_incomplete_input() {
    let input = "fx 1 st";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert!(!snapshot_expected_rules(&snapshot).is_empty());
}

#[test]
fn prefix_analysis_emits_context_for_partial_head_token() {
    let input = "pa";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert_eq!(snapshot.context.token_count, 1);
    assert_eq!(snapshot.context.active_token_text.as_deref(), Some("pa"));
    assert!(
        !snapshot_expected_tokens(&snapshot).is_empty()
            || !snapshot_expected_rules(&snapshot).is_empty()
    );
}

#[test]
fn prefix_analysis_keeps_single_token_partial_head_scoped_to_command_heads() {
    let input = "f";
    let snapshot = snapshot(input);
    let expected_rules = snapshot_expected_rules(&snapshot);
    let expected_tokens = snapshot_expected_tokens(&snapshot);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert!(snapshot.committed_clause_path().is_empty());
    assert!(expected_rules.contains(&GrammarRuleId::Command));
    assert!(expected_tokens.contains(&ExpectedToken::Token(TokenId::Fixture)));
    assert!(expected_tokens.contains(&ExpectedToken::Token(TokenId::Fx)));
    assert!(expected_tokens.contains(&ExpectedToken::Token(TokenId::Flow)));
    assert!(expected_tokens.contains(&ExpectedToken::Token(TokenId::Fps)));
    assert!(!expected_tokens.contains(&ExpectedToken::Token(TokenId::AtSign)));
    assert!(!expected_rules.contains(&GrammarRuleId::Selection));
    assert!(
        snapshot_projected_expectations(&snapshot)
            .iter()
            .any(|projected| {
                matches!(
                    projected.expectation.target,
                    nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(ref slot)
                        if slot.slot == SlotId::CommandHead
                )
            })
    );
}

#[test]
fn prefix_analysis_frontier_alternatives_derive_from_expected_rules() {
    let input = "timecode 1 ";
    let snapshot = snapshot(input);
    assert_eq!(snapshot.status(), ParseStatus::Error);
    assert!(!snapshot_expected_rules(&snapshot).is_empty());
    let projected = snapshot_projected_expectations(&snapshot);
    assert!(!projected.is_empty());
    assert!(projected.iter().any(|entry| matches!(
        entry.expectation.target,
        nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(_)
    )));
}

#[test]
fn prefix_analysis_store_blueprint_filter_continuation_does_not_offer_at_sign() {
    for input in [
        "store blueprint 9 filter red",
        "store blueprint 9 filter red ",
    ] {
        let snapshot = snapshot(input);
        assert!(
            !snapshot_expected_tokens(&snapshot).contains(&ExpectedToken::Token(TokenId::AtSign))
        );
    }
}

#[test]
fn prefix_analysis_frontier_alternatives_keep_branch_local_rules_for_programmer_continuations() {
    let input = "fix 311 red @ 100";
    let snapshot = snapshot(input);
    let projected = snapshot_projected_expectations(&snapshot);

    assert!(projected.iter().any(|entry| {
        entry.expectation.rule == GrammarRuleId::AttributeType
            && matches!(
                entry.expectation.target,
                nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                    if slot_ref.slot == SlotId::SetAttrAttribute
            )
    }));
    assert!(projected.iter().any(|entry| {
        entry.expectation.rule == GrammarRuleId::TimingKeyword
            && matches!(
                entry.expectation.target,
                nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                    if slot_ref.slot == SlotId::TimingsKeyword
            )
    }));
}

#[test]
fn prefix_analysis_frontier_alternatives_keep_branch_local_rules_for_channel_continuations() {
    let input = "channel 1";
    let snapshot = snapshot(input);
    let projected = snapshot_projected_expectations(&snapshot);

    assert!(projected.iter().any(|entry| {
        entry.expectation.rule == GrammarRuleId::DmxChannelExpression
            && matches!(
                entry.expectation.target,
                nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                    if slot_ref.slot == SlotId::ChannelOverrideIdentifier
            )
    }));
}

#[test]
fn prefix_analysis_fx_step_completed_duration_advances_to_attribute_definition() {
    let input = "store fx 1 step g 14 1bpm ";
    let snapshot = snapshot(input);
    let expected_rules = snapshot_expected_rules(&snapshot);
    let projected = snapshot_projected_expectations(&snapshot);

    assert!(expected_rules.contains(&GrammarRuleId::FxAttributeSteps));
    assert!(projected.iter().any(|entry| {
        entry.expectation.rule == GrammarRuleId::FxAttributeSteps
            && matches!(
                entry.expectation.target,
                nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                    if slot_ref.slot == SlotId::StepFxStepAttribute
            )
    }));
    assert_eq!(
        snapshot
            .committed_clause_path()
            .last()
            .map(|clause| clause.clause),
        Some(ClauseId::StepFxStepDefinition)
    );
}

#[test]
fn prefix_analysis_fx_step_incomplete_duration_keeps_duration_active() {
    let input = "store fx 1 step g 14 1bp ";
    let snapshot = snapshot(input);
    let expected_rules = snapshot_expected_rules(&snapshot);

    assert!(expected_rules.contains(&GrammarRuleId::DurationValue));
    assert!(!expected_rules.contains(&GrammarRuleId::FxAttributeSteps));
    assert_eq!(
        snapshot
            .committed_clause_path()
            .last()
            .map(|clause| clause.clause),
        Some(ClauseId::StepFx)
    );
}

#[test]
fn prefix_analysis_builds_observed_programmer_clause_tree() {
    let input = "fix 311 fade 1 red 10";
    let snapshot = snapshot(input);
    let clause_tree = &snapshot
        .branches
        .iter()
        .find(|branch| {
            branch
                .clause_tree
                .nodes
                .iter()
                .any(|node| node.clause.clause == ClauseId::ProgrammerTimings)
        })
        .expect("expected programmer timings branch")
        .clause_tree;

    assert_eq!(clause_tree.roots.len(), 1);
    let root = &clause_tree.nodes[clause_tree.roots[0].0 as usize];
    assert_eq!(root.clause.clause, ClauseId::Programmer);
    assert_eq!(
        root.span.map(|span| (span.start, span.end)),
        Some((0, input.len()))
    );
    assert!(
        root.fills
            .iter()
            .any(|fill| fill.slot == SlotId::CommandHead)
    );

    let child_clauses = root
        .children
        .iter()
        .map(|id| clause_tree.nodes[id.0 as usize].clause.clause)
        .collect::<Vec<_>>();
    assert!(child_clauses.contains(&ClauseId::ProgrammerSelection));
    assert!(child_clauses.contains(&ClauseId::ProgrammerTimings));
}

#[test]
fn prefix_analysis_clause_tree_splits_repeated_programmer_attribute_items() {
    let input = "fix 311 red @ 100 blue @ 100";
    let snapshot = snapshot(input);
    let clause_tree = &snapshot
        .branches
        .iter()
        .find(|branch| {
            branch
                .clause_tree
                .nodes
                .iter()
                .filter(|node| node.clause.clause == ClauseId::ProgrammerSetAttributeItem)
                .count()
                >= 2
        })
        .expect("expected repeated set-attribute branch")
        .clause_tree;

    let mut occurrences = clause_tree
        .nodes
        .iter()
        .filter(|node| node.clause.clause == ClauseId::ProgrammerSetAttributeItem)
        .map(|node| node.occurrence)
        .collect::<Vec<_>>();
    occurrences.sort_unstable();

    assert_eq!(occurrences, vec![0, 1]);
}

#[test]
fn prefix_analysis_projects_legacy_analysis_into_snapshot_contract() {
    let input = "fix 311 red @";
    let snapshot = snapshot(input);

    assert!(!snapshot.committed_clause_path().is_empty());
    assert_eq!(snapshot.branches.len(), 1);
    assert!(!snapshot_projected_expectations(&snapshot).is_empty());
}
