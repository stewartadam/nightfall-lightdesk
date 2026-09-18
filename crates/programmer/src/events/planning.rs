// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! High-level programmer command planning and selection-flatten authorization.

use super::release::partition_fixture_ref_for_release;
use super::*;

/// Returns whether releasing one selection would split a non-resolved programmer expression.
pub(super) fn release_would_flatten_non_resolved(
    programmer: &Programmer,
    selection: Option<SelectionExpr>,
    selection_resolver: &SelectionResolver,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) -> bool {
    let Some(selection_expr) = selection else {
        return false;
    };
    let selection_filter = selection_resolver
        .resolve_expr(&selection_expr)
        .into_value();
    if selection_filter.is_empty() {
        return false;
    }

    programmer
        .active_instructions()
        .iter()
        .any(|(_, instruction)| {
            if matches!(instruction.selection.source, SelectionExpr::Resolved(_)) {
                return false;
            }

            let resolved_instruction_selection = spatial_selection_resolver
                .resolve(&instruction.selection)
                .into_value()
                .canonical;

            let mut matched_count = 0;
            let mut unmatched_count = 0;
            for fixture in &resolved_instruction_selection {
                let (matched, unmatched) =
                    partition_fixture_ref_for_release(fixture, &selection_filter, fixture_data);
                matched_count += matched.len();
                unmatched_count += unmatched.len();
            }

            matched_count > 0 && unmatched_count > 0
        })
}

/// Builds the structured rejection consumed by the operator confirmation UI.
pub(super) fn selection_flatten_confirmation_error<T: Serialize>(
    module: &str,
    command: &T,
) -> CommandError {
    CommandError::new(
        "programmer.selection_flatten_confirmation_required",
        "This command would flatten programmer selection expressions and requires confirmation",
    )
    .with_details(serde_json::json!({
        "module": module,
        "command": command,
    }))
}

/// Builds the terminal failure returned for reused or fabricated approval capabilities.
fn invalid_selection_flatten_approval_error() -> CommandError {
    CommandError::new(
        "programmer.selection_flatten_approval_invalid",
        "Selection-flatten approval is invalid or has already been used",
    )
}

/// Builds the terminal failure returned when an approved retry cannot be represented safely.
pub(super) fn selection_flatten_approval_issue_error() -> CommandError {
    CommandError::new(
        "programmer.selection_flatten_approval_issue_failed",
        "Selection-flatten approval could not be issued",
    )
}

/// Returns whether any member of a complete plan requires selection-flatten approval.
fn plan_requires_selection_flatten_confirmation(
    planned_actions: &[DynEngineAction],
    programmer: &Programmer,
    selection_resolver: &SelectionResolver,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) -> bool {
    planned_actions.iter().any(|planned| {
        let Some(action) = planned.as_any().downcast_ref::<ProgrammerAction>() else {
            return false;
        };
        programmer_action_requires_selection_flatten_confirmation(
            action,
            programmer,
            selection_resolver,
            spatial_selection_resolver,
            fixture_data,
        )
    })
}

/// Returns whether one programmer action requires approval against current runtime state.
pub(super) fn programmer_action_requires_selection_flatten_confirmation(
    action: &ProgrammerAction,
    programmer: &Programmer,
    selection_resolver: &SelectionResolver,
    spatial_selection_resolver: &SpatialSelectionResolver,
    fixture_data: &FixtureDataProviderExt,
) -> bool {
    let (scope, allow_selection_flatten) = match action {
        ProgrammerAction::ClearSelection => return false,
        ProgrammerAction::ClearValues {
            scope,
            allow_selection_flatten,
            ..
        }
        | ProgrammerAction::ReleaseValues {
            scope,
            allow_selection_flatten,
            ..
        } => (scope, allow_selection_flatten),
    };
    !allow_selection_flatten
        && release_would_flatten_non_resolved(
            programmer,
            match scope {
                Scope::All => None,
                Scope::Selection(selection) => Some(selection.clone()),
            },
            selection_resolver,
            spatial_selection_resolver,
            fixture_data,
        )
}

/// Translates pending `UserCommand` intents into domain-owned engine actions.
///
/// This runs before undo capture and dispatch, keeping pending buffers focused
/// on command intent while runtime behavior executes through action payloads.
pub fn plan_pending_user_commands(
    mut pending_buffer: ResMut<PendingCommandBuffer>,
    mut pending_actions: ResMut<PendingEngineActionBuffer>,
    programmer: Res<Programmer>,
    settings: Res<DeskSettings>,
    selection_resolver: SelectionResolver,
    spatial_selection_resolver: SpatialSelectionResolver,
    fixture_data: Res<FixtureDataProviderExt>,
    mut approvals: ResMut<SelectionFlattenApprovals>,
    mut pending_plans: ResMut<PendingUserCommandPlans>,
    mut responder: CommandResponder,
) {
    /// Applies the immediate selection effect of one planned action to later planning context.
    fn update_context_from_action(context: &mut ProgrammerPlanContext, action: &dyn EngineAction) {
        if matches!(
            action.as_any().downcast_ref::<ProgrammerAction>(),
            Some(ProgrammerAction::ClearSelection)
        ) {
            context.active_selection_is_empty = true;
        }
    }

    /// Applies one still-pending programmer command to later planning context.
    fn update_context_from_programmer_command(
        context: &mut ProgrammerPlanContext,
        command: &ProgrammerCommand,
    ) {
        match command {
            ProgrammerCommand::ClearProgrammer | ProgrammerCommand::ClearProgrammerSelection => {
                context.active_selection_is_empty = true;
            }
            ProgrammerCommand::SetProgrammerSelection(selection) => {
                context.active_selection_is_empty = selection.is_empty();
            }
            ProgrammerCommand::SetProgrammerSpatialSelection(selection) => {
                context.active_selection_is_empty = selection.source.is_empty();
            }
            ProgrammerCommand::AddProgrammerSelection(selection) if !selection.is_empty() => {
                context.active_selection_is_empty = false;
            }
            _ => {}
        }
    }

    if pending_buffer.is_empty() {
        return;
    }

    let planner = ProgrammerCommandPlanner;
    let mut context = ProgrammerPlanContext {
        active_selection_is_empty: programmer.active_selection().is_empty(),
    };

    let pending_commands = pending_buffer.drain();
    for pending in pending_commands {
        let user_command = pending
            .payload
            .as_any()
            .downcast_ref::<UserCommand>()
            .cloned();

        let Some(user_command) = user_command else {
            if let Some(programmer_command) =
                pending.payload.as_any().downcast_ref::<ProgrammerCommand>()
            {
                update_context_from_programmer_command(&mut context, programmer_command);
            }

            pending_buffer.push(pending);
            continue;
        };

        if user_command.allows_selection_flatten()
            && !user_command
                .selection_flatten_approval()
                .is_some_and(|approval_id| {
                    approvals.consume(approval_id, "UserCommand", &user_command)
                })
        {
            if let Err(completion_error) = responder.fail(
                pending.command_id,
                invalid_selection_flatten_approval_error(),
            ) {
                tracing::error!(
                    command_id = %pending.command_id,
                    %completion_error,
                    "Failed to reject invalid selection-flatten approval"
                );
            }
            continue;
        }

        let planned_actions = planner.plan(&user_command, &context);
        if settings.selection_flatten_policy == SelectionFlattenPolicy::Prompt
            && plan_requires_selection_flatten_confirmation(
                &planned_actions,
                &programmer,
                &selection_resolver,
                &spatial_selection_resolver,
                &fixture_data,
            )
        {
            let Some(retry) = approvals.issue("UserCommand", |approval_id| {
                user_command.with_selection_flatten_approval(approval_id)
            }) else {
                if let Err(completion_error) =
                    responder.fail(pending.command_id, selection_flatten_approval_issue_error())
                {
                    tracing::error!(
                        command_id = %pending.command_id,
                        %completion_error,
                        "Failed to report selection-flatten approval issuance failure"
                    );
                }
                continue;
            };
            let error = selection_flatten_confirmation_error("UserCommand", &retry);
            if let Err(completion_error) = responder.fail(pending.command_id, error) {
                tracing::error!(
                    command_id = %pending.command_id,
                    %completion_error,
                    "Failed to reject user command requiring selection-flatten confirmation"
                );
            }
            continue;
        }
        if planned_actions.len() > 1
            && let Err(error) = responder.add_expected_completions(
                pending.command_id,
                planned_actions.len().saturating_sub(1),
            )
        {
            tracing::error!(
                command_id = %pending.command_id,
                action_count = planned_actions.len(),
                %error,
                "planned_action_join_expansion_failed"
            );
            if let Err(completion_error) = responder.fail_immediately(
                pending.command_id,
                CommandError::new(
                    "programmer.plan_tracking_failed",
                    "Unable to track every action produced by the command",
                ),
            ) {
                tracing::error!(
                    command_id = %pending.command_id,
                    %completion_error,
                    "Failed to report planned action tracking failure"
                );
            }
            continue;
        }
        for action in &planned_actions {
            update_context_from_action(&mut context, action.as_ref());
        }
        if planned_actions
            .iter()
            .any(|action| action.as_any().downcast_ref::<ProgrammerAction>().is_some())
        {
            pending_plans
                .commands
                .insert(pending.command_id, user_command);
        }
        for action in planned_actions {
            pending_actions.push(DynEngineActionEnvelope::for_command(
                pending.command_id,
                pending.undo_id,
                action,
            ));
        }
    }
}
