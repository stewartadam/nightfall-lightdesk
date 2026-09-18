// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Lexer contracts.

use logos::Logos;
use serde::{Deserialize, Serialize};
use smol_str::SmolStr;

/// Token category emitted by [`lex_command`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LexerTokenKind {
    Pipe,
    Equals,
    Whitespace,
    Word,
    Number,
    QuotedString,
    AtSign,
    DoubleAtSign,
    Dot,
    Comma,
    Colon,
    Percent,
    Tilde,
    Plus,
    Minus,
    GreaterThan,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    Unknown,
}

/// Byte range in the source command string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LexerSpan {
    pub start: usize,
    pub end: usize,
}

/// Single lexer token with original source text and span.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LexerToken {
    pub kind: LexerTokenKind,
    pub text: SmolStr,
    pub span: LexerSpan,
}

/// Lexer token categories produced before parser analysis assigns grammar meaning.
#[derive(Logos, Debug, Clone, Copy, PartialEq, Eq)]
enum RawTokenKind {
    #[token("|")]
    Pipe,
    #[token("=")]
    Equals,
    #[regex(r"[ \t\r\n\f]+")]
    Whitespace,

    #[token("@@")]
    DoubleAtSign,
    #[token("@")]
    AtSign,
    #[token(".")]
    Dot,
    #[token(",")]
    Comma,
    #[token(":")]
    Colon,
    #[token("%")]
    Percent,
    #[token("~")]
    Tilde,
    #[token("+")]
    Plus,
    #[token("-")]
    Minus,
    #[token(">")]
    GreaterThan,
    #[token("(")]
    LeftParen,
    #[token(")")]
    RightParen,
    #[token("{")]
    LeftBrace,
    #[token("}")]
    RightBrace,

    #[regex(r#""([^"\\]|\\.)*"?"#)]
    QuotedString,

    #[regex("[0-9]+", priority = 3)]
    Number,

    // Known hyphenated object aliases that should behave like single words.
    #[expect(
        clippy::duplicated_attributes,
        reason = "Logos priorities belong to separate regex rules, not the Word variant"
    )]
    #[regex(r#"(?i:colou?r-path)"#, priority = 4)]
    // Any non-structural, non-whitespace run.
    #[regex(r#"[^ \t\r\n\f@.,:%~+\->(){}"=|]+"#, priority = 1)]
    Word,
}

/// Tokenize a command string into a lossless token stream.
pub fn lex_command(input: &str) -> Vec<LexerToken> {
    let mut tokens = Vec::new();
    let mut lexer = RawTokenKind::lexer(input);

    while let Some(token) = lexer.next() {
        let span = lexer.span();
        let kind = match token {
            Ok(raw) => match raw {
                RawTokenKind::Pipe => LexerTokenKind::Pipe,
                RawTokenKind::Equals => LexerTokenKind::Equals,
                RawTokenKind::Whitespace => LexerTokenKind::Whitespace,
                RawTokenKind::Word => LexerTokenKind::Word,
                RawTokenKind::Number => LexerTokenKind::Number,
                RawTokenKind::QuotedString => LexerTokenKind::QuotedString,
                RawTokenKind::AtSign => LexerTokenKind::AtSign,
                RawTokenKind::DoubleAtSign => LexerTokenKind::DoubleAtSign,
                RawTokenKind::Dot => LexerTokenKind::Dot,
                RawTokenKind::Comma => LexerTokenKind::Comma,
                RawTokenKind::Colon => LexerTokenKind::Colon,
                RawTokenKind::Percent => LexerTokenKind::Percent,
                RawTokenKind::Tilde => LexerTokenKind::Tilde,
                RawTokenKind::Plus => LexerTokenKind::Plus,
                RawTokenKind::Minus => LexerTokenKind::Minus,
                RawTokenKind::GreaterThan => LexerTokenKind::GreaterThan,
                RawTokenKind::LeftParen => LexerTokenKind::LeftParen,
                RawTokenKind::RightParen => LexerTokenKind::RightParen,
                RawTokenKind::LeftBrace => LexerTokenKind::LeftBrace,
                RawTokenKind::RightBrace => LexerTokenKind::RightBrace,
            },
            Err(_) => LexerTokenKind::Unknown,
        };
        push_token(&mut tokens, kind, input, span.start, span.end);
    }

    tokens
}

/// Appends a lexer token with its source text and byte span.
fn push_token(
    tokens: &mut Vec<LexerToken>,
    kind: LexerTokenKind,
    input: &str,
    start: usize,
    end: usize,
) {
    tokens.push(LexerToken {
        kind,
        text: input[start..end].into(),
        span: LexerSpan { start, end },
    });
}

#[cfg(test)]
mod tests {
    use super::{LexerTokenKind, lex_command};

    #[test]
    fn lexes_structural_tokens_and_words() {
        let tokens = lex_command("fix 311 red @ 100");
        let kinds = tokens.iter().map(|token| token.kind).collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                LexerTokenKind::Word,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Number,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Word,
                LexerTokenKind::Whitespace,
                LexerTokenKind::AtSign,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Number,
            ]
        );
    }

    #[test]
    fn lexes_double_at_and_quoted_values() {
        let tokens = lex_command("@@ \"pan tilt\"");
        let kinds = tokens.iter().map(|token| token.kind).collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                LexerTokenKind::DoubleAtSign,
                LexerTokenKind::Whitespace,
                LexerTokenKind::QuotedString,
            ]
        );
    }

    #[test]
    fn lexes_commas_and_percent_as_structural_tokens() {
        let tokens = lex_command("(1, 2, 3) 25%");
        let kinds = tokens.iter().map(|token| token.kind).collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                LexerTokenKind::LeftParen,
                LexerTokenKind::Number,
                LexerTokenKind::Comma,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Number,
                LexerTokenKind::Comma,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Number,
                LexerTokenKind::RightParen,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Number,
                LexerTokenKind::Percent,
            ]
        );
    }

    #[test]
    fn lexes_escaped_quotes_inside_quoted_values() {
        let tokens = lex_command("flow 7 create \"{\\\"x\\\":1}\"");
        let quoted = tokens
            .iter()
            .find(|token| token.kind == LexerTokenKind::QuotedString)
            .expect("expected quoted payload token");

        assert_eq!(quoted.text.as_str(), "\"{\\\"x\\\":1}\"");
    }

    #[test]
    fn lexes_unterminated_quote_as_single_quoted_token() {
        let tokens = lex_command("\"pan tilt");
        let kinds = tokens.iter().map(|token| token.kind).collect::<Vec<_>>();
        assert_eq!(kinds, vec![LexerTokenKind::QuotedString]);
        assert_eq!(tokens[0].text.as_str(), "\"pan tilt");
    }

    #[test]
    fn lexes_color_path_alias_as_single_word() {
        let tokens = lex_command("store Colour-Path 101");
        let kinds = tokens.iter().map(|token| token.kind).collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                LexerTokenKind::Word,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Word,
                LexerTokenKind::Whitespace,
                LexerTokenKind::Number,
            ]
        );
        assert_eq!(tokens[2].text.as_str(), "Colour-Path");
    }
}
