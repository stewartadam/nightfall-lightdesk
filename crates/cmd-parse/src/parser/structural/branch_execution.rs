// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural branch seeding, execution, and lifecycle helpers.

use super::*;

/// Seeds a first executable parse branch from an exact command-head token.
pub fn seed_branch_from_head<'i>(
    context: &CommandPrefixContext,
    head: TokenId,
    furthest_pos: usize,
    clause_tree: ClauseParseTree,
) -> Option<ParseBranchState<'i>> {
    let parser = structural_clause_parser_for_head(head)?;
    let root_clause = ClauseInstance {
        clause: parser.clause,
        instance: 0,
    };
    let mut clause_stack = vec![ClauseFrame {
        clause: root_clause.clone(),
        phase: ClausePhase::Filling,
        commit_state: ClauseCommitState::Committed,
    }];
    let mut clause_usage = Vec::new();
    let mut consumed_items = Vec::new();
    let normalized_value = Some(NormalizedFilledValue::Keyword(head));
    clause_usage.push(crate::parser::analysis::ClauseUsageState {
        clause: root_clause.clone(),
        used_values: normalized_value.clone().into_iter().collect(),
    });
    let head_span = head_span(context, head);
    consumed_items.push(ConsumedSemanticItem {
        slot: SlotRef {
            slot: SlotId::CommandHead,
            clause: Some(root_clause.clone()),
        },
        clause: root_clause.clone(),
        surface: head_surface(context, head),
        normalized_value,
        source_span: head_span,
        source_token_start: head_span.start,
        source_token_end: head_span.end,
    });
    let _ = absorb_root_head_child(
        &parser,
        head,
        context,
        &mut clause_stack,
        &mut clause_usage,
        &mut consumed_items,
    );

    let mut branch = ParseBranchState {
        cursor: ParseCursor {
            token_index: context.token_count,
            furthest_pos,
        },
        clause_stack,
        clause_tree,
        clause_usage,
        consumed_items,
        status: PathStatus::Live,
        frontier: Vec::new(),
        ast: None,
        replace_start: None,
    };
    refresh_branch(&mut branch);

    Some(branch)
}

/// Executes the structural parser over lexer tokens and returns live branch states.
pub fn execute_branches_from_tokens<'i>(
    context: &CommandPrefixContext,
    tokens: &[LexerToken],
    furthest_pos: usize,
) -> Vec<ParseBranchState<'i>> {
    let significant = merged_structural_tokens(tokens)
        .into_iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect::<Vec<_>>();
    let Some(first_token) = significant.first() else {
        return Vec::new();
    };
    let head_token = if first_token.kind == LexerTokenKind::QuotedString {
        Some(TokenId::Quote)
    } else {
        token_id_for_text(first_token.text.as_str())
    };
    let Some(mut branch) = head_token
        .and_then(|head| {
            seed_branch_from_head(context, head, furthest_pos, ClauseParseTree::default())
        })
        .or_else(|| seed_active_selection_branch(context, first_token, furthest_pos))
    else {
        return Vec::new();
    };
    for item in &mut branch.consumed_items {
        item.surface = first_token.text.clone();
        item.source_span = token_span(first_token);
        item.source_token_start = first_token.span.start;
        item.source_token_end = first_token.span.end;
    }
    refresh_branch(&mut branch);
    branch.cursor.furthest_pos = first_token.span.end;
    branch.cursor.token_index = 1;

    let mut branches = vec![branch];
    let mut last_non_empty = branches.clone();
    for (index, token) in significant.iter().enumerate().skip(1) {
        let mut next = advance_branches_with_token(context, &branches, token);
        for branch in &mut next {
            branch.cursor.furthest_pos = token.span.end;
            branch.cursor.token_index = index + 1;
        }
        if next.is_empty() {
            branches = next;
            break;
        }
        last_non_empty = next.clone();
        branches = next;
    }

    if branches.is_empty() {
        branches = last_non_empty;
    }

    branches
        .into_iter()
        .map(|mut branch| {
            promote_ready_step_fx_definition(context, &mut branch);
            branch
        })
        .collect()
}

/// Seeds a programmer branch for attribute or value input that targets the active selection.
pub(in crate::parser) fn seed_active_selection_branch<'i>(
    context: &CommandPrefixContext,
    first_token: &LexerToken,
    furthest_pos: usize,
) -> Option<ParseBranchState<'i>> {
    let token_id = token_id_for_text(first_token.text.as_str());
    let attribute_token = token_id_for_slot_surface(
        SlotId::SetAttrAttribute,
        first_token.text.as_str(),
    )
    .filter(|token| {
        matches!(
            token,
            TokenId::Intensity | TokenId::Red | TokenId::Green | TokenId::Blue | TokenId::White
        )
    });
    let starts_with_value = matches!(
        token_id,
        Some(TokenId::AtSign | TokenId::Tilde | TokenId::DoubleAtSign)
    );
    let starts_with_attribute = attribute_token.is_some()
        || attribute_collection_parse_spec_for_slot(SlotId::SetAttrAttribute).is_some_and(|spec| {
            attribute_lexeme_is_allowed(
                spec.attribute_spec,
                first_token.text.as_str(),
                token_id_for_text(first_token.text.as_str()),
                first_token.kind == LexerTokenKind::QuotedString,
            )
        });
    if !starts_with_value && !starts_with_attribute {
        return None;
    }

    let root_clause = ClauseInstance {
        clause: ClauseId::Programmer,
        instance: 0,
    };
    let actions_clause = ClauseInstance {
        clause: ClauseId::ProgrammerAttributeActions,
        instance: 0,
    };
    let item_clause = ClauseInstance {
        clause: ClauseId::ProgrammerSetAttributeItem,
        instance: 0,
    };
    let mut branch = ParseBranchState {
        cursor: ParseCursor {
            token_index: context.token_count,
            furthest_pos,
        },
        clause_stack: vec![
            ClauseFrame {
                clause: root_clause.clone(),
                phase: ClausePhase::Filling,
                commit_state: ClauseCommitState::Committed,
            },
            ClauseFrame {
                clause: actions_clause,
                phase: ClausePhase::Entered,
                commit_state: ClauseCommitState::Committed,
            },
            ClauseFrame {
                clause: item_clause.clone(),
                phase: ClausePhase::Entered,
                commit_state: ClauseCommitState::Committed,
            },
        ],
        clause_tree: ClauseParseTree::default(),
        clause_usage: Vec::new(),
        consumed_items: Vec::new(),
        status: PathStatus::Live,
        frontier: Vec::new(),
        ast: None,
        replace_start: None,
    };
    if starts_with_value {
        let value_token = token_id.expect("active selection value token");
        let value = FilledValue::Token(value_token);
        let normalized_value =
            normalized_value_for_fill(SlotId::SetAttrValue, &value, &first_token.text);
        branch.consumed_items.push(ConsumedSemanticItem {
            slot: SlotRef {
                slot: SlotId::SetAttrValue,
                clause: Some(item_clause.clone()),
            },
            clause: item_clause.clone(),
            surface: first_token.text.clone(),
            normalized_value: normalized_value.clone(),
            source_span: token_span(first_token),
            source_token_start: first_token.span.start,
            source_token_end: first_token.span.end,
        });
        if let Some(value) = normalized_value {
            record_clause_usage(&mut branch, &item_clause, value);
        }
    } else {
        let normalized_value = attribute_token
            .and_then(canonical_text)
            .map(|text| NormalizedFilledValue::Attribute(text.into()))
            .or(Some(NormalizedFilledValue::Attribute(
                first_token.text.clone(),
            )));
        branch.consumed_items.push(ConsumedSemanticItem {
            slot: SlotRef {
                slot: SlotId::SetAttrAttribute,
                clause: Some(item_clause.clone()),
            },
            clause: item_clause.clone(),
            surface: first_token.text.clone(),
            normalized_value: normalized_value.clone(),
            source_span: token_span(first_token),
            source_token_start: first_token.span.start,
            source_token_end: first_token.span.end,
        });
        if let Some(value) = normalized_value {
            record_clause_usage(&mut branch, &item_clause, value);
        }
    }
    refresh_branch(&mut branch);
    Some(branch)
}

/// Commits a required child clause when its first slot consumes the root command head.
pub(in crate::parser) fn absorb_root_head_child(
    parser: &StructuralClauseParser,
    head: TokenId,
    context: &CommandPrefixContext,
    clause_stack: &mut Vec<ClauseFrame>,
    clause_usage: &mut Vec<crate::parser::analysis::ClauseUsageState>,
    consumed_items: &mut Vec<ConsumedSemanticItem>,
) -> Option<StructuralClauseParser> {
    let (child, slot) = parser.children.iter().find_map(|child| {
        let slot = first_required_slot(&child.parser)?;
        slot_accepts_token(slot.slot, head).then_some((child, slot))
    })?;

    let child_clause = ClauseInstance {
        clause: child.parser.clause,
        instance: 0,
    };
    let normalized_value = Some(NormalizedFilledValue::Keyword(head));

    clause_stack.push(ClauseFrame {
        clause: child_clause.clone(),
        phase: ClausePhase::Completed,
        commit_state: ClauseCommitState::Committed,
    });
    clause_usage.push(crate::parser::analysis::ClauseUsageState {
        clause: child_clause.clone(),
        used_values: normalized_value.clone().into_iter().collect(),
    });
    let head_span = head_span(context, head);
    consumed_items.push(ConsumedSemanticItem {
        slot: SlotRef {
            slot: slot.slot,
            clause: Some(child_clause.clone()),
        },
        clause: child_clause,
        surface: head_surface(context, head),
        normalized_value,
        source_span: head_span,
        source_token_start: head_span.start,
        source_token_end: head_span.end,
    });

    Some(child.parser.clone())
}

/// Advances every live branch through all valid slot-consumption and child-entry paths.
pub(in crate::parser) fn advance_branches_with_token<'i>(
    context: &CommandPrefixContext,
    branches: &[ParseBranchState<'i>],
    token: &LexerToken,
) -> Vec<ParseBranchState<'i>> {
    let mut next = Vec::new();
    for branch in branches {
        let branch_start = next.len();
        for expectation in &branch.frontier {
            match &expectation.target {
                ContinuationTarget::Slot(slot) => {
                    if let Some(branch) = consume_slot(branch, slot.clone(), token) {
                        push_unique_branch(&mut next, branch);
                    }
                }
                ContinuationTarget::Clause(clause) => {
                    if let Some(branch) = enter_clause_with_token(context, branch, *clause, token) {
                        push_unique_branch(&mut next, branch);
                    }
                }
            }
        }
        if next.len() == branch_start
            && let Some(promoted) = promote_unitless_step_fx_duration(branch, token)
        {
            for promoted_branch in advance_branches_with_token(context, &[promoted], token) {
                push_unique_branch(&mut next, promoted_branch);
            }
        }
    }
    next
}

/// Finalizes a unitless Step FX duration when the following token starts an attribute definition.
pub(in crate::parser) fn promote_unitless_step_fx_duration<'i>(
    branch: &ParseBranchState<'i>,
    token: &LexerToken,
) -> Option<ParseBranchState<'i>> {
    first_consumable_slot(
        &structural_clause_parser(ClauseId::StepFxStepDefinition),
        token,
    )?;
    let duration_clause = branch
        .consumed_items
        .iter()
        .rev()
        .find(|item| {
            item.slot.slot == SlotId::StepFxDuration && item.surface.parse::<f64>().is_ok()
        })?
        .clause
        .clone();
    let mut next = branch.clone();
    let duration_frame = next
        .clause_stack
        .iter_mut()
        .rfind(|frame| frame.clause == duration_clause && frame.phase == ClausePhase::Filling)?;
    duration_frame.phase = ClausePhase::Completed;
    duration_frame.commit_state = ClauseCommitState::Committed;
    refresh_branch(&mut next);
    Some(next)
}

/// Appends a branch only when an equivalent parse state has not already been produced.
pub(in crate::parser) fn push_unique_branch<'i>(
    branches: &mut Vec<ParseBranchState<'i>>,
    branch: ParseBranchState<'i>,
) {
    if !branches.contains(&branch) {
        branches.push(branch);
    }
}

/// Enters a child clause and consumes the triggering token when its schema permits it.
pub(in crate::parser) fn enter_clause_with_token<'i>(
    context: &CommandPrefixContext,
    branch: &ParseBranchState<'i>,
    clause: ClauseId,
    token: &LexerToken,
) -> Option<ParseBranchState<'i>> {
    let parser = structural_clause_parser(clause);
    let parent_clause = clause_parent(clause)?;
    let child_clause = ClauseInstance {
        clause,
        instance: next_child_clause_instance(branch, parent_clause, clause),
    };
    if clause == ClauseId::ProgrammerTimingOverride {
        let parent_instance = branch
            .clause_stack
            .iter()
            .rfind(|frame| frame.clause.clause == parent_clause)
            .map(|frame| frame.clause.clone())
            .unwrap_or(ClauseInstance {
                clause: parent_clause,
                instance: 0,
            });
        let parent_has_global_duration = branch.consumed_items.iter().any(|item| {
            item.clause == parent_instance && item.slot.slot == SlotId::TimingsGlobalDuration
        });
        if !parent_has_global_duration && duration_value_prefix(token.text.as_str()) {
            return None;
        }
    }
    if clause == ClauseId::StoreFxModule && token.text.eq_ignore_ascii_case("step") {
        return None;
    }

    let mut next = branch.clone();
    truncate_branch_to_clause_id(&mut next, parent_clause)?;

    if let crate::slots::contracts::ClauseEntryKind::Keyword(keywords) =
        crate::slots::contracts::clause_schema(clause).entry
    {
        if !token_id_for_text(token.text.as_str()).is_some_and(|id| keywords.contains(&id)) {
            return None;
        }
        next.clause_stack.push(ClauseFrame {
            clause: child_clause,
            phase: ClausePhase::Entered,
            commit_state: ClauseCommitState::Committed,
        });
        refresh_branch(&mut next);
        return Some(next);
    }

    let Some(first_slot) = first_consumable_slot(&parser, token) else {
        if parser.slots.iter().any(|slot| {
            matches!(
                slot.cardinality,
                crate::slots::contracts::SlotCardinality::Required
            )
        }) {
            return None;
        }
        if parser.children.is_empty() {
            return None;
        }
        next.clause_stack.push(ClauseFrame {
            clause: child_clause.clone(),
            phase: ClausePhase::Entered,
            commit_state: ClauseCommitState::Committed,
        });
        refresh_branch(&mut next);
        let mut nested = advance_branches_with_token(context, &[next], token);
        return nested.pop();
    };
    let (value, normalized_value) = filled_value_for_slot(first_slot.slot, token)?;
    let duration_complete =
        clause != ClauseId::StepFxDuration || is_complete_duration_value(token.text.as_str());

    next.clause_stack.push(ClauseFrame {
        clause: child_clause.clone(),
        phase: if duration_complete {
            ClausePhase::Completed
        } else {
            ClausePhase::Filling
        },
        commit_state: if duration_complete {
            ClauseCommitState::Committed
        } else {
            ClauseCommitState::Speculative
        },
    });
    next.consumed_items.push(ConsumedSemanticItem {
        slot: SlotRef {
            slot: first_slot.slot,
            clause: Some(child_clause.clone()),
        },
        clause: child_clause.clone(),
        surface: token.text.clone(),
        normalized_value: normalized_value.clone(),
        source_span: token_span(token),
        source_token_start: token.span.start,
        source_token_end: token.span.end,
    });
    if let Some(value) = normalized_value {
        record_clause_usage(&mut next, &child_clause, value);
    }
    if clause == ClauseId::StepFx && first_slot.slot == SlotId::StoreFxAction {
        if let Some(frame) = next
            .clause_stack
            .iter_mut()
            .rfind(|frame| frame.clause == child_clause)
        {
            frame.phase = ClausePhase::Entered;
        }
    }
    refresh_branch(&mut next);

    let _ = value;
    Some(next)
}

/// Returns whether a timing clause can accept another global duration value.
pub(in crate::parser) fn timings_global_duration_can_start_next_pair(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> bool {
    branch
        .consumed_items
        .iter()
        .filter(|item| {
            item.clause == *clause
                && matches!(
                    item.slot.slot,
                    SlotId::TimingsDirection | SlotId::TimingsGlobalDuration
                )
        })
        .max_by_key(|item| (item.source_span.start, item.source_span.end))
        .is_some_and(|item| item.slot.slot == SlotId::TimingsDirection)
}

/// Returns whether a child timing override should consume the current duration continuation.
pub(in crate::parser) fn timing_override_duration_should_receive_followup(
    branch: &ParseBranchState<'_>,
    timing_clause: &ClauseInstance,
    token_id: Option<TokenId>,
) -> bool {
    child_timing_override_clauses(branch, timing_clause)
        .into_iter()
        .any(|override_clause| {
            let fills = branch
                .consumed_items
                .iter()
                .filter(|item| {
                    item.clause == override_clause
                        && item.slot.slot == SlotId::TimingsOverrideDuration
                })
                .collect::<Vec<_>>();
            slot_requires_followup_value(SlotId::TimingsOverrideDuration, &fills)
                || (token_id == Some(TokenId::GreaterThan) && duration_range_can_extend(&fills))
        })
}

/// Returns timing override clauses that belong directly to the given timing clause.
pub(in crate::parser) fn child_timing_override_clauses(
    branch: &ParseBranchState<'_>,
    timing_clause: &ClauseInstance,
) -> Vec<ClauseInstance> {
    let Some(parent_index) = branch
        .clause_tree
        .nodes
        .iter()
        .position(|node| node.clause == *timing_clause)
    else {
        return Vec::new();
    };

    branch
        .clause_tree
        .nodes
        .iter()
        .filter(|node| {
            node.clause.clause == ClauseId::ProgrammerTimingOverride
                && node
                    .parent
                    .is_some_and(|parent_id| parent_id.0 as usize == parent_index)
        })
        .map(|node| node.clause.clone())
        .collect()
}

/// Returns the canonical object type selected by a structural store branch.
pub(in crate::parser) fn store_object_type_token(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> Option<TokenId> {
    if clause.clause != ClauseId::Store {
        return None;
    }
    branch
        .consumed_items
        .iter()
        .find(|item| item.clause == *clause && item.slot.slot == SlotId::StoreObjectType)
        .and_then(|item| token_id_for_text(item.surface.as_str()))
}

/// Returns whether an rm branch interprets its object identifier as a cue reference.
pub(in crate::parser) fn rm_object_identifier_uses_cue_ref(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> bool {
    clause.clause == ClauseId::Rm
        && branch.consumed_items.iter().any(|item| {
            item.clause == *clause
                && item.slot.slot == SlotId::RmObjectType
                && token_id_for_text(item.surface.as_str()) == Some(TokenId::Cue)
        })
}

/// Returns whether a store branch has selected cue-reference syntax.
pub(in crate::parser) fn store_cue_ref_uses_cue_ref(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> bool {
    clause.clause == ClauseId::Store
        && branch.consumed_items.iter().any(|item| {
            item.clause == *clause
                && item.slot.slot == SlotId::StoreObjectType
                && token_id_for_text(item.surface.as_str()) == Some(TokenId::Cue)
        })
}

/// Returns whether a rename source or target uses cue-reference syntax.
pub(in crate::parser) fn rename_identifier_uses_cue_ref(
    branch: &ParseBranchState<'_>,
    clause: &ClauseInstance,
    slot: SlotId,
) -> bool {
    clause.clause == ClauseId::RenameObjects
        && matches!(slot, SlotId::RenameSource | SlotId::RenameTarget)
        && branch.consumed_items.iter().any(|item| {
            item.clause == *clause
                && item.slot.slot == SlotId::RenameObjectType
                && token_id_for_text(item.surface.as_str()) == Some(TokenId::Cue)
        })
}

/// Computes the next stable instance number for a child clause under its parent family.
pub(in crate::parser) fn next_child_clause_instance(
    branch: &ParseBranchState<'_>,
    parent_clause: ClauseId,
    child_clause: ClauseId,
) -> u32 {
    branch
        .clause_tree
        .nodes
        .iter()
        .filter(|node| {
            node.clause.clause == child_clause
                && node.parent.is_some_and(|parent_id| {
                    branch.clause_tree.nodes[parent_id.0 as usize].clause.clause == parent_clause
                })
        })
        .count() as u32
}

/// Truncates the active clause stack after the specified clause instance.
pub(in crate::parser) fn truncate_branch_to_clause(
    branch: &mut ParseBranchState<'_>,
    clause: &ClauseInstance,
) -> Option<()> {
    let index = branch
        .clause_stack
        .iter()
        .rposition(|frame| frame.clause == *clause)?;
    branch.clause_stack.truncate(index + 1);
    Some(())
}

/// Truncates the active clause stack after the most recent clause of the requested kind.
pub(in crate::parser) fn truncate_branch_to_clause_id(
    branch: &mut ParseBranchState<'_>,
    clause: ClauseId,
) -> Option<()> {
    let index = branch
        .clause_stack
        .iter()
        .rposition(|frame| frame.clause.clause == clause)?;
    branch.clause_stack.truncate(index + 1);
    Some(())
}

/// Records a normalized value in the usage set for one clause instance.
pub(in crate::parser) fn record_clause_usage(
    branch: &mut ParseBranchState<'_>,
    clause: &ClauseInstance,
    value: NormalizedFilledValue,
) {
    if let Some(usage) = branch
        .clause_usage
        .iter_mut()
        .find(|usage| usage.clause == *clause)
    {
        usage.used_values.insert(value);
        return;
    }

    branch
        .clause_usage
        .push(crate::parser::analysis::ClauseUsageState {
            clause: clause.clone(),
            used_values: [value].into_iter().collect(),
        });
}

/// Rebuilds a branch tree and frontier, then derives whether the path remains live.
pub(in crate::parser) fn refresh_branch(branch: &mut ParseBranchState<'_>) {
    branch.ast = None;
    branch.clause_tree = clause_tree_from_branch(branch);
    let (frontier, has_blocking_expectations) = branch_frontier_state_for_branch(branch);
    branch.frontier = frontier;
    branch.status = if has_blocking_expectations {
        PathStatus::Live
    } else {
        PathStatus::Completed
    };
}
