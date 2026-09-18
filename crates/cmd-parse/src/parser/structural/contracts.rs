// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural parser contracts and schema-derived parser trees.

use super::*;

/// A schema-generated structural clause parser node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuralClauseParser {
    pub clause: ClauseId,
    pub hook: Option<ClauseHookId>,
    pub slots: &'static [ClauseSlotSpec],
    pub children: Vec<StructuralClauseChild>,
}

/// One child edge in a schema-generated structural clause parser node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuralClauseChild {
    pub cardinality: ClauseCardinality,
    pub parser: StructuralClauseParser,
}

/// Context made available to a clause semantic hook during branch execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClauseSemanticHookContext<'i> {
    pub segment: &'i str,
    pub prefix_context: CommandPrefixContext,
    pub active_clause: ClauseInstance,
    pub token_index: usize,
}

/// One raw slot fill presented to a clause semantic hook for normalization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClauseSemanticFill<'i> {
    pub slot: SlotRef,
    pub surface: &'i str,
}

/// Result of hook-owned slot normalization.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClauseSemanticFillOutcome {
    pub normalized_value: Option<NormalizedFilledValue>,
}

/// Handwritten semantic hook that complements schema-driven structural parsing.
pub trait ClauseSemanticHook {
    /// Returns the schema hook identifier implemented by this handler.
    fn hook_id(&self) -> ClauseHookId;

    /// Normalizes one raw fill while preserving the default no-op behavior for other hooks.
    fn normalize_fill(
        &self,
        _context: &ClauseSemanticHookContext<'_>,
        _fill: &ClauseSemanticFill<'_>,
    ) -> ClauseSemanticFillOutcome {
        ClauseSemanticFillOutcome::default()
    }

    /// Applies hook-owned branch updates after a semantic item is consumed.
    fn on_consumed_item<'i>(
        &self,
        _context: &ClauseSemanticHookContext<'_>,
        _branch: &mut ParseBranchState<'i>,
        _item: &ConsumedSemanticItem,
    ) {
    }

    /// Filters or augments expectations emitted for the hook's active clause.
    fn filter_expectations<'i>(
        &self,
        _context: &ClauseSemanticHookContext<'_>,
        _branch: &ParseBranchState<'i>,
        _expectations: &mut Vec<ClauseExpectation>,
    ) {
    }
}

/// Placeholder registry entry for a semantic hook family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClauseSemanticHookSpec<'a> {
    pub hook_id: ClauseHookId,
    pub marker: PhantomData<&'a dyn ClauseSemanticHook>,
}

impl<'a> ClauseSemanticHookSpec<'a> {
    /// Creates a marker specification for one registered semantic hook family.
    pub fn new(hook_id: ClauseHookId) -> Self {
        Self {
            hook_id,
            marker: PhantomData,
        }
    }
}

/// Returns the semantic hook family associated with a structural clause parser.
pub fn semantic_hook_spec(
    parser: &StructuralClauseParser,
) -> Option<ClauseSemanticHookSpec<'static>> {
    parser.hook.map(ClauseSemanticHookSpec::new)
}

/// Builds the structural parser tree rooted at the given clause.
pub fn structural_clause_parser(clause: ClauseId) -> StructuralClauseParser {
    StructuralClauseParser {
        clause,
        hook: clause_hook_id(clause),
        slots: clause_slots(clause),
        children: clause_children(clause)
            .iter()
            .map(|child| StructuralClauseChild {
                cardinality: child.cardinality,
                parser: structural_clause_parser(child.clause),
            })
            .collect(),
    }
}

/// Builds the structural parser tree selected by a command head token.
pub fn structural_clause_parser_for_head(head: TokenId) -> Option<StructuralClauseParser> {
    root_clause_for_command_head(head).map(structural_clause_parser)
}
