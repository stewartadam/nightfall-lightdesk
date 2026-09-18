// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Lexer-token merging required by structural parsing surfaces.

use super::*;

/// Merges adjacent lexer fragments that form one structural value surface.
pub(in crate::parser) fn merged_structural_tokens(tokens: &[LexerToken]) -> Vec<LexerToken> {
    let significant = tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .cloned()
        .collect::<Vec<_>>();
    let mut merged = Vec::with_capacity(significant.len());
    let mut index = 0;
    while index < significant.len() {
        if let Some((consumed, token)) = merged_percent_token(&significant[index..]) {
            merged.push(token);
            index += consumed;
            continue;
        }
        if let Some((consumed, token)) = merged_tuple_token(&significant[index..]) {
            merged.push(token);
            index += consumed;
            continue;
        }
        if index + 2 < significant.len()
            && significant[index].kind == LexerTokenKind::Word
            && significant[index].text.eq_ignore_ascii_case("art")
            && significant[index + 1].kind == LexerTokenKind::Minus
            && significant[index + 2].kind == LexerTokenKind::Word
            && significant[index + 2].text.eq_ignore_ascii_case("net")
        {
            merged.push(LexerToken {
                kind: LexerTokenKind::Word,
                text: "artnet".into(),
                span: crate::parser::lexer::LexerSpan {
                    start: significant[index].span.start,
                    end: significant[index + 2].span.end,
                },
            });
            index += 3;
            continue;
        }
        merged.push(significant[index].clone());
        index += 1;
    }
    merged
}

/// Merges a contiguous signed decimal and percent suffix when it is a valid duration surface.
pub(in crate::parser) fn merged_percent_token(
    tokens: &[LexerToken],
) -> Option<(usize, LexerToken)> {
    let mut end = 0usize;
    while end < tokens.len()
        && matches!(
            tokens[end].kind,
            LexerTokenKind::Plus
                | LexerTokenKind::Minus
                | LexerTokenKind::Number
                | LexerTokenKind::Dot
        )
    {
        if end > 0 && tokens[end - 1].span.end != tokens[end].span.start {
            break;
        }
        end += 1;
    }
    if end == 0
        || tokens.get(end)?.kind != LexerTokenKind::Percent
        || tokens[end - 1].span.end != tokens[end].span.start
    {
        return None;
    }
    let text = tokens[..=end]
        .iter()
        .map(|token| token.text.as_str())
        .collect::<String>();
    duration_value_prefix(text.as_str()).then(|| {
        (
            end + 1,
            LexerToken {
                kind: LexerTokenKind::Word,
                text: text.into(),
                span: crate::parser::lexer::LexerSpan {
                    start: tokens[0].span.start,
                    end: tokens[end].span.end,
                },
            },
        )
    })
}

/// Merges a contiguous three-component tuple into one structural lexer token.
pub(in crate::parser) fn merged_tuple_token(tokens: &[LexerToken]) -> Option<(usize, LexerToken)> {
    if !matches!(
        tokens.first()?.kind,
        LexerTokenKind::Plus | LexerTokenKind::Minus | LexerTokenKind::Number
    ) {
        return None;
    }

    let mut end = 0usize;
    while end < tokens.len()
        && matches!(
            tokens[end].kind,
            LexerTokenKind::Plus
                | LexerTokenKind::Minus
                | LexerTokenKind::Number
                | LexerTokenKind::Dot
                | LexerTokenKind::Comma
        )
    {
        end += 1;
    }
    let tuple = &tokens[..end];
    if tuple
        .iter()
        .filter(|token| token.kind == LexerTokenKind::Comma)
        .count()
        != 2
    {
        return None;
    }
    let text = tuple
        .iter()
        .map(|token| token.text.as_str())
        .collect::<String>();
    is_tuple_axis_component(text.as_str()).then(|| {
        (
            end,
            LexerToken {
                kind: LexerTokenKind::Word,
                text: text.into(),
                span: crate::parser::lexer::LexerSpan {
                    start: tokens[0].span.start,
                    end: tokens[end - 1].span.end,
                },
            },
        )
    })
}
