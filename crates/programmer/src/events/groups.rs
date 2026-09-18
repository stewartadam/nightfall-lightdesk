// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Group selection persistence and group-store event handling.

use super::*;

/// Returns the selection shape that should be persisted for a stored group.
fn stored_group_selection(
    selection: SpatialSelection,
    selection_resolver: &SpatialSelectionResolver,
) -> SpatialSelection {
    let stabilized = selection_resolver.stabilize_group_refs_selection(&selection);
    for warning in &stabilized.issues {
        tracing::warn!("{}", warning);
    }

    let mut selection = stabilized.value;
    let union = std::mem::take(&mut selection.union);
    let mut stored_selection = stored_group_selection_branch(selection, selection_resolver);
    stored_selection.union = union
        .into_iter()
        .map(|branch| stored_group_selection(branch, selection_resolver))
        .collect();

    stored_selection
}

/// Returns the leading source-shaping clause count that should be materialized.
fn stored_group_source_shaping_clause_count(clauses: &[SpatialClause]) -> Option<usize> {
    let mut count = 0;
    let mut should_materialize = false;
    for clause in clauses {
        match clause {
            SpatialClause::Split => {
                count += 1;
            }
            SpatialClause::Merge => {
                count += 1;
            }
            SpatialClause::Expand { depth } => {
                count += 1;
                should_materialize |= !matches!(depth, Some(0));
            }
            _ => break,
        }
    }

    should_materialize.then_some(count)
}

/// Returns a resolved selection expression that preserves resolved span boundaries.
fn resolved_selection_expr_for_stored_group(resolved: &ResolvedSelection) -> Option<SelectionExpr> {
    if resolved
        .canonical_fixtures()
        .iter()
        .any(|fixture_ref| fixture_ref.index.is_none())
    {
        return None;
    }

    let spans = resolved
        .to_spanned_selection()
        .spans()
        .map(|span| span.to_vec())
        .collect::<Vec<_>>();
    if spans.iter().all(|span| span.len() <= 1) {
        return Some(SelectionExpr::Resolved(
            resolved.canonical_fixtures().to_vec(),
        ));
    }

    Some(
        spans
            .into_iter()
            .map(|span| SelectionExpr::Span(Box::new(SelectionExpr::Resolved(span))))
            .reduce(|lhs, rhs| SelectionExpr::Add {
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
            .unwrap_or_else(|| SelectionExpr::Resolved(Vec::new())),
    )
}

/// Returns the persisted form of one spatial selection branch.
fn stored_group_selection_branch(
    selection: SpatialSelection,
    selection_resolver: &SpatialSelectionResolver,
) -> SpatialSelection {
    let Some(source_shaping_clause_count) =
        stored_group_source_shaping_clause_count(&selection.clauses)
    else {
        return selection;
    };

    let resolved_source = SpatialSelection::pipeline(
        selection.source.clone(),
        selection.clauses[..source_shaping_clause_count].to_vec(),
    );
    let resolved = selection_resolver.resolve(&resolved_source);
    for warning in &resolved.issues {
        tracing::warn!("{}", warning);
    }

    let Some(resolved_source_expr) = resolved_selection_expr_for_stored_group(&resolved.value)
    else {
        return SpatialSelection::pipeline(selection.source, selection.clauses);
    };

    SpatialSelection::pipeline(
        resolved_source_expr,
        selection.clauses[source_shaping_clause_count..].to_vec(),
    )
}

/// Handles events related to the programmer
pub fn handle_group_events(
    mut events_reader: MessageReader<CommandEnvelope<ProgrammerCommand>>,
    programmer: Res<Programmer>,
    mut actions: MessageWriter<EngineActionEnvelope<GroupAction>>,
    mut workflows: ResMut<StoreObjectWorkflows>,
    mut group_storage: ParamSet<(SpatialSelectionResolver, ResMut<DataProvider<Group>>)>,
) {
    for event in events_reader.read() {
        if let ProgrammerCommand::StoreGroup { group_id, label } = &event.command {
            tracing::debug!("Storing group with ID: {}", group_id);

            // Get the current selection from programmer
            let current_selection = {
                let resolver = group_storage.p0();
                stored_group_selection(programmer.active_spatial_selection(), &resolver)
            };

            // Create or update the group
            let mut group = {
                let group_data_provider = group_storage.p1();
                group_data_provider
                    .from_id(*group_id)
                    .ok()
                    .map(|group_ref| (*group_ref).clone())
                    .unwrap_or_else(|| {
                        tracing::warn!(
                            group_id,
                            "could not obtain group; defaulting to empty selection",
                        );
                        Group {
                            identifiers: Identifiers {
                                id: *group_id,
                                uid: uuid::Uuid::new_v4(),
                                label: label
                                    .clone()
                                    .unwrap_or_else(|| format!("Group {}", group_id)),
                            },
                            selection: SpatialSelection::default(),
                            description: String::new(),
                        }
                    })
            };

            // Update group with current selection
            group.selection = current_selection;
            if let Some(label) = label {
                group.identifiers.label = label.clone();
            }

            tracing::info!("Stored selection as group {}", group_id);
            let operation_id = OperationId::new();
            let command_id = event.command_id;
            workflows.commands.insert(operation_id, command_id);
            actions.write(EngineActionEnvelope {
                operation_id,
                command_id: Some(command_id),
                undo_id: Some(event.undo_id),
                action: GroupAction::StoreGroup(group),
            });
        }
    }
}
