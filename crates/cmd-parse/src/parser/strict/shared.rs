// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

fn split_significant_tokens<'a>(
    tokens: &[&'a LexerToken],
    separator: LexerTokenKind,
) -> Option<Vec<Vec<&'a LexerToken>>> {
    let significant = tokens
        .iter()
        .copied()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    if significant.is_empty() {
        return None;
    }

    let mut groups = Vec::new();
    let mut current = Vec::new();
    for token in significant {
        if token.kind == separator {
            if current.is_empty() {
                return None;
            }
            groups.push(std::mem::take(&mut current));
        } else {
            current.push(token);
        }
    }
    if current.is_empty() {
        return None;
    }
    groups.push(current);
    Some(groups)
}

pub(super) fn parse_value_range_from_tokens_with_mode<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    mode: ParameterValueMode,
) -> Option<ValueRangeAst<'i>> {
    Some(ValueRangeAst {
        mode,
        values: split_significant_tokens(tokens, LexerTokenKind::GreaterThan)?
            .into_iter()
            .map(|group| {
                parse_decimal_value_from_tokens(command_str, &group)
                    .or_else(|| parse_value_marker_from_tokens(command_str, &group))
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

pub(super) fn parse_duration_range_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<crate::ast::DurationRangeAst<'i>> {
    Some(crate::ast::DurationRangeAst {
        values: split_significant_tokens(tokens, LexerTokenKind::GreaterThan)?
            .into_iter()
            .map(|group| {
                let surface = slice_for_tokens(command_str, &group)?;
                Some(materialize_duration_value(
                    surface,
                    parse_duration_value_slice(surface)?,
                ))
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

pub(super) fn parse_object_type_from_tokens(tokens: &[&LexerToken]) -> Option<ObjectTypeAst> {
    let [token] = tokens else {
        return None;
    };
    general::parse_object_type_token(token)
}

fn attribute_alias_from_canonical(canonical: &str) -> Option<AttributeAliasAst> {
    match canonical {
        "int" => Some(AttributeAliasAst::Intensity),
        "red" => Some(AttributeAliasAst::Red),
        "green" => Some(AttributeAliasAst::Green),
        "blue" => Some(AttributeAliasAst::Blue),
        "white" => Some(AttributeAliasAst::White),
        _ => None,
    }
}

fn quoted_token_inner<'i>(command_str: &'i str, token: &LexerToken) -> Option<&'i str> {
    (token.kind == LexerTokenKind::QuotedString
        && token.span.end > token.span.start + 1
        && token.text.starts_with('"')
        && token.text.ends_with('"'))
    .then(|| &command_str[token.span.start + 1..token.span.end - 1])
}

/// Parse a fixture selection from the supplied token slice.
pub(super) fn parse_fixture_selection_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<FixtureSelectionAst> {
    let (head, ids) = tokens.split_first()?;
    let head = canonical_word(
        head,
        AliasCanonicalizationContext {
            selection_or_object_context: true,
            ..AliasCanonicalizationContext::default()
        },
    )?;
    (head == canonical_token_text(TokenId::Fixture)).then_some(())?;
    Some(FixtureSelectionAst {
        _fixture: FixtureKeyword,
        ids: parse_identifier_expression_from_tokens(command_str, ids)?,
    })
}

pub(super) fn parse_selection_from_tokens(
    command_str: &str,
    tokens: &[&LexerToken],
) -> Option<SelectionAst> {
    let (head, ids) = tokens.split_first()?;
    let selection_type = match canonical_word(
        head,
        AliasCanonicalizationContext {
            selection_or_object_context: true,
            ..AliasCanonicalizationContext::default()
        },
    )?
    .as_str()
    {
        canonical if canonical == canonical_token_text(TokenId::Fixture) => {
            SelectionTypeAst::Fixture
        }
        canonical if canonical == canonical_token_text(TokenId::Parameter) => {
            SelectionTypeAst::Parameter
        }
        canonical if canonical == canonical_token_text(TokenId::Group) => SelectionTypeAst::Group,
        _ => return None,
    };

    Some(SelectionAst {
        selection_type,
        ids: parse_identifier_expression_from_tokens(command_str, ids)?,
    })
}

/// Builds a placeholder selection AST for rich spatial sources represented by their source text.
fn spatial_selection_placeholder_ast() -> SelectionAst {
    SelectionAst {
        selection_type: SelectionTypeAst::Group,
        ids: IdentifierExpressionAst {
            head: TermAst::Single(SingleIdAst {
                target: TargetAst::FixtureRef { fixture_id: 0 },
            }),
            tail: Vec::new(),
        },
    }
}

/// Parses a rich spatial source or returns a placeholder AST after validation.
pub(super) fn parse_spatial_selection_base_from_source(source: &str) -> Option<SelectionAst> {
    parse_selection_base_from_source(source).or_else(|| {
        parse_spatial_selection_text(source)
            .ok()
            .map(|_| spatial_selection_placeholder_ast())
    })
}

/// Parses a selection argument and preserves its original source text.
pub(super) fn parse_selection_argument_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    allowed_types: &[SelectionTypeAst],
) -> Option<SelectionArgumentAst<'i>> {
    let source = trimmed_slice_for_tokens(command_str, tokens)?;
    if source.contains('|') {
        parse_spatial_selection_text(source).ok()?;
    }

    let selection = parse_spatial_selection_base_from_source(source)?;
    allowed_types
        .contains(&selection.selection_type)
        .then_some(SelectionArgumentAst { source, selection })
}

/// Parses the base selection segment from a possibly transformed selection source.
pub(super) fn parse_selection_base_from_source(source: &str) -> Option<SelectionAst> {
    let base = spatial_selection_base_segment(source)?;
    let tokens = lex_command(base);
    let significant = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    parse_selection_from_tokens(base, &significant)
}

/// Returns the source segment that contains the base fixture/group/parameter selection.
fn spatial_selection_base_segment(source: &str) -> Option<&str> {
    let base = first_top_level_spatial_clause(source).trim();
    let Some(inner) = strip_enclosing_parentheses(base) else {
        return Some(base);
    };

    spatial_selection_base_segment(inner)
}

/// Returns the spatial selection text before the first top-level clause separator.
fn first_top_level_spatial_clause(input: &str) -> &str {
    let mut depth = 0u32;
    let mut in_quote = false;
    let mut escaped = false;
    let mut split_at = input.len();

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
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            '|' if depth == 0 => {
                split_at = index;
                break;
            }
            _ => {}
        }
    }

    &input[..split_at]
}

/// Returns the inner text when the source is enclosed by one complete parenthesis pair.
fn strip_enclosing_parentheses(input: &str) -> Option<&str> {
    let input = input.trim();
    let first = input.strip_prefix('(')?;
    let inner = first.strip_suffix(')')?;
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
            '(' => depth += 1,
            ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 && index + ch.len_utf8() != input.len() {
                    return None;
                }
            }
            _ => {}
        }
    }

    Some(inner.trim())
}

pub(super) fn parse_attribute_type_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    spec_id: AttributeParseSpecId,
) -> Option<AttributeTypeAst<'i>> {
    let [token] = tokens else {
        return None;
    };
    let spec = attribute_parse_spec(spec_id);

    if let Some(inner) = quoted_token_inner(command_str, token) {
        return spec.allow_quoted.then_some(AttributeTypeAst::Quoted(inner));
    }

    let surface = &command_str[token.span.start..token.span.end];
    let canonical = canonical_word(
        token,
        AliasCanonicalizationContext {
            attribute_context: true,
            ..AliasCanonicalizationContext::default()
        },
    );
    if let Some(alias) = canonical
        .as_deref()
        .and_then(attribute_alias_from_canonical)
    {
        return Some(AttributeTypeAst::Aliased(alias));
    }
    spec.allow_custom_word
        .then_some(surface)
        .filter(|surface| surface.chars().all(|ch| ch.is_ascii_alphabetic()))
        .filter(|surface| validate_attribute_surface(spec, surface).is_ok())
        .map(AttributeTypeAst::Other)
}

pub(super) fn parse_attribute_types_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
    spec_id: AttributeParseSpecId,
) -> Option<Vec<AttributeTypeAst<'i>>> {
    (!tokens.is_empty()).then_some(())?;
    tokens
        .iter()
        .map(|token| {
            parse_attribute_type_from_tokens(command_str, std::slice::from_ref(token), spec_id)
        })
        .collect()
}
