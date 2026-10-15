// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::BTreeSet;

use nightfall_cmd_parse::parser::analysis::TokenId;
use nightfall_cmd_parse::slots::catalog::slot_spec;
use nightfall_cmd_parse::slots::contracts::{
    ClauseCondition, ClauseEntryKind, ClauseId, ClauseSchema, SlotCardinality, SlotId, SlotScope,
    clause_schema, command_grammar,
};

/// Collects the slots owned by a clause and, for subtree scope, by all of its descendants.
fn slots_in_scope(clause: ClauseId, scope: SlotScope) -> BTreeSet<SlotId> {
    let schema = clause_schema(clause);
    let mut slots = schema
        .slots
        .iter()
        .map(|slot| slot.slot)
        .collect::<BTreeSet<_>>();
    if scope == SlotScope::Subtree {
        for child in schema.children {
            slots.extend(slots_in_scope(child.clause, SlotScope::Subtree));
        }
    }
    slots
}

/// Returns a problem when a condition reads a slot that no clause in its scope owns.
fn slot_scope_problems(schema: &ClauseSchema, scope: SlotScope, slot: SlotId) -> Vec<String> {
    // The root command head is recorded as a fill of every root clause.
    let head = slot == SlotId::CommandHead && schema.parent.is_none();
    if head || slots_in_scope(schema.id, scope).contains(&slot) {
        Vec::new()
    } else {
        vec![format!(
            "{:?} condition reads {slot:?} outside {scope:?} scope",
            schema.id
        )]
    }
}

/// Returns the keywords a slot can hold: the clause's root heads for the command head, or the
/// tokens the slot catalog offers otherwise.
fn accepted_tokens(schema: &ClauseSchema, slot: SlotId) -> Vec<TokenId> {
    match (slot, schema.entry) {
        (SlotId::CommandHead, ClauseEntryKind::RootCommandHead(heads)) => heads.to_vec(),
        _ => slot_spec(slot).offers.tokens.to_vec(),
    }
}

/// Collects every problem with one condition: references to children the clause does not
/// declare, slots outside the condition's scope, or keywords the slot can never hold.
fn condition_problems(schema: &ClauseSchema, condition: &ClauseCondition) -> Vec<String> {
    match condition {
        ClauseCondition::Always | ClauseCondition::Never | ClauseCondition::Hook(_) => Vec::new(),
        ClauseCondition::HasAnyChild => {
            if schema.children.is_empty() {
                vec![format!(
                    "{:?} checks for children it cannot have",
                    schema.id
                )]
            } else {
                Vec::new()
            }
        }
        ClauseCondition::Filled(scope, slot) => slot_scope_problems(schema, *scope, *slot),
        ClauseCondition::FilledWith(scope, slot, tokens) => {
            let mut problems = slot_scope_problems(schema, *scope, *slot);
            let accepted = accepted_tokens(schema, *slot);
            problems.extend(
                tokens
                    .iter()
                    .filter(|token| !accepted.contains(token))
                    .map(|token| {
                        format!(
                            "{:?} condition expects {token:?} in {slot:?}, which never offers it",
                            schema.id
                        )
                    }),
            );
            problems
        }
        ClauseCondition::HasChild(child) => {
            if schema.children.iter().any(|spec| spec.clause == *child) {
                Vec::new()
            } else {
                vec![format!(
                    "{:?} condition checks undeclared child {child:?}",
                    schema.id
                )]
            }
        }
        ClauseCondition::Not(inner) => condition_problems(schema, inner),
        ClauseCondition::All(conditions) | ClauseCondition::Any(conditions) => conditions
            .iter()
            .flat_map(|condition| condition_problems(schema, condition))
            .collect(),
    }
}

/// Every availability rule names a child or slot its clause declares, at most once, and its
/// condition only reads children and slots that clause can actually observe.
#[test]
fn clause_rules_reference_declared_children_and_slots() {
    let mut problems = Vec::new();
    for schema in command_grammar().clauses {
        let mut seen_children = BTreeSet::new();
        for rule in schema.rules.children {
            if !schema
                .children
                .iter()
                .any(|spec| spec.clause == rule.clause)
            {
                problems.push(format!(
                    "{:?} has a rule for undeclared child {:?}",
                    schema.id, rule.clause
                ));
            }
            if !seen_children.insert(rule.clause) {
                problems.push(format!(
                    "{:?} has two rules for child {:?}",
                    schema.id, rule.clause
                ));
            }
            problems.extend(condition_problems(schema, &rule.when));
        }
        let mut seen_slots = BTreeSet::new();
        for rule in schema.rules.slots {
            if !schema.slots.iter().any(|spec| spec.slot == rule.slot) {
                problems.push(format!(
                    "{:?} has a rule for undeclared slot {:?}",
                    schema.id, rule.slot
                ));
            }
            if !seen_slots.insert(rule.slot) {
                problems.push(format!(
                    "{:?} has two rules for slot {:?}",
                    schema.id, rule.slot
                ));
            }
            problems.extend(condition_problems(schema, &rule.when));
        }
    }
    assert!(
        problems.is_empty(),
        "invalid clause rules:\n{}",
        problems.join("\n")
    );
}

/// Frontier rules only name declared children, child-only flags sit on clauses that have a
/// parent, and slot pairing is only requested by clauses with more than one required slot.
#[test]
fn frontier_rules_fit_the_grammar() {
    let mut problems = Vec::new();
    for schema in command_grammar().clauses {
        let frontier = &schema.rules.frontier;
        for eager in frontier.eager_children {
            if !schema
                .children
                .iter()
                .any(|spec| spec.clause == eager.clause)
            {
                problems.push(format!(
                    "{:?} eagerly offers undeclared child {:?}",
                    schema.id, eager.clause
                ));
            }
            problems.extend(condition_problems(schema, &eager.when));
        }
        let is_child = schema.parent.is_some();
        if frontier.blocks_parent_until_entered && !is_child {
            problems.push(format!("{:?} is a root but blocks a parent", schema.id));
        }
        if frontier.project_initial_slot && (!is_child || schema.slots.is_empty()) {
            problems.push(format!("{:?} projects an initial slot it lacks", schema.id));
        }
        let required_slots = schema
            .slots
            .iter()
            .filter(|slot| slot.cardinality == SlotCardinality::Required)
            .count();
        if frontier.offer_required_slots_together && required_slots < 2 {
            problems.push(format!(
                "{:?} pairs required slots but has {required_slots}",
                schema.id
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "invalid frontier rules:\n{}",
        problems.join("\n")
    );
}
