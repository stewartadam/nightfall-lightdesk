// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::branch_view::slot_tokens;
use super::context::StrictBranchContext;
use super::*;

#[cfg(test)]
fn significant_tokens(tokens: &[LexerToken]) -> Vec<&LexerToken> {
    tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

#[cfg(test)]
fn selection_or_object_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        selection_or_object_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

#[cfg(test)]
fn find_flow_action_index(tokens: &[&LexerToken]) -> Option<usize> {
    tokens.iter().position(|token| {
        canonical_word(token, AliasCanonicalizationContext::default()).is_some_and(|canonical| {
            let canonical = canonical.as_str();
            canonical == canonical_token_text(TokenId::Start)
                || canonical == canonical_token_text(TokenId::Stop)
                || canonical == canonical_token_text(TokenId::Go)
                || canonical == canonical_token_text(TokenId::Rm)
                || canonical == canonical_token_text(TokenId::Rename)
        })
    })
}

fn parse_flow_id(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<SimpleIdentifierExpressionAst> {
    parse_simple_identifier_expression_from_tokens(command_str, tokens)
}

pub(super) fn parse_flow_action_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<FlowActionAst> {
    let action = canonical_word(tokens.first()?, AliasCanonicalizationContext::default())?;

    match action.as_str() {
        canonical if canonical == canonical_token_text(TokenId::Start) && tokens.len() == 1 => {
            Some(FlowActionAst::Start)
        }
        canonical if canonical == canonical_token_text(TokenId::Stop) && tokens.len() == 1 => {
            Some(FlowActionAst::Stop)
        }
        canonical if canonical == canonical_token_text(TokenId::Go) && tokens.len() == 1 => {
            Some(FlowActionAst::Go)
        }
        canonical if canonical == canonical_token_text(TokenId::Rm) && tokens.len() == 1 => {
            Some(FlowActionAst::Delete)
        }
        canonical if canonical == canonical_token_text(TokenId::Rename) => {
            let target = parse_flow_id(command_str, &tokens[1..])?;
            Some(FlowActionAst::Rename(RenameFlowAst { to: target }))
        }
        _ => None,
    }
}

/// Parses lightweight flow commands such as `start`, `stop`, `go`, `delete`, and `rename`.
#[cfg(test)]
pub(super) fn parse_simple_flow_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    parse_simple_flow_command_from_tokens(command_str, &tokens)
}

#[cfg(test)]
pub(super) fn parse_simple_flow_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    let significant = significant_tokens(tokens);
    let head = significant.first()?;
    if canonical_word(head, selection_or_object_alias_context())?.as_str()
        != canonical_token_text(TokenId::Flow)
    {
        return None;
    }

    let action_index = find_flow_action_index(&significant[1..])? + 1;
    let flow_id = parse_flow_id(command_str, &significant[1..action_index])?;
    let action = parse_flow_action_from_tokens(command_str, &significant[action_index..])?;

    Some(CommandAst::Flow(FlowCommandAst {
        _flow: FlowKeyword,
        flow_id,
        action,
    }))
}

pub(super) fn materialize_flow_ast<'i>(ctx: StrictBranchContext<'i, '_>) -> Option<CommandAst<'i>> {
    let flow_id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::FlowIdentifier,
    )?;
    let action = parse_flow_action_from_tokens(
        ctx.command_str,
        &slot_tokens(
            ctx.tokens,
            ctx.branch,
            crate::slots::contracts::SlotId::FlowAction,
        ),
    )?;
    Some(CommandAst::Flow(FlowCommandAst {
        _flow: FlowKeyword,
        flow_id,
        action,
    }))
}
