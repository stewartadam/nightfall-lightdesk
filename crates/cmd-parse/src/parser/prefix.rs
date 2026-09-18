// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Prefix parse entry points.

use super::lexer::{LexerToken, LexerTokenKind, lex_command};
use super::strict::materialize_branch_ast;
use super::structural::execute_branches_from_tokens;
use crate::lexicon::aliases::canonical_token_has_alias_prefix;
use crate::lexicon::tokens::{canonical_text, token_id_for_text, top_level_command_heads};
use crate::parser::analysis::{
    ClauseExpectation, ClauseParseTree, CommandPrefixContext, CommandPrefixSnapshot,
    ContinuationKind, ContinuationTarget, ExpectedToken, GrammarRuleId, ParseBranchState,
    ParseCursor, ParseStatus, PathStatus, SlotRef, ValueKind,
};
use crate::slots::contracts::{ClauseId, SlotId};

/// Parses the command prefix up to the cursor and projects parser state for autocomplete.
pub fn parse_prefix<'i>(input: &'i str, cursor: usize) -> CommandPrefixSnapshot<'i> {
    let mut bounded_cursor = cursor.min(input.len());
    while !input.is_char_boundary(bounded_cursor) {
        bounded_cursor -= 1;
    }
    let prefix = &input[..bounded_cursor];

    let tokens = lex_command(prefix);
    let mut snapshot = parse_tokenized_prefix(prefix, &tokens);
    if !snapshot.context.has_trailing_whitespace {
        if let Some(token) = lex_command(input).iter().find(|token| {
            token.span.start == snapshot.context.active_token_start
                && token.span.end >= bounded_cursor
        }) {
            snapshot.context.active_token_end = token.span.end;
        }
    }
    snapshot
}

/// Executes the command grammar once, then materializes each fully consumed branch.
pub(crate) fn parse_tokenized_prefix<'i>(
    prefix: &'i str,
    tokens: &[LexerToken],
) -> CommandPrefixSnapshot<'i> {
    let context = build_prefix_context(tokens, prefix.len());
    let mut branches = build_structural_branches(tokens, &context, 0);
    if branches.is_empty() {
        branches.push(build_command_head_branch(
            tokens,
            &context,
            0,
            ParseStatus::Error,
        ));
    }
    let consumed_end = tokens
        .iter()
        .rfind(|token| token.kind != LexerTokenKind::Whitespace)
        .map_or(0, |token| token.span.end);
    for branch in &mut branches {
        let branch_end = branch.cursor.furthest_pos;
        branch.cursor.furthest_pos = if branch_end >= consumed_end {
            prefix.len()
        } else {
            tokens
                .iter()
                .find(|token| {
                    token.kind != LexerTokenKind::Whitespace && token.span.start >= branch_end
                })
                .map_or(branch_end, |token| token.span.start)
        };
        branch.ast = materialize_branch_ast(prefix, tokens, branch);
        branch.status = if branch.ast.is_some() {
            PathStatus::Completed
        } else {
            PathStatus::Live
        };
    }
    let furthest = branches
        .iter()
        .map(|branch| branch.cursor.furthest_pos)
        .max()
        .unwrap_or(0);
    let diagnostic_expectations = branches
        .iter()
        .filter(|branch| branch.cursor.furthest_pos == furthest)
        .flat_map(|branch| branch.frontier.iter().cloned())
        .collect();
    let replacement_branches = active_token_replacement_branches(prefix, &context);
    for branch in &mut branches {
        if branch.cursor.furthest_pos < consumed_end {
            if context.has_trailing_whitespace
                || branch.cursor.furthest_pos < context.active_token_start
            {
                branch.frontier.clear();
                continue;
            }
            for expectation in &mut branch.frontier {
                expectation.replace_active_token = true;
            }
        }
        if let Some(active) = context.active_token_text.as_deref() {
            for expectation in &mut branch.frontier {
                if expectation.replace_active_token {
                    expectation
                        .expected_tokens
                        .retain(|expected| expected_token_matches_active_text(expected, active));
                }
            }
            branch
                .frontier
                .retain(|expectation| !expectation.expected_tokens.is_empty());
        }
    }
    restrict_unitless_step_fx_duration_frontier(&mut branches);
    CommandPrefixSnapshot {
        context,
        branches,
        replacement_branches,
        diagnostic_expectations,
    }
}

/// Keeps autocomplete focused on duration units until a following attribute proves the duration complete.
fn restrict_unitless_step_fx_duration_frontier(branches: &mut [ParseBranchState<'_>]) {
    for branch in branches {
        let has_unitless_duration = branch.consumed_items.iter().any(|item| {
            item.slot.slot == SlotId::StepFxDuration && item.surface.parse::<f64>().is_ok()
        });
        let has_step_attribute = branch
            .consumed_items
            .iter()
            .any(|item| item.slot.slot == SlotId::StepFxStepAttribute);
        if !has_unitless_duration || has_step_attribute {
            continue;
        }
        branch.frontier.retain(|expectation| {
            !matches!(
                expectation.target,
                ContinuationTarget::Clause(ClauseId::StepFxStepDefinition)
            ) && !matches!(
                &expectation.target,
                ContinuationTarget::Slot(slot)
                    if matches!(slot.slot, SlotId::StepFxGroupsKeyword | SlotId::StepFxGroupsValue)
                        || slot.clause.as_ref().is_some_and(|clause| {
                            clause.clause == ClauseId::StepFxStepDefinition
                        })
            )
        });
    }
}

/// Build parser branches for the nonempty command prefix at the furthest cursor position.
fn build_structural_branches<'i>(
    tokens: &[LexerToken],
    context: &CommandPrefixContext,
    furthest_pos: usize,
) -> Vec<ParseBranchState<'i>> {
    if tokens
        .iter()
        .any(|token| token.kind != LexerTokenKind::Whitespace)
    {
        let branches = execute_branches_from_tokens(context, tokens, furthest_pos);
        if preserves_uncommitted_partial_head(tokens, context)
            && !branches
                .iter()
                .any(|branch| branch.status == PathStatus::Completed)
        {
            Vec::new()
        } else {
            branches
        }
    } else {
        Default::default()
    }
}

/// Retains the pre-token parser branches that can replace the active lexeme.
/// These branches describe edits only; they do not contribute consumed facts or command acceptance.
fn active_token_replacement_branches<'i>(
    prefix: &str,
    context: &CommandPrefixContext,
) -> Vec<ParseBranchState<'i>> {
    let Some(active) = context.active_token_text.as_deref() else {
        return Vec::new();
    };
    if context.has_trailing_whitespace || active.is_empty() {
        return Vec::new();
    }
    let before = &prefix[..context.active_token_start];
    let tokens = lex_command(before);
    let before_context = build_prefix_context(&tokens, before.len());
    let mut branches = build_structural_branches(&tokens, &before_context, 0);
    branches.retain(|branch| {
        branch.cursor.furthest_pos
            >= tokens
                .iter()
                .rfind(|token| token.kind != LexerTokenKind::Whitespace)
                .map_or(0, |token| token.span.end)
    });
    for branch in &mut branches {
        branch.ast = None;
        branch.status = PathStatus::Live;
        for expectation in &mut branch.frontier {
            expectation.replace_active_token = true;
            expectation
                .expected_tokens
                .retain(|expected| expected_token_matches_active_text(expected, active));
        }
        branch
            .frontier
            .retain(|expectation| !expectation.expected_tokens.is_empty());
    }
    branches.retain(|branch| !branch.frontier.is_empty());
    branches
}

/// Keeps an unfinished word at the command-head frontier until its spelling or whitespace commits it.
fn preserves_uncommitted_partial_head(
    tokens: &[LexerToken],
    context: &CommandPrefixContext,
) -> bool {
    let significant = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    significant.len() == 1
        && !context.has_trailing_whitespace
        && significant.first().is_some_and(|token| {
            let text = token.text.to_ascii_lowercase();
            token.kind == LexerTokenKind::Word
                && !top_level_command_heads().contains(&text.as_str())
                && (token_id_for_text(&text)
                    .and_then(crate::slots::contracts::root_clause_for_command_head)
                    .is_none()
                    || top_level_command_heads()
                        .iter()
                        .any(|head| head.starts_with(&text)))
        })
}

fn expected_token_matches_active_text(token: &ExpectedToken, active_token_text: &str) -> bool {
    let active_lower = active_token_text.to_ascii_lowercase();
    match token {
        ExpectedToken::Token(token_id) => canonical_text(*token_id).is_some_and(|canonical| {
            canonical.starts_with(&active_lower)
                || canonical_token_has_alias_prefix(canonical, &active_lower)
        }),
        ExpectedToken::Literal(literal) => literal.to_ascii_lowercase().starts_with(&active_lower),
        ExpectedToken::Placeholder(kind) => {
            if matches!(kind, ValueKind::Text | ValueKind::BlueprintAddress) {
                return !active_token_text.starts_with('$');
            }
            if *kind == ValueKind::ColorPathReference {
                return "path".starts_with(&active_lower)
                    || active_lower
                        .strip_prefix("path")
                        .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()));
            }
            if !active_token_text
                .chars()
                .all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.'))
            {
                return false;
            }
            matches!(
                kind,
                ValueKind::NumericDigit
                    | ValueKind::DurationValue
                    | ValueKind::IdentifierExpression
                    | ValueKind::DmxAddress
                    | ValueKind::ValueRange
            ) && active_token_text
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.'))
        }
    }
}

fn build_command_head_branch<'i>(
    tokens: &[LexerToken],
    context: &CommandPrefixContext,
    furthest_pos: usize,
    status: ParseStatus,
) -> ParseBranchState<'i> {
    let significant = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    let head_lexeme = significant.first().copied();
    let active_head = head_lexeme
        .filter(|_| significant.len() == 1 && !context.has_trailing_whitespace)
        .map(|token| token.text.to_ascii_lowercase());
    let expected_tokens = top_level_command_heads()
        .iter()
        .filter(|head| {
            active_head
                .as_deref()
                .is_none_or(|prefix| head.starts_with(prefix))
        })
        .filter_map(|head| token_id_for_text(head).map(ExpectedToken::Token))
        .collect::<Vec<_>>();

    ParseBranchState {
        cursor: ParseCursor {
            token_index: context.token_count,
            furthest_pos,
        },
        clause_stack: Vec::new(),
        clause_tree: ClauseParseTree::default(),
        clause_usage: Vec::new(),
        consumed_items: Vec::new(),
        status: if status == ParseStatus::Ok {
            PathStatus::Completed
        } else {
            PathStatus::Live
        },
        frontier: vec![ClauseExpectation {
            replace_active_token: false,
            target: ContinuationTarget::Slot(SlotRef {
                slot: SlotId::CommandHead,
                clause: None,
            }),
            continuation_kind: ContinuationKind::CommandHead,
            expected_tokens,
            rule: GrammarRuleId::Command,
        }],
        ast: None,
    }
}

/// Builds build prefix context for command parsing and completion.
fn build_prefix_context(
    tokens: &[super::lexer::LexerToken],
    cursor: usize,
) -> CommandPrefixContext {
    let has_trailing_whitespace = tokens
        .last()
        .is_some_and(|token| token.kind == LexerTokenKind::Whitespace);
    let non_whitespace_tokens = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    let token_count = non_whitespace_tokens.len();

    let active_token = if has_trailing_whitespace {
        None
    } else {
        non_whitespace_tokens.last().copied()
    };

    CommandPrefixContext {
        segment_start: 0,
        segment_end: cursor,
        cursor,
        token_count,
        active_token_start: active_token.map_or(cursor, |token| token.span.start),
        active_token_end: active_token.map_or(cursor, |token| token.span.end),
        has_trailing_whitespace,
        active_token_text: active_token.map(|token| token.text.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_prefix;
    use crate::parser::analysis::{ExpectedToken, ParseStatus, TokenId};
    use crate::parser::query::{
        expected_rules as snapshot_expected_rules, expected_tokens as snapshot_expected_tokens,
        projected_expectations as snapshot_projected_expectations,
    };
    use crate::slots::contracts::{ClauseId, SlotId};

    #[test]
    fn returns_ok_for_complete_prefix() {
        let snapshot = parse_prefix("fix 1 @ 50", "fix 1 @ 50".len());
        assert_eq!(snapshot.status(), ParseStatus::Ok);
        assert!(snapshot.completed_ast().is_some());
    }

    #[test]
    fn returns_error_for_incomplete_prefix() {
        let snapshot = parse_prefix("fix 1 @", "fix 1 @".len());
        assert_eq!(snapshot.status(), ParseStatus::Error);
        assert!(!snapshot_expected_rules(&snapshot).is_empty());
        assert!(!snapshot_expected_tokens(&snapshot).is_empty());
    }

    #[test]
    fn emits_qualifier_slot_for_store_filter() {
        let snapshot = parse_prefix(
            "store blueprint 9 filter red",
            "store blueprint 9 filter red".len(),
        );
        assert!(
            snapshot_projected_expectations(&snapshot)
                .iter()
                .any(|projected| {
                    matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                            if slot_ref.slot == SlotId::QualifierAttributeList
                    )
                }),
            "expected a qualifier-attribute frontier alternative",
        );
    }

    #[test]
    fn exact_heads_seed_structural_clip_action_frontier() {
        let snapshot = parse_prefix("clip 1 go", "clip 1 go".len());
        assert!(
            snapshot_projected_expectations(&snapshot)
                .iter()
                .any(|projected| {
                    (matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                            if slot_ref.slot == SlotId::ClipAction
                    ) || matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Clause(ClauseId::ClipAction)
                    )) && projected
                        .expectation
                        .expected_tokens
                        .iter()
                        .any(|token| matches!(token, ExpectedToken::Token(TokenId::Go)))
                }),
            "expected a clip action frontier alternative",
        );
    }

    #[test]
    fn fallback_does_not_emit_flow_action_for_unknown_action_token() {
        let snapshot = parse_prefix("flow 1 maybe", "flow 1 maybe".len());
        assert!(
            !snapshot
                .consumed_items()
                .iter()
                .any(|item| item.slot.slot == SlotId::FlowAction)
        );
    }

    #[test]
    fn reports_furthest_before_invalid_rm_object_type_token() {
        let input = "rm @ 0";
        let snapshot = parse_prefix(input, input.len());
        assert_eq!(snapshot.status(), ParseStatus::Error);
        assert!(snapshot.furthest_pos() < input.len());
        assert_eq!(snapshot.furthest_pos(), 3);
    }

    #[test]
    fn keeps_furthest_at_cursor_for_incomplete_but_completable_prefix() {
        let input = "fix 1 @";
        let snapshot = parse_prefix(input, input.len());
        assert_eq!(snapshot.status(), ParseStatus::Error);
        assert_eq!(snapshot.furthest_pos(), input.len());
    }

    #[test]
    fn exact_heads_preserve_dynamic_programmer_attribute_fills() {
        let input = "fix 311 zoom @ 100";
        let snapshot = parse_prefix(input, input.len());

        assert_eq!(snapshot.status(), ParseStatus::Ok);
        assert!(
            snapshot
                .committed_clause_path()
                .iter()
                .any(|clause| clause.clause == ClauseId::ProgrammerSetAttributeItem),
            "expected committed set-attribute clause for dynamic attribute fill",
        );
        assert!(
            snapshot.consumed_items().iter().any(|item| {
                item.slot.slot == SlotId::SetAttrAttribute
                    && item.surface.eq_ignore_ascii_case("zoom")
            }),
            "expected dynamic attribute slot fill",
        );
        assert!(
            snapshot.consumed_items().iter().any(|item| {
                item.slot.slot == SlotId::SetAttrValue && item.surface.trim() == "100"
            }),
            "expected value slot fill for dynamic attribute assignment",
        );
        assert!(
            snapshot_projected_expectations(&snapshot)
                .iter()
                .any(|projected| {
                    (matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                            if slot_ref.slot == SlotId::SetAttrAttribute
                    ) || matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Clause(
                            ClauseId::ProgrammerAttributeActions
                        )
                    )) && projected
                        .expectation
                        .expected_tokens
                        .iter()
                        .any(|token| matches!(token, ExpectedToken::Token(TokenId::Red)))
                }),
            "expected a programmer set-attribute frontier alternative",
        );
        assert!(
            snapshot_projected_expectations(&snapshot)
                .iter()
                .any(|projected| {
                    (matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                            if slot_ref.slot == SlotId::TimingsKeyword
                    ) || matches!(
                        projected.expectation.target,
                        crate::parser::analysis::ContinuationTarget::Clause(
                            ClauseId::ProgrammerTimings
                        )
                    )) && projected
                        .expectation
                        .expected_tokens
                        .iter()
                        .any(|token| matches!(token, ExpectedToken::Token(TokenId::Fade)))
                }),
            "expected a programmer timing frontier alternative",
        );
        assert!(
            !snapshot_projected_expectations(&snapshot)
                .iter()
                .any(|projected| matches!(
                    projected.expectation.target,
                    crate::parser::analysis::ContinuationTarget::Slot(ref slot_ref)
                        if slot_ref.slot == SlotId::StepFxStepAttribute
                )),
            "unexpected cross-family step-fx frontier alternative for programmer command",
        );
    }
}
