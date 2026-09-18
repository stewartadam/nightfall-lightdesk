// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub use crate::completion::api::CommandCompletionResponse;
use crate::completion::composer::compose_candidates_with_snapshot;
use crate::completion::formatting::{
    apply_text_for_candidate as completion_apply_text_for_candidate, token_replace_bounds,
};
use crate::parser::analysis::{ClauseInstance, ParseStatus as AnalysisParseStatus, ParserFrontier};
use crate::parser::prefix::parse_prefix;
use crate::slots::planner::build_slot_plan_with_snapshot;
use crate::{split_command_statements, statement_range_at, statement_ranges};

/// Half-open byte range in the original input string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

/// High-level parse outcome for the active command segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Ok,
    Error,
}

/// Snapshot of prefix parsing state exposed to autocomplete consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseSnapshot {
    pub status: ParseStatus,
    pub furthest_pos: usize,
    pub frontier: ParserFrontier,
    pub committed_clause_path: Vec<ClauseInstance>,
    pub projected_clause_paths: Vec<Vec<ClauseInstance>>,
}

/// Indicates how a completion candidate was produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateSource {
    GrammarToken,
}

/// A single completion option returned to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionCandidate {
    /// Opaque identifier valid within this completion response.
    pub id: String,
    /// The grammar expectation represented by this formatted edit.
    pub expected: crate::parser::analysis::ExpectedToken,
    /// Exact parser alternatives that own this candidate.
    pub frontier_sources: Vec<usize>,
    pub label: String,
    pub insert_text: String,
    pub apply_text: String,
    pub detail: Option<String>,
    pub replace: TextRange,
    pub source: CandidateSource,
    pub completable: bool,
}

/// Requests object IDs or labels from the application inventory for a parser-owned reference slot and edit template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectReferenceCompletionRequest {
    pub id: String,
    pub object_kind: ObjectReferenceKind,
    pub slot: crate::parser::analysis::SlotRef,
    pub frontier_sources: Vec<usize>,
    pub replace: TextRange,
    pub query: String,
    pub before_value: String,
    pub after_value: String,
}

/// Identifies the object inventory that supplies IDs or labels for a reference completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectReferenceKind {
    Blueprint,
}

/// Validation result for a full command submission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandValidationResponse {
    pub status: ParseStatus,
    pub furthest_pos: usize,
    pub expected_rules: Vec<String>,
    pub expected_tokens: Vec<String>,
    pub message: Option<String>,
}

/// Parses the active command segment and returns parser state, slot plans, and completion candidates for the cursor.
pub fn complete_command(input: &str, cursor: usize) -> CommandCompletionResponse {
    let input_len = input.len();
    let mut cursor = cursor.min(input_len);
    while !input.is_char_boundary(cursor) {
        cursor -= 1;
    }

    let statement_range = statement_range_at(input, cursor);
    let segment_start = statement_range.start;
    let segment_end = statement_range.end;

    let (replace_start, replace_end) =
        token_replace_bounds(input, cursor, segment_start, segment_end);
    let replace = TextRange {
        start: replace_start,
        end: replace_end,
    };

    let prefix_snapshot = parse_prefix(&input[segment_start..segment_end], cursor - segment_start);
    let mut slot_plan = build_slot_plan_with_snapshot(&prefix_snapshot);
    let mut composed = compose_candidates_with_snapshot(
        input,
        cursor,
        segment_start,
        replace,
        &prefix_snapshot,
        &slot_plan,
    );

    finalize_candidates_for_input(input, &mut composed.candidates);

    slot_plan.bind_candidates(&composed.candidates);

    CommandCompletionResponse {
        input_len,
        cursor,
        segment_start,
        segment_end,
        replace,
        parse: ParseSnapshot {
            status: match prefix_snapshot.status() {
                AnalysisParseStatus::Ok => ParseStatus::Ok,
                AnalysisParseStatus::Error => ParseStatus::Error,
            },
            furthest_pos: segment_start + prefix_snapshot.furthest_pos(),
            frontier: prefix_snapshot.frontier(),
            committed_clause_path: prefix_snapshot.committed_clause_path(),
            projected_clause_paths: prefix_snapshot.projected_clause_paths(),
        },
        slot_plan,
        object_reference_requests: object_reference_requests(
            input,
            cursor,
            &prefix_snapshot,
            &composed.candidates,
        ),
        candidates: composed.candidates,
    }
}

/// Validates a full command string and summarizes the nearest parse failure for the UI.
pub fn validate_command(input: &str) -> CommandValidationResponse {
    for range in statement_ranges(input) {
        let raw_segment = &input[range.start..range.end];
        let parser_segment = raw_segment.trim_start();
        if !parser_segment.trim().is_empty() {
            let leading_whitespace = raw_segment.len() - parser_segment.len();
            let trimmed_start = range.start + leading_whitespace;
            let response = validate_command_segment(input, trimmed_start, parser_segment);
            if response.status == ParseStatus::Error {
                return response;
            }
        }
    }

    if !split_command_statements(input).is_empty() {
        return CommandValidationResponse {
            status: ParseStatus::Ok,
            furthest_pos: input.len(),
            expected_rules: Vec::new(),
            expected_tokens: Vec::new(),
            message: None,
        };
    }

    validate_command_segment(input, 0, input)
}

/// Reports acceptance or the executed parser's expectations at the first invalid statement position.
fn validate_command_segment(
    input: &str,
    segment_start: usize,
    segment: &str,
) -> CommandValidationResponse {
    let snapshot = parse_prefix(segment, segment.len());
    if snapshot.completed_ast().is_some() {
        return CommandValidationResponse {
            status: ParseStatus::Ok,
            furthest_pos: segment_start + segment.len(),
            expected_rules: Vec::new(),
            expected_tokens: Vec::new(),
            message: None,
        };
    }

    let furthest_pos = segment_start + snapshot.furthest_pos().min(segment.len());
    let expected_rules = snapshot
        .diagnostic_expectations
        .iter()
        .map(|expectation| format!("{:?}", expectation.rule))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let expected_tokens = snapshot
        .diagnostic_expectations
        .iter()
        .flat_map(|expectation| &expectation.expected_tokens)
        .filter_map(crate::completion::composer::expected_token_insert_text)
        .filter(|token| !is_validation_noise_token(token))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let message = Some(format_validation_message(
        input[..furthest_pos].chars().count(),
        &expected_tokens,
        &expected_rules,
    ));
    CommandValidationResponse {
        status: ParseStatus::Error,
        furthest_pos,
        expected_rules,
        expected_tokens,
        message,
    }
}

/// Returns whether a candidate token is useful for autocomplete but noisy in validation diagnostics.
fn is_validation_noise_token(token: &str) -> bool {
    matches!(token, "+" | "-" | ">")
}

/// Applies display labels and cursor-aware insertion text to each composed candidate.
fn finalize_candidates_for_input(input: &str, candidates: &mut [CompletionCandidate]) {
    for candidate in candidates.iter_mut() {
        candidate.apply_text = completion_apply_text_for_candidate(
            input,
            candidate.replace.start,
            candidate.replace.end,
            &candidate.insert_text,
        );
    }
}

/// Builds a short user-facing error message from the Unicode character position and expected continuations.
fn format_validation_message(
    character_offset: usize,
    expected_tokens: &[String],
    expected_rules: &[String],
) -> String {
    let expected = expected_tokens.iter().take(3).cloned().collect::<Vec<_>>();
    let expected = if expected.is_empty() {
        expected_rules.iter().take(3).cloned().collect::<Vec<_>>()
    } else {
        expected
    };

    if expected.is_empty() {
        format!("Invalid command near character {}.", character_offset + 1)
    } else {
        format!(
            "Invalid command near character {}. Expected: {}.",
            character_offset + 1,
            expected.join(", ")
        )
    }
}

/// Projects address expectations into bounded requests for runtime values, using the same formatted edit as the placeholder.
fn object_reference_requests(
    input: &str,
    cursor: usize,
    snapshot: &crate::parser::analysis::CommandPrefixSnapshot<'_>,
    candidates: &[CompletionCandidate],
) -> Vec<ObjectReferenceCompletionRequest> {
    use crate::parser::analysis::{ContinuationTarget, ExpectedToken, ValueKind};
    let projected = snapshot.projected_expectations();
    candidates
        .iter()
        .filter_map(|candidate| {
            if candidate.expected != ExpectedToken::Placeholder(ValueKind::BlueprintAddress) {
                return None;
            }
            let source = projected.get(*candidate.frontier_sources.first()?)?;
            let ContinuationTarget::Slot(slot) = &source.expectation.target else {
                return None;
            };
            let (before, after) = candidate.apply_text.split_once(&candidate.insert_text)?;
            let raw_query = &input[candidate.replace.start
                ..cursor
                    .min(candidate.replace.end)
                    .max(candidate.replace.start)];
            let query = raw_query
                .strip_prefix('"')
                .unwrap_or(raw_query)
                .strip_suffix('"')
                .unwrap_or(raw_query.strip_prefix('"').unwrap_or(raw_query));
            Some(ObjectReferenceCompletionRequest {
                id: format!("object-reference-{}", candidate.id),
                object_kind: ObjectReferenceKind::Blueprint,
                slot: slot.clone(),
                frontier_sources: candidate.frontier_sources.clone(),
                replace: candidate.replace,
                query: query.to_owned(),
                before_value: before.to_owned(),
                after_value: after.to_owned(),
            })
        })
        .collect()
}
