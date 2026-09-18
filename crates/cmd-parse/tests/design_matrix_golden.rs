// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[path = "common.rs"]
mod common;

use std::collections::BTreeSet;

use libtest_mimic::{Arguments, Trial};
use nightfall_cmd_parse::autocomplete::{ParseStatus, complete_command};
use nightfall_cmd_parse::parser::analysis::{GrammarRuleId, ValueKind};
use nightfall_cmd_parse::slots::contracts::{ClauseId, SlotId};
use nightfall_cmd_parse::slots::planner::{BreadcrumbState, CompletionGroup};
use serde::Deserialize;

use crate::common::{candidate_inserts, committed_breadcrumb_label, expected_token_text};

/// Fixture definition used by command parser design-matrix tests.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixFixture {
    cases: Vec<MatrixCase>,
}

/// One command parser design-matrix scenario and its expected outputs.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MatrixCase {
    name: String,
    input: String,
    response: ResponseExpectations,
}

/// Expected parser response fields for a design-matrix case.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseExpectations {
    parse: ParseExpectations,
    completion_groups: Option<Vec<String>>,
    candidates: Option<Vec<String>>,
    forbidden_candidates: Option<Vec<String>>,
    groups: Option<Vec<GroupExpectations>>,
    current_breadcrumb: Option<String>,
    breadcrumb: Option<BreadcrumbExpectation>,
}

/// Expected AST and completion state for a design-matrix case.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParseExpectations {
    status: ParseStatus,
    expected_rules: Option<Vec<GrammarRuleId>>,
    expected_tokens: Option<Vec<String>>,
}

/// Expected breadcrumb shown for a parser location in design-matrix tests.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BreadcrumbExpectation {
    state: BreadcrumbStateKind,
    path: Option<Vec<ClauseId>>,
}

/// Breadcrumb states asserted by parser design-matrix tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BreadcrumbStateKind {
    None,
    AmbiguousClausePath,
    CurrentClausePath,
}

/// Expected completion group state for a design-matrix case.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupExpectations {
    group_id: String,
    active_slots: Option<Vec<SlotId>>,
    auto_advance_singleton: Option<String>,
    inline_placeholder: Option<ValueKind>,
    candidates: Option<Vec<String>>,
    forbidden_candidates: Option<Vec<String>>,
}

fn load_matrix() -> MatrixFixture {
    serde_json::from_str(include_str!("fixtures/design_matrix_cases.json"))
        .expect("design matrix fixture should deserialize")
}

fn completion_group_by_id<'a>(
    groups: &'a [CompletionGroup],
    group_id: &str,
) -> &'a CompletionGroup {
    groups
        .iter()
        .find(|group| group.group_id.as_str() == group_id)
        .unwrap_or_else(|| panic!("expected completion group {group_id}"))
}

fn group_candidate_texts(group: &CompletionGroup) -> BTreeSet<String> {
    group.candidates.iter().map(expected_token_text).collect()
}

fn breadcrumb_state_kind(breadcrumb: &BreadcrumbState) -> BreadcrumbStateKind {
    match breadcrumb {
        BreadcrumbState::None => BreadcrumbStateKind::None,
        BreadcrumbState::AmbiguousClausePath { .. } => BreadcrumbStateKind::AmbiguousClausePath,
        BreadcrumbState::CurrentClausePath { .. } => BreadcrumbStateKind::CurrentClausePath,
    }
}

fn assert_string_set_eq(
    actual: BTreeSet<String>,
    expected: &[String],
    context: &str,
    case: &MatrixCase,
) {
    let expected = expected.iter().cloned().collect::<BTreeSet<_>>();
    assert_eq!(
        actual, expected,
        "{} for fixture case '{}'",
        context, case.name
    );
}

fn assert_missing_strings(
    actual: &BTreeSet<String>,
    forbidden: &[String],
    context: &str,
    case: &MatrixCase,
) {
    for forbidden_token in forbidden {
        assert!(
            !actual.contains(forbidden_token),
            "{} unexpectedly contained '{}' for fixture case '{}'",
            context,
            forbidden_token,
            case.name
        );
    }
}

fn assert_group_expectations(
    groups: &[CompletionGroup],
    expectations: &[GroupExpectations],
    case: &MatrixCase,
) {
    for expectation in expectations {
        let group = completion_group_by_id(groups, &expectation.group_id);

        if let Some(active_slots) = &expectation.active_slots {
            assert_eq!(
                group
                    .active_slots
                    .iter()
                    .map(|slot_ref| slot_ref.slot)
                    .collect::<Vec<_>>(),
                *active_slots,
                "active_slots mismatch for fixture case '{}' group '{}'",
                case.name,
                expectation.group_id
            );
        }

        if let Some(auto_advance_singleton) = &expectation.auto_advance_singleton {
            assert_eq!(
                group.auto_advance_singleton.as_deref(),
                Some(auto_advance_singleton.as_str()),
                "auto_advance_singleton mismatch for fixture case '{}' group '{}'",
                case.name,
                expectation.group_id
            );
        }

        if let Some(inline_placeholder) = expectation.inline_placeholder {
            assert_eq!(
                group.inline_placeholder,
                Some(inline_placeholder),
                "inline_placeholder mismatch for fixture case '{}' group '{}'",
                case.name,
                expectation.group_id
            );
        }

        let candidate_texts = group_candidate_texts(group);
        if let Some(candidates) = &expectation.candidates {
            assert_string_set_eq(
                candidate_texts.clone(),
                candidates,
                &format!(
                    "group candidates mismatch for group '{}'",
                    expectation.group_id
                ),
                case,
            );
        }
        if let Some(forbidden_candidates) = &expectation.forbidden_candidates {
            assert_missing_strings(
                &candidate_texts,
                forbidden_candidates,
                &format!(
                    "group candidates unexpectedly contained forbidden values for group '{}'",
                    expectation.group_id
                ),
                case,
            );
        }
    }
}

fn run_case(case: &MatrixCase) {
    let response = complete_command(&case.input, case.input.len());

    assert_eq!(
        response.parse.status, case.response.parse.status,
        "response.parse.status mismatch for fixture case '{}'",
        case.name
    );

    if let Some(expected_rules) = &case.response.parse.expected_rules {
        let actual_rules = response
            .parse
            .frontier
            .expected_rules
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        let expected_rules = expected_rules.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(
            actual_rules, expected_rules,
            "response.parse.expected_rules mismatch for fixture case '{}'",
            case.name
        );
    }

    if let Some(expected_tokens) = &case.response.parse.expected_tokens {
        let actual_tokens = response
            .parse
            .frontier
            .expected_tokens
            .iter()
            .map(expected_token_text)
            .collect::<BTreeSet<_>>();
        assert_string_set_eq(
            actual_tokens,
            expected_tokens,
            "response.parse.expected_tokens mismatch",
            case,
        );
    }

    if let Some(completion_groups) = &case.response.completion_groups {
        let actual = response
            .slot_plan
            .completion_groups
            .iter()
            .map(|group| group.group_id.as_str().to_string())
            .collect::<BTreeSet<_>>();
        let expected = completion_groups.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            actual, expected,
            "response.completion_groups mismatch for fixture case '{}'",
            case.name
        );
    }

    if let Some(candidates) = &case.response.candidates {
        assert_string_set_eq(
            candidate_inserts(&response),
            candidates,
            "response.candidates mismatch",
            case,
        );
    }

    if let Some(forbidden_candidates) = &case.response.forbidden_candidates {
        let inserts = candidate_inserts(&response);
        assert_missing_strings(
            &inserts,
            forbidden_candidates,
            "response.candidates unexpectedly contained forbidden values",
            case,
        );
    }

    if let Some(groups) = &case.response.groups {
        assert_group_expectations(&response.slot_plan.completion_groups, groups, case);
    }

    if let Some(current_breadcrumb) = &case.response.current_breadcrumb {
        assert_eq!(
            committed_breadcrumb_label(&response).as_deref(),
            Some(current_breadcrumb.as_str()),
            "response.current_breadcrumb mismatch for fixture case '{}'",
            case.name
        );
    }

    if let Some(breadcrumb) = &case.response.breadcrumb {
        assert_eq!(
            breadcrumb_state_kind(&response.slot_plan.breadcrumb),
            breadcrumb.state,
            "response.breadcrumb.state mismatch for fixture case '{}'",
            case.name
        );

        if let Some(path) = &breadcrumb.path {
            match &response.slot_plan.breadcrumb {
                BreadcrumbState::CurrentClausePath { path: actual_path } => {
                    let actual = actual_path
                        .iter()
                        .map(|entry| entry.clause)
                        .collect::<Vec<_>>();
                    assert_eq!(
                        actual, *path,
                        "response.breadcrumb.path mismatch for fixture case '{}'",
                        case.name
                    );
                }
                _ => panic!(
                    "response.breadcrumb.path provided but state is not current_clause_path for fixture case '{}'",
                    case.name
                ),
            }
        }
    }
}

fn main() {
    let args = Arguments::from_args();
    let fixture = load_matrix();

    let tests = fixture
        .cases
        .into_iter()
        .enumerate()
        .map(|(index, case)| {
            let test_name = format!("{:02} {}", index + 1, case.name);
            Trial::test(test_name, move || {
                run_case(&case);
                Ok(())
            })
        })
        .collect::<Vec<_>>();

    libtest_mimic::run(&args, tests).exit();
}
