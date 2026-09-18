// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::branch_view::{clause_instances_in_order, clause_span, slot_tokens, tokens_in_span};
use super::context::StrictBranchContext;
use super::*;
use crate::ast::FxValueSourceAst;

fn significant_tokens(tokens: &[LexerToken]) -> Vec<&LexerToken> {
    tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

fn action_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        action_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

fn parse_duration_value_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, DurationValueAst<'i>)> {
    let max_len = tokens.len().min(5);
    for consumed in (1..=max_len).rev() {
        let surface = match super::trimmed_slice_for_tokens(command_str, &tokens[..consumed]) {
            Some(surface) => surface,
            None => continue,
        };
        let parsed = match super::parse_duration_value_slice(surface) {
            Some(parsed) => parsed,
            None => continue,
        };
        return Some((consumed, super::materialize_duration_value(surface, parsed)));
    }

    None
}

fn parse_curve_name_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, CurveNameAst<'i>)> {
    let first = tokens.first()?;
    let lowered = first.text.to_ascii_lowercase();
    match lowered.as_str() {
        "linear" => Some((1, CurveNameAst::Linear)),
        "easein" => Some((1, CurveNameAst::Easein)),
        "easeout" => Some((1, CurveNameAst::Easeout)),
        "ease" => Some((1, CurveNameAst::Ease)),
        "snap" => Some((1, CurveNameAst::Snap)),
        "bezier" => {
            let [_, open, x1_tokens @ ..] = tokens else {
                return None;
            };
            (open.kind == LexerTokenKind::LeftParen).then_some(())?;
            let (x1_len, x1) = super::parse_decimal_value_from_tokens(command_str, x1_tokens)
                .map(|value| (1, value))
                .or_else(|| parse_decimal_component_from_tokens(command_str, x1_tokens))?;
            let comma1 = x1_tokens.get(x1_len)?;
            (comma1.kind == LexerTokenKind::Comma).then_some(())?;
            let y1_tokens = &x1_tokens[x1_len + 1..];
            let (y1_len, y1) = parse_decimal_component_from_tokens(command_str, y1_tokens)?;
            let comma2 = y1_tokens.get(y1_len)?;
            (comma2.kind == LexerTokenKind::Comma).then_some(())?;
            let x2_tokens = &y1_tokens[y1_len + 1..];
            let (x2_len, x2) = parse_decimal_component_from_tokens(command_str, x2_tokens)?;
            let comma3 = x2_tokens.get(x2_len)?;
            (comma3.kind == LexerTokenKind::Comma).then_some(())?;
            let y2_tokens = &x2_tokens[x2_len + 1..];
            let (y2_len, y2) = parse_decimal_component_from_tokens(command_str, y2_tokens)?;
            let close = y2_tokens.get(y2_len)?;
            (close.kind == LexerTokenKind::RightParen).then_some(())?;
            Some((
                2 + x1_len + 1 + y1_len + 1 + x2_len + 1 + y2_len + 1,
                CurveNameAst::Bezier(BezierControlPointsAst { x1, y1, x2, y2 }),
            ))
        }
        _ => None,
    }
}

fn parse_decimal_component_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, ValueAst<'i>)> {
    let max_len = tokens.len().min(4);
    for len in (1..=max_len).rev() {
        if let Some(value) = super::parse_decimal_value_from_tokens(command_str, &tokens[..len]) {
            return Some((len, value));
        }
    }
    None
}

/// Parse one FX step value and shaping suffix, returning the consumed token count.
fn parse_fx_step_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, FxStepAst<'i>)> {
    let (source, mut consumed) = match tokens.first()?.kind {
        LexerTokenKind::AtSign => {
            if let Some((source_len, source)) =
                super::parse_blueprint_source_from_tokens(command_str, &tokens[1..])
            {
                (FxValueSourceAst::Blueprint(source), 1 + source_len)
            } else {
                let (value_len, value) =
                    parse_decimal_component_from_tokens(command_str, &tokens[1..])?;
                (
                    FxValueSourceAst::Direct {
                        mode: ParameterValueMode::Absolute,
                        value,
                    },
                    1 + value_len,
                )
            }
        }
        LexerTokenKind::Tilde => {
            let (value_len, value) =
                parse_decimal_component_from_tokens(command_str, &tokens[1..])?;
            (
                FxValueSourceAst::Direct {
                    mode: ParameterValueMode::Relative,
                    value,
                },
                1 + value_len,
            )
        }
        _ => {
            let (value_len, value) = parse_decimal_component_from_tokens(command_str, tokens)?;
            (
                FxValueSourceAst::Direct {
                    mode: ParameterValueMode::Absolute,
                    value,
                },
                value_len,
            )
        }
    };
    let mut width = None;
    let mut ramp = None;

    if tokens
        .get(consumed)
        .and_then(|token| canonical_word(token, AliasCanonicalizationContext::default()))
        .as_deref()
        == Some("width")
    {
        let (len, parsed) =
            parse_decimal_component_from_tokens(command_str, &tokens[consumed + 1..])?;
        width = Some(parsed);
        consumed += 1 + len;
    }

    if tokens
        .get(consumed)
        .and_then(|token| canonical_word(token, AliasCanonicalizationContext::default()))
        .as_deref()
        == Some("ramp")
    {
        let (len, parsed) =
            parse_decimal_component_from_tokens(command_str, &tokens[consumed + 1..])?;
        ramp = Some(parsed);
        consumed += 1 + len;
    }

    let curve =
        parse_curve_name_from_tokens(command_str, &tokens[consumed..]).map(|(len, curve)| {
            consumed += len;
            curve
        });

    Some((
        consumed,
        FxStepAst {
            source,
            width,
            ramp,
            curve,
        },
    ))
}

fn parse_fx_attribute_steps_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, FxAttributeStepsAst<'i>)> {
    let attribute = parse_attribute_type_from_tokens(
        command_str,
        std::slice::from_ref(tokens.first()?),
        AttributeParseSpecId::Standard,
    )?;
    let mut consumed = 1;
    let mut base_value = None;

    if tokens
        .get(consumed)
        .is_some_and(|token| token.kind == LexerTokenKind::AtSign)
    {
        if let Some((len, source)) =
            super::parse_blueprint_source_from_tokens(command_str, &tokens[consumed + 1..])
        {
            base_value = Some(FxValueSourceAst::Blueprint(source));
            consumed += 1 + len;
        } else {
            let (len, value) =
                parse_decimal_component_from_tokens(command_str, &tokens[consumed + 1..])?;
            base_value = Some(FxValueSourceAst::Direct {
                mode: ParameterValueMode::Absolute,
                value,
            });
            consumed += 1 + len;
        }
    }

    let steps_token = tokens.get(consumed)?;
    (steps_token.text.eq_ignore_ascii_case("steps")).then_some(())?;
    consumed += 1;

    let (first_len, first_step) = parse_fx_step_from_tokens(command_str, &tokens[consumed..])?;
    consumed += first_len;
    let mut steps = vec![first_step];

    while let Some((len, step)) = parse_fx_step_from_tokens(command_str, &tokens[consumed..]) {
        steps.push(step);
        consumed += len;
    }

    Some((
        consumed,
        FxAttributeStepsAst {
            attribute,
            base_value,
            steps,
        },
    ))
}

fn parse_fx_step_selection_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<(usize, SelectionArgumentAst<'i>)> {
    let selection_end = (1..tokens.len()).find(|&split| {
        parse_selection_argument_from_tokens(
            command_str,
            &tokens[..split],
            &[SelectionTypeAst::Fixture, SelectionTypeAst::Group],
        )
        .is_some()
            && parse_duration_value_from_tokens(command_str, &tokens[split..]).is_some()
    })?;
    Some((
        selection_end,
        parse_selection_argument_from_tokens(
            command_str,
            &tokens[..selection_end],
            &[SelectionTypeAst::Fixture, SelectionTypeAst::Group],
        )?,
    ))
}

fn parse_create_step_fx_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<CreateStepFxAst<'i>> {
    let first = tokens.first()?;
    (canonical_word(first, action_alias_context())?.as_str()
        == canonical_token_text(TokenId::Step))
    .then_some(())?;

    let (selection_len, selection) =
        parse_fx_step_selection_from_tokens(command_str, &tokens[1..])?;
    let mut consumed = 1 + selection_len;
    let (duration_len, duration) =
        parse_duration_value_from_tokens(command_str, &tokens[consumed..])?;
    consumed += duration_len;

    let mut base_value = None;
    if tokens
        .get(consumed)
        .is_some_and(|token| token.kind == LexerTokenKind::AtSign)
    {
        let (len, value) =
            parse_decimal_component_from_tokens(command_str, &tokens[consumed + 1..])?;
        base_value = Some(value);
        consumed += 1 + len;
    }

    let (first_attr_len, first_attr) =
        parse_fx_attribute_steps_from_tokens(command_str, &tokens[consumed..])?;
    consumed += first_attr_len;
    let mut attributes = vec![first_attr];

    while consumed < tokens.len() {
        let (len, attr) = parse_fx_attribute_steps_from_tokens(command_str, &tokens[consumed..])?;
        attributes.push(attr);
        consumed += len;
    }

    Some(CreateStepFxAst {
        selection,
        duration,
        base_value,
        attributes,
    })
}

pub(super) fn parse_fx_action_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<FxActionAst<'i>> {
    let first = tokens.first()?;
    let action = canonical_word(first, action_alias_context())?;
    match action.as_str() {
        canonical if canonical == canonical_token_text(TokenId::Start) && tokens.len() == 1 => {
            Some(FxActionAst::Start)
        }
        canonical if canonical == canonical_token_text(TokenId::Stop) && tokens.len() == 1 => {
            Some(FxActionAst::Stop)
        }
        canonical if canonical == canonical_token_text(TokenId::Rate) => {
            Some(FxActionAst::SetRate(SetFxRateAst {
                value: parse_decimal_value_from_tokens(command_str, &tokens[1..])?,
            }))
        }
        canonical if canonical == canonical_token_text(TokenId::Step) => Some(
            FxActionAst::CreateStep(parse_create_step_fx_from_tokens(command_str, tokens)?),
        ),
        _ => None,
    }
}

/// Builds an FX Module action from the identifier and verb accepted by its structural clause.
pub(super) fn materialize_fx_module_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let fx_id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::FxModuleIdentifier,
    )?;
    let actions = slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::FxModuleAction,
    );
    let [action] = actions.as_slice() else {
        return None;
    };
    let action = match canonical_word(action, action_alias_context())?.as_str() {
        "start" => FxModuleActionAst::Start,
        "stop" => FxModuleActionAst::Stop,
        _ => return None,
    };
    Some(CommandAst::FxModule(FxModuleCommandAst {
        _fx: FxKeyword,
        fx_id,
        action,
    }))
}

pub(super) fn materialize_fx_ast<'i>(ctx: StrictBranchContext<'i, '_>) -> Option<CommandAst<'i>> {
    let fx_id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::FxIdentifier,
    )?;
    let mut action_tokens = slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::FxAction,
    );
    if let Some(step_clause) = clause_instances_in_order(ctx.branch, ClauseId::StepFx)
        .into_iter()
        .next()
    {
        action_tokens.extend(tokens_in_span(
            ctx.tokens,
            clause_span(ctx.branch, &step_clause)?,
        ));
    }
    let action = parse_fx_action_from_tokens(ctx.command_str, &action_tokens)?;
    Some(CommandAst::Fx(FxCommandAst {
        _fx: FxKeyword,
        fx_id,
        action,
    }))
}

/// Materializes a stored step FX from the structurally committed store and step clauses.
pub(super) fn materialize_store_step_fx_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let id = parse_slot_identifier_expression_from_tokens(
        ctx.command_str,
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::StoreObjectIdentifier,
    )?;
    let step_clause = clause_instances_in_order(ctx.branch, ClauseId::StepFx)
        .into_iter()
        .next()?;
    let action = parse_fx_action_from_tokens(
        ctx.command_str,
        &tokens_in_span(ctx.tokens, clause_span(ctx.branch, &step_clause)?),
    )?;
    let FxActionAst::CreateStep(definition) = action else {
        return None;
    };

    Some(CommandAst::General(GeneralCommandAst::StoreStepFx(
        StoreStepFxCommandAst {
            _fx: FxKeyword,
            id,
            definition,
        },
    )))
}

/// Materializes a stored FX module from its structurally committed payload clause.
pub(super) fn materialize_store_fx_module_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    clause_instances_in_order(ctx.branch, ClauseId::StoreFxModule)
        .into_iter()
        .next()?;
    let significant = significant_tokens(ctx.tokens);
    let [store, fx, payload @ ..] = significant.as_slice() else {
        return None;
    };
    (crate::lexicon::tokens::token_id_for_text(store.text.as_str()) == Some(TokenId::Store)
        && crate::lexicon::tokens::token_id_for_text(fx.text.as_str()) == Some(TokenId::Fx))
    .then_some(())?;
    super::parse_store_fx_module_command_from_tokens(ctx.command_str, payload)
}
