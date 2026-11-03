// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Application of [`ProgrammerOperation`]s written by commands, plans, and automation.

use super::instruction_release::release_programmer_values;
use super::*;

/// A clear or release operation waiting to be applied to the programmer.
struct PendingRelease {
    /// Operation that requested the release.
    action_id: OperationId,
    /// Command the release reports to, or the operation ID for detached releases.
    correlation_id: uuid::Uuid,
    /// Undo group inherited by delegated operations.
    undo_id: uuid::Uuid,
    /// Fixtures to release, or every fixture when absent.
    selection: Option<SelectionExpr>,
    /// Attributes to release; empty releases every attribute.
    attributes: Vec<Attribute>,
    /// Whether playback parameters for the scope are released as well.
    emit_release_selection: bool,
    /// Whether the operator approved flattening non-resolved selections.
    allow_selection_flatten: bool,
    /// Whether a command awaits this release's outcome.
    respond_on_completion: bool,
}

/// Converts an action scope into the optional selection used by release mutation.
fn scope_to_selection(scope: Scope) -> Option<SelectionExpr> {
    match scope {
        Scope::All => None,
        Scope::Selection(selection) => Some(selection),
    }
}

/// Converts an action attribute filter into the empty-means-all runtime representation.
fn attribute_filter_to_attributes(attributes: AttributeFilter) -> Vec<Attribute> {
    match attributes {
        AttributeFilter::All => Vec::new(),
        AttributeFilter::Only(attributes) => attributes,
    }
}

/// Completes an action immediately or records the operations it delegated.
fn finish_or_wait_for_programmer_action(
    responder: &mut CommandResponder,
    workflows: &mut PendingProgrammerActionWorkflows,
    action_id: OperationId,
    command_id: CommandId,
    delegated_operations: Vec<OperationId>,
) {
    if delegated_operations.is_empty() {
        write_command_success(responder, command_id.into());
    } else {
        workflows.start(action_id, command_id, delegated_operations);
    }
}

/// Applies every programmer operation written this frame.
///
/// Stale user-command plans that would now flatten selections are rejected with a retryable
/// approval and their operations skipped. All selection clears apply before any release, so
/// a frame clearing both selection and values releases against the cleared selection.
pub(super) fn apply_operations(
    state: &mut ProgrammerMutationState,
    channels: &mut ProgrammerOperationChannels,
) {
    let programmer_action_events = channels.p0().read().cloned().collect::<Vec<_>>();
    let rejected_plan_ids = reject_stale_plans(state, &programmer_action_events);

    let mut clear_selection_events = Vec::new();
    let mut release_events = Vec::new();

    for event in &programmer_action_events {
        if event
            .command_id
            .is_some_and(|command_id| rejected_plan_ids.contains(&command_id))
        {
            continue;
        }
        let correlation_id: uuid::Uuid = event
            .command_id
            .map(Into::into)
            .unwrap_or_else(|| event.operation_id.into());
        let undo_id: uuid::Uuid = event.undo_id.map(Into::into).unwrap_or(correlation_id);
        let respond_on_completion = event.command_id.is_some();
        match &event.operation {
            ProgrammerOperation::ClearSelection => {
                clear_selection_events.push((correlation_id, respond_on_completion));
            }
            ProgrammerOperation::ClearValues {
                scope,
                attributes,
                allow_selection_flatten,
            } => {
                release_events.push(PendingRelease {
                    action_id: event.operation_id,
                    correlation_id,
                    undo_id,
                    selection: scope_to_selection(scope.clone()),
                    attributes: attribute_filter_to_attributes(attributes.clone()),
                    emit_release_selection: false,
                    allow_selection_flatten: *allow_selection_flatten,
                    respond_on_completion,
                });
            }
            ProgrammerOperation::ReleaseValues {
                scope,
                attributes,
                allow_selection_flatten,
            } => {
                release_events.push(PendingRelease {
                    action_id: event.operation_id,
                    correlation_id,
                    undo_id,
                    selection: scope_to_selection(scope.clone()),
                    attributes: attribute_filter_to_attributes(attributes.clone()),
                    emit_release_selection: matches!(attributes, AttributeFilter::All),
                    allow_selection_flatten: *allow_selection_flatten,
                    respond_on_completion,
                });
            }
        }
    }

    for (correlation_id, respond_on_completion) in clear_selection_events {
        state
            .programmer
            .set_active_selection(SelectionExpr::default());
        if respond_on_completion {
            write_command_success(&mut state.responder, correlation_id);
        }
    }

    for release in release_events {
        apply_release(state, channels, release);
    }
}

/// Retires pending user-command plans whose operations arrived this frame.
///
/// Plans whose operations would now require selection-flatten confirmation fail with a retry
/// command carrying a fresh approval. Returns the IDs of those rejected commands so their
/// operations are skipped.
fn reject_stale_plans(
    state: &mut ProgrammerMutationState,
    programmer_action_events: &[EngineOperationEnvelope<ProgrammerOperation>],
) -> HashSet<CommandId> {
    let planned_command_ids = programmer_action_events
        .iter()
        .filter_map(|event| event.command_id)
        .filter(|command_id| state.pending_plans.commands.contains_key(command_id))
        .collect::<HashSet<_>>();
    let rejected_plan_ids = programmer_action_events
        .iter()
        .filter_map(|event| {
            let command_id = event.command_id?;
            (state.pending_plans.commands.contains_key(&command_id)
                && programmer_action_requires_selection_flatten_confirmation(
                    &event.operation,
                    &state.programmer,
                    &state.selection_resolver,
                    &state.spatial_selection_resolver,
                    &state.fixture_data,
                ))
            .then_some(command_id)
        })
        .collect::<HashSet<_>>();

    for command_id in &rejected_plan_ids {
        let Some(command) = state.pending_plans.commands.remove(command_id) else {
            continue;
        };
        let Some(retry) = state.approvals.issue("UserCommand", |approval_id| {
            command.with_selection_flatten_approval(approval_id)
        }) else {
            if let Err(completion_error) = state
                .responder
                .fail_immediately(*command_id, selection_flatten_approval_issue_error())
            {
                tracing::error!(
                    %command_id,
                    %completion_error,
                    "Failed to report stale-plan approval issuance failure"
                );
            }
            continue;
        };
        let error = selection_flatten_confirmation_error("UserCommand", &retry);
        if let Err(completion_error) = state.responder.fail_immediately(*command_id, error) {
            tracing::error!(
                %command_id,
                %completion_error,
                "Failed to reject stale user-command plan requiring confirmation"
            );
        }
    }
    for command_id in planned_command_ids.difference(&rejected_plan_ids) {
        state.pending_plans.commands.remove(command_id);
    }
    rejected_plan_ids
}

/// Applies one clear or release operation, delegating cue and playback cleanup.
///
/// Releases that would flatten non-resolved selections under the prompt policy are rejected
/// with a retryable approval instead. Tracked releases complete once every delegated
/// operation finishes.
fn apply_release(
    state: &mut ProgrammerMutationState,
    channels: &mut ProgrammerOperationChannels,
    release: PendingRelease,
) {
    let PendingRelease {
        action_id,
        correlation_id,
        undo_id,
        selection,
        attributes,
        emit_release_selection,
        allow_selection_flatten,
        respond_on_completion,
    } = release;

    if !allow_selection_flatten
        && state.settings.selection_flatten_policy == SelectionFlattenPolicy::Prompt
        && release_would_flatten_non_resolved(
            &state.programmer,
            selection.clone(),
            &state.selection_resolver,
            &state.spatial_selection_resolver,
            &state.fixture_data,
        )
    {
        reject_release_requiring_confirmation(
            state,
            action_id,
            correlation_id,
            selection,
            attributes,
            respond_on_completion,
        );
        return;
    }

    let mut delegated_operations = Vec::new();
    if let Some(operation_id) = release_programmer_values(
        state,
        correlation_id,
        undo_id,
        selection.clone(),
        &attributes,
        respond_on_completion,
        &mut channels.p1(),
    ) {
        delegated_operations.push(operation_id);
    }
    if emit_release_selection {
        let action = PlaybackOperation::ReleaseParameters {
            scope: match selection {
                Some(selection) => PlaybackScope::Selection(selection),
                None => PlaybackScope::All,
            },
        };
        let envelope = if respond_on_completion {
            EngineOperationEnvelope::for_command_context(
                CommandId::from(correlation_id),
                UndoId::from(undo_id),
                action,
            )
        } else {
            EngineOperationEnvelope::detached(action)
        };
        if respond_on_completion {
            delegated_operations.push(envelope.operation_id);
        }
        channels.p2().write(envelope);
    }
    if respond_on_completion {
        finish_or_wait_for_programmer_action(
            &mut state.responder,
            &mut state.pending_action_workflows,
            action_id,
            CommandId::from(correlation_id),
            delegated_operations,
        );
    }
}

/// Fails a release that needs selection-flatten confirmation, offering an approved retry.
///
/// Detached releases register a broadcast command context first so the operator still sees
/// the rejection and its retry command.
fn reject_release_requiring_confirmation(
    state: &mut ProgrammerMutationState,
    action_id: OperationId,
    correlation_id: uuid::Uuid,
    selection: Option<SelectionExpr>,
    attributes: Vec<Attribute>,
    respond_on_completion: bool,
) {
    let response_command_id = CommandId::from(correlation_id);
    let Some(retry) = state.approvals.issue("ProgrammerCommand", |approval_id| {
        ProgrammerCommand::ReleaseProgrammerValues {
            selection,
            attributes,
            allow_selection_flatten: true,
            selection_flatten_approval: Some(approval_id),
        }
    }) else {
        if respond_on_completion {
            if let Err(completion_error) = state.responder.fail(
                response_command_id,
                selection_flatten_approval_issue_error(),
            ) {
                tracing::error!(
                    %action_id,
                    %completion_error,
                    "Failed to report selection-flatten approval issuance failure"
                );
            }
        } else {
            tracing::error!(
                %action_id,
                "Failed to issue detached selection-flatten approval"
            );
        }
        return;
    };
    if !respond_on_completion
        && let Err(registration_error) = state.responder.register_context(
            response_command_id,
            UndoId::from(correlation_id),
            CommandOrigin::Remote("AutomationAction".to_string()),
            ReplyTarget::ClientBroadcast,
        )
    {
        tracing::error!(
            %action_id,
            %registration_error,
            "Failed to register detached programmer-action rejection"
        );
        return;
    }
    let error = selection_flatten_confirmation_error("ProgrammerCommand", &retry);
    if let Err(completion_error) = state.responder.fail(response_command_id, error) {
        tracing::error!(
            %correlation_id,
            ?completion_error,
            "Failed to reject programmer action requiring selection-flatten confirmation"
        );
    }
}
