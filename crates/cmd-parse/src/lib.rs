// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parser for CLI commands.

use thiserror::Error;

pub mod ast;
pub mod autocomplete;
pub(crate) mod command_family;
pub mod completion;
pub mod completion_groups;
pub mod conv;
pub mod lexicon;
pub mod parser;
mod phase_language;
mod selection_language;
pub mod slots;
mod statements;
pub use phase_language::{format_phase_expression_degrees, parse_phase_expression_text};
pub use selection_language::parse_selection_expr;
pub use selection_language::parse_spatial_selection_text;
pub use statements::{
    StatementRange, split_command_statements, statement_range_at, statement_ranges,
};

/// Common re-exports for downstream crates using command parsing APIs.
pub mod prelude {
    pub use crate::ParseError;
    pub use crate::autocomplete::CommandValidationResponse;
    pub use crate::autocomplete::CompletionCandidate;
    pub use crate::autocomplete::ParseSnapshot;
    pub use crate::autocomplete::ParseStatus;
    pub use crate::autocomplete::TextRange;
    pub use crate::autocomplete::complete_command;
    pub use crate::autocomplete::validate_command;
    pub use crate::completion::api::CommandCompletionResponse;
    pub use crate::completion_groups::contracts::CompletionGroupId;
    pub use crate::parser::analysis::CommandPrefixContext;
    pub use crate::parser::analysis::CommandPrefixSnapshot;
    pub use crate::parser::analysis::ExpectedToken;
    pub use crate::parser::analysis::GrammarRuleId;
    pub use crate::parser::analysis::ParseBranchState;
    pub use crate::parser::analysis::ParseStatus as AnalysisParseStatus;
    pub use crate::parser::analysis::TokenId;
    pub use crate::parser::analysis::ValueKind;
    pub use crate::slots::contracts::ClauseId;
    pub use crate::slots::contracts::FlagId;
    pub use crate::slots::contracts::SlotId;
}

/// Errors that can occur during command parsing.
#[derive(Debug, Error)]
pub enum ParseError {
    /// Failed to parse the command with the given reason.
    #[error("Failed to parse command: {0}")]
    Failure(String),
}

/// Generates an AST for a strict command string parse.
pub fn generate_ast<'i>(command_str: &'i str) -> Result<ast::CommandAst<'i>, ast::AstError> {
    parser::strict::parse_strict(command_str)
}
