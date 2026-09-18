// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::str::FromStr;

use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use thiserror::Error;

use crate::ast;

/// Maximum number of concrete object IDs one store command may expand into.
pub const MAX_STORE_IDENTIFIER_EXPANSION: usize = 32_736;

/// Reasons a parsed command AST cannot be converted into an engine command.
#[derive(Debug, Error)]
pub enum AstConvError {
    #[error("no match: {0}")]
    NoMatch(&'static str),
    #[error("invalid value: {0}")]
    Invalid(&'static str),
    #[error("identifier expression expands to more than {limit} IDs")]
    TooManyIdentifiers { limit: usize },
}

/// Extracts a single fixture ID from an identifier expression when it resolves to one fixture reference.
pub fn identifier_ast_to_single_id(id_ast: &ast::IdentifierExpressionAst) -> Option<u32> {
    // Simple extraction: accept a single numeric identifier with no set ops.
    match &id_ast.head {
        ast::TermAst::Single(single) => {
            // SingleIdAst contains a TargetAst
            match &single.target {
                ast::TargetAst::FixtureRef { fixture_id } => Some(*fixture_id),
                ast::TargetAst::ElementRef {
                    fixture_id,
                    element_index: _,
                } => Some(*fixture_id),
            }
        }
        ast::TermAst::Grouped(grouped) => {
            // GroupedExprAst wraps an IdentifierExpressionAst
            // Try to extract a single id from its head if present
            let inner = &grouped.expr;
            match &inner.head {
                ast::TermAst::Single(single) => match &single.target {
                    ast::TargetAst::FixtureRef { fixture_id } => Some(*fixture_id),
                    ast::TargetAst::ElementRef {
                        fixture_id,
                        element_index: _,
                    } => Some(*fixture_id),
                },
                _ => None,
            }
        }
        _ => None,
    }
}

/// Extract a single integer ID from a SimpleIdentifierExpressionAst.
/// These expressions only allow integer IDs (no decimal notation).
pub fn simple_identifier_ast_to_single_id(
    id_ast: &ast::SimpleIdentifierExpressionAst,
) -> Option<u32> {
    // Simple extraction: accept a single numeric identifier with no set ops.
    match &id_ast.head {
        ast::SimpleTermAst::Single(single) => Some(single.id),
        ast::SimpleTermAst::Grouped(grouped) => {
            let inner = &grouped.expr;
            match &inner.head {
                ast::SimpleTermAst::Single(single) => Some(single.id),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Convert SimpleIdentifierExpressionAst -> IdExpr.
/// Used for commands that accept ID ranges (delete, rename, etc.).
pub fn simple_identifier_ast_to_idexpr(
    id_ast: &ast::SimpleIdentifierExpressionAst,
) -> Result<IdExpr, AstConvError> {
    let mut expr = simple_term_to_idexpr(&id_ast.head)?;
    for op in &id_ast.tail {
        let rhs = simple_term_to_idexpr(&op.term)?;
        expr = match op.op {
            ast::SetOperatorAst::Add => IdExpr::Add {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
            ast::SetOperatorAst::Remove => IdExpr::Sub {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
        };
    }
    Ok(expr)
}

/// Expands a simple identifier expression into concrete IDs in expression order.
pub fn simple_identifier_ast_to_ids(
    id_ast: &ast::SimpleIdentifierExpressionAst,
) -> Result<Vec<u32>, AstConvError> {
    let ids = expand_idexpr_bounded(
        &simple_identifier_ast_to_idexpr(id_ast)?,
        MAX_STORE_IDENTIFIER_EXPANSION,
    )?;
    if ids.is_empty() {
        return Err(AstConvError::Invalid("identifier expression"));
    }
    Ok(ids)
}

/// Expands an identifier expression while bounding every intermediate allocation.
fn expand_idexpr_bounded(expr: &IdExpr, limit: usize) -> Result<Vec<u32>, AstConvError> {
    match expr {
        IdExpr::Single(id) => {
            if limit == 0 {
                return Err(AstConvError::TooManyIdentifiers { limit });
            }
            Ok(vec![*id])
        }
        IdExpr::Label(_) => Ok(Vec::new()),
        IdExpr::Range { start, end } => {
            let count = u64::from(start.abs_diff(*end)) + 1;
            if count > limit as u64 {
                return Err(AstConvError::TooManyIdentifiers { limit });
            }

            if start <= end {
                Ok((*start..=*end).collect())
            } else {
                Ok((*end..=*start).rev().collect())
            }
        }
        IdExpr::Add { lhs, rhs } => {
            let mut ids = expand_idexpr_bounded(lhs, limit)?;
            let remaining = limit.saturating_sub(ids.len());
            let additional = expand_idexpr_bounded(rhs, remaining)
                .map_err(|_| AstConvError::TooManyIdentifiers { limit })?;
            ids.extend(additional);
            Ok(ids)
        }
        IdExpr::Sub { lhs, rhs } => {
            let mut ids = expand_idexpr_bounded(lhs, limit)?;
            let removed = expand_idexpr_bounded(rhs, limit)?
                .into_iter()
                .collect::<std::collections::HashSet<_>>();
            ids.retain(|id| !removed.contains(id));
            Ok(ids)
        }
        IdExpr::Span(inner) => expand_idexpr_bounded(inner, limit),
    }
}

/// Converts a simple identifier term into an `IdExpr`, preserving grouping and ranges.
fn simple_term_to_idexpr(term: &ast::SimpleTermAst) -> Result<IdExpr, AstConvError> {
    match term {
        ast::SimpleTermAst::Grouped(g) => Ok(IdExpr::Span(Box::new(
            simple_identifier_ast_to_idexpr(&g.expr)?,
        ))),
        ast::SimpleTermAst::Range(r) => Ok(IdExpr::Range {
            start: r.start.id,
            end: r.end.id,
        }),
        ast::SimpleTermAst::Single(s) => Ok(IdExpr::Single(s.id)),
    }
}

/// Convert SelectionAst -> common::SelectionExpr
pub fn selection_from_ast(sel: &ast::SelectionAst) -> Result<SelectionExpr, AstConvError> {
    // Convert selection AST into runtime SelectionExpr/IdExpr
    match sel.selection_type {
        ast::SelectionTypeAst::Fixture => Ok(identifier_expression_to_selection(&sel.ids)),
        ast::SelectionTypeAst::Group => {
            let idexpr = identifier_expression_to_idexpr(&sel.ids)
                .map_err(|_| AstConvError::Invalid("id expr"))?;
            Ok(SelectionExpr::Group(idexpr.into()))
        }
        _ => Err(AstConvError::NoMatch("unsupported selection type")),
    }
}

/// Converts an identifier-expression AST into a selection expression with set operators.
pub fn identifier_expression_to_selection(ids: &ast::IdentifierExpressionAst) -> SelectionExpr {
    let mut expr = term_to_selection(&ids.head);
    for op in &ids.tail {
        let rhs = term_to_selection(&op.term);
        expr = match op.op {
            ast::SetOperatorAst::Add => SelectionExpr::Add {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
            ast::SetOperatorAst::Remove => SelectionExpr::Sub {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
        };
    }
    expr
}

/// Converts one identifier term into a `SelectionExpr` leaf or grouped span.
pub fn term_to_selection(term: &ast::TermAst) -> SelectionExpr {
    match term {
        ast::TermAst::Grouped(g) => {
            SelectionExpr::Span(Box::new(identifier_expression_to_selection(&g.expr)))
        }
        ast::TermAst::FixtureMap(map) => SelectionExpr::FixtureMap {
            fixtures: fixture_range_from_ast(&map.fixtures),
            elements: element_selector_from_ast(&map.elements),
        },
        ast::TermAst::Range(r) => {
            let start = singleid_to_unresolved(&r.start);
            let end = singleid_to_unresolved(&r.end);
            SelectionExpr::FixtureRange { start, end }
        }
        ast::TermAst::Single(s) => {
            let target = singleid_to_unresolved(s);
            SelectionExpr::Fixture(target)
        }
    }
}

/// Converts a single fixture or element reference into an unresolved selection target.
pub fn singleid_to_unresolved(s: &ast::SingleIdAst) -> UnresolvedFixtureRef {
    match &s.target {
        ast::TargetAst::FixtureRef { fixture_id } => UnresolvedFixtureRef {
            fixture_id: *fixture_id,
            element_index: None,
        },
        ast::TargetAst::ElementRef {
            fixture_id,
            element_index,
        } => UnresolvedFixtureRef {
            fixture_id: *fixture_id,
            element_index: *element_index,
        },
    }
}

/// Converts an identifier-expression AST into an `IdExpr` for commands that operate on raw IDs.
pub fn identifier_expression_to_idexpr(
    ids: &ast::IdentifierExpressionAst,
) -> Result<IdExpr, AstConvError> {
    let mut expr = term_to_idexpr(&ids.head)?;
    for op in &ids.tail {
        let rhs = term_to_idexpr(&op.term)?;
        expr = match op.op {
            ast::SetOperatorAst::Add => IdExpr::Add {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
            ast::SetOperatorAst::Remove => IdExpr::Sub {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
        };
    }
    Ok(expr)
}

/// Converts one identifier term into an `IdExpr` node.
pub fn term_to_idexpr(term: &ast::TermAst) -> Result<IdExpr, AstConvError> {
    match term {
        ast::TermAst::Grouped(g) => Ok(IdExpr::Span(Box::new(identifier_expression_to_idexpr(
            &g.expr,
        )?))),
        ast::TermAst::FixtureMap(_) => Err(AstConvError::Invalid("fixture map in id expr")),
        ast::TermAst::Range(r) => {
            let start = singleid_to_u32(&r.start)?;
            let end = singleid_to_u32(&r.end)?;
            Ok(IdExpr::Range { start, end })
        }
        ast::TermAst::Single(s) => Ok(IdExpr::Single(singleid_to_u32(s)?)),
    }
}

/// Extracts a plain fixture ID from a single-id AST, rejecting element references.
pub fn singleid_to_u32(s: &ast::SingleIdAst) -> Result<u32, AstConvError> {
    match &s.target {
        ast::TargetAst::FixtureRef { fixture_id } => Ok(*fixture_id),
        ast::TargetAst::ElementRef { .. } => {
            Err(AstConvError::Invalid("element reference in id expr"))
        }
    }
}

/// Converts a fixture-range AST into an inclusive fixture ID range.
fn fixture_range_from_ast(range: &ast::FixtureRangeAst) -> FixtureRangeExpr {
    FixtureRangeExpr {
        start: range.start,
        end: range.end,
    }
}

/// Converts an element-selector AST into the corresponding element selection expression.
fn element_selector_from_ast(selector: &ast::ElementSelectorAst) -> ElementSelectorExpr {
    match selector {
        ast::ElementSelectorAst::Single(index) => ElementSelectorExpr::Single(*index),
        ast::ElementSelectorAst::Range { start, end } => ElementSelectorExpr::Range {
            start: *start,
            end: *end,
        },
    }
}

/// Convert Duration AST (ValueAst) -> seconds as f32
pub fn duration_from_ast(d: &ast::DurationValueAst) -> Result<f32, AstConvError> {
    // Parse the numeric value
    let s = d.value.0;
    let val: f32 = s.parse().map_err(|_| AstConvError::Invalid("duration"))?;

    if let Some(unit) = &d.unit {
        let u = unit.0.to_ascii_lowercase();
        match u.as_str() {
            "bpm" => Ok(60.0 / val),
            "hz" => Ok(1.0 / val),
            "ms" => Ok(val / 1000.0),
            "s" => Ok(val),
            _ => Ok(val),
        }
    } else {
        Ok(val)
    }
}

/// Convert ValueAst -> absolute percent parameter value.
pub fn parameter_value_from_ast(v: &ast::ValueAst) -> Result<ParameterValue, AstConvError> {
    parameter_value_from_ast_with_mode(v, ast::ParameterValueMode::Absolute)
}

/// Convert ValueAst -> parameter value using the provided absolute/relative mode.
pub fn parameter_value_from_ast_with_mode(
    v: &ast::ValueAst,
    mode: ast::ParameterValueMode,
) -> Result<ParameterValue, AstConvError> {
    let s = v.0;
    let numeric_value = s
        .parse::<f32>()
        .map_err(|_| AstConvError::Invalid("value"))?;
    let percentage = Percentage::from(numeric_value / 100.0);
    if mode == ast::ParameterValueMode::Relative {
        Ok(ParameterValue::RelativePercent { offset: percentage })
    } else {
        Ok(ParameterValue::AbsolutePercent { value: percentage })
    }
}

/// Convert ValueRangeAst -> Vec<ParameterValue> for fanned values
pub fn parameter_values_from_range_ast(
    range: &ast::ValueRangeAst,
) -> Result<Vec<ParameterValue>, AstConvError> {
    range
        .values
        .iter()
        .map(|value| parameter_value_from_ast_with_mode(value, range.mode))
        .collect()
}

/// Convert ValueRangeAst -> Vec<ParameterValue> and validate absolute signs for an attribute.
pub fn parameter_values_from_range_ast_for_attribute(
    range: &ast::ValueRangeAst,
    attribute: &Attribute,
) -> Result<Vec<ParameterValue>, AstConvError> {
    let values = parameter_values_from_range_ast(range)?;
    validate_parameter_values_for_attribute(&values, attribute)?;
    Ok(values)
}

/// Ensures unsigned parameters do not receive absolute negative percent values.
pub fn validate_parameter_values_for_attribute(
    values: &[ParameterValue],
    attribute: &Attribute,
) -> Result<(), AstConvError> {
    if attribute.value_polarity() == ParameterValuePolarity::Signed {
        return Ok(());
    }
    for value in values {
        if let ParameterValue::AbsolutePercent { value } = value {
            let percent = value.as_f32();
            if percent < 0.0 {
                return Err(AstConvError::Invalid("unsigned absolute value"));
            }
        }
    }
    Ok(())
}

/// Convert ValueRangeAst -> ValueSource
/// - Single value -> ValueSource::Inline
/// - Multiple values -> ValueSource::Fanned
pub fn value_source_from_range_ast(
    range: &ast::ValueRangeAst,
) -> Result<nightfall::prelude::ValueSource, AstConvError> {
    if let Some(marker) = value_marker_source_from_range_ast(range)? {
        return Ok(marker);
    }

    let values = parameter_values_from_range_ast(range)?;
    Ok(if values.len() == 1 {
        nightfall::prelude::ValueSource::Inline(values.into_iter().next().unwrap())
    } else {
        nightfall::prelude::ValueSource::Fanned { values }
    })
}

/// Convert ValueRangeAst -> ValueSource and validate absolute signs for an attribute.
pub fn value_source_from_range_ast_for_attribute(
    range: &ast::ValueRangeAst,
    attribute: &Attribute,
) -> Result<nightfall::prelude::ValueSource, AstConvError> {
    if let Some(marker) = value_marker_source_from_range_ast(range)? {
        return Ok(marker);
    }

    let values = parameter_values_from_range_ast_for_attribute(range, attribute)?;
    Ok(if values.len() == 1 {
        nightfall::prelude::ValueSource::Inline(values.into_iter().next().unwrap())
    } else {
        nightfall::prelude::ValueSource::Fanned { values }
    })
}

/// Converts a single symbolic marker range into a cue value source.
fn value_marker_source_from_range_ast(
    range: &ast::ValueRangeAst,
) -> Result<Option<nightfall::prelude::ValueSource>, AstConvError> {
    let marker_values = range
        .values
        .iter()
        .filter_map(|value| ast::ValueMarkerAst::parse(value.0))
        .collect::<Vec<_>>();

    if marker_values.is_empty() {
        return Ok(None);
    }
    if marker_values.len() != 1 || range.values.len() != 1 {
        return Err(AstConvError::Invalid("mixed marker value fan"));
    }
    if range.mode == ast::ParameterValueMode::Relative {
        return Err(AstConvError::Invalid("relative marker value"));
    }

    Ok(Some(match marker_values[0] {
        ast::ValueMarkerAst::Release => nightfall::prelude::ValueSource::Release,
        ast::ValueMarkerAst::HoldPosition => nightfall::prelude::ValueSource::HoldPosition,
    }))
}

/// Convert attribute AST to runtime Attribute.
pub fn attribute_type_from_ast(attribute: &ast::AttributeTypeAst<'_>) -> Attribute {
    match attribute {
        ast::AttributeTypeAst::Aliased(alias) => {
            let name = format!("{alias:?}");
            Attribute::from_str(&name).unwrap_or(Attribute::Custom { label: name })
        }
        ast::AttributeTypeAst::Quoted(quoted) => {
            Attribute::from_str(quoted).unwrap_or_else(|_| Attribute::Custom {
                label: quoted.to_string(),
            })
        }
        ast::AttributeTypeAst::Other(other) => {
            Attribute::from_str(other).unwrap_or_else(|_| Attribute::Custom {
                label: other.to_string(),
            })
        }
    }
}

/// Convert DmxChannelExpressionAst -> DmxChannelExpr
pub fn dmx_channel_expression_from_ast(expr: &ast::DmxChannelExpressionAst) -> DmxChannelExpr {
    let mut result = dmx_channel_term_to_expr(&expr.head);
    for op in &expr.tail {
        let rhs = dmx_channel_term_to_expr(&op.term);
        result = match op.op {
            ast::SetOperatorAst::Add => DmxChannelExpr::Add {
                lhs: Box::new(result),
                rhs: Box::new(rhs),
            },
            ast::SetOperatorAst::Remove => DmxChannelExpr::Sub {
                lhs: Box::new(result),
                rhs: Box::new(rhs),
            },
        };
    }
    result
}

/// Converts one DMX channel term into a `DmxChannelExpr` node.
fn dmx_channel_term_to_expr(term: &ast::DmxChannelTermAst) -> DmxChannelExpr {
    match term {
        ast::DmxChannelTermAst::Grouped(g) => {
            DmxChannelExpr::Span(Box::new(dmx_channel_expression_from_ast(&g.expr)))
        }
        ast::DmxChannelTermAst::Range(r) => {
            let start = dmx_channel_ref_from_ast(&r.start.channel);
            let end = dmx_channel_ref_from_ast(&r.end.channel);
            DmxChannelExpr::Range { start, end }
        }
        ast::DmxChannelTermAst::Single(s) => {
            let ch = dmx_channel_ref_from_ast(&s.channel);
            DmxChannelExpr::Single(ch)
        }
    }
}

/// Converts a parsed DMX channel reference into a concrete `DmxChannelRef`.
fn dmx_channel_ref_from_ast(ch: &ast::DmxChannelRefAst) -> DmxChannelRef {
    DmxChannelRef {
        universe: ch.universe,
        address: ch.address,
    }
}

/// Convert release DMX channel expression AST into DMX channel expression.
///
/// Universe shorthand like `5.` is normalized to range `5.1>5.512`.
pub fn release_dmx_channel_expression_from_ast(
    expr: &ast::ReleaseDmxChannelExpressionAst,
) -> Result<DmxChannelExpr, AstConvError> {
    let mut result = release_dmx_channel_term_to_expr(&expr.head)?;
    for op in &expr.tail {
        let rhs = release_dmx_channel_term_to_expr(&op.term)?;
        result = match op.op {
            ast::SetOperatorAst::Add => DmxChannelExpr::Add {
                lhs: Box::new(result),
                rhs: Box::new(rhs),
            },
            ast::SetOperatorAst::Remove => DmxChannelExpr::Sub {
                lhs: Box::new(result),
                rhs: Box::new(rhs),
            },
        };
    }
    Ok(result)
}

/// Converts one release-target DMX term into a `DmxChannelExpr`, expanding universe shorthand where needed.
fn release_dmx_channel_term_to_expr(
    term: &ast::ReleaseDmxChannelTermAst,
) -> Result<DmxChannelExpr, AstConvError> {
    match term {
        ast::ReleaseDmxChannelTermAst::Grouped(grouped) => Ok(DmxChannelExpr::Span(Box::new(
            release_dmx_channel_expression_from_ast(&grouped.expr)?,
        ))),
        ast::ReleaseDmxChannelTermAst::Range(range) => {
            let max_address = max_dmx_address()?;
            let start = release_dmx_channel_ref_from_ast(&range.start.channel, 1);
            let end = release_dmx_channel_ref_from_ast(&range.end.channel, max_address);
            Ok(DmxChannelExpr::Range { start, end })
        }
        ast::ReleaseDmxChannelTermAst::Single(single) => release_dmx_single_from_ast(single),
    }
}

/// Converts a single release DMX target into either one channel or a full-universe range.
fn release_dmx_single_from_ast(
    single: &ast::ReleaseDmxChannelSingleAst,
) -> Result<DmxChannelExpr, AstConvError> {
    let max_address = max_dmx_address()?;
    if let Some(address) = single.channel.address {
        return Ok(DmxChannelExpr::Single(DmxChannelRef {
            universe: single.channel.universe,
            address,
        }));
    }

    Ok(DmxChannelExpr::Range {
        start: DmxChannelRef {
            universe: single.channel.universe,
            address: 1,
        },
        end: DmxChannelRef {
            universe: single.channel.universe,
            address: max_address,
        },
    })
}

/// Converts a parsed release DMX reference, filling in the default address when it is omitted.
fn release_dmx_channel_ref_from_ast(
    ch: &ast::ReleaseDmxChannelRefAst,
    default_address: u16,
) -> DmxChannelRef {
    DmxChannelRef {
        universe: ch.universe,
        address: ch.address.unwrap_or(default_address),
    }
}

/// Returns the highest DMX address supported by the runtime as a `u16`.
fn max_dmx_address() -> Result<u16, AstConvError> {
    u16::try_from(MAX_CHANNELS_PER_UNIVERSE).map_err(|_| AstConvError::Invalid("dmx max address"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the configured store expansion boundary remains inclusive.
    #[test]
    fn bounded_store_expansion_accepts_the_maximum_size() {
        let ids = expand_idexpr_bounded(
            &IdExpr::Range {
                start: 1,
                end: MAX_STORE_IDENTIFIER_EXPANSION as u32,
            },
            MAX_STORE_IDENTIFIER_EXPANSION,
        )
        .expect("the maximum permitted range should expand");

        assert_eq!(ids.len(), MAX_STORE_IDENTIFIER_EXPANSION);
        assert_eq!(ids.first(), Some(&1));
        assert_eq!(ids.last(), Some(&(MAX_STORE_IDENTIFIER_EXPANSION as u32)));
    }

    /// Verifies a full-width range is rejected before allocating its members.
    #[test]
    fn bounded_store_expansion_rejects_oversized_range() {
        let error = expand_idexpr_bounded(
            &IdExpr::Range {
                start: 0,
                end: u32::MAX,
            },
            MAX_STORE_IDENTIFIER_EXPANSION,
        )
        .expect_err("an oversized range should be rejected");

        assert!(matches!(
            error,
            AstConvError::TooManyIdentifiers {
                limit: MAX_STORE_IDENTIFIER_EXPANSION
            }
        ));
    }

    /// Verifies additions cannot exceed the limit through individually valid operands.
    #[test]
    fn bounded_store_expansion_rejects_oversized_addition() {
        let error = expand_idexpr_bounded(
            &IdExpr::Add {
                lhs: Box::new(IdExpr::Range {
                    start: 1,
                    end: MAX_STORE_IDENTIFIER_EXPANSION as u32,
                }),
                rhs: Box::new(IdExpr::Single(1)),
            },
            MAX_STORE_IDENTIFIER_EXPANSION,
        )
        .expect_err("an addition beyond the expansion limit should be rejected");

        assert!(matches!(error, AstConvError::TooManyIdentifiers { .. }));
    }
}
