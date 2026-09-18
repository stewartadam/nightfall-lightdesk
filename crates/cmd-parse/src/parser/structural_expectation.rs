// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Expectation construction helpers for the structural parser.

use crate::parser::analysis::{
    ClauseExpectation, ClauseInstance, ContinuationKind, ContinuationTarget, ExpectedToken, SlotRef,
};
use crate::parser::structural::{
    StructuralClauseParser, continuation_kind_for_slot, expected_tokens_for_clause_entry,
    expected_tokens_for_slot, grammar_rule_for_slot, root_rule_for_clause,
};
use crate::slots::catalog::slot_spec;
use crate::slots::contracts::{ClauseId, ClauseSlotSpec};

pub(super) fn slot_expectation(
    parser: &StructuralClauseParser,
    clause: ClauseInstance,
    slot: ClauseSlotSpec,
) -> ClauseExpectation {
    let slot_ref = SlotRef {
        slot: slot.slot,
        clause: Some(clause),
    };
    let expected_tokens = expected_tokens_for_slot(slot_ref.clone());
    filtered_slot_expectation(
        parser,
        slot_ref.clause.clone().expect("slot clause"),
        slot,
        expected_tokens,
    )
}

pub(super) fn filtered_slot_expectation(
    parser: &StructuralClauseParser,
    clause: ClauseInstance,
    slot: ClauseSlotSpec,
    expected_tokens: Vec<ExpectedToken>,
) -> ClauseExpectation {
    let slot_ref = SlotRef {
        slot: slot.slot,
        clause: Some(clause),
    };
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Slot(slot_ref.clone()),
        continuation_kind: continuation_kind_for_slot(slot.slot),
        expected_tokens: expected_tokens.clone(),
        rule: grammar_rule_for_slot(slot.slot, &expected_tokens, parser.clause),
    }
}

pub(super) fn slot_value_expectation(
    parser: &StructuralClauseParser,
    clause: ClauseInstance,
    slot: ClauseSlotSpec,
) -> ClauseExpectation {
    let slot_ref = SlotRef {
        slot: slot.slot,
        clause: Some(clause),
    };
    let expected_tokens = slot_spec(slot.slot)
        .offers
        .placeholder
        .into_iter()
        .map(ExpectedToken::Placeholder)
        .collect::<Vec<_>>();
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Slot(slot_ref),
        continuation_kind: continuation_kind_for_slot(slot.slot),
        expected_tokens: expected_tokens.clone(),
        rule: grammar_rule_for_slot(slot.slot, &expected_tokens, parser.clause),
    }
}

pub(super) fn clause_expectation(
    parser: &StructuralClauseParser,
    clause: ClauseId,
) -> ClauseExpectation {
    let rule = if matches!(clause, ClauseId::PatchSource | ClauseId::PatchTarget) {
        root_rule_for_clause(clause)
    } else {
        root_rule_for_clause(parser.clause)
    };
    ClauseExpectation {
        replace_active_token: false,
        target: ContinuationTarget::Clause(clause),
        continuation_kind: ContinuationKind::ClauseEntry,
        expected_tokens: expected_tokens_for_clause_entry(clause),
        rule,
    }
}
