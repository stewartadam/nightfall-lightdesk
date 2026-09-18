// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Presentation projections over branch-owned parser expectations.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::catalog::slot_spec;
use super::contracts::{
    ClauseId, FlagId, SlotId, SuppressRule, clause_display_label as schema_clause_display_label,
};
use crate::completion_groups::catalog::completion_group_specs;
use crate::completion_groups::contracts::{
    CompletionGroupId, CompletionGroupSpec, FrontierPredicate,
};
use crate::lexicon::tokens::canonical_text;
use crate::parser::analysis::{
    ClauseInstance, CommandPrefixSnapshot, ContinuationTarget, ExpectedToken, FilledValue,
    ParseBranchState, ProjectedClauseExpectation, SlotRef, Span, ValueKind,
};
use crate::parser::query::{branch_fills, is_attribute_token, non_rejected_branches};

/// Breadcrumb state for slot-based completion planning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum BreadcrumbState {
    None,
    AmbiguousClausePath { paths: Vec<Vec<ClauseInstance>> },
    CurrentClausePath { path: Vec<ClauseInstance> },
}

/// Filled slot record for slot-based completion planning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilledSlot {
    pub slot: SlotId,
    pub clause: Option<ClauseInstance>,
    pub value: FilledValue,
    pub span: Span,
}

/// Suppression record for slot-based completion planning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuppressionRecord {
    pub slot: SlotId,
    pub clause: Option<ClauseInstance>,
    pub suppressed: ExpectedToken,
    pub rule: SuppressRule,
    pub because_of: SuppressionEvidence,
}

/// Evidence explaining why a candidate or group was suppressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SuppressionEvidence {
    FilledSlot {
        slot: SlotId,
        value: FilledValue,
        clause: Option<ClauseInstance>,
        span: Span,
    },
    Flag {
        flag: FlagId,
        span: Span,
    },
}

/// Planned completion group state for the active snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionGroup {
    pub auto_advance_candidate_id: Option<String>,
    /// References to fully formatted candidate edits in this response.
    pub candidate_ids: Vec<String>,
    pub group_id: CompletionGroupId,
    pub label: String,
    pub priority: u16,
    pub candidates: Vec<ExpectedToken>,
    pub slots: Vec<SlotId>,
    pub active_slots: Vec<SlotRef>,
    pub frontier_sources: Vec<usize>,
    pub auto_advance_singleton: Option<String>,
    pub inline_placeholder: Option<ValueKind>,
}

/// A visible token retains the particular parser alternative that supplied it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct FrontierTokenRef {
    pub source: usize,
    pub token: ExpectedToken,
}

/// Slot-planner output returned alongside completion candidates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotPlan {
    pub visible_frontier: Vec<FrontierTokenRef>,
    pub loose_frontier: Vec<FrontierTokenRef>,
    /// Formatted candidates that are displayed outside named groups.
    pub loose_candidate_ids: Vec<String>,
    pub breadcrumb: BreadcrumbState,
    pub committed_path: Vec<ClauseInstance>,
    pub active_slots: Vec<SlotRef>,
    pub filled: Vec<FilledSlot>,
    pub completion_groups: Vec<CompletionGroup>,
    pub loose_candidates: Vec<ExpectedToken>,
    pub suppression: Vec<SuppressionRecord>,
    pub next_clause_options: Vec<ClauseId>,
}

/// Projects each viable continuation without inventing slots or borrowing another branch's tokens.
pub fn build_slot_plan_with_snapshot(snapshot: &CommandPrefixSnapshot<'_>) -> SlotPlan {
    let projected = snapshot.projected_expectations();
    let branch_filled = snapshot
        .completion_branches()
        .map(filled_slots_for_branch)
        .collect::<Vec<_>>();
    let mut suppression = Vec::new();
    let visible = projected
        .iter()
        .map(|source| {
            visible_source_candidates(
                source,
                &branch_filled[source.branch_index],
                &mut suppression,
            )
        })
        .collect::<Vec<_>>();
    let mut completion_groups = Vec::new();
    let mut covered = BTreeSet::new();
    for spec in completion_group_specs() {
        let frontier_sources = projected
            .iter()
            .enumerate()
            .filter_map(|(index, source)| {
                (spec
                    .frontier_predicates
                    .iter()
                    .any(|predicate| frontier_predicate_matches(predicate, source))
                    && group_is_visible(spec, source, &branch_filled[source.branch_index]))
                .then_some(index)
            })
            .collect::<Vec<_>>();
        if frontier_sources.is_empty() {
            continue;
        }
        let candidates = frontier_sources
            .iter()
            .flat_map(|index| visible[*index].iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            continue;
        }
        let active_slots = slot_refs(frontier_sources.iter().map(|index| &projected[*index]));
        let inline_placeholder = candidates.iter().find_map(|candidate| match candidate {
            ExpectedToken::Placeholder(kind) => Some(*kind),
            _ => None,
        });
        let auto_advance_singleton = match candidates.as_slice() {
            [ExpectedToken::Token(token)] => canonical_text(*token).map(str::to_owned),
            [ExpectedToken::Literal(text)] => Some(text.to_string()),
            _ => None,
        };
        for source in &frontier_sources {
            covered.extend(
                visible[*source]
                    .iter()
                    .cloned()
                    .map(|token| FrontierTokenRef {
                        source: *source,
                        token,
                    }),
            );
        }
        completion_groups.push(CompletionGroup {
            auto_advance_candidate_id: None,
            candidate_ids: Vec::new(),
            group_id: spec.id,
            label: spec.label.to_owned(),
            priority: spec.priority,
            candidates,
            slots: spec.slots.clone(),
            active_slots,
            frontier_sources,
            auto_advance_singleton,
            inline_placeholder,
        });
    }
    completion_groups.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.group_id.as_str().cmp(right.group_id.as_str()))
    });
    let visible_frontier = visible
        .into_iter()
        .enumerate()
        .flat_map(|(source, tokens)| {
            tokens
                .into_iter()
                .map(move |token| FrontierTokenRef { source, token })
        })
        .collect::<Vec<_>>();
    let loose_frontier = visible_frontier
        .iter()
        .filter(|candidate| !covered.contains(candidate))
        .cloned()
        .collect::<Vec<_>>();
    let loose_candidates = loose_frontier
        .iter()
        .map(|candidate| candidate.token.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut next_clause_options = Vec::new();
    for source in &projected {
        if let Some(clause) = source
            .entry_clause
            .or_else(|| match source.expectation.target {
                ContinuationTarget::Clause(clause) => Some(clause),
                _ => None,
            })
        {
            if !next_clause_options.contains(&clause) {
                next_clause_options.push(clause);
            }
        }
    }
    SlotPlan {
        visible_frontier,
        loose_frontier,
        loose_candidate_ids: Vec::new(),
        committed_path: snapshot.committed_clause_path(),
        breadcrumb: frontier_breadcrumb(snapshot, &projected),
        active_slots: slot_refs(projected.iter()),
        filled: shared_filled_slots(snapshot),
        completion_groups,
        loose_candidates,
        suppression,
        next_clause_options,
    }
}

/// Applies slot presentation suppression using evidence from the expectation's own branch.
fn visible_source_candidates(
    source: &ProjectedClauseExpectation,
    filled: &[FilledSlot],
    suppression: &mut Vec<SuppressionRecord>,
) -> Vec<ExpectedToken> {
    source
        .expectation
        .expected_tokens
        .iter()
        .filter_map(|candidate| {
            if let ContinuationTarget::Slot(slot) = &source.expectation.target {
                if let Some(record) = suppression_for_candidate(
                    slot.slot,
                    candidate,
                    filled,
                    slot_spec(slot.slot).policy.suppress,
                ) {
                    if !suppression.contains(&record) {
                        suppression.push(record);
                    }
                    return None;
                }
            }
            Some(candidate.clone())
        })
        .collect()
}

/// Checks visibility against the current parser target and fills from its own branch.
fn group_is_visible(
    spec: &CompletionGroupSpec,
    source: &ProjectedClauseExpectation,
    filled: &[FilledSlot],
) -> bool {
    if let ContinuationTarget::Slot(target) = &source.expectation.target {
        if filled.iter().any(|entry| {
            entry.clause == target.clause
                && spec.activation.excludes_local_slots.contains(&entry.slot)
        }) {
            return false;
        }
    }
    let has_slot = |slot: &SlotId| {
        matches!(&source.expectation.target, ContinuationTarget::Slot(target) if target.slot == *slot)
            || filled.iter().any(|entry| entry.slot == *slot)
    };
    (spec.activation.requires_any_slots.is_empty()
        || spec.activation.requires_any_slots.iter().any(has_slot))
        && spec.activation.requires_all_slots.iter().all(has_slot)
}

/// Matches a catalog predicate to one parser continuation, preserving its clause ancestry.
fn frontier_predicate_matches(
    predicate: &FrontierPredicate,
    source: &ProjectedClauseExpectation,
) -> bool {
    let prefix = predicate.clause_path_prefix;
    source.frontier_path.len() >= prefix.len()
        && source.frontier_path.iter().zip(prefix).all(|(instance, clause)| instance.clause == *clause)
        && predicate.slot.is_none_or(|slot| matches!(&source.expectation.target, ContinuationTarget::Slot(target) if target.slot == slot))
        && predicate.rule.is_none_or(|rule| source.expectation.rule == rule)
        && predicate.next_clause.is_none_or(|clause| source.entry_clause == Some(clause) || source.expectation.target == ContinuationTarget::Clause(clause))
}

/// Collects only explicit parser slot targets, preserving repeated clause instances.
fn slot_refs<'a>(
    sources: impl IntoIterator<Item = &'a ProjectedClauseExpectation>,
) -> Vec<SlotRef> {
    let mut slots = Vec::new();
    for source in sources {
        if let ContinuationTarget::Slot(slot) = &source.expectation.target {
            if !slots.contains(slot) {
                slots.push(slot.clone());
            }
        }
    }
    slots
}

/// Projects frontier ancestry while keeping ambiguity distinct from the shared committed prefix.
fn frontier_breadcrumb(
    snapshot: &CommandPrefixSnapshot<'_>,
    sources: &[ProjectedClauseExpectation],
) -> BreadcrumbState {
    let mut paths = Vec::new();
    for source in sources {
        let path = source.frontier_path.clone();
        if path.is_empty() {
            continue;
        }
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    match paths.as_slice() {
        [] => {
            let path = snapshot.committed_clause_path();
            if path.is_empty() {
                BreadcrumbState::None
            } else {
                BreadcrumbState::CurrentClausePath { path }
            }
        }
        [path] => BreadcrumbState::CurrentClausePath { path: path.clone() },
        _ => BreadcrumbState::AmbiguousClausePath { paths },
    }
}

/// Reads the semantic fills owned by one parse branch.
fn filled_slots_for_branch(branch: &ParseBranchState<'_>) -> Vec<FilledSlot> {
    branch_fills(branch)
        .map(|(clause, fill)| FilledSlot {
            slot: fill.slot,
            clause: Some(clause.clone()),
            value: fill.value.clone(),
            span: fill.span,
        })
        .collect()
}

/// Exposes only consumed facts shared by every viable branch.
fn shared_filled_slots(snapshot: &CommandPrefixSnapshot<'_>) -> Vec<FilledSlot> {
    let mut branches = non_rejected_branches(snapshot);
    let Some(first) = branches.next() else {
        return Vec::new();
    };
    let mut filled = filled_slots_for_branch(first);
    for branch in branches {
        let other = filled_slots_for_branch(branch);
        filled.retain(|entry| other.contains(entry));
    }
    filled
}

/// Returns the catalog's display label without changing clause identity.
pub fn clause_display_label(clause: ClauseId) -> &'static str {
    schema_clause_display_label(clause)
}

/// Explains why a slot's presentation policy suppresses a candidate.
fn suppression_for_candidate(
    slot: SlotId,
    candidate: &ExpectedToken,
    filled: &[FilledSlot],
    rules: &[SuppressRule],
) -> Option<SuppressionRecord> {
    for rule in rules {
        match *rule {
            SuppressRule::ExcludeFilledTokensInSlot { slot: source } => {
                let because = filled.iter().find(|entry| {
                    entry.slot == source && entry_matches_expected_token(&entry.value, candidate)
                })?;
                return Some(suppression_record(slot, candidate.clone(), *rule, because));
            }
            SuppressRule::ExcludeFilledAttributesInSlot { slot: source } => {
                let ExpectedToken::Token(candidate_token) = candidate else {
                    continue;
                };
                if !is_attribute_token(*candidate_token) {
                    continue;
                }
                let because = filled.iter().find(|entry| {
                    entry.slot == source
                        && matches!(
                            entry.value,
                            FilledValue::Token(token) if token == *candidate_token
                        )
                })?;
                return Some(suppression_record(slot, candidate.clone(), *rule, because));
            }
            SuppressRule::ExcludeClauseAlreadyHasToken { clause } => {
                let ExpectedToken::Token(candidate_token) = candidate else {
                    continue;
                };
                let because = filled.iter().find(|entry| {
                    entry
                        .clause
                        .as_ref()
                        .is_some_and(|instance| instance.clause == clause)
                        && matches!(
                            entry.value,
                            FilledValue::Token(token) if token == *candidate_token
                        )
                })?;
                return Some(suppression_record(slot, candidate.clone(), *rule, because));
            }
        }
    }
    None
}

/// Creates a suppression record pointing to the conflicting filled slot.
fn suppression_record(
    slot: SlotId,
    suppressed: ExpectedToken,
    rule: SuppressRule,
    because: &FilledSlot,
) -> SuppressionRecord {
    SuppressionRecord {
        slot,
        clause: because.clause.clone(),
        suppressed,
        rule,
        because_of: SuppressionEvidence::FilledSlot {
            slot: because.slot,
            value: because.value.clone(),
            clause: because.clause.clone(),
            span: because.span,
        },
    }
}

/// Checks whether a filled slot value matches an expected token.
fn entry_matches_expected_token(value: &FilledValue, expected: &ExpectedToken) -> bool {
    match (value, expected) {
        (FilledValue::Token(left), ExpectedToken::Token(right)) => left == right,
        (FilledValue::Placeholder(left, _), ExpectedToken::Placeholder(right)) => left == right,
        (FilledValue::Lexeme(left), ExpectedToken::Literal(right)) => left == right,
        _ => false,
    }
}

impl SlotPlan {
    /// Binds presentation groups to the formatted edits owned by their exact frontier sources.
    pub fn bind_candidates(&mut self, candidates: &[crate::autocomplete::CompletionCandidate]) {
        for group in &mut self.completion_groups {
            group.candidate_ids = candidates
                .iter()
                .filter(|candidate| {
                    group.candidates.contains(&candidate.expected)
                        && candidate.frontier_sources.iter().any(|source| {
                            group.frontier_sources.contains(source)
                                && self.visible_frontier.contains(&FrontierTokenRef {
                                    source: *source,
                                    token: candidate.expected.clone(),
                                })
                        })
                })
                .map(|candidate| candidate.id.clone())
                .collect();
            group.auto_advance_candidate_id = if group.inline_placeholder.is_none()
                && group.candidate_ids.len() == 1
                && group.auto_advance_singleton.is_some()
            {
                group.candidate_ids.first().cloned()
            } else {
                None
            };
        }
        self.loose_candidate_ids = candidates
            .iter()
            .filter(|candidate| {
                candidate.frontier_sources.iter().any(|source| {
                    self.loose_frontier.contains(&FrontierTokenRef {
                        source: *source,
                        token: candidate.expected.clone(),
                    })
                })
            })
            .map(|candidate| candidate.id.clone())
            .collect();
    }
}
