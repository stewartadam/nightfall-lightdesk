// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Strict parse entry points.

#[cfg(test)]
use std::cmp::Reverse;

use super::lexer::{LexerToken, LexerTokenKind, lex_command};
#[cfg(test)]
use super::structural::execute_branches_from_tokens;
use crate::ast::{
    ActiveSelectionAttributeCommandAst, AttributeActionAst, AttributeActionsAst,
    AttributeCategoryAst, AttributeCommandAst, AttributeOverrideAst, AttributeTargetAst,
    AttributeValueSourceAst, AxisAst, AxisValueAst, BezierControlPointsAst, BlockCueCommandAst,
    BlockCueOperationAst, BlueprintAddressAst, BlueprintResolutionAst, BlueprintSourceAst,
    CreateStepFxAst, CurveNameAst, DelaysAst, FadesAst, FixturePlacementCommandAst, FxActionAst,
    FxAttributeStepsAst, FxCommandAst, FxKeyword, FxModuleActionAst, FxModuleCommandAst, FxStepAst,
    OffsetValueAst, ParameterValueMode, PlacementActionsAst, PositionActionAst, PositionValueAst,
    RotationActionAst, RotationValueAst, SetAttributeAst, SetFxRateAst, StoreBlueprintCommandAst,
    StoreClipCommandAst, StoreFixtureCommandAst, StoreFixtureOffsetCommandAst, StoreFlowCommandAst,
    StoreStepFxCommandAst, StoreTimecodeCommandAst, StoreTimelineCommandAst, TimingClauseAst,
    TimingDirectionAst, TimingsAst, TupleValueAst, ValueMarkerAst, ValueRangeAst,
};
use crate::ast::{
    AddressAst, AstError, AttributeAliasAst, AttributeKeyword, AttributeQualifierAst,
    AttributeTypeAst, ChannelCommandAst, ChannelKeyword, ClearAttributeTargetAst, ClearCommandAst,
    ClearFixtureTargetAst, ClearSelectionAst, ClearSpanFilterAst, ClearTargetAst, ClearValuesAst,
    ClipCommandAst, ClipKeyword, CommandAst, ConsoleEndpointAst, CueKeyword, CueRefAst,
    DebugCommandAst, DeleteCommandAst, DeleteCueCommandAst, DisabledEndpointAst,
    DmxChannelExpressionAst, DmxChannelGroupedAst, DmxChannelOpTermAst, DmxChannelRangeAst,
    DmxChannelRefAst, DmxChannelSingleAst, DmxChannelTermAst, DuplicateColorPathCommandAst,
    DurationUnitAst, DurationValueAst, ElementSelectorAst, FixtureElementAst, FixtureEndpointAst,
    FixtureKeyword, FixtureMapAst, FixtureParamAst, FixtureRangeAst, FixtureSelectionAst,
    FixtureTargetAst, FlowKeyword, GeneralCommandAst, GroupKeyword, GroupedExprAst, HelpCommandAst,
    IdentifierExpressionAst, IntegerAst, LoadCommandAst, LogCommandAst, LogCommandsAst,
    LogFilterCommandAst, LogFilterCommandsAst, LogFixtureCommandAst, LogLevelAst,
    LogLevelCommandAst, NewShowfileCommandAst, ObjectTypeAst, OpTermAst, PatchAddCommandAst,
    PatchCloneAst, PatchEndpointAst, PatchPriorityAst, PlaybackActionAst, QuitCommandAst, RangeAst,
    RecallBlueprintCommandAst, RecallCueCommandAst, RedoCommandAst, ReleaseAttributeTargetAst,
    ReleaseChannelKeyword, ReleaseCommandAst, ReleaseDmxChannelExpressionAst,
    ReleaseDmxChannelGroupedAst, ReleaseDmxChannelOpTermAst, ReleaseDmxChannelRangeAst,
    ReleaseDmxChannelRefAst, ReleaseDmxChannelSingleAst, ReleaseDmxChannelTermAst,
    ReleaseDmxTargetAst, ReleaseFixtureTargetAst, ReleaseTargetAst, RenameCommandAst,
    RenameCueCommandAst, RenameFlowAst, RmPatchCommandAst, SaveCommandAst, SelectionArgumentAst,
    SelectionAst, SelectionCommandAst, SelectionTypeAst, SetCueColorPathCommandAst,
    SetFixtureColorPathCommandAst, SetFpsCommandAst, SetObjectPropertyAst,
    SetObjectPropertyCommandAst, SetObjectPropertyTargetAst, SetObjectTargetTypeAst,
    SetOperatorAst, SetSpanFilterAst, SimpleGroupedExprAst, SimpleIdAst,
    SimpleIdentifierExpressionAst, SimpleOpTermAst, SimpleRangeAst, SimpleTermAst, SingleIdAst,
    SleepCommandAst, SpanFieldNameAst, SpanFieldValueAst, StartStopAst, StoreColorPathCommandAst,
    StoreCueCommandAst, StoreCueModeAst, StoreCueTargetAst, StoreGroupCommandAst, TargetAst,
    TermAst, TimecodeActionAst, TimecodeCommandAst, TimecodeKeyword, TimelineCommandAst,
    TimelineKeyword, TransportEndpointAst, TransportNameAst, UndoCommandAst, UniverseRangeAst,
    ValueAst, WordAst,
};
use crate::ast::{BlueprintKeyword, FlowActionAst, FlowCommandAst, QuotedStringAst};
use crate::ast::{
    FxModuleConfigClauseAst, FxModuleConfigEntryAst, FxModuleMergeFlagAst,
    FxModuleSelectionClauseAst, FxModuleStorePartAst, StoreFxModuleCommandAst,
};
use crate::command_family::{StructuralAstDispatchKind, command_family_for_root_clause};
use crate::lexicon::aliases::{AliasCanonicalizationContext, canonicalize_token};
#[cfg(test)]
use crate::parser::analysis::CommandPrefixContext;
use crate::parser::analysis::{PathStatus, TokenId};
use crate::parser::parse_specs::{
    AttributeParseSpecId, attribute_parse_spec, validate_attribute_surface,
};
use crate::selection_language::parse_spatial_selection_text;
use crate::slots::contracts::ClauseId;

mod branch_view;
mod context;
mod flow;
mod fx;
mod general;
mod patch;
mod programmer;
mod shared;
mod transport;

use self::branch_view::slot_tokens;
use self::context::StrictBranchContext;
use self::shared::{
    parse_attribute_type_from_tokens, parse_attribute_types_from_tokens,
    parse_duration_range_from_tokens, parse_fixture_selection_from_tokens,
    parse_object_type_from_tokens, parse_selection_argument_from_tokens,
    parse_selection_from_tokens, parse_value_range_from_tokens_with_mode,
};

fn canonical_token_text(token_id: TokenId) -> &'static str {
    crate::lexicon::tokens::canonical_text(token_id).expect("missing canonical token text")
}

fn canonical_word(token: &LexerToken, context: AliasCanonicalizationContext) -> Option<String> {
    (token.kind == LexerTokenKind::Word).then(|| canonicalize_token(token.text.as_str(), context))
}

/// Parses one Blueprint ID or label while reserving `$` for future expression syntax.
fn parse_blueprint_address_from_token<'i>(
    command_str: &'i str,
    token: &LexerToken,
) -> Option<BlueprintAddressAst<'i>> {
    match token.kind {
        LexerTokenKind::Number => Some(BlueprintAddressAst::Id(token.text.parse().ok()?)),
        LexerTokenKind::QuotedString
            if token.text.starts_with('"') && token.text.ends_with('"') =>
        {
            Some(BlueprintAddressAst::Label(
                &command_str[token.span.start + 1..token.span.end - 1],
            ))
        }
        LexerTokenKind::Word if !token.text.starts_with('$') => Some(BlueprintAddressAst::Label(
            &command_str[token.span.start..token.span.end],
        )),
        _ => None,
    }
}

/// Parses a Blueprint keyword and address, followed by an optional source-local resolution flag.
fn parse_blueprint_source_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, BlueprintSourceAst<'i>)> {
    let [keyword, address, rest @ ..] = tokens else {
        return None;
    };
    let canonical = canonical_word(
        keyword,
        AliasCanonicalizationContext {
            selection_or_object_context: true,
            ..AliasCanonicalizationContext::default()
        },
    )?;
    if canonical != canonical_token_text(TokenId::Blueprint) {
        return None;
    }
    let address = parse_blueprint_address_from_token(command_str, address)?;
    let (resolution, modifier_len) = match rest.first() {
        Some(modifier) if modifier.text.eq_ignore_ascii_case("/absolute") => {
            (BlueprintResolutionAst::Absolute, 1)
        }
        _ => (BlueprintResolutionAst::Reference, 0),
    };
    Some((
        2 + modifier_len,
        BlueprintSourceAst {
            address,
            resolution,
        },
    ))
}

fn parse_duration_value_slice(input: &str) -> Option<ParsedDurationValue> {
    let lowered = input.trim().to_ascii_lowercase();
    let bytes = lowered.as_bytes();
    if bytes.is_empty() {
        return None;
    }

    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let integer_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == integer_start {
        return None;
    }
    if matches!(bytes.get(index), Some(b'.')) {
        index += 1;
        let fraction_start = index;
        while matches!(bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
    }

    let value = 0..index;
    while matches!(bytes.get(index), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        index += 1;
    }
    let unit = if index == bytes.len() {
        None
    } else {
        let unit_surface = &lowered[index..];
        Some(match unit_surface {
            "seconds" | "sec" | "ms" | "bpm" | "hz" | "s" | "%" => index..bytes.len(),
            _ => return None,
        })
    };

    Some(ParsedDurationValue { value, unit })
}

fn significant_token_refs<'a>(tokens: &[&'a LexerToken]) -> Vec<&'a LexerToken> {
    tokens
        .iter()
        .copied()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

fn parse_u32_token(token: &LexerToken) -> Option<u32> {
    (token.kind == LexerTokenKind::Number)
        .then(|| token.text.as_str().parse().ok())
        .flatten()
}

fn is_range_separator(token: &LexerToken) -> bool {
    token.kind == LexerTokenKind::GreaterThan
        || (token.kind == LexerTokenKind::Word
            && canonical_word(
                token,
                AliasCanonicalizationContext {
                    identifier_context: true,
                    ..AliasCanonicalizationContext::default()
                },
            )
            .is_some_and(|canonical| canonical == ">"))
}

fn parse_simple_id_from_token_refs(tokens: &[&LexerToken]) -> Option<(usize, SimpleIdAst)> {
    let [token, ..] = tokens else {
        return None;
    };
    Some((
        1,
        SimpleIdAst {
            id: parse_u32_token(token)?,
        },
    ))
}

fn parse_simple_term_from_token_refs(tokens: &[&LexerToken]) -> Option<(usize, SimpleTermAst)> {
    let [token, ..] = tokens else {
        return None;
    };

    if token.kind == LexerTokenKind::LeftParen {
        let mut depth = 1usize;
        for (index, token) in tokens.iter().enumerate().skip(1) {
            match token.kind {
                LexerTokenKind::LeftParen => depth += 1,
                LexerTokenKind::RightParen => {
                    depth -= 1;
                    if depth == 0 {
                        let expr =
                            parse_simple_identifier_expression_from_token_refs(&tokens[1..index])?;
                        return Some((
                            index + 1,
                            SimpleTermAst::Grouped(SimpleGroupedExprAst {
                                expr: Box::new(expr),
                            }),
                        ));
                    }
                }
                _ => {}
            }
        }
        return None;
    }

    let (start_len, start) = parse_simple_id_from_token_refs(tokens)?;
    if let [through, rest @ ..] = &tokens[start_len..]
        && is_range_separator(through)
    {
        let (end_len, end) = parse_simple_id_from_token_refs(rest)?;
        return Some((
            start_len + 1 + end_len,
            SimpleTermAst::Range(SimpleRangeAst { start, end }),
        ));
    }

    Some((start_len, SimpleTermAst::Single(start)))
}

fn parse_simple_identifier_expression_from_token_refs(
    tokens: &[&LexerToken],
) -> Option<SimpleIdentifierExpressionAst> {
    let (head_len, head) = parse_simple_term_from_token_refs(tokens)?;
    let mut consumed = head_len;
    let mut tail = Vec::new();

    while consumed < tokens.len() {
        let op = match tokens.get(consumed)?.kind {
            LexerTokenKind::Plus => SetOperatorAst::Add,
            LexerTokenKind::Minus => SetOperatorAst::Remove,
            _ => return None,
        };
        let (term_len, term) = parse_simple_term_from_token_refs(&tokens[consumed + 1..])?;
        tail.push(SimpleOpTermAst { op, term });
        consumed += 1 + term_len;
    }

    Some(SimpleIdentifierExpressionAst { head, tail })
}

fn parse_fixture_range_from_token_refs(tokens: &[&LexerToken]) -> Option<(usize, FixtureRangeAst)> {
    let [start, rest @ ..] = tokens else {
        return None;
    };
    let start = parse_u32_token(start)?;
    if let [through, end, ..] = rest
        && is_range_separator(through)
    {
        return Some((
            3,
            FixtureRangeAst {
                start,
                end: parse_u32_token(end)?,
            },
        ));
    }
    Some((1, FixtureRangeAst { start, end: start }))
}

fn parse_element_selector_from_token_refs(
    tokens: &[&LexerToken],
) -> Option<(usize, ElementSelectorAst)> {
    let [first, rest @ ..] = tokens else {
        return None;
    };

    if first.kind == LexerTokenKind::LeftParen {
        let [_, start, through, end, close, ..] = tokens else {
            return None;
        };
        (through.kind == LexerTokenKind::GreaterThan && close.kind == LexerTokenKind::RightParen)
            .then_some(())?;
        return Some((
            5,
            ElementSelectorAst::Range {
                start: parse_u32_token(start)?,
                end: parse_u32_token(end)?,
            },
        ));
    }

    let start = parse_u32_token(first)?;
    if let [through, end, ..] = rest
        && is_range_separator(through)
    {
        return Some((
            3,
            ElementSelectorAst::Range {
                start,
                end: parse_u32_token(end)?,
            },
        ));
    }

    Some((1, ElementSelectorAst::Single(start)))
}

fn parse_single_id_ast_from_token_refs(tokens: &[&LexerToken]) -> Option<(usize, SingleIdAst)> {
    let [fixture_id, rest @ ..] = tokens else {
        return None;
    };
    let fixture_id = parse_u32_token(fixture_id)?;
    if let [dot, element_index, ..] = rest
        && dot.kind == LexerTokenKind::Dot
    {
        return Some((
            3,
            SingleIdAst {
                target: TargetAst::ElementRef {
                    fixture_id,
                    element_index: Some(parse_u32_token(element_index)?),
                },
            },
        ));
    }

    Some((
        1,
        SingleIdAst {
            target: TargetAst::FixtureRef { fixture_id },
        },
    ))
}

fn parse_identifier_term_from_token_refs(tokens: &[&LexerToken]) -> Option<(usize, TermAst)> {
    let [token, ..] = tokens else {
        return None;
    };

    if token.kind == LexerTokenKind::LeftParen {
        let mut depth = 1usize;
        for (index, token) in tokens.iter().enumerate().skip(1) {
            match token.kind {
                LexerTokenKind::LeftParen => depth += 1,
                LexerTokenKind::RightParen => {
                    depth -= 1;
                    if depth == 0 {
                        let expr = parse_identifier_expression_from_token_refs(&tokens[1..index])?;
                        return Some((
                            index + 1,
                            TermAst::Grouped(GroupedExprAst {
                                expr: Box::new(expr),
                            }),
                        ));
                    }
                }
                _ => {}
            }
        }
        return None;
    }

    if let Some((fixture_len, fixtures)) = parse_fixture_range_from_token_refs(tokens) {
        if let [dot, ..] = &tokens[fixture_len..]
            && dot.kind == LexerTokenKind::Dot
            && (dot.span.start > tokens[fixture_len - 1].span.end
                || matches!(
                    tokens.get(fixture_len + 1).map(|token| token.kind),
                    Some(LexerTokenKind::LeftParen)
                ))
            && let Some((elements_len, elements)) =
                parse_element_selector_from_token_refs(&tokens[fixture_len + 1..])
        {
            return Some((
                fixture_len + 1 + elements_len,
                TermAst::FixtureMap(FixtureMapAst { fixtures, elements }),
            ));
        }
    }

    let (start_len, start) = parse_single_id_ast_from_token_refs(tokens)?;
    if let [through, rest @ ..] = &tokens[start_len..]
        && is_range_separator(through)
    {
        let (end_len, end) = parse_single_id_ast_from_token_refs(rest)?;
        return Some((
            start_len + 1 + end_len,
            TermAst::Range(RangeAst { start, end }),
        ));
    }

    Some((start_len, TermAst::Single(start)))
}

fn parse_identifier_expression_from_token_refs(
    tokens: &[&LexerToken],
) -> Option<IdentifierExpressionAst> {
    let (head_len, head) = parse_identifier_term_from_token_refs(tokens)?;
    let mut consumed = head_len;
    let mut tail = Vec::new();

    while consumed < tokens.len() {
        let op = match tokens.get(consumed)?.kind {
            LexerTokenKind::Plus => SetOperatorAst::Add,
            LexerTokenKind::Minus => SetOperatorAst::Remove,
            _ => return None,
        };
        let (term_len, term) = parse_identifier_term_from_token_refs(&tokens[consumed + 1..])?;
        tail.push(OpTermAst { op, term });
        consumed += 1 + term_len;
    }

    Some(IdentifierExpressionAst { head, tail })
}

fn slice_for_tokens<'i>(command_str: &'i str, tokens: &[&LexerToken]) -> Option<&'i str> {
    let start = tokens.first()?.span.start;
    let end = tokens.last()?.span.end;
    Some(&command_str[start..end])
}

fn trimmed_slice_for_tokens<'i>(command_str: &'i str, tokens: &[&LexerToken]) -> Option<&'i str> {
    let slice = slice_for_tokens(command_str, tokens)?.trim();
    (!slice.is_empty()).then_some(slice)
}

pub(crate) fn exact_decimal_surface(input: &str) -> bool {
    let bytes = input.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let integer_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == integer_start {
        return false;
    }
    if matches!(bytes.get(index), Some(b'.')) {
        index += 1;
        let fraction_start = index;
        while matches!(bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
        }
        if index == fraction_start {
            return false;
        }
    }
    index == bytes.len()
}

fn exact_offset_surface(input: &str) -> bool {
    if let Some(percentless) = input.strip_suffix('%') {
        return exact_decimal_surface(percentless);
    }
    exact_decimal_surface(input)
}

fn parse_simple_identifier_expression_from_tokens(
    _command_str: &str,
    tokens: &[&LexerToken],
) -> Option<SimpleIdentifierExpressionAst> {
    let tokens = significant_token_refs(tokens);
    (!tokens.is_empty())
        .then(|| parse_simple_identifier_expression_from_token_refs(&tokens))
        .flatten()
}

fn parse_identifier_expression_from_tokens(
    _command_str: &str,
    tokens: &[&LexerToken],
) -> Option<IdentifierExpressionAst> {
    let tokens = significant_token_refs(tokens);
    (!tokens.is_empty())
        .then(|| parse_identifier_expression_from_token_refs(&tokens))
        .flatten()
}

fn parse_single_id_from_tokens(_command_str: &str, tokens: &[&LexerToken]) -> Option<SingleIdAst> {
    let tokens = significant_token_refs(tokens);
    match tokens.as_slice() {
        [fixture_id] => Some(SingleIdAst {
            target: TargetAst::FixtureRef {
                fixture_id: parse_u32_token(fixture_id)?,
            },
        }),
        [fixture_id, dot, element_index] if dot.kind == LexerTokenKind::Dot => Some(SingleIdAst {
            target: TargetAst::ElementRef {
                fixture_id: parse_u32_token(fixture_id)?,
                element_index: Some(parse_u32_token(element_index)?),
            },
        }),
        _ => None,
    }
}

fn parse_cue_ref_from_tokens(_command_str: &str, tokens: &[&LexerToken]) -> Option<CueRefAst> {
    let tokens = significant_token_refs(tokens);
    match tokens.as_slice() {
        [sequence_id, dot, cue_id] if dot.kind == LexerTokenKind::Dot => Some(CueRefAst {
            sequence_id: parse_u32_token(sequence_id)?,
            cue_id: parse_u32_token(cue_id)?,
        }),
        _ => None,
    }
}

fn parse_cue_part_ref_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<(CueRefAst, Option<u32>)> {
    let tokens = significant_token_refs(tokens);
    let surface = trimmed_slice_for_tokens(command_str, &tokens)?;
    parse_cue_part_ref_surface(surface)
        .or_else(|| parse_cue_ref_from_tokens(command_str, &tokens).map(|cue_ref| (cue_ref, None)))
}

fn parse_cue_part_ref_surface(raw: &str) -> Option<(CueRefAst, Option<u32>)> {
    let value = raw
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let bytes = value.as_bytes();
    let mut index = 0usize;

    let sequence_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == sequence_start || !matches!(bytes.get(index), Some(b'.')) {
        return None;
    }
    let sequence_id = value[sequence_start..index].parse::<u32>().ok()?;

    index += 1;
    let cue_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == cue_start {
        return None;
    }
    let cue_id = value[cue_start..index].parse::<u32>().ok()?;

    let part_id = if index == bytes.len() {
        None
    } else {
        if !matches!(bytes.get(index), Some(b'p' | b'P')) {
            return None;
        }
        index += 1;
        let part_start = index;
        while matches!(bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
        }
        if index == part_start || index != bytes.len() {
            return None;
        }
        Some(value[part_start..index].parse::<u32>().ok()?)
    };

    Some((
        CueRefAst {
            sequence_id,
            cue_id,
        },
        part_id,
    ))
}

/// Parses a store cue mode flag from a single token.
fn parse_store_cue_mode_token(token: &LexerToken) -> Option<StoreCueModeAst> {
    match token.text.to_ascii_lowercase().as_str() {
        "/merge" => Some(StoreCueModeAst::Merge),
        "/update" => Some(StoreCueModeAst::Update),
        "/remove" => Some(StoreCueModeAst::Remove),
        _ => None,
    }
}

/// Parses whether a token is the recall cue select flag.
fn parse_recall_cue_select_token(token: &LexerToken) -> bool {
    token.text.eq_ignore_ascii_case("/select")
}

/// Parses a store cue target, including append-style cue and part targets.
fn parse_store_cue_target_surface(raw: &str) -> Option<StoreCueTargetAst> {
    let value = raw
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let bytes = value.as_bytes();
    let mut index = 0usize;

    let sequence_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == sequence_start || !matches!(bytes.get(index), Some(b'.')) {
        return None;
    }
    let sequence_id = value[sequence_start..index].parse::<u32>().ok()?;

    index += 1;
    if matches!(bytes.get(index), Some(b'(')) {
        let cue_surface = &value[index..];
        let cue_tokens = lex_command(cue_surface);
        let cue_token_refs = cue_tokens.iter().collect::<Vec<_>>();
        let cue_ids = parse_simple_identifier_expression_from_tokens(cue_surface, &cue_token_refs)?;
        return Some(StoreCueTargetAst::Cues {
            sequence_id,
            cue_ids,
        });
    }
    let cue_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == cue_start {
        return (index == bytes.len()).then_some(StoreCueTargetAst::NextCue { sequence_id });
    }
    let cue_ref = CueRefAst {
        sequence_id,
        cue_id: value[cue_start..index].parse::<u32>().ok()?,
    };

    if index == bytes.len() {
        return Some(StoreCueTargetAst::Cue(cue_ref));
    }

    if !matches!(bytes.get(index), Some(b'p' | b'P')) {
        return None;
    }
    index += 1;
    let part_start = index;
    while matches!(bytes.get(index), Some(b'0'..=b'9')) {
        index += 1;
    }
    if index == part_start {
        return (index == bytes.len()).then_some(StoreCueTargetAst::NextPart { cue_ref });
    }
    (index == bytes.len()).then_some(StoreCueTargetAst::CuePart {
        cue_ref,
        part_id: value[part_start..index].parse::<u32>().ok()?,
    })
}

/// Parses a store cue target and optional mode flag from tokenized input.
fn parse_store_cue_target_and_mode_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<(StoreCueTargetAst, StoreCueModeAst)> {
    let tokens = significant_token_refs(tokens);
    let (target_tokens, mode) = match tokens.split_last() {
        Some((last, leading)) => {
            if let Some(mode) = parse_store_cue_mode_token(last) {
                (leading, mode)
            } else {
                (tokens.as_slice(), StoreCueModeAst::Replace)
            }
        }
        None => return None,
    };
    let surface = trimmed_slice_for_tokens(command_str, target_tokens)?;
    Some((parse_store_cue_target_surface(surface)?, mode))
}

fn parse_optional_cue_part_ref_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<(CueRefAst, Option<u32>)> {
    match tokens
        .first()
        .and_then(|token| canonical_word(token, AliasCanonicalizationContext::default()))
    {
        Some(head) if head == canonical_token_text(TokenId::Cue) => {
            parse_cue_part_ref_from_tokens(command_str, &tokens[1..])
        }
        _ => parse_cue_part_ref_from_tokens(command_str, tokens),
    }
}

/// Parses a recall cue target and optional select flag from tokenized input.
fn parse_recall_cue_target_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<(CueRefAst, Option<u32>, bool)> {
    let tokens = significant_token_refs(tokens);
    let (target_tokens, select) = match tokens.split_last() {
        Some((last, leading)) if parse_recall_cue_select_token(last) => (leading, true),
        Some(_) => (tokens.as_slice(), false),
        None => return None,
    };
    let (cue_ref, part_id) = parse_optional_cue_part_ref_from_tokens(command_str, target_tokens)?;
    Some((cue_ref, part_id, select))
}

fn parse_decimal_value_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<ValueAst<'i>> {
    let surface = trimmed_slice_for_tokens(command_str, tokens)?;
    exact_decimal_surface(surface).then_some(ValueAst(surface))
}

/// Parses a symbolic attribute marker value from tokenized input.
fn parse_value_marker_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<ValueAst<'i>> {
    let surface = trimmed_slice_for_tokens(command_str, tokens)?;
    ValueMarkerAst::parse(surface).map(|_| ValueAst(surface))
}

fn parse_offset_value_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<OffsetValueAst<'i>> {
    let surface = trimmed_slice_for_tokens(command_str, tokens)?;
    exact_offset_surface(surface).then_some(OffsetValueAst(surface))
}

fn parse_slot_identifier_expression_from_tokens(
    command_str: &str,
    tokens: &[LexerToken],
    branch: &crate::parser::analysis::ParseBranchState<'_>,
    slot: crate::slots::contracts::SlotId,
) -> Option<SimpleIdentifierExpressionAst> {
    parse_simple_identifier_expression_from_tokens(command_str, &slot_tokens(tokens, branch, slot))
}

fn parse_u16_token(token: &LexerToken) -> Option<u16> {
    (token.kind == LexerTokenKind::Number)
        .then(|| token.text.parse::<u16>().ok())
        .flatten()
}

fn parse_dmx_channel_ref_from_tokens(tokens: &[&LexerToken]) -> Option<(usize, DmxChannelRefAst)> {
    let [universe, dot, address, ..] = tokens else {
        return None;
    };
    (dot.kind == LexerTokenKind::Dot).then_some(())?;
    Some((
        3,
        DmxChannelRefAst {
            universe: parse_u16_token(universe)?,
            address: parse_u16_token(address)?,
        },
    ))
}

fn parse_dmx_channel_term_from_tokens(
    tokens: &[&LexerToken],
) -> Option<(usize, DmxChannelTermAst)> {
    if let [open, rest @ ..] = tokens
        && open.kind == LexerTokenKind::LeftParen
    {
        let (consumed, expr) = parse_dmx_channel_expression_inner(rest)?;
        let close = rest.get(consumed)?;
        (close.kind == LexerTokenKind::RightParen).then_some(())?;
        return Some((
            consumed + 2,
            DmxChannelTermAst::Grouped(DmxChannelGroupedAst {
                expr: Box::new(expr),
            }),
        ));
    }

    let (consumed, start) = parse_dmx_channel_ref_from_tokens(tokens)?;
    if let Some(through) = tokens.get(consumed)
        && through.kind == LexerTokenKind::GreaterThan
    {
        let (tail_consumed, end) = parse_dmx_channel_ref_from_tokens(&tokens[consumed + 1..])?;
        return Some((
            consumed + 1 + tail_consumed,
            DmxChannelTermAst::Range(DmxChannelRangeAst {
                start: DmxChannelSingleAst { channel: start },
                end: DmxChannelSingleAst { channel: end },
            }),
        ));
    }

    Some((
        consumed,
        DmxChannelTermAst::Single(DmxChannelSingleAst { channel: start }),
    ))
}

fn parse_dmx_channel_expression_inner(
    tokens: &[&LexerToken],
) -> Option<(usize, DmxChannelExpressionAst)> {
    let (mut consumed, head) = parse_dmx_channel_term_from_tokens(tokens)?;
    let mut tail = Vec::new();

    while let Some(op_token) = tokens.get(consumed) {
        let op = match op_token.kind {
            LexerTokenKind::Plus => SetOperatorAst::Add,
            LexerTokenKind::Minus => SetOperatorAst::Remove,
            _ => break,
        };
        let (term_consumed, term) = parse_dmx_channel_term_from_tokens(&tokens[consumed + 1..])?;
        tail.push(DmxChannelOpTermAst { op, term });
        consumed += 1 + term_consumed;
    }

    Some((consumed, DmxChannelExpressionAst { head, tail }))
}

fn parse_dmx_channel_expression_from_tokens(
    tokens: &[&LexerToken],
) -> Option<DmxChannelExpressionAst> {
    let (consumed, expr) = parse_dmx_channel_expression_inner(tokens)?;
    (consumed == tokens.len()).then_some(expr)
}

fn parse_release_dmx_channel_ref_from_tokens(
    tokens: &[&LexerToken],
) -> Option<(usize, ReleaseDmxChannelRefAst)> {
    let [universe, dot, rest @ ..] = tokens else {
        return None;
    };
    (dot.kind == LexerTokenKind::Dot).then_some(())?;
    let universe = parse_u16_token(universe)?;
    let address = match rest.first() {
        Some(token) if token.kind == LexerTokenKind::Number => Some(parse_u16_token(token)?),
        _ => None,
    };
    Some((
        2 + usize::from(address.is_some()),
        ReleaseDmxChannelRefAst { universe, address },
    ))
}

fn parse_release_dmx_channel_term_from_tokens(
    tokens: &[&LexerToken],
) -> Option<(usize, ReleaseDmxChannelTermAst)> {
    if let [open, rest @ ..] = tokens
        && open.kind == LexerTokenKind::LeftParen
    {
        let (consumed, expr) = parse_release_dmx_channel_expression_inner(rest)?;
        let close = rest.get(consumed)?;
        (close.kind == LexerTokenKind::RightParen).then_some(())?;
        return Some((
            consumed + 2,
            ReleaseDmxChannelTermAst::Grouped(ReleaseDmxChannelGroupedAst {
                expr: Box::new(expr),
            }),
        ));
    }

    let (consumed, start) = parse_release_dmx_channel_ref_from_tokens(tokens)?;
    if let Some(through) = tokens.get(consumed)
        && through.kind == LexerTokenKind::GreaterThan
    {
        let (tail_consumed, end) =
            parse_release_dmx_channel_ref_from_tokens(&tokens[consumed + 1..])?;
        return Some((
            consumed + 1 + tail_consumed,
            ReleaseDmxChannelTermAst::Range(ReleaseDmxChannelRangeAst {
                start: ReleaseDmxChannelSingleAst { channel: start },
                end: ReleaseDmxChannelSingleAst { channel: end },
            }),
        ));
    }

    Some((
        consumed,
        ReleaseDmxChannelTermAst::Single(ReleaseDmxChannelSingleAst { channel: start }),
    ))
}

fn parse_release_dmx_channel_expression_inner(
    tokens: &[&LexerToken],
) -> Option<(usize, ReleaseDmxChannelExpressionAst)> {
    let (mut consumed, head) = parse_release_dmx_channel_term_from_tokens(tokens)?;
    let mut tail = Vec::new();

    while let Some(op_token) = tokens.get(consumed) {
        let op = match op_token.kind {
            LexerTokenKind::Plus => SetOperatorAst::Add,
            LexerTokenKind::Minus => SetOperatorAst::Remove,
            _ => break,
        };
        let (term_consumed, term) =
            parse_release_dmx_channel_term_from_tokens(&tokens[consumed + 1..])?;
        tail.push(ReleaseDmxChannelOpTermAst { op, term });
        consumed += 1 + term_consumed;
    }

    Some((consumed, ReleaseDmxChannelExpressionAst { head, tail }))
}

fn parse_release_dmx_channel_expression_from_tokens(
    tokens: &[&LexerToken],
) -> Option<ReleaseDmxChannelExpressionAst> {
    let (consumed, expr) = parse_release_dmx_channel_expression_inner(tokens)?;
    (consumed == tokens.len()).then_some(expr)
}

/// Performs a lightweight preparse to reject empty or structurally impossible strict commands early.
#[cfg(test)]
fn strict_preparse(input: &str) -> Result<(), AstError> {
    let tokens = lex_command(input);
    strict_preparse_tokens(&tokens)
}

fn strict_preparse_tokens(tokens: &[LexerToken]) -> Result<(), AstError> {
    let Some(head) = tokens
        .iter()
        .find(|token| token.kind != LexerTokenKind::Whitespace)
    else {
        return Err(AstError::Strict(
            "input does not match strict command head syntax".into(),
        ));
    };

    match head.kind {
        LexerTokenKind::Word
        | LexerTokenKind::AtSign
        | LexerTokenKind::Tilde
        | LexerTokenKind::DoubleAtSign
        | LexerTokenKind::LeftParen
        | LexerTokenKind::LeftBrace
        | LexerTokenKind::QuotedString => Ok(()),
        _ => Err(AstError::Strict(
            "input does not match strict command head syntax".into(),
        )),
    }
}

/// Parses lightweight general commands such as `help`, `undo`, and `quit` before the strict parser is needed.
#[cfg(test)]
fn parse_simple_general_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Parses lightweight clip commands such as `on`, `off`, and `goto`.
#[cfg(test)]
fn parse_simple_clip_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    transport::parse_simple_clip_command(command_str)
}

/// Parses lightweight timecode transport commands.
#[cfg(test)]
fn parse_simple_timecode_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    transport::parse_simple_timecode_command(command_str)
}

/// Parses lightweight timeline transport commands.
#[cfg(test)]
fn parse_simple_timeline_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    transport::parse_simple_timeline_command(command_str)
}

/// Parses lightweight flow commands such as `start`, `stop`, `go`, `delete`, and `rename`.
#[cfg(test)]
fn parse_simple_flow_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    flow::parse_simple_flow_command(command_str)
}

/// Parses lightweight store, recall, delete, and rename object commands.
#[cfg(test)]
fn parse_simple_general_object_commands<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Exercises FPS syntax through the production command parser.
#[cfg(test)]
fn parse_set_fps_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Exercises duration commands through the production command parser.
#[cfg(test)]
fn parse_sleep_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Parses `channel` commands that target DMX channels and values.
#[cfg(test)]
fn parse_channel_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Duration token parsed from command text with its original span.
#[derive(Debug, Clone)]
struct ParsedDurationValue {
    value: std::ops::Range<usize>,
    unit: Option<std::ops::Range<usize>>,
}

/// Parses a `patch` command with one or more endpoints and optional modifiers.
#[cfg(test)]
fn parse_patch_add_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    patch::parse_patch_add_command_from_tokens(command_str, &tokens)
}

/// Parses an `rm patch` command that removes matching patch bindings.
#[cfg(test)]
fn parse_rm_patch_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    patch::parse_rm_patch_command_from_tokens(command_str, &tokens)
}

/// Converts parsed duration value into AST values sliced from the original command text.
fn materialize_duration_value<'i>(
    trimmed: &'i str,
    value: ParsedDurationValue,
) -> DurationValueAst<'i> {
    DurationValueAst {
        value: ValueAst(&trimmed[value.value]),
        unit: value.unit.map(|unit| DurationUnitAst(&trimmed[unit])),
    }
}

/// Merges two timing fragments into one timing AST.
fn merge_timings<'i>(left: TimingsAst<'i>, right: TimingsAst<'i>) -> TimingsAst<'i> {
    TimingsAst {
        fades: merge_fade_timings(left.fades, right.fades),
        delays: merge_delay_timings(left.delays, right.delays),
    }
}

/// Merges repeated fade timing clauses while preserving command order.
fn merge_fade_timings<'i>(
    left: Option<FadesAst<'i>>,
    right: Option<FadesAst<'i>>,
) -> Option<FadesAst<'i>> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            left.additional.push(TimingClauseAst {
                direction: right.direction,
                value: right.value,
                overrides: right.overrides,
            });
            left.additional.extend(right.additional);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

/// Merges repeated delay timing clauses while preserving command order.
fn merge_delay_timings<'i>(
    left: Option<DelaysAst<'i>>,
    right: Option<DelaysAst<'i>>,
) -> Option<DelaysAst<'i>> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            left.additional.push(TimingClauseAst {
                direction: right.direction,
                value: right.value,
                overrides: right.overrides,
            });
            left.additional.extend(right.additional);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

/// Parses extended `store` commands that include payload values such as blueprint types or quoted names.
#[cfg(test)]
fn parse_store_extended_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    parse_store_extended_command_from_tokens(command_str, &tokens)
}

#[cfg(test)]
fn parse_store_extended_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    let significant = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    let head = significant.first()?;
    if canonical_word(head, AliasCanonicalizationContext::default())?.as_str()
        != canonical_token_text(TokenId::Store)
    {
        return None;
    }

    let object = significant.get(1)?;
    match canonical_word(
        object,
        AliasCanonicalizationContext {
            selection_or_object_context: true,
            ..AliasCanonicalizationContext::default()
        },
    )?
    .as_str()
    {
        canonical if canonical == canonical_token_text(TokenId::Fx) => {
            parse_store_fx_command_from_tokens(command_str, &significant[2..])
        }
        canonical if canonical == canonical_token_text(TokenId::Clip) => {
            let id =
                parse_simple_identifier_expression_from_tokens(command_str, &significant[2..])?;
            Some(CommandAst::General(GeneralCommandAst::StoreClip(
                StoreClipCommandAst {
                    _clip: ClipKeyword,
                    id,
                },
            )))
        }
        canonical if canonical == canonical_token_text(TokenId::Flow) => {
            parse_store_flow_command_from_tokens(command_str, &significant[2..])
        }
        canonical if canonical == canonical_token_text(TokenId::Timecode) => {
            let id =
                parse_simple_identifier_expression_from_tokens(command_str, &significant[2..])?;
            Some(CommandAst::General(GeneralCommandAst::StoreTimecode(
                StoreTimecodeCommandAst {
                    _timecode: TimecodeKeyword,
                    id,
                },
            )))
        }
        canonical if canonical == canonical_token_text(TokenId::Timeline) => {
            let id =
                parse_simple_identifier_expression_from_tokens(command_str, &significant[2..])?;
            Some(CommandAst::General(GeneralCommandAst::StoreTimeline(
                StoreTimelineCommandAst {
                    _timeline: TimelineKeyword,
                    id,
                },
            )))
        }
        canonical if canonical == canonical_token_text(TokenId::Fixture) => {
            let body = &significant[1..];
            if let Some(offset_index) = body
                .iter()
                .position(|token| token.text.eq_ignore_ascii_case("offset"))
            {
                if offset_index < 2 || offset_index + 2 >= body.len() {
                    return None;
                }
                let selection = parse_selection_from_tokens(command_str, &body[..offset_index])?;
                if selection.selection_type != SelectionTypeAst::Fixture {
                    return None;
                }
                for split in (offset_index + 2..=body.len()).rev() {
                    let attribute = match parse_attribute_type_from_tokens(
                        command_str,
                        &body[offset_index + 1..split],
                        AttributeParseSpecId::Standard,
                    ) {
                        Some(attribute) => attribute,
                        None => continue,
                    };
                    let value = match parse_offset_value_from_tokens(command_str, &body[split..]) {
                        Some(value) => value,
                        None => continue,
                    };
                    return Some(CommandAst::General(GeneralCommandAst::StoreFixtureOffset(
                        StoreFixtureOffsetCommandAst {
                            _fixture: FixtureKeyword,
                            id: selection.ids,
                            attribute,
                            value,
                        },
                    )));
                }
                return None;
            }

            if body.len() < 5 {
                return None;
            }
            let tail = &body[body.len() - 3..];
            if tail[0].kind != LexerTokenKind::QuotedString
                || tail[1].kind != LexerTokenKind::QuotedString
                || tail[2].kind != LexerTokenKind::Word
            {
                return None;
            }
            let selection = parse_selection_from_tokens(command_str, &body[..body.len() - 3])?;
            if selection.selection_type != SelectionTypeAst::Fixture {
                return None;
            }
            Some(CommandAst::General(GeneralCommandAst::StoreFixture(
                StoreFixtureCommandAst {
                    _fixture: FixtureKeyword,
                    id: selection.ids,
                    make: QuotedStringAst(&command_str[tail[0].span.start..tail[0].span.end]),
                    model: QuotedStringAst(&command_str[tail[1].span.start..tail[1].span.end]),
                    mode: WordAst(&command_str[tail[2].span.start..tail[2].span.end]),
                },
            )))
        }
        canonical if canonical == canonical_token_text(TokenId::Blueprint) => {
            let body = &significant[2..];
            let filter_index = body
                .iter()
                .position(|token| token.text.eq_ignore_ascii_case("filter"));
            let id_end = filter_index.unwrap_or(body.len());
            if id_end == 0 {
                return None;
            }
            let id = parse_simple_identifier_expression_from_tokens(command_str, &body[..id_end])?;
            let filter = if let Some(filter_index) = filter_index {
                Some(parse_attribute_types_from_tokens(
                    command_str,
                    &body[filter_index + 1..],
                    AttributeParseSpecId::Standard,
                )?)
            } else {
                None
            };
            Some(CommandAst::General(GeneralCommandAst::StoreBlueprint(
                StoreBlueprintCommandAst {
                    _blueprint: BlueprintKeyword,
                    id,
                    filter: filter.unwrap_or_default(),
                },
            )))
        }
        _ => None,
    }
}

/// Parses a stored flow ID and optional quoted serialized definition.
#[cfg(test)]
fn parse_store_flow_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<CommandAst<'i>> {
    let payload = tokens
        .last()
        .filter(|token| token.kind == LexerTokenKind::QuotedString);
    let id_tokens = if payload.is_some() {
        &tokens[..tokens.len().checked_sub(1)?]
    } else {
        tokens
    };
    let id = parse_simple_identifier_expression_from_tokens(command_str, id_tokens)?;
    let payload =
        payload.map(|token| QuotedStringAst(&command_str[token.span.start..token.span.end]));
    Some(CommandAst::General(GeneralCommandAst::StoreFlow(
        StoreFlowCommandAst {
            _flow: FlowKeyword,
            id,
            payload,
        },
    )))
}

/// Disambiguates step FX definitions from stored FX module instances.
#[cfg(test)]
fn parse_store_fx_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<CommandAst<'i>> {
    for split in 1..tokens.len() {
        let Some(id) =
            parse_simple_identifier_expression_from_tokens(command_str, &tokens[..split])
        else {
            continue;
        };
        let Some(action) = fx::parse_fx_action_from_tokens(command_str, &tokens[split..]) else {
            continue;
        };
        let FxActionAst::CreateStep(definition) = action else {
            continue;
        };
        return Some(CommandAst::General(GeneralCommandAst::StoreStepFx(
            StoreStepFxCommandAst {
                _fx: FxKeyword,
                id,
                definition,
            },
        )));
    }
    if (1..tokens.len()).any(|split| {
        parse_simple_identifier_expression_from_tokens(command_str, &tokens[..split]).is_some()
            && tokens.get(split).is_some_and(|token| {
                canonical_word(token, AliasCanonicalizationContext::default()).as_deref()
                    == Some(canonical_token_text(TokenId::Step))
            })
    }) {
        return None;
    }
    parse_store_fx_module_command_from_tokens(command_str, tokens)
}

/// Parses a structurally isolated stored FX module payload.
fn parse_store_fx_module_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<CommandAst<'i>> {
    let id_end = (1..tokens.len()).find(|&split| {
        parse_simple_identifier_expression_from_tokens(command_str, &tokens[..split]).is_some()
            && tokens
                .get(split)
                .is_some_and(|token| token.kind == LexerTokenKind::Word)
    })?;
    let id = parse_simple_identifier_expression_from_tokens(command_str, &tokens[..id_end])?;
    let (module_name, module_name_end) =
        parse_hyphenated_word_argument(command_str, tokens, id_end)?;
    let mut index = module_name_end;
    let mut parts = Vec::new();

    while index < tokens.len() {
        let token = tokens[index];
        if token.text.eq_ignore_ascii_case("selection") {
            let selection_end = (index + 1..=tokens.len()).find(|&split| {
                split == tokens.len()
                    || tokens[split].text.eq_ignore_ascii_case("config")
                    || tokens[split].text.eq_ignore_ascii_case("/merge")
            })?;
            let selection = parse_selection_argument_from_tokens(
                command_str,
                &tokens[index + 1..selection_end],
                &[SelectionTypeAst::Fixture, SelectionTypeAst::Group],
            )?;
            parts.push(FxModuleStorePartAst::Selection(
                FxModuleSelectionClauseAst { selection },
            ));
            index = selection_end;
            continue;
        }

        if token.text.eq_ignore_ascii_case("config") {
            let start = index + 1;
            let end = (start..=tokens.len()).find(|&split| {
                split == tokens.len() || tokens[split].text.eq_ignore_ascii_case("/merge")
            })?;
            if start == end {
                return None;
            }
            let entries = fx_module_config_entries(command_str, &tokens[start..end])
                .into_iter()
                .map(FxModuleConfigEntryAst)
                .collect();
            parts.push(FxModuleStorePartAst::ConfigClause(
                FxModuleConfigClauseAst { entries },
            ));
            index = end;
            continue;
        }

        if token.text.eq_ignore_ascii_case("/merge") {
            parts.push(FxModuleStorePartAst::Merge(FxModuleMergeFlagAst));
            index += 1;
            continue;
        }

        let (entry, consumed) = fx_module_config_entry_from_tokens(command_str, &tokens[index..])?;
        parts.push(FxModuleStorePartAst::ConfigEntry(FxModuleConfigEntryAst(
            entry,
        )));
        index += consumed;
    }

    Some(CommandAst::General(GeneralCommandAst::StoreFxModule(
        StoreFxModuleCommandAst {
            _fx: FxKeyword,
            id,
            module_name,
            parts,
        },
    )))
}

/// Collect raw config entries, preserving contiguous lexer pieces such as signed values.
fn fx_module_config_entries<'i>(command_str: &'i str, tokens: &[&LexerToken]) -> Vec<&'i str> {
    let mut entries = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let Some((entry, consumed)) =
            fx_module_config_entry_from_tokens(command_str, &tokens[index..])
        else {
            break;
        };
        entries.push(entry);
        index += consumed;
    }
    entries
}

/// Return one config entry by joining tokens that were adjacent in the source text.
fn fx_module_config_entry_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(&'i str, usize)> {
    let first = tokens.first()?;
    let mut consumed = 1;
    let mut span_end = first.span.end;

    while let Some(next) = tokens.get(consumed) {
        if next.span.start != span_end {
            break;
        }
        consumed += 1;
        span_end = next.span.end;
    }

    Some((&command_str[first.span.start..span_end], consumed))
}

/// Parse a word argument that may contain contiguous hyphen separators.
fn parse_hyphenated_word_argument<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    start: usize,
) -> Option<(WordAst<'i>, usize)> {
    let first = tokens.get(start)?;
    (first.kind == LexerTokenKind::Word).then_some(())?;

    let mut end = start + 1;
    let mut span_end = first.span.end;
    while end + 1 < tokens.len() {
        let hyphen = tokens[end];
        let word = tokens[end + 1];
        if hyphen.kind != LexerTokenKind::Minus
            || word.kind != LexerTokenKind::Word
            || hyphen.span.start != span_end
            || hyphen.span.end != word.span.start
        {
            break;
        }

        span_end = word.span.end;
        end += 2;
    }

    Some((WordAst(&command_str[first.span.start..span_end]), end))
}

/// Parses `release` commands for fixture, attribute, and DMX targets.
#[cfg(test)]
fn parse_release_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Parses `clear` commands for selection, attribute, and value targets.
#[cfg(test)]
fn parse_clear_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Exercises log syntax through the production command parser.
#[cfg(test)]
fn parse_log_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    parse_strict(command_str).ok()
}

/// Promotes a simple identifier expression into the full identifier-expression AST.
fn identifier_expression_from_simple(
    simple: SimpleIdentifierExpressionAst,
) -> IdentifierExpressionAst {
    /// Builds a `SingleIdAst` parser from a target parser.
    fn single_id(simple_id: SimpleIdAst) -> SingleIdAst {
        SingleIdAst {
            target: TargetAst::FixtureRef {
                fixture_id: simple_id.id,
            },
        }
    }

    /// Builds an identifier-term parser from grouped, ranged, and single-ID forms.
    fn term(term: SimpleTermAst) -> TermAst {
        match term {
            SimpleTermAst::Single(id) => TermAst::Single(single_id(id)),
            SimpleTermAst::Range(range) => TermAst::Range(RangeAst {
                start: single_id(range.start),
                end: single_id(range.end),
            }),
            SimpleTermAst::Grouped(grouped) => TermAst::Grouped(crate::ast::GroupedExprAst {
                expr: Box::new(identifier_expression_from_simple(*grouped.expr)),
            }),
        }
    }

    IdentifierExpressionAst {
        head: term(simple.head),
        tail: simple
            .tail
            .into_iter()
            .map(|tail| OpTermAst {
                op: tail.op,
                term: term(tail.term),
            })
            .collect(),
    }
}

/// Materializes a standalone fixture, group, or parameter selection for selection-expression callers.
fn parse_simple_selection_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    general::parse_simple_selection_command(command_str)
}

/// Parse a standalone selection expression (`fix 1>3`, `grp 1+2`) into `SelectionAst`.
pub(crate) fn parse_selection_ast(input: &str) -> Result<SelectionAst, AstError> {
    let command = parse_simple_selection_command(input)
        .ok_or_else(|| AstError::Strict("input does not match strict selection grammar".into()))?;
    match command {
        CommandAst::Selection(selection) => Ok(selection.selection),
        _ => Err(AstError::Strict(
            "input does not match strict selection grammar".into(),
        )),
    }
}

pub(crate) fn materialize_strict_ast<'i>(command_str: &'i str) -> Result<CommandAst<'i>, AstError> {
    let tokens = lex_command(command_str);
    materialize_strict_ast_with_tokens(command_str, &tokens)
}

/// Executes the command grammar and returns an AST from a completed parser branch.
pub(crate) fn materialize_strict_ast_with_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Result<CommandAst<'i>, AstError> {
    super::prefix::parse_tokenized_prefix(command_str, tokens)
        .completed_ast()
        .ok_or_else(|| AstError::Strict("input does not match command grammar".to_owned()))
}

/// Materializes only the fully consumed semantic structure of this particular parser branch.
pub(crate) fn materialize_branch_ast<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    strict_preparse_tokens(tokens).ok()?;
    let consumed_end = tokens
        .iter()
        .rfind(|token| token.kind != LexerTokenKind::Whitespace)?
        .span
        .end;
    let branch_end = branch.cursor.furthest_pos;
    if branch_end < consumed_end || branch.status != PathStatus::Completed {
        return None;
    }
    dispatch_structural_branch(command_str, tokens, branch.clone())
}

#[cfg(test)]
fn materialize_strict_ast_from_structural_dispatch<'i>(
    command_str: &'i str,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    materialize_strict_ast_from_structural_dispatch_with_tokens(command_str, &tokens)
}

/// Select the best completed structural branch and convert it into a command AST.
#[cfg(test)]
fn materialize_strict_ast_from_structural_dispatch_with_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    let context = build_strict_prefix_context(tokens, command_str.len());
    let branches = execute_branches_from_tokens(&context, tokens, command_str.len());
    let consumed_end = tokens
        .iter()
        .rfind(|token| token.kind != LexerTokenKind::Whitespace)
        .map_or(0, |token| token.span.end);
    let branch = best_completed_structural_branch(&branches, consumed_end)?.clone();
    dispatch_structural_branch(command_str, tokens, branch)
}

#[cfg(test)]
fn build_strict_prefix_context(tokens: &[LexerToken], cursor: usize) -> CommandPrefixContext {
    let non_whitespace_tokens = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();

    CommandPrefixContext {
        segment_start: 0,
        segment_end: cursor,
        cursor,
        token_count: non_whitespace_tokens.len(),
        active_token_start: cursor,
        active_token_end: cursor,
        has_trailing_whitespace: true,
        active_token_text: None,
    }
}

#[cfg(test)]
fn best_completed_structural_branch<'i, 'b>(
    branches: &'b [crate::parser::analysis::ParseBranchState<'i>],
    consumed_end: usize,
) -> Option<&'b crate::parser::analysis::ParseBranchState<'i>> {
    branches
        .iter()
        .filter(|branch| {
            let fully_consumed = branch
                .consumed_items
                .iter()
                .map(|item| item.source_token_end)
                .max()
                .is_some_and(|end| end >= consumed_end);
            fully_consumed
                && (branch.status == PathStatus::Completed
                    || branch.frontier.iter().all(|expectation| {
                        matches!(
                            expectation.target,
                            crate::parser::analysis::ContinuationTarget::Clause(_)
                        )
                    }))
        })
        .max_by_key(|branch| {
            (
                branch.committed_clause_path().len(),
                committed_fill_distribution(branch),
                branch.consumed_items.len(),
                Reverse(branch.frontier.len()),
            )
        })
}

#[cfg(test)]
fn committed_fill_distribution(
    branch: &crate::parser::analysis::ParseBranchState<'_>,
) -> Vec<usize> {
    let committed_path = branch.committed_clause_path();
    committed_path
        .iter()
        .map(|clause| {
            branch
                .consumed_items
                .iter()
                .filter(|item| item.clause == *clause)
                .count()
        })
        .collect()
}

fn dispatch_structural_branch<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
    branch: crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let ctx = StrictBranchContext::new(command_str, tokens, &branch);
    let committed = branch.committed_clause_path();
    let root = committed.first()?.clause;
    let has_clause = |target| committed.iter().any(|clause| clause.clause == target);

    match command_family_for_root_clause(root)?.structural_ast_dispatch {
        StructuralAstDispatchKind::CueBlock => general::materialize_cue_block_ast(ctx),
        StructuralAstDispatchKind::ObjectProperty => general::materialize_object_property_ast(ctx),
        StructuralAstDispatchKind::Utility => general::materialize_utility_ast(ctx),
        StructuralAstDispatchKind::ColorPath => general::materialize_color_path_ast(ctx),
        StructuralAstDispatchKind::Programmer if has_clause(ClauseId::ProgrammerColorPath) => {
            general::materialize_color_path_ast(ctx)
        }
        StructuralAstDispatchKind::Store if has_clause(ClauseId::StoreColorPath) => {
            general::materialize_color_path_ast(ctx)
        }
        StructuralAstDispatchKind::Programmer => {
            if has_clause(ClauseId::ProgrammerPlacement3d) {
                programmer::materialize_fixture_placement_ast(ctx)
            } else if has_clause(ClauseId::ProgrammerAttributeActions)
                || has_clause(ClauseId::ProgrammerSetAttributeItem)
                || has_clause(ClauseId::ProgrammerTimings)
                || has_clause(ClauseId::ProgrammerTimingOverride)
            {
                programmer::materialize_attribute_ast(ctx)
            } else {
                programmer::materialize_selection_ast(ctx)
            }
        }
        StructuralAstDispatchKind::Fx if has_clause(ClauseId::FxModule) => {
            fx::materialize_fx_module_ast(ctx)
        }
        StructuralAstDispatchKind::Fx => fx::materialize_fx_ast(ctx),
        StructuralAstDispatchKind::Patch => patch::materialize_patch_add_ast(ctx),
        StructuralAstDispatchKind::Clip => transport::materialize_clip_ast(ctx),
        StructuralAstDispatchKind::ChannelOverride => programmer::materialize_channel_ast(ctx),
        StructuralAstDispatchKind::Release => general::materialize_release_ast(ctx),
        StructuralAstDispatchKind::Clear => general::materialize_clear_ast(ctx),
        StructuralAstDispatchKind::Flow => flow::materialize_flow_ast(ctx),
        StructuralAstDispatchKind::Timecode => transport::materialize_timecode_ast(ctx),
        StructuralAstDispatchKind::Timeline => transport::materialize_timeline_ast(ctx),
        StructuralAstDispatchKind::Rm => patch::materialize_rm_patch_ast(ctx)
            .or_else(|| general::materialize_general_object_ast(ctx)),
        StructuralAstDispatchKind::Rename => general::materialize_general_object_ast(ctx),
        StructuralAstDispatchKind::Store => general::materialize_store_ast(ctx),
        StructuralAstDispatchKind::Log => general::materialize_log_ast(ctx),
        StructuralAstDispatchKind::Recall => general::materialize_recall_ast(ctx),
        StructuralAstDispatchKind::Debug => general::materialize_general_object_ast(ctx),
        StructuralAstDispatchKind::Sleep => general::materialize_sleep_ast(ctx),
        StructuralAstDispatchKind::Fps => general::materialize_fps_ast(ctx),
    }
}

/// Parse a complete command string into a strict command AST.
pub fn parse_strict<'i>(command_str: &'i str) -> Result<CommandAst<'i>, AstError> {
    materialize_strict_ast(command_str)
}

#[cfg(test)]
fn materialize_log_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_log_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_store_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_store_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_release_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_release_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_clear_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_clear_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_channel_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    programmer::materialize_channel_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_sleep_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_sleep_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_fps_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_fps_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_recall_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_recall_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_general_object_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    general::materialize_general_object_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_rm_patch_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    patch::materialize_rm_patch_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_selection_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    programmer::materialize_selection_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_fx_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    fx::materialize_fx_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_attribute_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    programmer::materialize_attribute_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
fn materialize_fixture_placement_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    programmer::materialize_fixture_placement_ast(StrictBranchContext::new(
        command_str,
        &tokens,
        branch,
    ))
}

#[cfg(test)]
fn materialize_patch_add_ast_from_branch<'i>(
    command_str: &'i str,
    branch: &crate::parser::analysis::ParseBranchState<'i>,
) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    patch::materialize_patch_add_ast(StrictBranchContext::new(command_str, &tokens, branch))
}

#[cfg(test)]
mod tests;
