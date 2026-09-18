// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::LexerToken;
use crate::parser::analysis::{ClauseInstance, ParseBranchState, TokenId};
use crate::parser::lexer::LexerTokenKind;
use crate::slots::contracts::{ClauseId, SlotId};

pub(super) fn merged_slot_span(
    branch: &ParseBranchState<'_>,
    slot: SlotId,
) -> Option<std::ops::Range<usize>> {
    let mut fills = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == slot);
    let first = fills.next()?;
    let mut start = first.source_span.start;
    let mut end = first.source_span.end;
    for fill in fills {
        start = start.min(fill.source_span.start);
        end = end.max(fill.source_span.end);
    }
    Some(start..end)
}

/// Collect tokens contained within the requested source span.
pub(super) fn tokens_in_span(
    tokens: &[LexerToken],
    span: std::ops::Range<usize>,
) -> Vec<&LexerToken> {
    tokens
        .iter()
        .filter(|token| {
            token.kind != LexerTokenKind::Whitespace
                && token.span.start >= span.start
                && token.span.end <= span.end
        })
        .collect()
}

pub(super) fn slot_tokens<'a>(
    tokens: &'a [LexerToken],
    branch: &ParseBranchState<'_>,
    slot: SlotId,
) -> Vec<&'a LexerToken> {
    merged_slot_span(branch, slot)
        .map(|span| tokens_in_span(tokens, span))
        .unwrap_or_default()
}

pub(super) fn tokens_for_spans<'a>(
    tokens: &'a [LexerToken],
    spans: &[std::ops::Range<usize>],
) -> Vec<&'a LexerToken> {
    spans
        .iter()
        .flat_map(|span| tokens_in_span(tokens, span.clone()))
        .collect()
}

pub(super) fn sorted_tokens_for_spans<'a>(
    tokens: &'a [LexerToken],
    spans: &[std::ops::Range<usize>],
) -> Vec<&'a LexerToken> {
    let mut spans = spans.to_vec();
    spans.sort_by_key(|span| span.start);
    tokens_for_spans(tokens, &spans)
}

pub(super) fn slot_spans_in_clause(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    slot: SlotId,
) -> Vec<std::ops::Range<usize>> {
    let mut spans = branch
        .consumed_items
        .iter()
        .filter(|item| item.clause == *clause && item.slot.slot == slot)
        .map(|item| item.source_span.start..item.source_span.end)
        .collect::<Vec<_>>();
    spans.sort_by_key(|span| (span.start, span.end));
    spans.dedup();
    spans
}

pub(super) fn slot_tokens_in_clause<'a>(
    tokens: &'a [LexerToken],
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    slot: SlotId,
) -> Vec<&'a LexerToken> {
    tokens_for_spans(tokens, &slot_spans_in_clause(branch, clause, slot))
}

pub(super) fn slot_spans(
    branch: &ParseBranchState<'_>,
    slot: SlotId,
) -> Vec<std::ops::Range<usize>> {
    let mut spans = branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == slot)
        .map(|item| item.source_span.start..item.source_span.end)
        .collect::<Vec<_>>();
    spans.sort_by_key(|span| (span.start, span.end));
    spans.dedup();
    spans
}

pub(super) fn merged_slot_span_without_prefix_tokens(
    command_str: &str,
    branch: &ParseBranchState<'_>,
    slot: SlotId,
    prefix_tokens: &[TokenId],
) -> Option<std::ops::Range<usize>> {
    let spans = slot_spans(branch, slot);
    let first_non_prefix = spans.iter().position(|span| {
        let surface = command_str[span.clone()].trim();
        !crate::lexicon::tokens::token_id_for_text(surface)
            .is_some_and(|token| prefix_tokens.contains(&token))
    })?;
    combined_span(&spans[first_non_prefix..])
}

pub(super) fn last_slot_span_matching(
    branch: &ParseBranchState<'_>,
    slot: SlotId,
    predicate: impl Fn(&crate::parser::analysis::ConsumedSemanticItem) -> bool,
) -> Option<std::ops::Range<usize>> {
    branch
        .consumed_items
        .iter()
        .filter(|item| item.slot.slot == slot)
        .filter(|item| predicate(item))
        .map(|item| item.source_span.start..item.source_span.end)
        .last()
}

pub(super) fn shifted_range(
    base: &std::ops::Range<usize>,
    local: std::ops::Range<usize>,
) -> std::ops::Range<usize> {
    (base.start + local.start)..(base.start + local.end)
}

pub(super) fn combined_span(spans: &[std::ops::Range<usize>]) -> Option<std::ops::Range<usize>> {
    let first = spans.first()?;
    let last = spans.last()?;
    Some(first.start..last.end)
}

pub(super) fn clause_instances_in_order(
    branch: &ParseBranchState<'_>,
    clause: ClauseId,
) -> Vec<ClauseInstance> {
    let mut nodes = branch
        .clause_tree
        .nodes
        .iter()
        .filter(|node| node.clause.clause == clause)
        .collect::<Vec<_>>();
    nodes.sort_by_key(|node| {
        (
            node.span.map(|span| span.start).unwrap_or(usize::MAX),
            node.occurrence,
            node.clause.instance,
        )
    });
    nodes.into_iter().map(|node| node.clause.clone()).collect()
}

pub(super) fn clause_span(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> Option<std::ops::Range<usize>> {
    branch
        .clause_tree
        .nodes
        .iter()
        .find(|node| node.clause == *clause)
        .and_then(|node| node.span.map(|span| span.start..span.end))
}

pub(super) fn child_clause_instances_in_order(
    branch: &ParseBranchState<'_>,
    parent_clause: &ClauseInstance,
    child_clause: ClauseId,
) -> Vec<ClauseInstance> {
    let Some(parent_index) = branch
        .clause_tree
        .nodes
        .iter()
        .position(|node| node.clause == *parent_clause)
    else {
        return Vec::new();
    };

    let mut nodes = branch
        .clause_tree
        .nodes
        .iter()
        .filter(|node| {
            node.parent == Some(crate::parser::analysis::ClauseNodeId(parent_index as u32))
                && node.clause.clause == child_clause
        })
        .collect::<Vec<_>>();
    nodes.sort_by_key(|node| {
        (
            node.span.map(|span| span.start).unwrap_or(usize::MAX),
            node.occurrence,
            node.clause.instance,
        )
    });
    nodes.into_iter().map(|node| node.clause.clone()).collect()
}
