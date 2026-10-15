// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Evaluation of the grammar's declarative clause conditions against a parse branch.

use super::*;
use crate::parser::analysis::ClauseNode;
use crate::slots::contracts::{
    ChildrenMode, ClauseCondition, ConditionHookId, SlotScope, clause_rules,
};

/// Returns whether the grammar rules allow entering `child_clause` under `clause` now.
///
/// Applies the parent's [`ChildrenMode`] first, so a clause whose children are alternatives
/// only continues with the child already chosen, then the child's own condition, if any.
pub(in crate::parser) fn child_clause_is_available(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    child_clause: ClauseId,
) -> bool {
    let rules = clause_rules(clause.clause);
    if rules.children_mode == ChildrenMode::OneOf
        && let Some(active) = child_nodes(branch, clause).next()
        && active.clause.clause != child_clause
    {
        return false;
    }
    rules
        .children
        .iter()
        .find(|rule| rule.clause == child_clause)
        .is_none_or(|rule| condition_holds(branch, clause, &rule.when))
}

/// Returns whether the grammar rules allow filling `slot` in `clause` now.
pub(in crate::parser) fn slot_is_available_in_branch(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    slot: SlotId,
) -> bool {
    clause_rules(clause.clause)
        .slots
        .iter()
        .find(|rule| rule.slot == slot)
        .is_none_or(|rule| condition_holds(branch, clause, &rule.when))
}

/// Evaluates one grammar condition for a clause instance in the branch.
fn condition_holds(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    condition: &ClauseCondition,
) -> bool {
    match condition {
        ClauseCondition::Never => false,
        ClauseCondition::Filled(scope, slot) => {
            scoped_fills(branch, clause, *scope, *slot).next().is_some()
        }
        ClauseCondition::FilledWith(scope, slot, tokens) => {
            scoped_fills(branch, clause, *scope, *slot)
                .any(|item| fill_token(item).is_some_and(|token| tokens.contains(&token)))
        }
        ClauseCondition::HasChild(child_clause) => {
            child_nodes(branch, clause).any(|node| node.clause.clause == *child_clause)
        }
        ClauseCondition::HasAnyChild => child_nodes(branch, clause).next().is_some(),
        ClauseCondition::Not(inner) => !condition_holds(branch, clause, inner),
        ClauseCondition::All(conditions) => conditions
            .iter()
            .all(|condition| condition_holds(branch, clause, condition)),
        ClauseCondition::Any(conditions) => conditions
            .iter()
            .any(|condition| condition_holds(branch, clause, condition)),
        ClauseCondition::Hook(hook) => hook_holds(branch, clause, *hook),
    }
}

/// Evaluates a named parser hook referenced from the grammar.
fn hook_holds(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    hook: ConditionHookId,
) -> bool {
    match hook {
        ConditionHookId::BezierShapingOpen => {
            let shaping_fills = scoped_fills(
                branch,
                clause,
                SlotScope::Own,
                SlotId::StepFxAttributeShaping,
            )
            .collect::<Vec<_>>();
            bezier_expression_in_progress(&shaping_fills)
        }
    }
}

/// Finds the observed tree node for a clause instance, if the branch has reached it.
fn clause_node<'b>(
    branch: &'b ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> Option<&'b ClauseNode> {
    branch
        .clause_tree
        .nodes
        .iter()
        .find(|node| node.clause == *clause)
}

/// Iterates the observed tree nodes directly under the given clause instance.
fn child_nodes<'b>(
    branch: &'b ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> impl Iterator<Item = &'b ClauseNode> + 'b {
    let nodes = &branch.clause_tree.nodes;
    clause_node(branch, clause)
        .into_iter()
        .flat_map(move |node| node.children.iter().map(|id| &nodes[id.0 as usize]))
}

/// Iterates consumed fills of `slot` owned by the clause instance or, for
/// [`SlotScope::Subtree`], by any clause nested under it in the observed tree.
fn scoped_fills<'b>(
    branch: &'b ParseBranchState<'_>,
    clause: &ClauseInstance,
    scope: SlotScope,
    slot: SlotId,
) -> impl Iterator<Item = &'b ConsumedSemanticItem> + 'b {
    let owners = match scope {
        SlotScope::Own => vec![clause.clone()],
        SlotScope::Subtree => subtree_clauses(branch, clause),
    };
    branch
        .consumed_items
        .iter()
        .filter(move |item| item.slot.slot == slot && owners.contains(&item.clause))
}

/// Collects the clause instance and every instance nested under it in the observed tree.
fn subtree_clauses(branch: &ParseBranchState<'_>, clause: &ClauseInstance) -> Vec<ClauseInstance> {
    let nodes = &branch.clause_tree.nodes;
    let mut clauses = vec![clause.clone()];
    let mut pending = clause_node(branch, clause)
        .map(|node| node.children.clone())
        .unwrap_or_default();
    while let Some(id) = pending.pop() {
        let node = &nodes[id.0 as usize];
        clauses.push(node.clause.clone());
        pending.extend(node.children.iter().copied());
    }
    clauses
}

/// Returns the keyword a fill resolved to, using the same resolution as the clause tree.
fn fill_token(item: &ConsumedSemanticItem) -> Option<TokenId> {
    match filled_value_from_consumed_item(item) {
        FilledValue::Token(token) => Some(token),
        _ => None,
    }
}
