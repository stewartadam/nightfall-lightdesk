// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Executable selection syntax shared by command slots and selection validation.

use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{ExpectedToken, TokenId, ValueKind};
use crate::parser::lexer::{LexerToken, LexerTokenKind, lex_command};

/// Continuations and completion state at the end of a selection expression.
pub(crate) struct SelectionPrefix {
    pub valid: bool,
    pub complete: bool,
    pub expected: Vec<ExpectedToken>,
}

/// Classifies the argument grammar of one spatial transform.
#[derive(Clone, Copy)]
pub(super) enum TransformArguments {
    Empty,
    Grid,
    OptionalAxis,
    Direction,
    OptionalAmount,
    Amount,
    Assignments { signed: bool },
    Invert,
}

/// Couples a transform keyword to the argument parser used for complete and partial input.
pub(super) const TRANSFORMS: &[(&str, TransformArguments)] = &[
    ("grid", TransformArguments::Grid),
    ("transpose", TransformArguments::Empty),
    ("mirror", TransformArguments::OptionalAxis),
    ("rotate", TransformArguments::Direction),
    ("split", TransformArguments::Empty),
    ("merge", TransformArguments::Empty),
    ("expand", TransformArguments::OptionalAmount),
    ("take", TransformArguments::Amount),
    ("skip", TransformArguments::Amount),
    ("shift", TransformArguments::Assignments { signed: true }),
    ("blocks", TransformArguments::Assignments { signed: false }),
    ("group", TransformArguments::Assignments { signed: false }),
    ("wings", TransformArguments::Assignments { signed: false }),
    ("shuffle", TransformArguments::Assignments { signed: false }),
    ("invert", TransformArguments::Invert),
];

/// Executes the selection grammar without inventing a suffix to make incomplete input parse.
pub(crate) fn analyze_selection_prefix(input: &str) -> SelectionPrefix {
    let tokens = lex_command(input)
        .into_iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect();
    let mut reader = SelectionReader {
        tokens,
        index: 0,
        expected: Vec::new(),
    };
    let result = reader.selection();
    let exhausted = reader.index == reader.tokens.len();
    SelectionPrefix {
        valid: exhausted && result != Err(ParseStop::Invalid),
        complete: exhausted && result.is_ok(),
        expected: if exhausted {
            reader.expected
        } else {
            Vec::new()
        },
    }
}

/// Distinguishes an unfinished production from a token that cannot enter that production.
#[derive(PartialEq)]
enum ParseStop {
    Incomplete,
    Invalid,
}

/// Traverses one selection expression and records expectations only at its actual cursor.
struct SelectionReader {
    tokens: Vec<LexerToken>,
    index: usize,
    expected: Vec<ExpectedToken>,
}

impl SelectionReader {
    /// Returns the unconsumed token without changing parser state.
    fn current(&self) -> Option<&LexerToken> {
        self.tokens.get(self.index)
    }

    /// Checks a punctuation or keyword through the shared alias inventory.
    fn at(&self, id: TokenId) -> bool {
        self.current()
            .is_some_and(|token| token_id_for_text(&token.text) == Some(id))
    }

    /// Consumes an exact token and clears expectations belonging to the previous cursor.
    fn eat(&mut self, id: TokenId) -> bool {
        if self.at(id) {
            self.advance();
            true
        } else {
            false
        }
    }

    /// Moves the execution cursor past a token accepted by the active production.
    fn advance(&mut self) {
        self.index += 1;
        self.expected.clear();
    }

    /// Adds alternatives at end of input while preserving grammar order.
    fn offer(&mut self, expected: impl IntoIterator<Item = ExpectedToken>) {
        if self.current().is_none() {
            for token in expected {
                if !self.expected.contains(&token) {
                    self.expected.push(token);
                }
            }
        }
    }

    /// Offers fixed syntax at the current end of input.
    fn offer_tokens(&mut self, ids: &[TokenId]) {
        self.offer(ids.iter().copied().map(ExpectedToken::Token));
    }

    /// Requires one exact grammar token.
    fn require(&mut self, id: TokenId) -> Result<(), ParseStop> {
        if self.eat(id) {
            return Ok(());
        }
        self.offer_tokens(&[id]);
        Err(if self.current().is_none() {
            ParseStop::Incomplete
        } else {
            ParseStop::Invalid
        })
    }

    /// Parses additive sources and their ordered transform pipelines.
    fn selection(&mut self) -> Result<(), ParseStop> {
        self.source()?;
        loop {
            self.offer_tokens(&[TokenId::Pipe, TokenId::Plus]);
            if self.eat(TokenId::Pipe) {
                self.transform()?;
            } else if self.eat(TokenId::Plus) {
                self.source()?;
            } else {
                return Ok(());
            }
        }
    }

    /// Parses a fixture/group source, a quoted group label, or a nested selection.
    fn source(&mut self) -> Result<(), ParseStop> {
        self.offer_tokens(&[
            TokenId::Fixture,
            TokenId::Group,
            TokenId::Parameter,
            TokenId::LeftParen,
            TokenId::LeftBrace,
        ]);
        self.offer([ExpectedToken::Placeholder(ValueKind::Text)]);
        if self.eat(TokenId::LeftParen) {
            self.selection()?;
            return self.require(TokenId::RightParen);
        }
        if self.eat(TokenId::LeftBrace) {
            self.selection()?;
            return self.require(TokenId::RightBrace);
        }
        if let Some(token) = self.current() {
            if token.kind == LexerTokenKind::QuotedString {
                let closed = token.text.len() > 1 && token.text.ends_with('"');
                self.advance();
                if !closed {
                    self.offer_tokens(&[TokenId::Quote]);
                    return Err(ParseStop::Incomplete);
                }
                return Ok(());
            }
        }
        if self.eat(TokenId::Fixture) || self.eat(TokenId::Group) || self.eat(TokenId::Parameter) {
            return self.identifiers();
        }
        Err(if self.current().is_none() {
            ParseStop::Incomplete
        } else {
            ParseStop::Invalid
        })
    }

    /// Parses numeric set expressions, leaving additions of a new source to the outer grammar.
    fn identifiers(&mut self) -> Result<(), ParseStop> {
        self.identifier_term()?;
        loop {
            self.offer_tokens(&[
                TokenId::Plus,
                TokenId::Minus,
                TokenId::GreaterThan,
                TokenId::Dot,
            ]);
            if self.at(TokenId::Plus)
                && self.tokens.get(self.index + 1).is_some_and(|token| {
                    matches!(
                        token_id_for_text(&token.text),
                        Some(
                            TokenId::Fixture
                                | TokenId::Group
                                | TokenId::Parameter
                                | TokenId::LeftBrace
                        )
                    ) || token.kind == LexerTokenKind::QuotedString
                        || (token.kind == LexerTokenKind::LeftParen
                            && self
                                .tokens
                                .get(self.index + 2)
                                .is_some_and(|next| next.kind != LexerTokenKind::Number))
                })
            {
                return Ok(());
            }
            let addition = self.eat(TokenId::Plus);
            if addition
                || self.eat(TokenId::Minus)
                || self.eat(TokenId::GreaterThan)
                || self.eat(TokenId::Dot)
            {
                if addition && self.current().is_none() {
                    self.offer_tokens(&[TokenId::Fixture, TokenId::Group, TokenId::LeftBrace]);
                }
                self.identifier_term()?;
            } else {
                return Ok(());
            }
        }
    }

    /// Parses one unsigned identifier or parenthesized numeric expression.
    fn identifier_term(&mut self) -> Result<(), ParseStop> {
        if self.eat(TokenId::LeftParen) {
            self.identifiers()?;
            return self.require(TokenId::RightParen);
        }
        self.amount(false)
    }

    /// Consumes a bounded integer, preserving an unfinished sign as a required value position.
    fn amount(&mut self, signed: bool) -> Result<(), ParseStop> {
        if signed && !self.eat(TokenId::Minus) {
            self.eat(TokenId::Plus);
        }
        self.offer([ExpectedToken::Placeholder(ValueKind::NumericDigit)]);
        let Some(token) = self.current() else {
            return Err(ParseStop::Incomplete);
        };
        if token.kind != LexerTokenKind::Number || token.text.parse::<u32>().is_err() {
            return Err(ParseStop::Invalid);
        }
        self.advance();
        Ok(())
    }

    /// Consumes one word from an explicit grammar alternative set.
    fn word(&mut self, choices: &[&str]) -> Result<(), ParseStop> {
        self.offer(
            choices
                .iter()
                .map(|word| ExpectedToken::Literal((*word).into())),
        );
        let Some(token) = self.current() else {
            return Err(ParseStop::Incomplete);
        };
        if !choices
            .iter()
            .any(|word| token.text.eq_ignore_ascii_case(word))
        {
            return Err(ParseStop::Invalid);
        }
        self.advance();
        Ok(())
    }

    /// Parses a transform's argument production from the shared transform registry.
    fn transform(&mut self) -> Result<(), ParseStop> {
        self.offer(
            TRANSFORMS
                .iter()
                .map(|(word, _)| ExpectedToken::Literal((*word).into())),
        );
        let Some(token) = self.current() else {
            return Err(ParseStop::Incomplete);
        };
        let Some((_, arguments)) = TRANSFORMS
            .iter()
            .find(|(word, _)| token.text.eq_ignore_ascii_case(word))
        else {
            return Err(ParseStop::Invalid);
        };
        let arguments = *arguments;
        self.advance();
        match arguments {
            TransformArguments::Empty => Ok(()),
            TransformArguments::OptionalAxis => {
                self.offer_tokens(&[TokenId::X, TokenId::Y, TokenId::Z]);
                if self.at(TokenId::X) || self.at(TokenId::Y) || self.at(TokenId::Z) {
                    self.advance();
                }
                Ok(())
            }
            TransformArguments::Direction => self.word(&["left", "right"]),
            TransformArguments::OptionalAmount => {
                self.offer([ExpectedToken::Placeholder(ValueKind::NumericDigit)]);
                if self
                    .current()
                    .is_some_and(|token| token.kind == LexerTokenKind::Number)
                {
                    self.amount(false)?;
                }
                Ok(())
            }
            TransformArguments::Amount => self.amount(false),
            TransformArguments::Grid => {
                self.offer([ExpectedToken::Placeholder(ValueKind::NumericDigit)]);
                let Some(token) = self.current() else {
                    return Err(ParseStop::Incomplete);
                };
                let lower = token.text.to_ascii_lowercase();
                let mut dimensions = lower.split('x');
                if dimensions
                    .next()
                    .is_none_or(|value| value.parse::<u32>().is_err())
                {
                    return Err(ParseStop::Invalid);
                }
                let height = dimensions.next();
                if dimensions.next().is_some() {
                    return Err(ParseStop::Invalid);
                }
                if height == Some("") {
                    self.advance();
                    self.offer([ExpectedToken::Placeholder(ValueKind::NumericDigit)]);
                    return Err(ParseStop::Incomplete);
                }
                if height.is_some_and(|value| value.parse::<u32>().is_err()) {
                    return Err(ParseStop::Invalid);
                }
                self.advance();
                Ok(())
            }
            TransformArguments::Assignments { signed } => self.assignments(signed),
            TransformArguments::Invert => {
                self.word(&["index", "block", "group", "wing"])?;
                self.offer([ExpectedToken::Literal("attrs".into())]);
                if self
                    .current()
                    .is_some_and(|token| token.text.eq_ignore_ascii_case("attrs"))
                {
                    self.advance();
                    loop {
                        self.offer([ExpectedToken::Placeholder(ValueKind::Text)]);
                        let Some(token) = self.current() else {
                            return Err(ParseStop::Incomplete);
                        };
                        if !matches!(
                            token.kind,
                            LexerTokenKind::Word | LexerTokenKind::QuotedString
                        ) {
                            return Err(ParseStop::Invalid);
                        }
                        self.advance();
                        if self
                            .current()
                            .is_some_and(|token| token.kind == LexerTokenKind::Comma)
                        {
                            self.advance();
                        } else {
                            break;
                        }
                    }
                }
                Ok(())
            }
        }
    }

    /// Parses a positional amount or one or more axis assignments.
    fn assignments(&mut self, signed: bool) -> Result<(), ParseStop> {
        self.offer_tokens(&[TokenId::X, TokenId::Y, TokenId::Z]);
        if !self.at(TokenId::X) && !self.at(TokenId::Y) && !self.at(TokenId::Z) {
            return self.amount(signed);
        }
        loop {
            self.word(&["x", "y", "z"])?;
            self.require(TokenId::Equals)?;
            self.amount(signed)?;
            self.offer_tokens(&[TokenId::X, TokenId::Y, TokenId::Z]);
            if !self.at(TokenId::X) && !self.at(TokenId::Y) && !self.at(TokenId::Z) {
                return Ok(());
            }
        }
    }
}
