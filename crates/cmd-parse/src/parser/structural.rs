// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema-driven structural clause parser facade and coordinator.

mod branch_execution;
mod continuation;
mod contracts;
mod grammar_mapping;
mod slot_consumption;
mod token_acceptance;
mod token_merging;
mod value_surface;

#[cfg(test)]
mod tests;

use std::marker::PhantomData;

pub(in crate::parser) use branch_execution::*;
pub use branch_execution::{execute_branches_from_tokens, seed_branch_from_head};
pub(in crate::parser) use continuation::*;
pub use contracts::*;
pub(in crate::parser) use grammar_mapping::*;
pub use grammar_mapping::{expected_tokens_for_clause_entry, expected_tokens_for_slot};
pub(in crate::parser) use slot_consumption::*;
use smol_str::SmolStr;
pub(in crate::parser) use token_acceptance::*;
pub(in crate::parser) use token_merging::*;
pub(in crate::parser) use value_surface::*;

use super::frontier::is_complete_duration_value;
use super::parse_specs::{
    attribute_collection_parse_spec_for_slot, attribute_lexeme_is_allowed, duration_value_prefix,
};
use super::structural_frontier::branch_frontier_state_for_branch;
use super::structural_frontier::slot_keeps_expression_continuation_live;
use super::structural_fx::{
    filled_value_for_fx_rate_followup, fx_rate_requires_followup, promote_ready_step_fx_definition,
};
use super::structural_tree::clause_tree_from_branch;
use crate::lexicon::aliases::{AliasCanonicalizationContext, canonicalize_token};
use crate::lexicon::tokens::canonical_text;
use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{
    ClauseCommitState, ClauseExpectation, ClauseFrame, ClauseInstance, ClauseParseTree,
    ClausePhase, CommandPrefixContext, ConsumedSemanticItem, ContinuationKind, ContinuationTarget,
    ExpectedToken, FilledValue, GrammarRuleId, NormalizedFilledValue, ParseBranchState,
    ParseCursor, PathStatus, SlotRef, Span, TokenId, ValueKind,
};
use crate::parser::lexer::{LexerToken, LexerTokenKind};
use crate::slots::catalog::slot_spec;
use crate::slots::contracts::{
    ClauseCardinality, ClauseHookId, ClauseId, ClauseSlotSpec, SlotCardinality, SlotId,
    clause_children, clause_hook_id, clause_parent, clause_slots, root_clause_for_command_head,
};
