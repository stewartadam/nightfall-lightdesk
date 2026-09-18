// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Formatting of parser-owned continuation edits.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::autocomplete::{CandidateSource, CompletionCandidate, TextRange};
use crate::lexicon::labels::token_label;
use crate::parser::analysis::{CommandPrefixSnapshot, ExpectedToken, ValueKind};

/// Formatted candidates retain their expected token and exact source alternatives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ComposedCandidates {
    pub expected_tokens: BTreeSet<ExpectedToken>,
    pub candidates: Vec<CompletionCandidate>,
}

/// Formats each parser continuation without adding syntax or choosing command-family behavior.
pub fn compose_candidates_with_snapshot(
    _input: &str,
    _cursor: usize,
    segment_start: usize,
    _word_replace: TextRange,
    snapshot: &CommandPrefixSnapshot<'_>,
    plan: &crate::slots::planner::SlotPlan,
) -> ComposedCandidates {
    let mut expected_tokens = BTreeSet::new();
    let mut candidates: Vec<CompletionCandidate> = Vec::new();
    for (source, projected) in snapshot.projected_expectations().iter().enumerate() {
        let replace = TextRange {
            start: segment_start + projected.replace.start,
            end: segment_start + projected.replace.end,
        };
        for expected in &projected.expectation.expected_tokens {
            if !plan
                .visible_frontier
                .iter()
                .any(|visible| visible.source == source && visible.token == *expected)
            {
                continue;
            }
            let Some(insert_text) = expected_token_insert_text(expected) else {
                continue;
            };
            expected_tokens.insert(expected.clone());
            if let Some(existing) = candidates
                .iter_mut()
                .find(|candidate| candidate.expected == *expected && candidate.replace == replace)
            {
                if !existing.frontier_sources.contains(&source) {
                    existing.frontier_sources.push(source);
                }
                continue;
            }
            let label = match expected {
                ExpectedToken::Token(token) => token_label(*token).unwrap_or(insert_text),
                _ => insert_text,
            };
            candidates.push(CompletionCandidate {
                id: format!("candidate-{}", candidates.len()),
                expected: expected.clone(),
                frontier_sources: vec![source],
                label: label.to_owned(),
                insert_text: insert_text.to_owned(),
                apply_text: insert_text.to_owned(),
                detail: Some("Expected token".to_owned()),
                replace,
                source: CandidateSource::GrammarToken,
                completable: !matches!(expected, ExpectedToken::Placeholder(_)),
            });
        }
    }
    ComposedCandidates {
        expected_tokens,
        candidates,
    }
}

/// Returns the literal text inserted for an expected token, if that expectation has one.
pub(crate) fn expected_token_insert_text(token: &ExpectedToken) -> Option<&str> {
    match token {
        ExpectedToken::Token(token_id) => crate::lexicon::tokens::canonical_text(*token_id),
        ExpectedToken::Placeholder(value_kind) => Some(value_kind_to_text(*value_kind)),
        ExpectedToken::Literal(value) => Some(value.as_str()),
    }
}

/// Maps a placeholder value kind to the inline text shown for that placeholder.
fn value_kind_to_text(value_kind: ValueKind) -> &'static str {
    match value_kind {
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
