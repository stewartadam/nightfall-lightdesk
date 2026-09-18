// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Direct queries over authoritative parser snapshots.

use std::collections::BTreeSet;

use crate::parser::analysis::{
    ClauseInstance, ClauseSlotFill, CommandPrefixSnapshot, ExpectedToken, GrammarRuleId,
    ParseBranchState, PathStatus, ProjectedClauseExpectation, TokenId,
};

/// Returns non-rejected parse branches for branch-aware snapshot queries.
pub fn non_rejected_branches<'a, 'i>(
    snapshot: &'a CommandPrefixSnapshot<'i>,
) -> impl Iterator<Item = &'a ParseBranchState<'i>> + 'a {
    snapshot
        .branches
        .iter()
        .filter(|branch| branch.status != PathStatus::Rejected)
}

/// Returns all clause-tree fills observed for a single branch.
pub fn branch_fills<'a, 'i>(
    branch: &'a ParseBranchState<'i>,
) -> impl Iterator<Item = (&'a ClauseInstance, &'a ClauseSlotFill)> + 'a {
    branch
        .clause_tree
        .nodes
        .iter()
        .flat_map(|node| node.fills.iter().map(move |fill| (&node.clause, fill)))
}

/// Returns branch expectations annotated with committed clause ancestry.
pub fn projected_expectations(
    snapshot: &CommandPrefixSnapshot<'_>,
) -> Vec<ProjectedClauseExpectation> {
    snapshot.projected_expectations()
}

/// Returns the token union of parser-owned continuation and replacement alternatives.
pub fn expected_tokens(snapshot: &CommandPrefixSnapshot<'_>) -> BTreeSet<ExpectedToken> {
    snapshot.frontier().expected_tokens.into_iter().collect()
}

/// Returns the rule union of parser-owned continuation and replacement alternatives.
pub fn expected_rules(snapshot: &CommandPrefixSnapshot<'_>) -> BTreeSet<GrammarRuleId> {
    snapshot.frontier().expected_rules.into_iter().collect()
}

/// Returns true when a token is an attribute keyword.
pub fn is_attribute_token(token_id: TokenId) -> bool {
    matches!(
        token_id,
        TokenId::Intensity | TokenId::Red | TokenId::Green | TokenId::Blue | TokenId::White
    )
}
