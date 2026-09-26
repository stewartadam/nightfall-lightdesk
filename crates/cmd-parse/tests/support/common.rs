// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#![allow(dead_code)]

use std::collections::BTreeSet;

use nightfall_cmd_parse::autocomplete::{CommandCompletionResponse, complete_command};
use nightfall_cmd_parse::completion_groups::contracts::CompletionGroupId;
use nightfall_cmd_parse::lexicon::tokens::canonical_text;
use nightfall_cmd_parse::parser::analysis::{CommandPrefixSnapshot, ExpectedToken, ValueKind};
use nightfall_cmd_parse::parser::prefix::parse_prefix;
use nightfall_cmd_parse::slots::planner::{
    CompletionGroup, SlotPlan, build_slot_plan_with_snapshot, clause_display_label,
};

pub fn complete(input: &str) -> CommandCompletionResponse {
    complete_command(input, input.len())
}

pub fn snapshot(input: &str) -> CommandPrefixSnapshot<'_> {
    parse_prefix(input, input.len())
}

pub fn plan(input: &str) -> SlotPlan {
    let snapshot = snapshot(input);
    build_slot_plan_with_snapshot(&snapshot)
}

pub fn has_completion_group(groups: &[CompletionGroup], group_id: CompletionGroupId) -> bool {
    groups.iter().any(|group| group.group_id == group_id)
}

pub fn completion_group_by_id(
    groups: &[CompletionGroup],
    group_id: CompletionGroupId,
) -> &CompletionGroup {
    groups
        .iter()
        .find(|group| group.group_id == group_id)
        .expect("expected completion group")
}

pub fn committed_breadcrumb_label(response: &CommandCompletionResponse) -> Option<String> {
    (!response.slot_plan.committed_path.is_empty()).then(|| {
        response
            .slot_plan
            .committed_path
            .iter()
            .map(|clause| clause_display_label(clause.clause))
            .collect::<Vec<_>>()
            .join(" > ")
    })
}

pub fn has_candidate_insert(response: &CommandCompletionResponse, insert_text: &str) -> bool {
    response
        .candidates
        .iter()
        .any(|candidate| candidate.insert_text == insert_text)
}

pub fn candidate_by_insert<'a>(
    response: &'a CommandCompletionResponse,
    insert_text: &str,
) -> &'a nightfall_cmd_parse::autocomplete::CompletionCandidate {
    if let Some(candidate) = response
        .candidates
        .iter()
        .find(|candidate| candidate.insert_text == insert_text)
    {
        return candidate;
    }

    let inserts = response
        .candidates
        .iter()
        .map(|candidate| candidate.insert_text.as_str())
        .collect::<Vec<_>>();
    panic!("expected candidate `{insert_text}`, got {inserts:?}")
}

pub fn candidate_inserts(response: &CommandCompletionResponse) -> BTreeSet<String> {
    response
        .candidates
        .iter()
        .map(|candidate| candidate.insert_text.clone())
        .collect()
}

pub fn plan_has_expected_token(plan: &SlotPlan, token: ExpectedToken) -> bool {
    plan.loose_candidates.contains(&token)
        || plan
            .completion_groups
            .iter()
            .any(|group| group.candidates.contains(&token))
}

pub fn expected_token_text(token: &ExpectedToken) -> String {
    match token {
        ExpectedToken::Token(token) => canonical_text(*token)
            .expect("token should have canonical text")
            .to_string(),
        ExpectedToken::Placeholder(kind) => placeholder_text(*kind).to_string(),
        ExpectedToken::Literal(value) => value.to_string(),
    }
}

fn placeholder_text(kind: ValueKind) -> &'static str {
    match kind {
        ValueKind::ColorPathReference => "path0..9",
        ValueKind::BlueprintAddress => "Blueprint ID or label",
        ValueKind::Text => "text",
        ValueKind::NumericDigit
        | ValueKind::IdentifierExpression
        | ValueKind::ValueRange
        | ValueKind::DurationValue
        | ValueKind::DmxAddress => "0..9",
    }
}
