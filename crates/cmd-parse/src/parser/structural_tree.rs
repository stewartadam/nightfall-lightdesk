// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clause-tree reconstruction helpers for structural parser branches.

use std::collections::BTreeMap;

use crate::lexicon::tokens::token_id_for_text;
use crate::parser::analysis::{
    ClauseInstance, ClauseNode, ClauseNodeId, ClauseParseTree, ClauseSlotFill,
    ConsumedSemanticItem, FilledValue, NormalizedFilledValue, ParseBranchState, Span,
};
use crate::slots::contracts::clause_parent;

pub(crate) fn clause_tree_from_branch(branch: &ParseBranchState<'_>) -> ClauseParseTree {
    let mut tree = ClauseParseTree::default();
    let mut ids = BTreeMap::<ClauseInstance, ClauseNodeId>::new();

    for frame in &branch.clause_stack {
        ensure_clause_node(&mut tree, &mut ids, &frame.clause);
    }

    for item in &branch.consumed_items {
        let node_id = ensure_clause_node(&mut tree, &mut ids, &item.clause);
        let node = &mut tree.nodes[node_id.0 as usize];
        node.fills.push(ClauseSlotFill {
            slot: item.slot.slot,
            value: filled_value_from_consumed_item(item),
            span: item.source_span,
        });
        merge_node_span(&mut node.span, item.source_span);
    }

    for index in (0..tree.nodes.len()).rev() {
        let Some(parent_id) = tree.nodes[index].parent else {
            continue;
        };
        let child_span = tree.nodes[index].span;
        if let Some(span) = child_span {
            merge_node_span(&mut tree.nodes[parent_id.0 as usize].span, span);
        }
    }

    tree
}

fn ensure_clause_node(
    tree: &mut ClauseParseTree,
    ids: &mut BTreeMap<ClauseInstance, ClauseNodeId>,
    clause: &ClauseInstance,
) -> ClauseNodeId {
    if let Some(id) = ids.get(clause).copied() {
        return id;
    }

    let parent = clause_parent(clause.clause).map(|parent_clause| ClauseInstance {
        clause: parent_clause,
        instance: 0,
    });
    let parent_id = parent
        .as_ref()
        .map(|parent_clause| ensure_clause_node(tree, ids, parent_clause));
    let id = ClauseNodeId(tree.nodes.len() as u32);
    tree.nodes.push(ClauseNode {
        clause: clause.clone(),
        occurrence: clause.instance,
        parent: parent_id,
        children: Vec::new(),
        fills: Vec::new(),
        span: None,
        explicit: true,
    });
    if let Some(parent_id) = parent_id {
        tree.nodes[parent_id.0 as usize].children.push(id);
    } else {
        tree.roots.push(id);
    }
    ids.insert(clause.clone(), id);
    id
}

fn filled_value_from_consumed_item(item: &ConsumedSemanticItem) -> FilledValue {
    match &item.normalized_value {
        Some(NormalizedFilledValue::Keyword(token)) => FilledValue::Token(*token),
        _ => token_id_for_text(item.surface.as_str())
            .map(FilledValue::Token)
            .unwrap_or_else(|| FilledValue::Lexeme(item.surface.clone())),
    }
}

fn merge_node_span(span: &mut Option<Span>, next: Span) {
    match span {
        Some(current) => {
            current.start = current.start.min(next.start);
            current.end = current.end.max(next.end);
        }
        None => *span = Some(next),
    }
}
