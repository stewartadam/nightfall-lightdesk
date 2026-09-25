// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::branch_view::{
    clause_instances_in_order, clause_span, combined_span, merged_slot_span, slot_spans,
    sorted_tokens_for_spans, tokens_in_span,
};
use super::context::StrictBranchContext;
use super::*;

#[cfg(test)]
fn significant_tokens(tokens: &[LexerToken]) -> Vec<&LexerToken> {
    tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

fn selection_or_object_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        selection_or_object_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

fn parse_endpoint_word_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, &'i str)> {
    let first = tokens.first()?;
    matches!(first.kind, LexerTokenKind::Word | LexerTokenKind::Number).then_some(())?;
    let start = first.span.start;
    let mut end = first.span.end;
    let mut consumed = 1;

    while let Some(token) = tokens.get(consumed) {
        if !matches!(
            token.kind,
            LexerTokenKind::Word | LexerTokenKind::Number | LexerTokenKind::Minus
        ) || token.span.start != end
        {
            break;
        }
        end = token.span.end;
        consumed += 1;
    }

    Some((consumed, &command_str[start..end]))
}

pub(super) fn parse_patch_endpoint_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<PatchEndpointAst<'i>> {
    let [head, rest @ ..] = tokens else {
        return None;
    };

    if canonical_word(head, selection_or_object_alias_context()).as_deref()
        == Some(canonical_token_text(TokenId::Fixture))
    {
        let ids_end = (1..=rest.len()).rev().find(|&split| {
            parse_identifier_expression_from_tokens(command_str, &rest[..split]).is_some()
        })?;
        let ids = parse_identifier_expression_from_tokens(command_str, &rest[..ids_end])?;
        let target = parse_patch_fixture_target_from_tokens(command_str, &rest[ids_end..])?;
        return Some(PatchEndpointAst::Fixture(FixtureEndpointAst {
            _fixture: FixtureKeyword,
            ids,
            target,
        }));
    }

    if canonical_word(head, AliasCanonicalizationContext::default()).as_deref()
        == Some(canonical_token_text(TokenId::Console))
    {
        let (range, address) = parse_patch_universe_address_from_tokens(command_str, rest)?;
        return Some(PatchEndpointAst::Console(ConsoleEndpointAst {
            range,
            address,
        }));
    }

    if canonical_word(head, AliasCanonicalizationContext::default()).as_deref()
        == Some(canonical_token_text(TokenId::Disabled))
        && rest.is_empty()
    {
        return Some(PatchEndpointAst::Disabled(DisabledEndpointAst));
    }

    let (transport_len, transport) = parse_endpoint_word_from_tokens(command_str, tokens)?;
    let (range, address) =
        parse_patch_universe_address_from_tokens(command_str, &tokens[transport_len..])?;
    Some(PatchEndpointAst::Transport(TransportEndpointAst {
        transport: TransportNameAst(transport),
        range,
        address,
    }))
}

pub(super) fn parse_patch_modifiers_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(Option<PatchPriorityAst<'i>>, Option<PatchCloneAst>)> {
    let mut priority = None;
    let mut clone = None;
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens.get(index)?;
        if token.text.eq_ignore_ascii_case("/clone") {
            if clone.is_some() {
                return None;
            }
            clone = Some(PatchCloneAst);
            index += 1;
            continue;
        }

        let canonical =
            canonicalize_token(token.text.as_str(), AliasCanonicalizationContext::default());
        if canonical != "priority" && !token.text.eq_ignore_ascii_case("prio") {
            return None;
        }

        let value_end = match (tokens.get(index + 1), tokens.get(index + 2)) {
            (Some(next), _) if next.kind == LexerTokenKind::Number => index + 2,
            (Some(sign), Some(value))
                if matches!(sign.kind, LexerTokenKind::Plus | LexerTokenKind::Minus)
                    && value.kind == LexerTokenKind::Number =>
            {
                index + 3
            }
            _ => return None,
        };

        if priority.is_some() {
            return None;
        }
        let value = &tokens[index + 1..value_end];
        priority = Some(PatchPriorityAst {
            value: IntegerAst(trimmed_slice_for_tokens(command_str, value)?),
        });
        index = value_end;
    }

    Some((priority, clone))
}

fn parse_patch_universe_range_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, UniverseRangeAst<'i>)> {
    let [start, rest @ ..] = tokens else {
        return None;
    };
    (start.kind == LexerTokenKind::Number).then_some(())?;
    let start_ast = IntegerAst(&command_str[start.span.start..start.span.end]);

    if let [through, end, ..] = rest
        && through.kind == LexerTokenKind::GreaterThan
        && end.kind == LexerTokenKind::Number
    {
        return Some((
            3,
            UniverseRangeAst {
                start: start_ast,
                end: Some(IntegerAst(&command_str[end.span.start..end.span.end])),
            },
        ));
    }

    Some((
        1,
        UniverseRangeAst {
            start: start_ast,
            end: None,
        },
    ))
}

fn parse_patch_universe_address_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(Option<UniverseRangeAst<'i>>, Option<AddressAst<'i>>)> {
    if tokens.is_empty() {
        return Some((None, None));
    }

    let [colon, rest @ ..] = tokens else {
        return None;
    };
    (colon.kind == LexerTokenKind::Colon).then_some(())?;

    let (consumed, range) = parse_patch_universe_range_from_tokens(command_str, rest)?;
    let remaining = &rest[consumed..];

    let address = if remaining.is_empty() {
        None
    } else {
        let [dot, value] = remaining else {
            return None;
        };
        (dot.kind == LexerTokenKind::Dot && value.kind == LexerTokenKind::Number)
            .then_some(AddressAst {
                value: IntegerAst(&command_str[value.span.start..value.span.end]),
            })?
            .into()
    };

    Some((Some(range), address))
}

fn parse_patch_fixture_target_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<Option<FixtureTargetAst<'i>>> {
    if tokens.is_empty() {
        return Some(None);
    }

    let mut index = 0;
    let mut element = None;
    let mut param = None;

    // `break N` selects a whole additional DMX break of the fixture.
    if let [head, value] = tokens
        && head.text.eq_ignore_ascii_case("break")
        && value.kind == LexerTokenKind::Number
    {
        return Some(Some(FixtureTargetAst {
            element: None,
            param: None,
            dmx_break: Some(IntegerAst(&command_str[value.span.start..value.span.end])),
        }));
    }

    if let [dot, value, ..] = &tokens[index..]
        && dot.kind == LexerTokenKind::Dot
        && value.kind == LexerTokenKind::Number
    {
        element = Some(FixtureElementAst {
            index: IntegerAst(&command_str[value.span.start..value.span.end]),
        });
        index += 2;
    }

    if let [head, ..] = &tokens[index..]
        && canonical_word(head, AliasCanonicalizationContext::default()).as_deref() == Some("param")
    {
        let (consumed, name) = parse_endpoint_word_from_tokens(command_str, &tokens[index + 1..])?;
        param = Some(FixtureParamAst {
            name: WordAst(name),
        });
        index += 1 + consumed;
    }

    (index == tokens.len()).then_some(())?;
    if element.is_none() && param.is_none() {
        return None;
    }

    Some(Some(FixtureTargetAst {
        element,
        param,
        dmx_break: None,
    }))
}

#[cfg(test)]
fn split_target_and_modifiers<'a, 'i>(
    command_str: &'i str,
    tokens: &[&'a LexerToken],
    target_required: bool,
) -> Option<(
    Option<PatchEndpointAst<'i>>,
    Option<PatchPriorityAst<'i>>,
    Option<PatchCloneAst>,
)> {
    let min_target_len = usize::from(target_required);
    let mut fallback = None;
    for split in (min_target_len..=tokens.len()).rev() {
        let target = if split == 0 {
            None
        } else {
            match parse_patch_endpoint_from_tokens(command_str, &tokens[..split]) {
                Some(target) => Some(target),
                None => continue,
            }
        };
        if let Some((priority, clone)) =
            parse_patch_modifiers_from_tokens(command_str, &tokens[split..])
        {
            if priority.is_some() || clone.is_some() {
                return Some((target, priority, clone));
            }
            fallback.get_or_insert((target, priority, clone));
        }
    }
    fallback
}

#[cfg(test)]
pub(super) fn parse_patch_add_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    let significant = significant_tokens(tokens);
    let head = significant.first()?;
    if canonical_word(head, AliasCanonicalizationContext::default())?.as_str()
        != canonical_token_text(TokenId::Patch)
    {
        return None;
    }

    let body = &significant[1..];
    let at_index = body
        .iter()
        .position(|token| token.kind == LexerTokenKind::AtSign)?;
    if body[at_index + 1..]
        .iter()
        .any(|token| token.kind == LexerTokenKind::AtSign)
    {
        return None;
    }
    let source = parse_patch_endpoint_from_tokens(command_str, &body[..at_index])?;
    let (target, priority, clone) =
        split_target_and_modifiers(command_str, &body[at_index + 1..], true)?;

    Some(CommandAst::PatchAdd(PatchAddCommandAst {
        source,
        target: target?,
        priority,
        clone,
    }))
}

#[cfg(test)]
pub(super) fn parse_rm_patch_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    let significant = significant_tokens(tokens);
    let [head, patch, rest @ ..] = significant.as_slice() else {
        return None;
    };
    if canonical_word(head, AliasCanonicalizationContext::default())?.as_str()
        != canonical_token_text(TokenId::Rm)
        || canonical_word(patch, AliasCanonicalizationContext::default())?.as_str()
            != canonical_token_text(TokenId::Patch)
    {
        return None;
    }

    let at_index = rest
        .iter()
        .position(|token| token.kind == LexerTokenKind::AtSign);
    let (source, target, priority, clone) = if let Some(at_index) = at_index {
        if rest[at_index + 1..]
            .iter()
            .any(|token| token.kind == LexerTokenKind::AtSign)
        {
            return None;
        }
        let source = if at_index == 0 {
            None
        } else {
            Some(parse_patch_endpoint_from_tokens(
                command_str,
                &rest[..at_index],
            )?)
        };
        let (target, priority, clone) =
            split_target_and_modifiers(command_str, &rest[at_index + 1..], false)?;
        (source, target, priority, clone)
    } else {
        let mut parsed = None;
        for split in (0..=rest.len()).rev() {
            let source = if split == 0 {
                None
            } else {
                match parse_patch_endpoint_from_tokens(command_str, &rest[..split]) {
                    Some(source) => Some(source),
                    None => continue,
                }
            };
            if let Some((priority, clone)) =
                parse_patch_modifiers_from_tokens(command_str, &rest[split..])
            {
                parsed = Some((source, None, priority, clone));
                break;
            }
        }
        parsed?
    };

    Some(CommandAst::RmPatch(RmPatchCommandAst {
        source,
        target,
        priority,
        clone,
    }))
}

pub(super) fn materialize_patch_add_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let source_clause = clause_instances_in_order(ctx.branch, ClauseId::PatchSource)
        .into_iter()
        .next()?;
    let target_clause = clause_instances_in_order(ctx.branch, ClauseId::PatchTarget)
        .into_iter()
        .next()?;
    let source = parse_patch_endpoint_from_tokens(
        ctx.command_str,
        &tokens_in_span(ctx.tokens, clause_span(ctx.branch, &source_clause)?),
    )?;
    let mut target_tokens = tokens_in_span(ctx.tokens, clause_span(ctx.branch, &target_clause)?);
    if matches!(
        target_tokens.first().map(|token| token.kind),
        Some(LexerTokenKind::AtSign)
    ) {
        target_tokens.remove(0);
    }
    let target = parse_patch_endpoint_from_tokens(ctx.command_str, &target_tokens)?;
    let modifier_tokens = sorted_tokens_for_spans(
        ctx.tokens,
        &[
            slot_spans(ctx.branch, crate::slots::contracts::SlotId::PatchPriority),
            slot_spans(ctx.branch, crate::slots::contracts::SlotId::PatchClone),
        ]
        .concat(),
    );
    let (priority, clone) = parse_patch_modifiers_from_tokens(ctx.command_str, &modifier_tokens)
        .unwrap_or((None, None));

    Some(CommandAst::PatchAdd(PatchAddCommandAst {
        source,
        target,
        priority,
        clone,
    }))
}

pub(super) fn materialize_rm_patch_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let object_type_span =
        merged_slot_span(ctx.branch, crate::slots::contracts::SlotId::RmObjectType)?;
    if !ctx.command_str[object_type_span]
        .trim()
        .eq_ignore_ascii_case("patch")
    {
        return None;
    }

    let source = combined_span(
        &[
            slot_spans(
                ctx.branch,
                crate::slots::contracts::SlotId::PatchSourceEndpoint,
            ),
            slot_spans(
                ctx.branch,
                crate::slots::contracts::SlotId::PatchSourceUniverse,
            ),
            slot_spans(
                ctx.branch,
                crate::slots::contracts::SlotId::PatchSourceAddress,
            ),
        ]
        .concat(),
    )
    .and_then(|span| {
        parse_patch_endpoint_from_tokens(ctx.command_str, &tokens_in_span(ctx.tokens, span))
    });
    let target = merged_slot_span(
        ctx.branch,
        crate::slots::contracts::SlotId::PatchTargetEndpoint,
    )
    .and_then(|span| {
        let mut target_tokens = tokens_in_span(ctx.tokens, span);
        if matches!(
            target_tokens.first().map(|token| token.kind),
            Some(LexerTokenKind::AtSign)
        ) {
            target_tokens.remove(0);
        }
        parse_patch_endpoint_from_tokens(ctx.command_str, &target_tokens)
    });
    let modifier_tokens = sorted_tokens_for_spans(
        ctx.tokens,
        &[
            slot_spans(ctx.branch, crate::slots::contracts::SlotId::PatchPriority),
            slot_spans(ctx.branch, crate::slots::contracts::SlotId::PatchClone),
        ]
        .concat(),
    );
    let (priority, clone) = parse_patch_modifiers_from_tokens(ctx.command_str, &modifier_tokens)
        .unwrap_or((None, None));

    Some(CommandAst::RmPatch(RmPatchCommandAst {
        source,
        target,
        priority,
        clone,
    }))
}
