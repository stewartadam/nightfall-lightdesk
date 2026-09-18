// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{BTreeMap, BTreeSet};
use std::io::IsTerminal;

use nightfall_cmd_parse::completion_groups::catalog::completion_group_specs;
use nightfall_cmd_parse::completion_groups::contracts::CompletionGroupId;
use nightfall_cmd_parse::parser::analysis::{
    ClauseInstance, CommandPrefixSnapshot, FilledValue, NormalizedFilledValue, Span, TokenId,
};
use nightfall_cmd_parse::parser::prefix::parse_prefix;
use nightfall_cmd_parse::slots::catalog::slot_spec;
use nightfall_cmd_parse::slots::contracts::{
    ClauseId, SlotId, clause_for_command_slot, clause_parent, clause_trace_label,
    command_head_token_for_root_clause,
};
use nightfall_cmd_parse::slots::planner::{SlotPlan, build_slot_plan_with_snapshot};

/// Command-line arguments accepted by this diagnostic example.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CliArgs {
    input: String,
    cursor: usize,
}

/// Stable key used to identify a clause node in the hierarchy trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct ClauseNodeKey {
    clause: ClauseId,
    instance: Option<u32>,
    occurrence: u32,
}

/// Byte span recorded for a parsed clause or slot in trace output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SpanRange {
    start: usize,
    end: usize,
}

/// Clause tree node emitted by the clause/slot hierarchy trace.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClauseNode {
    key: ClauseNodeKey,
    present: bool,
    optional: bool,
    span: Option<SpanRange>,
    text: Option<String>,
}

/// Value categories displayed for slots in the hierarchy trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotValueKind {
    Token,
    Placeholder,
    Lexeme,
}

/// Rendered value and span information for one traced slot.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SlotValue {
    text: String,
    kind: SlotValueKind,
}

/// Slot entry attached to a traced command clause.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SlotNode {
    slot: SlotId,
    present: bool,
    values: Vec<SlotValue>,
    token_count: usize,
    placeholder_count: usize,
    lexeme_count: usize,
}

/// Rooted command hierarchy produced by the tracing example.
#[derive(Debug, Default)]
struct ClauseTree {
    roots: Vec<ClauseNodeKey>,
    children: BTreeMap<ClauseNodeKey, Vec<ClauseNodeKey>>,
    clauses: BTreeMap<ClauseNodeKey, ClauseNode>,
    slots: BTreeMap<ClauseNodeKey, Vec<SlotNode>>,
    repeated_clauses: BTreeSet<ClauseId>,
}

/// Kinds of trace entries that can introduce a clause in the hierarchy output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClauseEntry {
    Slot(SlotId),
    Clause(ClauseNodeKey),
}

fn main() {
    let args = parse_args();
    let tree = build_clause_tree(&args.input, args.cursor);
    render_clause_tree(&tree);
}

fn build_clause_tree(input: &str, cursor: usize) -> ClauseTree {
    let cursor = cursor.min(input.len());
    let (segment_start, _) = segment_bounds(input, cursor);
    let prefix = &input[segment_start..cursor];
    let snapshot = parse_prefix(prefix, prefix.len());
    let slot_plan = build_slot_plan_with_snapshot(&snapshot);
    clause_tree_from_parse(prefix, &snapshot, &slot_plan)
}

fn clause_tree_from_parse(
    prefix: &str,
    snapshot: &CommandPrefixSnapshot<'_>,
    slot_plan: &SlotPlan,
) -> ClauseTree {
    let command_head = command_head_token(snapshot);
    let clause_tree = &snapshot.branches[0].clause_tree;
    let frontier = snapshot.frontier();
    let mut nodes = BTreeSet::<ClauseNodeKey>::new();
    let mut present_nodes = BTreeSet::<ClauseNodeKey>::new();
    let mut optional_nodes = BTreeSet::<ClauseNodeKey>::new();
    let mut spans = BTreeMap::<ClauseNodeKey, SpanRange>::new();
    let mut slots = BTreeMap::<ClauseNodeKey, BTreeMap<SlotId, SlotNode>>::new();
    for node in &clause_tree.nodes {
        let key = ClauseNodeKey {
            clause: node.clause.clause,
            instance: Some(node.clause.instance),
            occurrence: node.occurrence,
        };
        nodes.insert(key);
        present_nodes.insert(key);
        if let Some(span) = node.span {
            spans.insert(
                key,
                SpanRange {
                    start: span.start,
                    end: span.end,
                },
            );
        }

        for fill in &node.fills {
            let mut merged_span = fill.span;
            let mut trailing_step_values = Vec::<String>::new();
            if fill.slot == SlotId::StepFxStepValues && matches!(fill.value, FilledValue::Lexeme(_))
            {
                let (values, end) = trailing_numeric_values_after_span(prefix, fill.span);
                trailing_step_values = values;
                merged_span.end = end;
            }
            merge_span(&mut spans, key, &merged_span);
            upsert_filled_slot(
                &mut slots,
                key,
                fill.slot,
                &fill.value,
                span_text(prefix, fill.span),
            );
            if !trailing_step_values.is_empty() {
                upsert_additional_lexeme_values(&mut slots, key, fill.slot, trailing_step_values);
            }
        }
    }

    for slot_ref in frontier
        .alternatives
        .iter()
        .filter_map(|alternative| alternative.slot.as_ref())
    {
        if let Some(clause_instance) = &slot_ref.clause {
            let key = present_clause_key_for_instance(clause_instance, &present_nodes)
                .unwrap_or_else(|| optional_clause_key(clause_instance.clause));
            nodes.insert(key);
            if !present_nodes.contains(&key) {
                optional_nodes.insert(key);
            }
            slots
                .entry(key)
                .or_default()
                .entry(slot_ref.slot)
                .or_insert_with(|| empty_slot_node(slot_ref.slot));
        }
    }

    for clause in frontier
        .alternatives
        .iter()
        .filter_map(|alternative| alternative.next_clause)
    {
        if !has_present_clause_instance(clause, &present_nodes) {
            let key = ClauseNodeKey {
                clause,
                instance: None,
                occurrence: 0,
            };
            nodes.insert(key);
            optional_nodes.insert(key);
        }
    }

    for active_slot in &slot_plan.active_slots {
        if let Some(clause_instance) = &active_slot.clause {
            let key = present_clause_key_for_instance(clause_instance, &present_nodes)
                .unwrap_or_else(|| optional_clause_key(clause_instance.clause));
            nodes.insert(key);
            if !present_nodes.contains(&key) {
                optional_nodes.insert(key);
            }
            slots
                .entry(key)
                .or_default()
                .entry(active_slot.slot)
                .or_insert_with(|| empty_slot_node(active_slot.slot));
        }
    }

    if let Some(command_head) = command_head {
        for spec in completion_group_specs()
            .iter()
            .filter(|spec| completion_group_matches_command_head(spec.id, command_head))
        {
            for anchor_clause in completion_group_anchor_clauses(spec.id) {
                ensure_clause_targets(
                    *anchor_clause,
                    &mut nodes,
                    &present_nodes,
                    &mut optional_nodes,
                );
            }

            for &slot in &spec.slots {
                let Some(owner_clause) = clause_for_command_slot(slot, command_head) else {
                    continue;
                };
                ensure_optional_slot_targets(
                    owner_clause,
                    slot,
                    &mut nodes,
                    &present_nodes,
                    &mut optional_nodes,
                    &mut slots,
                );
            }
        }
    }

    ensure_ancestor_nodes(&mut nodes, &present_nodes, &mut optional_nodes);
    optional_nodes.retain(|node| !present_nodes.contains(node));

    let repeated_clauses = repeated_clause_ids(&present_nodes);
    let mut clauses = build_clause_nodes(&nodes, &present_nodes, &optional_nodes, &spans);
    let slots = build_slot_nodes(slots);
    let children = build_children(&nodes, &clauses);
    propagate_clause_spans(&mut clauses, &children);
    update_clause_text(prefix, &mut clauses);
    let roots = root_nodes(&nodes, &children, &clauses);

    ClauseTree {
        roots,
        children,
        clauses,
        slots,
        repeated_clauses,
    }
}

fn build_clause_nodes(
    nodes: &BTreeSet<ClauseNodeKey>,
    present_nodes: &BTreeSet<ClauseNodeKey>,
    optional_nodes: &BTreeSet<ClauseNodeKey>,
    spans: &BTreeMap<ClauseNodeKey, SpanRange>,
) -> BTreeMap<ClauseNodeKey, ClauseNode> {
    nodes
        .iter()
        .copied()
        .map(|key| {
            (
                key,
                ClauseNode {
                    key,
                    present: present_nodes.contains(&key),
                    optional: optional_nodes.contains(&key),
                    span: spans.get(&key).copied(),
                    text: None,
                },
            )
        })
        .collect()
}

fn build_slot_nodes(
    slots: BTreeMap<ClauseNodeKey, BTreeMap<SlotId, SlotNode>>,
) -> BTreeMap<ClauseNodeKey, Vec<SlotNode>> {
    slots
        .into_iter()
        .map(|(key, slot_map)| {
            let mut values = slot_map.into_values().collect::<Vec<_>>();
            values.sort_by_key(|slot_node| slot_node.slot);
            (key, values)
        })
        .collect()
}

fn build_children(
    nodes: &BTreeSet<ClauseNodeKey>,
    clause_nodes: &BTreeMap<ClauseNodeKey, ClauseNode>,
) -> BTreeMap<ClauseNodeKey, Vec<ClauseNodeKey>> {
    let mut children = BTreeMap::<ClauseNodeKey, Vec<ClauseNodeKey>>::new();
    for node in nodes {
        let Some(parent_clause) = clause_parent(node.clause) else {
            continue;
        };
        let parent = best_parent_key(*node, parent_clause, nodes, clause_nodes);
        if let Some(parent_key) = parent {
            children.entry(parent_key).or_default().push(*node);
        }
    }

    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| {
            clause_node_sort_key(*left, clause_nodes)
                .cmp(&clause_node_sort_key(*right, clause_nodes))
        });
    }
    children
}

fn propagate_clause_spans(
    clauses: &mut BTreeMap<ClauseNodeKey, ClauseNode>,
    children: &BTreeMap<ClauseNodeKey, Vec<ClauseNodeKey>>,
) {
    for _ in 0..clauses.len() {
        let mut changed = false;
        for key in clauses.keys().copied().collect::<Vec<_>>() {
            let Some(child_keys) = children.get(&key) else {
                continue;
            };
            let mut merged = clauses.get(&key).and_then(|node| node.span);
            for child in child_keys {
                if let Some(span) = clauses.get(child).and_then(|node| node.span) {
                    merged = Some(match merged {
                        Some(existing) => SpanRange {
                            start: existing.start.min(span.start),
                            end: existing.end.max(span.end),
                        },
                        None => span,
                    });
                }
            }
            if let Some(span) = merged {
                if let Some(node) = clauses.get_mut(&key) {
                    if node.span != Some(span) {
                        node.span = Some(span);
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
}

fn update_clause_text(prefix: &str, clauses: &mut BTreeMap<ClauseNodeKey, ClauseNode>) {
    for node in clauses.values_mut() {
        node.text = node.span.and_then(|span| span_range_text(prefix, span));
    }
}

fn root_nodes(
    nodes: &BTreeSet<ClauseNodeKey>,
    children: &BTreeMap<ClauseNodeKey, Vec<ClauseNodeKey>>,
    clauses: &BTreeMap<ClauseNodeKey, ClauseNode>,
) -> Vec<ClauseNodeKey> {
    let mut has_parent = BTreeSet::new();
    for nested in children.values() {
        for child in nested {
            has_parent.insert(*child);
        }
    }
    let mut roots = nodes
        .iter()
        .copied()
        .filter(|node| !has_parent.contains(node))
        .collect::<Vec<_>>();
    roots.sort_by(|left, right| {
        clause_node_sort_key(*left, clauses).cmp(&clause_node_sort_key(*right, clauses))
    });
    roots
}

fn best_parent_key(
    node: ClauseNodeKey,
    parent_clause: ClauseId,
    nodes: &BTreeSet<ClauseNodeKey>,
    clause_nodes: &BTreeMap<ClauseNodeKey, ClauseNode>,
) -> Option<ClauseNodeKey> {
    let candidates = nodes
        .iter()
        .copied()
        .filter(|candidate| candidate.clause == parent_clause)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return candidates.first().copied();
    }
    candidates
        .into_iter()
        .min_by_key(|candidate| parent_candidate_score(*candidate, node, clause_nodes))
}

fn parent_candidate_score(
    parent: ClauseNodeKey,
    child: ClauseNodeKey,
    clause_nodes: &BTreeMap<ClauseNodeKey, ClauseNode>,
) -> (u8, usize, u8, u8, u32, u32) {
    let parent_span = clause_nodes.get(&parent).and_then(|node| node.span);
    let child_span = clause_nodes.get(&child).and_then(|node| node.span);
    let contains = match (parent_span, child_span) {
        (Some(parent), Some(child)) => {
            if parent.start <= child.start && parent.end >= child.end {
                0
            } else {
                1
            }
        }
        (Some(_), None) => 1,
        (None, Some(_)) => 2,
        (None, None) => 3,
    };
    let span_width = parent_span
        .map(|span| span.end.saturating_sub(span.start))
        .unwrap_or(usize::MAX);
    let instance_rank = match (child.instance, parent.instance) {
        (Some(child_instance), Some(parent_instance)) if child_instance == parent_instance => 0,
        (_, Some(0)) => 1,
        (_, Some(_)) => 2,
        (_, None) => 3,
    };
    let occurrence_rank = if parent.occurrence == child.occurrence {
        0
    } else if parent.occurrence == 0 {
        1
    } else {
        2
    };
    let present_rank = if clause_nodes.get(&parent).is_some_and(|node| node.present) {
        0
    } else {
        1
    };
    let parent_instance = parent.instance.unwrap_or(u32::MAX);
    (
        contains,
        span_width,
        instance_rank,
        occurrence_rank,
        present_rank,
        parent_instance,
    )
}

fn clause_node_sort_key(
    key: ClauseNodeKey,
    clause_nodes: &BTreeMap<ClauseNodeKey, ClauseNode>,
) -> (usize, String, u32, u32, u8) {
    let span_start = clause_nodes
        .get(&key)
        .and_then(|node| node.span.map(|span| span.start))
        .unwrap_or(usize::MAX);
    (
        span_start,
        format!("{:?}", key.clause),
        key.instance.unwrap_or(u32::MAX),
        key.occurrence,
        if key.instance.is_some() { 0 } else { 1 },
    )
}

fn ensure_ancestor_nodes(
    nodes: &mut BTreeSet<ClauseNodeKey>,
    present_nodes: &BTreeSet<ClauseNodeKey>,
    optional_nodes: &mut BTreeSet<ClauseNodeKey>,
) {
    let mut additions = Vec::new();
    for node in nodes.iter().copied().collect::<Vec<_>>() {
        let mut parent = clause_parent(node.clause);
        while let Some(parent_clause) = parent {
            if !nodes
                .iter()
                .any(|existing| existing.clause == parent_clause)
            {
                additions.push(ClauseNodeKey {
                    clause: parent_clause,
                    instance: None,
                    occurrence: 0,
                });
            }
            parent = clause_parent(parent_clause);
        }
    }
    for addition in additions {
        if nodes.insert(addition) && !has_present_clause_instance(addition.clause, present_nodes) {
            optional_nodes.insert(addition);
        }
    }
}

fn repeated_clause_ids(present_nodes: &BTreeSet<ClauseNodeKey>) -> BTreeSet<ClauseId> {
    let mut counts = BTreeMap::<ClauseId, usize>::new();
    let mut repeated = BTreeSet::<ClauseId>::new();
    for node in present_nodes {
        *counts.entry(node.clause).or_insert(0usize) += 1;
        if node.instance.unwrap_or(0) > 0 || node.occurrence > 0 {
            repeated.insert(node.clause);
        }
    }
    for (clause, count) in counts {
        if count > 1 {
            repeated.insert(clause);
        }
    }
    repeated
}

fn has_present_clause_instance(clause: ClauseId, present_nodes: &BTreeSet<ClauseNodeKey>) -> bool {
    present_nodes.iter().any(|node| node.clause == clause)
}

fn present_clause_key(
    clause: ClauseId,
    present_nodes: &BTreeSet<ClauseNodeKey>,
) -> Option<ClauseNodeKey> {
    present_nodes
        .iter()
        .copied()
        .filter(|node| node.clause == clause)
        .min()
}

fn present_clause_key_for_instance(
    clause: &ClauseInstance,
    present_nodes: &BTreeSet<ClauseNodeKey>,
) -> Option<ClauseNodeKey> {
    present_nodes
        .iter()
        .copied()
        .filter(|node| node.clause == clause.clause && node.instance == Some(clause.instance))
        .max_by_key(|node| node.occurrence)
        .or_else(|| present_clause_key(clause.clause, present_nodes))
}

fn ensure_clause_targets(
    clause: ClauseId,
    nodes: &mut BTreeSet<ClauseNodeKey>,
    present_nodes: &BTreeSet<ClauseNodeKey>,
    optional_nodes: &mut BTreeSet<ClauseNodeKey>,
) -> Vec<ClauseNodeKey> {
    let targets = clause_targets(clause, present_nodes);
    for target in &targets {
        nodes.insert(*target);
        if !present_nodes.contains(target) {
            optional_nodes.insert(*target);
        }
    }
    targets
}

fn ensure_optional_slot_targets(
    clause: ClauseId,
    slot: SlotId,
    nodes: &mut BTreeSet<ClauseNodeKey>,
    present_nodes: &BTreeSet<ClauseNodeKey>,
    optional_nodes: &mut BTreeSet<ClauseNodeKey>,
    slots: &mut BTreeMap<ClauseNodeKey, BTreeMap<SlotId, SlotNode>>,
) {
    let targets = ensure_clause_targets(clause, nodes, present_nodes, optional_nodes);
    for target in targets {
        slots
            .entry(target)
            .or_default()
            .entry(slot)
            .or_insert_with(|| empty_slot_node(slot));
    }
}

fn clause_targets(clause: ClauseId, present_nodes: &BTreeSet<ClauseNodeKey>) -> Vec<ClauseNodeKey> {
    let targets = present_nodes
        .iter()
        .copied()
        .filter(|node| node.clause == clause)
        .collect::<Vec<_>>();
    if targets.is_empty() {
        vec![optional_clause_key(clause)]
    } else {
        targets
    }
}

fn optional_clause_key(clause: ClauseId) -> ClauseNodeKey {
    ClauseNodeKey {
        clause,
        instance: None,
        occurrence: 0,
    }
}

fn merge_span(spans: &mut BTreeMap<ClauseNodeKey, SpanRange>, key: ClauseNodeKey, span: &Span) {
    spans
        .entry(key)
        .and_modify(|existing| {
            existing.start = existing.start.min(span.start);
            existing.end = existing.end.max(span.end);
        })
        .or_insert(SpanRange {
            start: span.start,
            end: span.end,
        });
}

fn span_text(input: &str, span: Span) -> Option<String> {
    span_range_text(
        input,
        SpanRange {
            start: span.start,
            end: span.end,
        },
    )
}

fn span_range_text(input: &str, span: SpanRange) -> Option<String> {
    if span.start >= span.end || span.end > input.len() {
        return None;
    }
    let slice = input.get(span.start..span.end)?;
    let normalized = normalize_text(slice);
    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn empty_slot_node(slot: SlotId) -> SlotNode {
    SlotNode {
        slot,
        present: false,
        values: Vec::new(),
        token_count: 0,
        placeholder_count: 0,
        lexeme_count: 0,
    }
}

fn upsert_filled_slot(
    slots: &mut BTreeMap<ClauseNodeKey, BTreeMap<SlotId, SlotNode>>,
    key: ClauseNodeKey,
    slot: SlotId,
    value: &FilledValue,
    text: Option<String>,
) {
    let slot_node = slots
        .entry(key)
        .or_default()
        .entry(slot)
        .or_insert_with(|| empty_slot_node(slot));
    slot_node.present = true;
    let value_kind = slot_value_kind(value);
    match value_kind {
        SlotValueKind::Token => slot_node.token_count += 1,
        SlotValueKind::Placeholder => slot_node.placeholder_count += 1,
        SlotValueKind::Lexeme => slot_node.lexeme_count += 1,
    }
    if let Some(text) = text {
        slot_node.values.push(SlotValue {
            text,
            kind: value_kind,
        });
    }
}

fn upsert_additional_lexeme_values(
    slots: &mut BTreeMap<ClauseNodeKey, BTreeMap<SlotId, SlotNode>>,
    key: ClauseNodeKey,
    slot: SlotId,
    values: Vec<String>,
) {
    if values.is_empty() {
        return;
    }
    let slot_node = slots
        .entry(key)
        .or_default()
        .entry(slot)
        .or_insert_with(|| empty_slot_node(slot));
    slot_node.present = true;
    for value in values {
        slot_node.lexeme_count += 1;
        slot_node.values.push(SlotValue {
            text: value,
            kind: SlotValueKind::Lexeme,
        });
    }
}

fn slot_value_kind(value: &FilledValue) -> SlotValueKind {
    match value {
        FilledValue::Token(_) => SlotValueKind::Token,
        FilledValue::Placeholder(_, _) => SlotValueKind::Placeholder,
        FilledValue::Lexeme(_) => SlotValueKind::Lexeme,
    }
}

fn command_head_token(snapshot: &CommandPrefixSnapshot<'_>) -> Option<TokenId> {
    for item in snapshot.consumed_items() {
        if item.slot.slot != SlotId::CommandHead {
            continue;
        }

        match &item.normalized_value {
            Some(NormalizedFilledValue::Keyword(token)) => return Some(*token),
            _ => {
                if let Some(token) = command_head_token_from_lexeme(item.surface.as_str()) {
                    return Some(token);
                }
            }
        }
    }

    snapshot
        .committed_clause_path()
        .into_iter()
        .next()
        .and_then(|clause| command_head_token_from_root_clause(clause.clause))
}

fn command_head_token_from_lexeme(raw: &str) -> Option<TokenId> {
    match raw.to_ascii_lowercase().as_str() {
        "fixture" | "fix" => Some(TokenId::Fixture),
        "group" | "grp" => Some(TokenId::Group),
        "parameter" | "param" => Some(TokenId::Parameter),
        "fx" => Some(TokenId::Fx),
        "patch" => Some(TokenId::Patch),
        "clip" => Some(TokenId::Clip),
        "channel" => Some(TokenId::Channel),
        "release" => Some(TokenId::Release),
        "clear" => Some(TokenId::Clear),
        "flow" => Some(TokenId::Flow),
        "timecode" => Some(TokenId::Timecode),
        "timeline" => Some(TokenId::Timeline),
        "rm" => Some(TokenId::Rm),
        "rename" => Some(TokenId::Rename),
        "store" => Some(TokenId::Store),
        "log" => Some(TokenId::Log),
        "recall" => Some(TokenId::Recall),
        "debug" => Some(TokenId::Debug),
        "sleep" => Some(TokenId::Sleep),
        "fps" => Some(TokenId::Fps),
        _ => None,
    }
}

fn command_head_token_from_root_clause(clause: ClauseId) -> Option<TokenId> {
    command_head_token_for_root_clause(clause)
}

fn completion_group_anchor_clauses(group_id: CompletionGroupId) -> &'static [ClauseId] {
    match group_id {
        CompletionGroupId::Command => &[],
        CompletionGroupId::ProgrammerSelection => &[ClauseId::ProgrammerSelection],
        CompletionGroupId::ProgrammerSelectionIdentifier => {
            &[ClauseId::ProgrammerSelectionIdentifier]
        }
        CompletionGroupId::ProgrammerSetAttribute | CompletionGroupId::ProgrammerIntensity => {
            &[ClauseId::ProgrammerSetAttributeItem]
        }
        CompletionGroupId::ProgrammerTimings => &[
            ClauseId::ProgrammerTimings,
            ClauseId::ProgrammerTimingOverride,
        ],
        CompletionGroupId::ProgrammerPlacement3d => &[ClauseId::ProgrammerPlacement3d],
        CompletionGroupId::FxIdentifier => &[ClauseId::FxIdentifier],
        CompletionGroupId::FxAction => &[ClauseId::FxAction],
        CompletionGroupId::StepFx => &[ClauseId::StepFx],
        CompletionGroupId::StepFxSelection => &[ClauseId::StepFxSelection],
        CompletionGroupId::StepFxDuration => &[ClauseId::StepFxDuration],
        CompletionGroupId::StepFxAttribute
        | CompletionGroupId::StepFxAttributeBaseline
        | CompletionGroupId::StepFxValues
        | CompletionGroupId::StepFxShaping => &[ClauseId::StepFxStepDefinition],
        CompletionGroupId::PatchSource | CompletionGroupId::PatchDmxAddress => {
            &[ClauseId::PatchSource]
        }
        CompletionGroupId::PatchTarget => &[ClauseId::PatchTarget],
        CompletionGroupId::ClipIdentifier => &[ClauseId::ClipIdentifier],
        CompletionGroupId::ClipAction => &[ClauseId::ClipAction],
        CompletionGroupId::Clear => &[ClauseId::Clear],
        CompletionGroupId::ClearAttributes => &[ClauseId::ClearAttributes],
        CompletionGroupId::ChannelOverrideIdentifier | CompletionGroupId::ChannelOverrideValue => {
            &[ClauseId::ChannelOverride]
        }
        CompletionGroupId::ReleaseAttributes => &[ClauseId::ReleaseAttributes],
        CompletionGroupId::ReleaseChannel => &[ClauseId::ReleaseChannel],
        CompletionGroupId::RmObjectType | CompletionGroupId::RmObjectIdentifier => &[ClauseId::Rm],
        CompletionGroupId::StoreObjectType
        | CompletionGroupId::StoreObjectIdentifier
        | CompletionGroupId::StoreCueRef
        | CompletionGroupId::StoreGroupIdentifier
        | CompletionGroupId::StoreBlueprint => &[ClauseId::Store],
        CompletionGroupId::StoreBlueprintFilter => &[ClauseId::StoreBlueprintFilter],
        CompletionGroupId::Rename | CompletionGroupId::RenameObjectType => &[ClauseId::Rename],
        CompletionGroupId::FlowIdentifier => &[ClauseId::FlowIdentifier],
        CompletionGroupId::FlowAction => &[ClauseId::FlowAction],
        CompletionGroupId::TimecodeIdentifier => &[ClauseId::TimecodeIdentifier],
        CompletionGroupId::TimecodeAction => &[ClauseId::TimecodeAction],
        CompletionGroupId::TimelineIdentifier => &[ClauseId::TimelineIdentifier],
        CompletionGroupId::TimelineAction => &[ClauseId::TimelineAction],
        CompletionGroupId::LogLevel => &[ClauseId::LogLevel],
        CompletionGroupId::LogFilter => &[ClauseId::LogFilter],
        CompletionGroupId::LogFixture => &[ClauseId::LogFixture],
        CompletionGroupId::RecallCueRef => &[ClauseId::Recall],
        CompletionGroupId::DebugObject => &[ClauseId::Debug],
        CompletionGroupId::SleepDuration => &[ClauseId::Sleep],
        CompletionGroupId::FpsValue => &[ClauseId::Fps],
    }
}

fn completion_group_matches_command_head(group_id: CompletionGroupId, head: TokenId) -> bool {
    match group_id {
        CompletionGroupId::Command => true,
        CompletionGroupId::ProgrammerSelection
        | CompletionGroupId::ProgrammerSelectionIdentifier
        | CompletionGroupId::ProgrammerSetAttribute
        | CompletionGroupId::ProgrammerIntensity
        | CompletionGroupId::ProgrammerTimings
        | CompletionGroupId::ProgrammerPlacement3d => {
            matches!(head, TokenId::Fixture | TokenId::Group | TokenId::Parameter)
        }
        CompletionGroupId::FxIdentifier
        | CompletionGroupId::FxAction
        | CompletionGroupId::StepFx
        | CompletionGroupId::StepFxSelection
        | CompletionGroupId::StepFxDuration
        | CompletionGroupId::StepFxAttribute
        | CompletionGroupId::StepFxAttributeBaseline
        | CompletionGroupId::StepFxValues
        | CompletionGroupId::StepFxShaping => head == TokenId::Fx,
        CompletionGroupId::PatchSource
        | CompletionGroupId::PatchDmxAddress
        | CompletionGroupId::PatchTarget => head == TokenId::Patch,
        CompletionGroupId::ClipIdentifier | CompletionGroupId::ClipAction => head == TokenId::Clip,
        CompletionGroupId::Clear | CompletionGroupId::ClearAttributes => head == TokenId::Clear,
        CompletionGroupId::ChannelOverrideIdentifier | CompletionGroupId::ChannelOverrideValue => {
            head == TokenId::Channel
        }
        CompletionGroupId::ReleaseAttributes | CompletionGroupId::ReleaseChannel => {
            head == TokenId::Release
        }
        CompletionGroupId::RmObjectType | CompletionGroupId::RmObjectIdentifier => {
            head == TokenId::Rm
        }
        CompletionGroupId::StoreObjectType
        | CompletionGroupId::StoreObjectIdentifier
        | CompletionGroupId::StoreCueRef
        | CompletionGroupId::StoreGroupIdentifier
        | CompletionGroupId::StoreBlueprint
        | CompletionGroupId::StoreBlueprintFilter => head == TokenId::Store,
        CompletionGroupId::Rename | CompletionGroupId::RenameObjectType => head == TokenId::Rename,
        CompletionGroupId::FlowIdentifier | CompletionGroupId::FlowAction => head == TokenId::Flow,
        CompletionGroupId::TimecodeIdentifier | CompletionGroupId::TimecodeAction => {
            head == TokenId::Timecode
        }
        CompletionGroupId::TimelineIdentifier | CompletionGroupId::TimelineAction => {
            head == TokenId::Timeline
        }
        CompletionGroupId::LogLevel
        | CompletionGroupId::LogFilter
        | CompletionGroupId::LogFixture => head == TokenId::Log,
        CompletionGroupId::RecallCueRef => head == TokenId::Recall,
        CompletionGroupId::DebugObject => head == TokenId::Debug,
        CompletionGroupId::SleepDuration => head == TokenId::Sleep,
        CompletionGroupId::FpsValue => head == TokenId::Fps,
    }
}

fn render_clause_tree(tree: &ClauseTree) {
    if tree.roots.is_empty() {
        println!("(no clauses)");
        return;
    }
    for (index, root) in tree.roots.iter().enumerate() {
        render_clause_node(*root, "", index + 1 == tree.roots.len(), true, tree);
        if index + 1 < tree.roots.len() {
            println!();
        }
    }
}

fn render_clause_node(
    key: ClauseNodeKey,
    prefix: &str,
    is_last: bool,
    is_root: bool,
    tree: &ClauseTree,
) {
    let clause_node = tree
        .clauses
        .get(&key)
        .expect("clause node should exist for rendered key");
    let label = clause_line_text(clause_node, tree);
    let styled = style_presence(&label, clause_node.present);
    if is_root {
        println!("{styled}");
    } else {
        let branch = if is_last { "└──" } else { "├──" };
        println!("{prefix}{branch} {styled}");
    }

    let next_prefix = if is_root {
        String::new()
    } else if is_last {
        format!("{prefix}    ")
    } else {
        format!("{prefix}│   ")
    };

    let mut entries = Vec::<ClauseEntry>::new();
    if let Some(slot_nodes) = tree.slots.get(&key) {
        for slot in slot_nodes {
            entries.push(ClauseEntry::Slot(slot.slot));
        }
    }
    if let Some(children) = tree.children.get(&key) {
        for child in children {
            entries.push(ClauseEntry::Clause(*child));
        }
    }

    for (index, entry) in entries.iter().enumerate() {
        let entry_is_last = index + 1 == entries.len();
        match entry {
            ClauseEntry::Slot(slot) => {
                render_slot_node(key, *slot, &next_prefix, entry_is_last, tree);
            }
            ClauseEntry::Clause(child) => {
                render_clause_node(*child, &next_prefix, entry_is_last, false, tree);
            }
        }
    }
}

fn render_slot_node(
    clause: ClauseNodeKey,
    slot: SlotId,
    prefix: &str,
    is_last: bool,
    tree: &ClauseTree,
) {
    let Some(slot_nodes) = tree.slots.get(&clause) else {
        return;
    };
    let Some(slot_node) = slot_nodes.iter().find(|entry| entry.slot == slot) else {
        return;
    };
    let clause_text = tree
        .clauses
        .get(&clause)
        .and_then(|node| node.text.as_deref());
    let (is_repeated, rendered_value) = slot_render_info(slot, slot_node, clause_text);
    let branch = if is_last { "└──" } else { "├──" };
    let mut text = slot_label(slot);
    if is_repeated {
        text.push('*');
    }
    if slot_spec(slot).policy.can_skip {
        text.push('?');
    }
    if let Some(value) = rendered_value {
        text.push_str(": ");
        text.push_str(&value);
    }
    println!(
        "{prefix}{branch} {}",
        style_presence(&text, slot_node.present)
    );
}

fn slot_node_is_repeated(slot_node: &SlotNode) -> bool {
    slot_node.lexeme_count > 1 || slot_node.placeholder_count > 1 || slot_node.token_count > 1
}

fn slot_render_info(
    slot: SlotId,
    slot_node: &SlotNode,
    clause_text: Option<&str>,
) -> (bool, Option<String>) {
    let mut repeated = slot_node_is_repeated(slot_node);
    let mut value = slot_display_value(slot_node);
    if slot == SlotId::StepFxStepValues {
        let inferred_values = clause_text.map(infer_step_fx_values).unwrap_or_default();
        if inferred_values.len() > 1 {
            repeated = true;
            value = Some(inferred_values.join(" "));
        } else if value.is_none() && inferred_values.len() == 1 {
            value = inferred_values.first().cloned();
        }
    }
    (repeated, value)
}

fn slot_display_value(slot_node: &SlotNode) -> Option<String> {
    if slot_node.values.is_empty() {
        return None;
    }

    let non_token_values = slot_node
        .values
        .iter()
        .filter(|value| value.kind != SlotValueKind::Token)
        .map(|value| value.text.clone())
        .collect::<Vec<_>>();
    if !non_token_values.is_empty() {
        return Some(non_token_values.join(" "));
    }

    Some(
        slot_node
            .values
            .iter()
            .map(|value| value.text.clone())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn infer_step_fx_values(clause_text: &str) -> Vec<String> {
    let words = clause_text.split_whitespace().collect::<Vec<_>>();
    let Some(start) = words
        .iter()
        .position(|word| word.eq_ignore_ascii_case("steps"))
    else {
        return Vec::new();
    };
    let mut values = Vec::new();
    for word in words.iter().skip(start + 1) {
        if !looks_value_like_text(word) {
            break;
        }
        values.push((*word).to_owned());
    }
    values
}

fn looks_value_like_text(raw: &str) -> bool {
    raw.chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit() || ch == '+' || ch == '-')
}

fn trailing_numeric_values_after_span(input: &str, span: Span) -> (Vec<String>, usize) {
    let mut cursor = span.end.min(input.len());
    let mut values = Vec::<String>::new();
    let mut end = cursor;

    while cursor < input.len() {
        while cursor < input.len()
            && input
                .as_bytes()
                .get(cursor)
                .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            cursor += 1;
        }
        if cursor >= input.len() {
            break;
        }

        let token_start = cursor;
        while cursor < input.len()
            && input
                .as_bytes()
                .get(cursor)
                .is_some_and(|byte| !byte.is_ascii_whitespace())
        {
            cursor += 1;
        }

        let Some(token) = input.get(token_start..cursor) else {
            break;
        };
        if !looks_value_like_text(token) {
            break;
        }
        values.push(token.to_owned());
        end = cursor;
    }

    (values, end.max(span.end))
}

fn clause_line_text(node: &ClauseNode, tree: &ClauseTree) -> String {
    let mut text = clause_label(node.key.clause);
    if tree.repeated_clauses.contains(&node.key.clause) {
        text.push('*');
    }
    if node.optional {
        text.push('?');
    }
    if clause_parent(node.key.clause).is_some() {
        if let Some(snippet) = &node.text {
            text.push_str(": ");
            text.push_str(snippet);
        }
    }
    text
}

fn clause_label(clause: ClauseId) -> String {
    clause_trace_label(clause)
}

fn slot_label(slot: SlotId) -> String {
    format!("{slot:?}Slot")
}

fn style_presence(text: &str, present: bool) -> String {
    if present {
        style_ansi(text, "32")
    } else {
        style_ansi(text, "90")
    }
}

fn color_enabled() -> bool {
    if std::env::var_os("CLICOLOR_FORCE")
        .and_then(|value| value.into_string().ok())
        .as_deref()
        == Some("1")
    {
        return true;
    }
    if std::env::var_os("CLICOLOR")
        .and_then(|value| value.into_string().ok())
        .as_deref()
        == Some("0")
    {
        return false;
    }
    std::io::stdout().is_terminal()
}

fn style_ansi(text: &str, code: &str) -> String {
    if color_enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_owned()
    }
}

fn parse_args() -> CliArgs {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        print_usage_and_exit(2);
    }
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        print_usage_and_exit(0);
    }

    let mut cursor = None::<usize>;
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--cursor" => {
                if index + 1 >= args.len() {
                    eprintln!("--cursor requires a value");
                    std::process::exit(2);
                }
                let value = args[index + 1].parse::<usize>().unwrap_or_else(|_| {
                    eprintln!("invalid --cursor value: {}", args[index + 1]);
                    std::process::exit(2);
                });
                cursor = Some(value);
                args.drain(index..=index + 1);
                continue;
            }
            flag if flag.starts_with("--") => {
                eprintln!("unknown option: {flag}");
                print_usage_and_exit(2);
            }
            _ => {}
        }
        index += 1;
    }

    if args.is_empty() {
        eprintln!("input is required");
        print_usage_and_exit(2);
    }

    let input = args.join(" ");
    let cursor = cursor.unwrap_or(input.len());
    CliArgs { input, cursor }
}

fn print_usage_and_exit(code: i32) -> ! {
    eprintln!(
        "Usage: cargo run -p nightfall-cmd-parse --example clause_slot_hierarchy_trace -- \"<input>\" [--cursor <n>]"
    );
    std::process::exit(code);
}

fn segment_bounds(input: &str, cursor: usize) -> (usize, usize) {
    let segment_start = input[..cursor]
        .rfind(';')
        .map_or(0usize, |index| index.saturating_add(1));
    let segment_end = input[cursor..]
        .find(';')
        .map_or(input.len(), |offset| cursor + offset);
    (segment_start, segment_end)
}
