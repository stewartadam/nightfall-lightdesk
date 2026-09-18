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
fn selection_or_object_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        selection_or_object_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

fn action_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        action_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

#[cfg(test)]
fn significant_tokens(tokens: &[LexerToken]) -> Vec<&LexerToken> {
    tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

#[cfg(test)]
fn parse_object_action_command<'i, Action>(
    command_str: &'i str,
    tokens: &[LexerToken],
    expected_head: TokenId,
    parse_action: impl Fn(&'i str, &[&LexerToken]) -> Option<(usize, Action)>,
    build_command: impl Fn(SimpleIdentifierExpressionAst, Action) -> CommandAst<'i>,
) -> Option<CommandAst<'i>> {
    let significant = significant_tokens(tokens);
    let head = significant.first()?;
    if canonical_word(head, selection_or_object_alias_context())?.as_str()
        != canonical_token_text(expected_head)
    {
        return None;
    }

    let (action_start, action) = parse_action(command_str, &significant[1..])?;
    let identifier_tokens = &significant[1..1 + action_start];
    let identifier =
        parse_simple_identifier_expression_from_tokens(command_str, identifier_tokens)?;
    Some(build_command(identifier, action))
}

/// Interpret clip playback tokens as a supported transport action.
pub(super) fn parse_clip_action(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<(usize, PlaybackActionAst)> {
    let action = tokens.last()?;
    let action_index = tokens.len().checked_sub(1)?;

    if let Some(rate_index) = tokens.iter().position(|token| {
        canonical_word(token, AliasCanonicalizationContext::default())
            .is_some_and(|word| word.as_str() == canonical_token_text(TokenId::Rate))
    }) {
        let value = parse_decimal_value_from_tokens(command_str, &tokens[rate_index + 1..])?;
        return Some((rate_index, PlaybackActionAst::Rate(value.0.parse().ok()?)));
    }

    if action.kind == LexerTokenKind::Number {
        let keyword_index = tokens.len().checked_sub(2)?;
        let keyword = tokens.get(keyword_index)?;
        let keyword_name = canonical_word(keyword, AliasCanonicalizationContext::default())?;
        return match keyword_name.as_str() {
            canonical if canonical == canonical_token_text(TokenId::Goto) => Some((
                keyword_index,
                PlaybackActionAst::Goto(action.text.parse().ok()?),
            )),
            _ => None,
        };
    }

    let action_name = canonical_word(action, action_alias_context())?;

    match action_name.as_str() {
        canonical if canonical == canonical_token_text(TokenId::Start) => {
            Some((action_index, PlaybackActionAst::On))
        }
        canonical if canonical == canonical_token_text(TokenId::Stop) => {
            Some((action_index, PlaybackActionAst::Off))
        }
        canonical if canonical == canonical_token_text(TokenId::Go) => {
            Some((action_index, PlaybackActionAst::Go))
        }
        canonical if canonical == canonical_token_text(TokenId::Back) => {
            Some((action_index, PlaybackActionAst::Back))
        }
        _ => None,
    }
}

pub(super) fn parse_timecode_action(tokens: &[&LexerToken]) -> Option<(usize, TimecodeActionAst)> {
    let action_index = tokens.len().checked_sub(1)?;
    let action_name = canonical_word(
        tokens.get(action_index)?,
        AliasCanonicalizationContext::default(),
    )?;

    match action_name.as_str() {
        canonical if canonical == canonical_token_text(TokenId::Start) => {
            Some((action_index, TimecodeActionAst::Start))
        }
        canonical if canonical == canonical_token_text(TokenId::Pause) => {
            Some((action_index, TimecodeActionAst::Pause))
        }
        canonical if canonical == canonical_token_text(TokenId::Stop) => {
            Some((action_index, TimecodeActionAst::Stop))
        }
        _ => None,
    }
}

pub(super) fn parse_timeline_action(tokens: &[&LexerToken]) -> Option<(usize, StartStopAst)> {
    let action_index = tokens.len().checked_sub(1)?;
    let action_name = canonical_word(
        tokens.get(action_index)?,
        AliasCanonicalizationContext::default(),
    )?;

    match action_name.as_str() {
        canonical if canonical == canonical_token_text(TokenId::Start) => {
            Some((action_index, StartStopAst::Start))
        }
        canonical if canonical == canonical_token_text(TokenId::Stop) => {
            Some((action_index, StartStopAst::Stop))
        }
        _ => None,
    }
}

/// Parses lightweight clip commands such as `on`, `off`, and `goto`.
#[cfg(test)]
pub(super) fn parse_simple_clip_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    parse_simple_clip_command_from_tokens(command_str, &tokens)
}

#[cfg(test)]
pub(super) fn parse_simple_clip_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    parse_object_action_command(
        command_str,
        tokens,
        TokenId::Clip,
        parse_clip_action,
        |clip_id, action| {
            CommandAst::Clip(ClipCommandAst {
                _clip: ClipKeyword,
                clip_id,
                action,
            })
        },
    )
}

/// Parses lightweight timecode transport commands.
#[cfg(test)]
pub(super) fn parse_simple_timecode_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    parse_simple_timecode_command_from_tokens(command_str, &tokens)
}

#[cfg(test)]
pub(super) fn parse_simple_timecode_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    parse_object_action_command(
        command_str,
        tokens,
        TokenId::Timecode,
        |_, tokens| parse_timecode_action(tokens),
        |timecode_id, action| {
            CommandAst::Timecode(TimecodeCommandAst {
                _timecode: TimecodeKeyword,
                timecode_id,
                action,
            })
        },
    )
}

/// Parses lightweight timeline transport commands.
#[cfg(test)]
pub(super) fn parse_simple_timeline_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    parse_simple_timeline_command_from_tokens(command_str, &tokens)
}

#[cfg(test)]
pub(super) fn parse_simple_timeline_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    parse_object_action_command(
        command_str,
        tokens,
        TokenId::Timeline,
        |_, tokens| parse_timeline_action(tokens),
        |timeline_id, action| {
            CommandAst::Timeline(TimelineCommandAst {
                _timeline: TimelineKeyword,
                timeline_id,
                action,
            })
        },
    )
}

pub(super) fn materialize_clip_ast<'i>(ctx: StrictBranchContext<'i, '_>) -> Option<CommandAst<'i>> {
    let clip_id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::ClipIdentifier,
    )?;
    let (_, action) = parse_clip_action(
        ctx.command_str,
        &slot_tokens(
            ctx.tokens,
            ctx.branch,
            crate::slots::contracts::SlotId::ClipAction,
        ),
    )?;
    Some(CommandAst::Clip(ClipCommandAst {
        _clip: ClipKeyword,
        clip_id,
        action,
    }))
}

pub(super) fn materialize_timecode_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let timecode_id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::TimecodeIdentifier,
    )?;
    let (_, action) = parse_timecode_action(&slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::TimecodeAction,
    ))?;
    Some(CommandAst::Timecode(TimecodeCommandAst {
        _timecode: TimecodeKeyword,
        timecode_id,
        action,
    }))
}

pub(super) fn materialize_timeline_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let timeline_id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::TimelineIdentifier,
    )?;
    let (_, action) = parse_timeline_action(&slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::TimelineAction,
    ))?;
    Some(CommandAst::Timeline(TimelineCommandAst {
        _timeline: TimelineKeyword,
        timeline_id,
        action,
    }))
}
