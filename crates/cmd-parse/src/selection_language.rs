// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

pub(crate) mod prefix;

use std::str::FromStr;

use nightfall::prelude::*;
use nightfall_dmx::prelude::Attribute;

use crate::{
    ParseError,
    conv::selection_from_ast,
    parser::{
        lexer::{LexerToken, LexerTokenKind, lex_command},
        strict::parse_selection_ast,
    },
};

/// Parses a selection expression into a `SelectionExpr`, rejecting commands that are not valid selections.
pub fn parse_selection_expr(input: &str) -> Result<SelectionExpr, ParseError> {
    let selection_ast =
        parse_selection_ast(input).map_err(|err| ParseError::Failure(err.to_string()))?;
    selection_from_ast(&selection_ast).map_err(|err| {
        ParseError::Failure(format!("failed to convert selection expression: {err}"))
    })
}

/// Parses a spatial selection expression into a `SpatialSelection`.
pub fn parse_spatial_selection_text(input: &str) -> Result<SpatialSelection, ParseError> {
    if !prefix::analyze_selection_prefix(input).complete {
        return Err(ParseError::Failure(
            "incomplete or invalid spatial selection".to_owned(),
        ));
    }
    let input = input.trim();
    if input.is_empty() {
        return Err(ParseError::Failure("missing spatial selection".to_string()));
    }

    if let Ok(selection) = parse_spatial_selection_pipeline(input) {
        return Ok(selection);
    }

    let segments = split_top_level_additions(input);
    if segments.len() <= 1 {
        return parse_spatial_selection_pipeline(input);
    }

    let mut selections = segments
        .into_iter()
        .map(parse_spatial_selection_pipeline)
        .collect::<Result<Vec<_>, _>>()?;
    let mut selection = selections.remove(0);
    selection.union = selections;
    Ok(selection)
}

/// Parses one source-plus-clause spatial selection pipeline.
fn parse_spatial_selection_pipeline(input: &str) -> Result<SpatialSelection, ParseError> {
    let segments = split_top_level_pipes(input);
    if segments.iter().any(|segment| segment.is_empty()) {
        return Err(ParseError::Failure(
            "missing spatial selection segment".to_string(),
        ));
    }

    let source = parse_spatial_selection_source(segments[0])?;
    let mut clauses = Vec::new();
    for clause_text in &segments[1..] {
        clauses.extend(parse_spatial_clause(clause_text)?);
    }

    Ok(SpatialSelection::pipeline(source, clauses))
}

/// Parses the source segment, preserving grouped spatial pipelines as composable sources.
fn parse_spatial_selection_source(input: &str) -> Result<SelectionExpr, ParseError> {
    let additions = split_top_level_source_additions(input);
    if additions.len() > 1 {
        let mut selections = additions
            .into_iter()
            .map(parse_spatial_selection_source)
            .collect::<Result<Vec<_>, _>>()?;
        let mut selection = selections.remove(0);
        for rhs in selections {
            selection = SelectionExpr::Add {
                lhs: Box::new(selection),
                rhs: Box::new(rhs),
            };
        }
        return Ok(selection);
    }

    if let Some(inner) = strip_enclosing_parentheses(input) {
        if contains_spatial_pipeline(inner) {
            return Ok(SelectionExpr::Spatial(Box::new(
                parse_spatial_selection_text(inner)?,
            )));
        }

        if let Ok(selection) = parse_selection_expr(inner) {
            return Ok(selection);
        }

        return Ok(SelectionExpr::Spatial(Box::new(
            parse_spatial_selection_text(inner)?,
        )));
    }

    if let Some(inner) = strip_enclosing_braces(input) {
        if contains_spatial_pipeline(inner) {
            return Ok(SelectionExpr::Span(Box::new(SelectionExpr::Spatial(
                Box::new(parse_spatial_selection_text(inner)?),
            ))));
        }

        if let Ok(selection) = parse_selection_expr(inner) {
            return Ok(SelectionExpr::Span(Box::new(selection)));
        }

        return Ok(SelectionExpr::Span(Box::new(SelectionExpr::Spatial(
            Box::new(parse_spatial_selection_text(inner)?),
        ))));
    }

    if let Some(label) = parse_quoted_group_label_source(input) {
        return Ok(SelectionExpr::Group(GroupRefExpr::ByLabel(
            label.to_string(),
        )));
    }

    parse_selection_expr(input)
}

/// Splits a spatial selection at top-level clause separators.
fn split_top_level_pipes(input: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut depth = 0u32;
    let mut in_quote = false;
    let mut escaped = false;

    for (index, ch) in input.char_indices() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_quote = false;
            }
            continue;
        }

        match ch {
            '"' => in_quote = true,
            '(' | '{' => depth += 1,
            ')' | '}' => depth = depth.saturating_sub(1),
            '|' if depth == 0 => {
                segments.push(input[start..index].trim());
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }

    segments.push(input[start..].trim());
    segments
}

/// Returns the inner text when one parenthesis pair encloses the whole input.
fn strip_enclosing_parentheses(input: &str) -> Option<&str> {
    strip_enclosing_delimiters(input, LexerTokenKind::LeftParen, LexerTokenKind::RightParen)
}

/// Returns the inner text when one brace pair encloses the whole input.
fn strip_enclosing_braces(input: &str) -> Option<&str> {
    strip_enclosing_delimiters(input, LexerTokenKind::LeftBrace, LexerTokenKind::RightBrace)
}

/// Returns the inner text when one delimiter pair encloses the whole input.
fn strip_enclosing_delimiters(
    input: &str,
    open: LexerTokenKind,
    close: LexerTokenKind,
) -> Option<&str> {
    let input = input.trim();
    let tokens = significant_tokens(input);
    if tokens.first().map(|token| token.kind) != Some(open)
        || tokens.last().map(|token| token.kind) != Some(close)
    {
        return None;
    }

    let mut depth = 0u32;
    for (index, token) in tokens.iter().enumerate() {
        match token.kind {
            kind if kind == open => depth += 1,
            kind if kind == close => {
                depth = depth.saturating_sub(1);
                if depth == 0 && index + 1 != tokens.len() {
                    return None;
                }
            }
            _ => {}
        }
    }

    let first = tokens.first()?;
    let last = tokens.last()?;
    Some(input[first.span.end..last.span.start].trim())
}

/// Returns whether the text contains a spatial pipeline at this level or one enclosing pair down.
fn contains_spatial_pipeline(input: &str) -> bool {
    contains_top_level_pipe(input)
        || strip_enclosing_parentheses(input)
            .map(contains_top_level_pipe)
            .unwrap_or(false)
        || strip_enclosing_braces(input)
            .map(contains_top_level_pipe)
            .unwrap_or(false)
}

/// Parses a quoted group label when the source consists of a single quoted token.
fn parse_quoted_group_label_source(input: &str) -> Option<&str> {
    let tokens = significant_tokens(input);
    match tokens.as_slice() {
        [token] if token.kind == LexerTokenKind::QuotedString => {
            Some(unquote(&input[token.span.start..token.span.end]))
        }
        _ => None,
    }
}

/// Returns true when text starts with a standalone selection source.
fn starts_selection_source(input: &str) -> bool {
    let tokens = significant_tokens(input);
    let Some(token) = tokens.first() else {
        return false;
    };

    match token.kind {
        LexerTokenKind::QuotedString | LexerTokenKind::LeftParen | LexerTokenKind::LeftBrace => {
            true
        }
        LexerTokenKind::Word => matches!(
            input[token.span.start..token.span.end]
                .to_ascii_lowercase()
                .as_str(),
            "fix" | "fixture" | "f" | "group" | "grp" | "g" | "param" | "parameter" | "p"
        ),
        _ => false,
    }
}

/// Splits a source segment at top-level additions whose right side starts a new selection source.
fn split_top_level_source_additions(input: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut depth = 0u32;

    for token in significant_tokens(input) {
        match token.kind {
            LexerTokenKind::LeftParen | LexerTokenKind::LeftBrace => depth += 1,
            LexerTokenKind::RightParen | LexerTokenKind::RightBrace => {
                depth = depth.saturating_sub(1)
            }
            LexerTokenKind::Plus
                if depth == 0 && starts_selection_source(&input[token.span.end..]) =>
            {
                segments.push(input[start..token.span.start].trim());
                start = token.span.end;
            }
            _ => {}
        }
    }

    segments.push(input[start..].trim());
    segments
}

/// Splits a selection string at top-level spatial union operators.
fn split_top_level_additions(input: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut depth = 0u32;

    for token in significant_tokens(input) {
        match token.kind {
            LexerTokenKind::LeftParen | LexerTokenKind::LeftBrace => depth += 1,
            LexerTokenKind::RightParen | LexerTokenKind::RightBrace => {
                depth = depth.saturating_sub(1)
            }
            LexerTokenKind::Plus
                if depth == 0 && contains_top_level_pipe(&input[start..token.span.start]) =>
            {
                segments.push(input[start..token.span.start].trim());
                start = token.span.end;
            }
            _ => {}
        }
    }

    segments.push(input[start..].trim());
    segments
}

/// Returns whether the segment contains a top-level spatial clause separator.
fn contains_top_level_pipe(input: &str) -> bool {
    let mut depth = 0u32;
    let mut in_quote = false;
    let mut escaped = false;

    for ch in input.chars() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_quote = false;
            }
            continue;
        }

        match ch {
            '"' => in_quote = true,
            '(' | '{' => depth += 1,
            ')' | '}' => depth = depth.saturating_sub(1),
            '|' if depth == 0 => return true,
            _ => {}
        }
    }

    false
}

fn parse_spatial_clause(input: &str) -> Result<Vec<SpatialClause>, ParseError> {
    let tokens = significant_tokens(input);
    let Some(keyword) = tokens.first().map(|token| token.text.to_ascii_lowercase()) else {
        return Err(ParseError::Failure("missing spatial clause".to_string()));
    };
    let rest = tail_after_first_token(input, &tokens);

    match keyword.as_str() {
        "grid" => Ok(vec![SpatialClause::Grid(parse_grid_value(rest)?)]),
        "transpose" if rest.is_empty() => Ok(vec![SpatialClause::Transpose]),
        "mirror" => Ok(vec![SpatialClause::Mirror(parse_optional_axis(rest)?)]),
        "rotate" => Ok(vec![parse_rotate_clause(rest)?]),
        "split" if rest.is_empty() => Ok(vec![SpatialClause::Split]),
        "merge" if rest.is_empty() => Ok(vec![SpatialClause::Merge]),
        "expand" => Ok(vec![SpatialClause::Expand {
            depth: parse_optional_clause_amount("expand", rest)?,
        }]),
        "take" => Ok(vec![SpatialClause::Take(parse_clause_amount(
            "take", rest,
        )?)]),
        "skip" => Ok(vec![SpatialClause::Skip(parse_clause_amount(
            "skip", rest,
        )?)]),
        "shift" => parse_i32_assignments("shift", rest, |axis, amount| SpatialClause::Shift {
            axis,
            amount,
        }),
        "blocks" => parse_u32_assignments("blocks", rest, |axis, amount| SpatialClause::Blocks {
            axis,
            amount,
        }),
        "group" => parse_u32_assignments("group", rest, |axis, amount| SpatialClause::Group {
            axis,
            amount,
        }),
        "wings" => parse_u32_assignments("wings", rest, |axis, amount| SpatialClause::Wings {
            axis,
            amount,
        }),
        "shuffle" => parse_u32_assignments("shuffle", rest, |axis, seed| SpatialClause::Shuffle {
            axis,
            seed,
        }),
        "invert" => Ok(vec![parse_invert_clause(input, &tokens)?]),
        _ => Err(ParseError::Failure(format!(
            "unsupported spatial clause '{input}'"
        ))),
    }
}

/// Parses an optional unsigned amount used by selection transform clauses.
fn parse_optional_clause_amount(keyword: &str, input: &str) -> Result<Option<u32>, ParseError> {
    let parts = input.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [] => Ok(None),
        [value] => parse_u32(keyword, value).map(Some),
        _ => Err(ParseError::Failure(format!(
            "invalid {keyword} clause '{}'",
            input.trim()
        ))),
    }
}

/// Parses the single unsigned amount used by selection subset clauses.
fn parse_clause_amount(keyword: &str, input: &str) -> Result<u32, ParseError> {
    let parts = input.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [] => Err(ParseError::Failure(format!("missing {keyword} value"))),
        [value] => parse_u32(keyword, value),
        _ => Err(ParseError::Failure(format!(
            "invalid {keyword} clause '{}'",
            input.trim()
        ))),
    }
}

fn parse_grid_value(input: &str) -> Result<GridSize, ParseError> {
    let value = input.trim();
    if value.is_empty() {
        return Err(ParseError::Failure("missing grid value".to_string()));
    }

    let lowercase = value.to_ascii_lowercase();
    if let Some((x, y)) = lowercase.split_once('x') {
        return Ok(GridSize::WidthHeight {
            x: parse_u32("grid width", x)?,
            y: parse_u32("grid height", y)?,
        });
    }

    Ok(GridSize::Width(parse_u32("grid width", value)?))
}

fn parse_optional_axis(input: &str) -> Result<Axis, ParseError> {
    let value = input.trim();
    if value.is_empty() {
        Ok(Axis::X)
    } else {
        parse_axis(value)
    }
}

fn parse_rotate_clause(input: &str) -> Result<SpatialClause, ParseError> {
    match input.trim().to_ascii_lowercase().as_str() {
        "left" => Ok(SpatialClause::RotateLeft),
        "right" => Ok(SpatialClause::RotateRight),
        _ => Err(ParseError::Failure(format!(
            "invalid rotate direction '{input}'"
        ))),
    }
}

fn parse_u32_assignments(
    keyword: &str,
    input: &str,
    build: impl Fn(Axis, u32) -> SpatialClause,
) -> Result<Vec<SpatialClause>, ParseError> {
    parse_assignment_tokens(keyword, input, |axis, value| {
        Ok(build(axis, parse_u32(keyword, value)?))
    })
}

fn parse_i32_assignments(
    keyword: &str,
    input: &str,
    build: impl Fn(Axis, i32) -> SpatialClause,
) -> Result<Vec<SpatialClause>, ParseError> {
    parse_assignment_tokens(keyword, input, |axis, value| {
        Ok(build(axis, parse_i32(keyword, value)?))
    })
}

fn parse_assignment_tokens<T>(
    keyword: &str,
    input: &str,
    build: impl Fn(Axis, &str) -> Result<T, ParseError>,
) -> Result<Vec<T>, ParseError> {
    let parts = input.split_whitespace().collect::<Vec<_>>();
    if parts.is_empty() {
        return Err(ParseError::Failure(format!("missing {keyword} value")));
    }

    if parts.len() == 1 && !parts[0].contains('=') {
        return Ok(vec![build(Axis::X, parts[0])?]);
    }

    parts
        .into_iter()
        .map(|part| {
            let (axis, value) = part.split_once('=').ok_or_else(|| {
                ParseError::Failure(format!("invalid {keyword} assignment '{part}'"))
            })?;
            build(parse_axis(axis)?, value)
        })
        .collect()
}

fn parse_invert_clause(input: &str, tokens: &[LexerToken]) -> Result<SpatialClause, ParseError> {
    let mode_token = tokens
        .get(1)
        .ok_or_else(|| ParseError::Failure("missing invert mode".to_string()))?;
    let mode = match mode_token.text.to_ascii_lowercase().as_str() {
        "index" => InvertMode::Index,
        "block" => InvertMode::Block,
        "group" => InvertMode::Group,
        "wing" => InvertMode::Wing,
        other => {
            return Err(ParseError::Failure(format!(
                "invalid invert mode '{other}'"
            )));
        }
    };

    let attrs = if tokens.len() <= 2 {
        None
    } else {
        let attrs_keyword = tokens
            .get(2)
            .ok_or_else(|| ParseError::Failure("missing invert attrs keyword".to_string()))?;
        if !attrs_keyword.text.eq_ignore_ascii_case("attrs") {
            return Err(ParseError::Failure(format!(
                "invalid invert clause '{input}'"
            )));
        }
        Some(parse_attribute_list(input, &tokens[3..])?)
    };

    Ok(SpatialClause::Invert { mode, attrs })
}

fn parse_attribute_list(input: &str, tokens: &[LexerToken]) -> Result<Vec<Attribute>, ParseError> {
    if tokens.is_empty() {
        return Err(ParseError::Failure("missing invert attributes".to_string()));
    }

    let mut groups = Vec::new();
    let mut start = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        if token.kind == LexerTokenKind::Comma {
            if start == index {
                return Err(ParseError::Failure(
                    "empty attribute in invert attrs list".to_string(),
                ));
            }
            groups.push(&tokens[start..index]);
            start = index + 1;
        }
    }
    if start >= tokens.len() {
        return Err(ParseError::Failure(
            "empty attribute in invert attrs list".to_string(),
        ));
    }
    groups.push(&tokens[start..]);

    groups
        .into_iter()
        .map(|group| {
            let first = group
                .first()
                .ok_or_else(|| ParseError::Failure("missing attribute".to_string()))?;
            let last = group
                .last()
                .ok_or_else(|| ParseError::Failure("missing attribute".to_string()))?;
            let surface = input[first.span.start..last.span.end].trim();
            let normalized = unquote(surface);
            Ok(
                Attribute::from_str(normalized).unwrap_or_else(|_| Attribute::Custom {
                    label: normalized.to_string(),
                }),
            )
        })
        .collect()
}

fn significant_tokens(input: &str) -> Vec<LexerToken> {
    lex_command(input)
        .into_iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

fn tail_after_first_token<'a>(input: &'a str, tokens: &[LexerToken]) -> &'a str {
    tokens
        .first()
        .map(|token| input[token.span.end..].trim())
        .unwrap_or_default()
}

fn parse_axis(input: &str) -> Result<Axis, ParseError> {
    match input.trim().to_ascii_lowercase().as_str() {
        "x" => Ok(Axis::X),
        "y" => Ok(Axis::Y),
        "z" => Ok(Axis::Z),
        other => Err(ParseError::Failure(format!("invalid axis '{other}'"))),
    }
}

fn parse_u32(label: &str, input: &str) -> Result<u32, ParseError> {
    input
        .trim()
        .parse::<u32>()
        .map_err(|_| ParseError::Failure(format!("invalid {label} value '{}'", input.trim())))
}

fn parse_i32(label: &str, input: &str) -> Result<i32, ParseError> {
    input
        .trim()
        .parse::<i32>()
        .map_err(|_| ParseError::Failure(format!("invalid {label} value '{}'", input.trim())))
}

fn unquote(input: &str) -> &str {
    input
        .strip_prefix('"')
        .and_then(|trimmed| trimmed.strip_suffix('"'))
        .unwrap_or(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_selection_expr_supports_fixture_maps() {
        assert!(matches!(
            parse_selection_expr("fixture 1>3 .1"),
            Ok(SelectionExpr::FixtureMap { fixtures, elements })
                if fixtures.start == 1
                    && fixtures.end == 3
                    && matches!(elements, ElementSelectorExpr::Single(1))
        ));
    }

    #[test]
    fn parse_selection_expr_rejects_parameter_selection() {
        assert!(parse_selection_expr("parameter 1").is_err());
    }

    #[test]
    fn parse_spatial_selection_text_supports_clause_sequence() {
        let selection = parse_spatial_selection_text(
            "fix 1>8 | Grid 4x2 | Mirror Y | Split | Merge | Expand 1 | Take 6 | Skip 1 | Blocks 2 | Shift 1 | Group Y=2 | Wings 2 | Shuffle 17 | Invert Wing Attrs Pan,Tilt",
        )
        .expect("parse spatial selection");

        assert!(matches!(
            selection.source,
            SelectionExpr::FixtureRange { .. }
        ));
        assert_eq!(
            selection.clauses,
            vec![
                SpatialClause::Grid(GridSize::WidthHeight { x: 4, y: 2 }),
                SpatialClause::Mirror(Axis::Y),
                SpatialClause::Split,
                SpatialClause::Merge,
                SpatialClause::Expand { depth: Some(1) },
                SpatialClause::Take(6),
                SpatialClause::Skip(1),
                SpatialClause::Blocks {
                    axis: Axis::X,
                    amount: 2
                },
                SpatialClause::Shift {
                    axis: Axis::X,
                    amount: 1
                },
                SpatialClause::Group {
                    axis: Axis::Y,
                    amount: 2
                },
                SpatialClause::Wings {
                    axis: Axis::X,
                    amount: 2
                },
                SpatialClause::Shuffle {
                    axis: Axis::X,
                    seed: 17
                },
                SpatialClause::Invert {
                    mode: InvertMode::Wing,
                    attrs: Some(vec![Attribute::Pan, Attribute::Tilt]),
                },
            ]
        );
    }

    #[test]
    fn parse_spatial_selection_text_rejects_invert_without_mode() {
        assert!(parse_spatial_selection_text("fix 1>8 | Invert Attrs Pan,Tilt").is_err());
    }
}
