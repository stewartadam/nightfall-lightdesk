// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::branch_view::{
    child_clause_instances_in_order, clause_instances_in_order, clause_span, combined_span,
    last_slot_span_matching, merged_slot_span, slot_tokens, slot_tokens_in_clause,
    tokens_for_spans, tokens_in_span,
};
use super::context::StrictBranchContext;
use super::*;
use crate::ast::DurationRangeAst;
use crate::parser::analysis::ClauseInstance;

fn placement_action_kind(token: &LexerToken) -> Option<bool> {
    if token.kind != LexerTokenKind::Word {
        return None;
    }
    if token.text.eq_ignore_ascii_case("pos") {
        return Some(true);
    }
    if token.text.eq_ignore_ascii_case("rot") {
        return Some(false);
    }
    None
}

fn axis_from_token(token: &LexerToken) -> Option<AxisAst> {
    if token.kind != LexerTokenKind::Word {
        return None;
    }
    if token.text.eq_ignore_ascii_case("x") {
        return Some(AxisAst::X);
    }
    if token.text.eq_ignore_ascii_case("y") {
        return Some(AxisAst::Y);
    }
    if token.text.eq_ignore_ascii_case("z") {
        return Some(AxisAst::Z);
    }
    None
}

fn is_axis_token(token: &LexerToken) -> bool {
    axis_from_token(token).is_some()
}

fn parse_tuple_value_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, TupleValueAst<'i>)> {
    let right_paren = tokens
        .iter()
        .position(|token| token.kind == LexerTokenKind::RightParen)?;
    let tuple_tokens = &tokens[..=right_paren];
    let first = tuple_tokens.first()?;
    let last = tuple_tokens.last()?;
    (first.kind == LexerTokenKind::LeftParen && last.kind == LexerTokenKind::RightParen)
        .then_some(())?;

    let comma_positions = tuple_tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token.kind == LexerTokenKind::Comma).then_some(index))
        .collect::<Vec<_>>();
    (comma_positions.len() == 2).then_some(())?;

    let x = parse_decimal_value_from_tokens(command_str, &tuple_tokens[1..comma_positions[0]])?;
    let y = parse_decimal_value_from_tokens(
        command_str,
        &tuple_tokens[comma_positions[0] + 1..comma_positions[1]],
    )?;
    let z = parse_decimal_value_from_tokens(
        command_str,
        &tuple_tokens[comma_positions[1] + 1..tuple_tokens.len() - 1],
    )?;

    Some((right_paren + 1, TupleValueAst { x, y, z }))
}

fn parse_axis_chain_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, Vec<AxisValueAst<'i>>)> {
    let mut consumed = 0usize;
    let mut values = Vec::new();
    let mut seen_x = false;
    let mut seen_y = false;
    let mut seen_z = false;

    while consumed < tokens.len() {
        if placement_action_kind(tokens[consumed]).is_some() {
            break;
        }
        let axis = axis_from_token(tokens[consumed])?;
        let seen = match axis {
            AxisAst::X => {
                let was_seen = seen_x;
                seen_x = true;
                was_seen
            }
            AxisAst::Y => {
                let was_seen = seen_y;
                seen_y = true;
                was_seen
            }
            AxisAst::Z => {
                let was_seen = seen_z;
                seen_z = true;
                was_seen
            }
        };
        if seen {
            return None;
        }

        let value_start = consumed + 1;
        let value_end = tokens[value_start..]
            .iter()
            .position(|token| is_axis_token(token) || placement_action_kind(token).is_some())
            .map_or(tokens.len(), |offset| value_start + offset);
        let value = parse_decimal_value_from_tokens(command_str, &tokens[value_start..value_end])?;
        values.push(AxisValueAst { axis, value });
        consumed = value_end;
    }

    (!values.is_empty()).then_some((consumed, values))
}

fn parse_position_action_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, PositionActionAst<'i>)> {
    placement_action_kind(tokens.first()?).filter(|is_position| *is_position)?;
    let value_tokens = &tokens[1..];
    if value_tokens.first()?.kind == LexerTokenKind::LeftParen {
        let (consumed, value) = parse_tuple_value_from_tokens(command_str, value_tokens)?;
        return Some((
            consumed + 1,
            PositionActionAst {
                value: PositionValueAst::Tuple(value),
            },
        ));
    }

    let (consumed, values) = parse_axis_chain_from_tokens(command_str, value_tokens)?;
    let value = if values.len() == 1 {
        PositionValueAst::Axis(values.into_iter().next().expect("single axis value"))
    } else {
        PositionValueAst::AxisChain(values)
    };
    Some((consumed + 1, PositionActionAst { value }))
}

fn parse_rotation_action_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, RotationActionAst<'i>)> {
    (!placement_action_kind(tokens.first()?)?).then_some(())?;
    let value_tokens = &tokens[1..];
    if value_tokens.first()?.kind == LexerTokenKind::LeftParen {
        let (consumed, value) = parse_tuple_value_from_tokens(command_str, value_tokens)?;
        return Some((
            consumed + 1,
            RotationActionAst {
                value: RotationValueAst::Tuple(value),
            },
        ));
    }

    let (consumed, values) = parse_axis_chain_from_tokens(command_str, value_tokens)?;
    let value = if values.len() == 1 {
        RotationValueAst::Axis(values.into_iter().next().expect("single axis value"))
    } else {
        RotationValueAst::AxisChain(values)
    };
    Some((consumed + 1, RotationActionAst { value }))
}

pub(super) fn parse_placement_actions_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<PlacementActionsAst<'i>> {
    let first_is_position = placement_action_kind(tokens.first()?)?;
    let (first_consumed, mut position, mut rotation) = if first_is_position {
        let (consumed, action) = parse_position_action_from_tokens(command_str, tokens)?;
        (consumed, Some(action), None)
    } else {
        let (consumed, action) = parse_rotation_action_from_tokens(command_str, tokens)?;
        (consumed, None, Some(action))
    };

    let remaining = &tokens[first_consumed..];
    if remaining.is_empty() {
        return Some(PlacementActionsAst { position, rotation });
    }

    let second_is_position = placement_action_kind(remaining.first()?)?;
    if second_is_position {
        position.is_none().then_some(())?;
        let (consumed, action) = parse_position_action_from_tokens(command_str, remaining)?;
        remaining[consumed..].is_empty().then_some(())?;
        position = Some(action);
    } else {
        rotation.is_none().then_some(())?;
        let (consumed, action) = parse_rotation_action_from_tokens(command_str, remaining)?;
        remaining[consumed..].is_empty().then_some(())?;
        rotation = Some(action);
    }

    Some(PlacementActionsAst { position, rotation })
}

pub(super) fn materialize_selection_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let StrictBranchContext {
        command_str,
        tokens,
        branch,
    } = ctx;
    let selection = super::shared::parse_spatial_selection_base_from_source(command_str)?;
    let _ = (tokens, branch);
    Some(CommandAst::Selection(SelectionCommandAst {
        source: command_str.trim(),
        selection,
    }))
}

/// Resolve programmer attribute clauses into ordered value and timing actions.
pub(super) fn materialize_attribute_actions<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<AttributeActionsAst<'i>> {
    let StrictBranchContext {
        command_str,
        tokens,
        branch,
    } = ctx;
    let mut item_clauses =
        clause_instances_in_order(branch, ClauseId::ProgrammerSetAttributeItem).into_iter();
    let first_clause = item_clauses.next()?;
    let first_attribute_tokens = slot_tokens_in_clause(
        tokens,
        branch,
        &first_clause,
        crate::slots::contracts::SlotId::SetAttrAttribute,
    );
    let first_value_tokens = slot_tokens_in_clause(
        tokens,
        branch,
        &first_clause,
        crate::slots::contracts::SlotId::SetAttrValue,
    );
    let first_resolution_tokens = slot_tokens_in_clause(
        tokens,
        branch,
        &first_clause,
        crate::slots::contracts::SlotId::BlueprintResolution,
    );
    let first = if first_attribute_tokens.is_empty() {
        match first_value_tokens.as_slice() {
            [token] if token.kind == LexerTokenKind::DoubleAtSign => {
                AttributeActionAst::SetFullIntensity
            }
            [operator, rest @ ..]
                if value_operator_mode(operator).is_some() && !rest.is_empty() =>
            {
                if let Some(source) =
                    parse_blueprint_source_from_tokens(command_str, rest, &first_resolution_tokens)
                {
                    AttributeActionAst::ApplyBlueprint(source)
                } else {
                    AttributeActionAst::SetIntensity(parse_value_range_from_tokens_with_mode(
                        command_str,
                        rest,
                        value_operator_mode(operator)?,
                    )?)
                }
            }
            _ => return None,
        }
    } else {
        let value_tokens = match first_value_tokens.as_slice() {
            [operator, rest @ ..]
                if value_operator_mode(operator).is_some() && !rest.is_empty() =>
            {
                rest
            }
            _ => return None,
        };
        let source = parse_attribute_value_source_from_tokens(
            command_str,
            value_tokens,
            value_operator_mode(first_value_tokens[0])?,
            &first_resolution_tokens,
        )?;
        AttributeActionAst::SetAttribute(SetAttributeAst {
            target: parse_attribute_target_from_tokens(command_str, &first_attribute_tokens)?,
            source,
        })
    };

    let mut rest = Vec::new();
    for clause in item_clauses {
        let attribute_tokens = slot_tokens_in_clause(
            tokens,
            branch,
            &clause,
            crate::slots::contracts::SlotId::SetAttrAttribute,
        );
        let value_tokens = slot_tokens_in_clause(
            tokens,
            branch,
            &clause,
            crate::slots::contracts::SlotId::SetAttrValue,
        );
        let resolution_tokens = slot_tokens_in_clause(
            tokens,
            branch,
            &clause,
            crate::slots::contracts::SlotId::BlueprintResolution,
        );
        let [operator, rest_tokens @ ..] = value_tokens.as_slice() else {
            return None;
        };
        let mode = value_operator_mode(operator)?;
        if rest_tokens.is_empty() {
            return None;
        }
        rest.push(SetAttributeAst {
            target: parse_attribute_target_from_tokens(command_str, &attribute_tokens)?,
            source: parse_attribute_value_source_from_tokens(
                command_str,
                rest_tokens,
                mode,
                &resolution_tokens,
            )?,
        });
    }

    Some(AttributeActionsAst { first, rest })
}

/// Parses one direct or Blueprint-backed value source after an assignment operator.
fn parse_attribute_value_source_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    mode: ParameterValueMode,
    resolution_tokens: &[&LexerToken],
) -> Option<AttributeValueSourceAst<'i>> {
    if let Some(source) = parse_blueprint_source_from_tokens(command_str, tokens, resolution_tokens)
    {
        return Some(AttributeValueSourceAst::Blueprint(source));
    }
    Some(AttributeValueSourceAst::Direct(
        parse_value_range_from_tokens_with_mode(command_str, tokens, mode)?,
    ))
}

/// Parses the Blueprint keyword, one ID-or-label address, and optional `/absolute` modifier.
fn parse_blueprint_source_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    resolution_tokens: &[&LexerToken],
) -> Option<BlueprintSourceAst<'i>> {
    let resolution = match resolution_tokens {
        [] => BlueprintResolutionAst::Reference,
        [modifier] if modifier.text.eq_ignore_ascii_case("/absolute") => {
            BlueprintResolutionAst::Absolute
        }
        _ => return None,
    };
    let (consumed, mut source) = super::parse_blueprint_source_from_tokens(command_str, tokens)?;
    (consumed == tokens.len()).then_some(())?;
    source.resolution = resolution;
    Some(source)
}

/// Parses an unquoted category token or falls back to the standard attribute parser.
fn parse_attribute_target_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<AttributeTargetAst<'i>> {
    if let [token] = tokens
        && token.kind == LexerTokenKind::Word
    {
        let category = match token.text.to_ascii_lowercase().as_str() {
            "dimmer" => Some(AttributeCategoryAst::Dimmer),
            "position" => Some(AttributeCategoryAst::Position),
            "gobo" => Some(AttributeCategoryAst::Gobo),
            "color" | "colour" => Some(AttributeCategoryAst::Color),
            "beam" => Some(AttributeCategoryAst::Beam),
            "focus" => Some(AttributeCategoryAst::Focus),
            "control" => Some(AttributeCategoryAst::Control),
            "other" => Some(AttributeCategoryAst::Other),
            _ => None,
        };
        if let Some(category) = category {
            return Some(AttributeTargetAst::Category(category));
        }
    }
    Some(AttributeTargetAst::Attribute(
        parse_attribute_type_from_tokens(command_str, tokens, AttributeParseSpecId::Standard)?,
    ))
}

fn value_operator_mode(token: &LexerToken) -> Option<ParameterValueMode> {
    match token.kind {
        LexerTokenKind::AtSign => Some(ParameterValueMode::Absolute),
        LexerTokenKind::Tilde => Some(ParameterValueMode::Relative),
        _ => None,
    }
}

/// Parses an optional timing direction qualifier from a timing clause.
fn parse_timing_direction_from_tokens(
    tokens: &[&LexerToken],
) -> Option<Option<TimingDirectionAst>> {
    let token = *tokens.first()?;
    let canonical = canonical_word(token, AliasCanonicalizationContext::default())?;
    if canonical == canonical_token_text(TokenId::In) {
        Some(Some(TimingDirectionAst::In))
    } else if canonical == canonical_token_text(TokenId::Out) {
        Some(Some(TimingDirectionAst::Out))
    } else {
        None
    }
}

enum TimingClauseEvent<'i> {
    Direction {
        start: usize,
        direction: TimingDirectionAst,
    },
    GlobalDuration {
        start: usize,
        value: DurationRangeAst<'i>,
    },
    Override {
        start: usize,
        value: AttributeOverrideAst<'i>,
    },
}

impl TimingClauseEvent<'_> {
    /// Returns the source offset used to order timing fragments and overrides.
    fn start(&self) -> usize {
        match self {
            TimingClauseEvent::Direction { start, .. }
            | TimingClauseEvent::GlobalDuration { start, .. }
            | TimingClauseEvent::Override { start, .. } => *start,
        }
    }
}

/// Returns whether a timing clause contains any parsed directional, default, or override data.
fn timing_clause_has_value<'i>(clause: &TimingClauseAst<'i>) -> bool {
    clause.direction.is_some() || clause.value.is_some() || !clause.overrides.is_empty()
}

/// Converts accumulated duration token spans into one ordered timing event.
fn flush_timing_duration_event<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
    spans: &mut Vec<std::ops::Range<usize>>,
    events: &mut Vec<TimingClauseEvent<'i>>,
) -> Option<()> {
    if spans.is_empty() {
        return Some(());
    }

    let start = spans.first()?.start;
    let value = parse_duration_range_from_tokens(command_str, &tokens_for_spans(tokens, spans))?;
    events.push(TimingClauseEvent::GlobalDuration { start, value });
    spans.clear();
    Some(())
}

/// Builds source-ordered timing events from one parsed timing clause.
fn timing_events_from_clause<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
    branch: &crate::parser::analysis::ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> Option<Vec<TimingClauseEvent<'i>>> {
    let mut events = Vec::new();
    let mut duration_spans = Vec::new();
    let mut direct_items = branch
        .consumed_items
        .iter()
        .filter(|item| {
            item.clause == *clause
                && matches!(
                    item.slot.slot,
                    crate::slots::contracts::SlotId::TimingsDirection
                        | crate::slots::contracts::SlotId::TimingsGlobalDuration
                )
        })
        .collect::<Vec<_>>();
    direct_items.sort_by_key(|item| (item.source_span.start, item.source_span.end));

    for item in direct_items {
        match item.slot.slot {
            crate::slots::contracts::SlotId::TimingsDirection => {
                flush_timing_duration_event(command_str, tokens, &mut duration_spans, &mut events)?;
                let direction = parse_timing_direction_from_tokens(&tokens_in_span(
                    tokens,
                    item.source_span.start..item.source_span.end,
                ))??;
                events.push(TimingClauseEvent::Direction {
                    start: item.source_span.start,
                    direction,
                });
            }
            crate::slots::contracts::SlotId::TimingsGlobalDuration => {
                duration_spans.push(item.source_span.start..item.source_span.end);
            }
            _ => {}
        }
    }
    flush_timing_duration_event(command_str, tokens, &mut duration_spans, &mut events)?;

    for override_clause in
        child_clause_instances_in_order(branch, clause, ClauseId::ProgrammerTimingOverride)
    {
        let attribute = parse_attribute_type_from_tokens(
            command_str,
            &slot_tokens_in_clause(
                tokens,
                branch,
                &override_clause,
                crate::slots::contracts::SlotId::TimingsOverrideAttribute,
            ),
            AttributeParseSpecId::TimingOverride,
        )?;
        let value = parse_duration_range_from_tokens(
            command_str,
            &slot_tokens_in_clause(
                tokens,
                branch,
                &override_clause,
                crate::slots::contracts::SlotId::TimingsOverrideDuration,
            ),
        )?;
        let start = clause_span(branch, &override_clause)
            .map(|span| span.start)
            .unwrap_or(usize::MAX);
        events.push(TimingClauseEvent::Override {
            start,
            value: AttributeOverrideAst { attribute, value },
        });
    }

    events.sort_by_key(TimingClauseEvent::start);
    Some(events)
}

/// Groups source-ordered timing events into primary and additional timing clauses.
fn timing_clauses_from_events<'i>(
    events: Vec<TimingClauseEvent<'i>>,
) -> Option<Vec<TimingClauseAst<'i>>> {
    let mut clauses = Vec::new();
    let mut current = TimingClauseAst {
        direction: None,
        value: None,
        overrides: Vec::new(),
    };

    for event in events {
        match event {
            TimingClauseEvent::Direction { direction, .. } => {
                if current.direction.is_some()
                    && current.value.is_none()
                    && current.overrides.is_empty()
                {
                    return None;
                }
                if timing_clause_has_value(&current) {
                    clauses.push(current);
                    current = TimingClauseAst {
                        direction: None,
                        value: None,
                        overrides: Vec::new(),
                    };
                }
                current.direction = Some(direction);
            }
            TimingClauseEvent::GlobalDuration { value, .. } => {
                if current.value.is_some() {
                    return None;
                }
                current.value = Some(value);
            }
            TimingClauseEvent::Override { value, .. } => {
                current.overrides.push(value);
            }
        }
    }

    if timing_clause_has_value(&current) {
        clauses.push(current);
    }
    if clauses.is_empty()
        || clauses
            .iter()
            .any(|clause| clause.value.is_none() && clause.overrides.is_empty())
    {
        return None;
    }

    Some(clauses)
}

pub(super) fn materialize_timings<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<Option<TimingsAst<'i>>> {
    let StrictBranchContext {
        command_str,
        tokens,
        branch,
    } = ctx;
    let timing_clauses = clause_instances_in_order(branch, ClauseId::ProgrammerTimings);
    if timing_clauses.is_empty() {
        return Some(None);
    }

    let mut timings = TimingsAst {
        fades: None,
        delays: None,
    };
    for clause in timing_clauses {
        let keyword_tokens = slot_tokens_in_clause(
            tokens,
            branch,
            &clause,
            crate::slots::contracts::SlotId::TimingsKeyword,
        );
        let keyword = keyword_tokens.first()?;
        let is_fade = canonical_word(keyword, AliasCanonicalizationContext::default())?
            == canonical_token_text(TokenId::Fade);
        let mut clauses = timing_clauses_from_events(timing_events_from_clause(
            command_str,
            tokens,
            branch,
            &clause,
        )?)?
        .into_iter();
        let first = clauses.next()?;
        let additional = clauses.collect::<Vec<_>>();

        timings = merge_timings(
            timings,
            if is_fade {
                TimingsAst {
                    fades: Some(FadesAst {
                        direction: first.direction,
                        value: first.value,
                        overrides: first.overrides,
                        additional,
                    }),
                    delays: None,
                }
            } else {
                TimingsAst {
                    fades: None,
                    delays: Some(DelaysAst {
                        direction: first.direction,
                        value: first.value,
                        overrides: first.overrides,
                        additional,
                    }),
                }
            },
        );
    }

    Some(Some(timings))
}

pub(super) fn materialize_attribute_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let StrictBranchContext {
        command_str,
        tokens,
        branch,
    } = ctx;
    let actions = materialize_attribute_actions(ctx)?;
    let timings = materialize_timings(ctx)?;
    let selection_span = merged_slot_span(branch, crate::slots::contracts::SlotId::SelectionSource)
        .or_else(|| {
            let selection_type_span =
                merged_slot_span(branch, crate::slots::contracts::SlotId::SelectionType)?;
            let ids_span =
                merged_slot_span(branch, crate::slots::contracts::SlotId::SelectionIdentifier)?;
            combined_span(&[selection_type_span, ids_span])
        });
    if let Some(selection_span) = selection_span {
        let selection_source = &command_str[selection_span.start..selection_span.end];
        let selection = parse_selection_argument_from_tokens(
            command_str,
            &tokens_in_span(tokens, selection_span),
            &[
                SelectionTypeAst::Fixture,
                SelectionTypeAst::Group,
                SelectionTypeAst::Parameter,
            ],
        )?;
        let _ = selection_source;
        Some(CommandAst::Attribute(AttributeCommandAst {
            selection,
            actions,
            timings,
        }))
    } else {
        Some(CommandAst::ActiveSelectionAttribute(
            ActiveSelectionAttributeCommandAst { actions, timings },
        ))
    }
}

pub(super) fn materialize_fixture_placement_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let StrictBranchContext {
        command_str,
        tokens,
        branch,
    } = ctx;
    let selection_type_span =
        merged_slot_span(branch, crate::slots::contracts::SlotId::SelectionType)?;
    let ids_span = merged_slot_span(branch, crate::slots::contracts::SlotId::SelectionIdentifier)?;
    let selection_span = combined_span(&[selection_type_span, ids_span])?;
    let selection =
        parse_selection_from_tokens(command_str, &tokens_in_span(tokens, selection_span))?;
    if !matches!(selection.selection_type, SelectionTypeAst::Fixture) {
        return None;
    }
    let placement_clause = clause_instances_in_order(branch, ClauseId::ProgrammerPlacement3d)
        .into_iter()
        .next()?;
    let placement_tokens = tokens_in_span(tokens, clause_span(branch, &placement_clause)?)
        .into_iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    let actions = parse_placement_actions_from_tokens(command_str, &placement_tokens)?;

    Some(CommandAst::FixturePlacement(FixturePlacementCommandAst {
        _fixture: FixtureKeyword,
        ids: selection.ids,
        actions,
    }))
}

pub(super) fn materialize_channel_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let StrictBranchContext {
        command_str,
        tokens,
        branch,
    } = ctx;
    let channels = parse_dmx_channel_expression_from_tokens(&slot_tokens(
        tokens,
        branch,
        crate::slots::contracts::SlotId::ChannelOverrideIdentifier,
    ))?;
    let value_tokens = last_slot_span_matching(
        branch,
        crate::slots::contracts::SlotId::ChannelOverrideValue,
        |item| item.surface.trim() != "@",
    )
    .or_else(|| {
        merged_slot_span(
            branch,
            crate::slots::contracts::SlotId::ChannelOverrideValue,
        )
    })
    .map(|span| tokens_in_span(tokens, span))?;
    Some(CommandAst::Channel(ChannelCommandAst {
        _channel: ChannelKeyword,
        channels,
        value: parse_decimal_value_from_tokens(command_str, &value_tokens)?,
    }))
}
