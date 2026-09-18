// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime programmer selection and instruction mutation handlers.

use bevy_ecs::system::SystemParam;

use super::cues::{write_command_error, write_command_success, write_command_warning};
use super::planning::{
    programmer_action_requires_selection_flatten_confirmation, release_would_flatten_non_resolved,
    selection_flatten_approval_issue_error, selection_flatten_confirmation_error,
};
use super::release::partition_fixture_ref_for_release;
use super::store_mode::add_programmer_instruction_with_overrides;
use super::*;

/// Cohesive runtime state used while mutating programmer selection and instructions.
#[derive(SystemParam)]
pub struct ProgrammerMutationState<'w, 's> {
    /// Publishes terminal command outcomes and non-terminal notices.
    responder: CommandResponder<'w>,
    /// Active programmer selection, instructions, and recalled-cue context.
    programmer: ResMut<'w, Programmer>,
    /// Resolves non-spatial fixture selections.
    selection_resolver: SelectionResolver<'w>,
    /// Resolves spatial selection pipelines against fixture and group data.
    spatial_selection_resolver: SpatialSelectionResolver<'w>,
    /// Supplies fixture element metadata needed by partial releases and overrides.
    fixture_data: Res<'w, FixtureDataProviderExt>,
    /// Controls operator confirmation policy for destructive selection flattening.
    settings: Res<'w, DeskSettings>,
    /// Stores single-use capabilities for approved selection flattening.
    approvals: ResMut<'w, SelectionFlattenApprovals>,
    /// Retains high-level commands until their planned actions reach dispatch.
    pending_plans: ResMut<'w, PendingUserCommandPlans>,
    /// Joins delegated cue and playback operations for each programmer action.
    pending_action_workflows: Local<'s, PendingProgrammerActionWorkflows>,
}

/// Handles events related to the programmer and its instructions
#[allow(clippy::type_complexity)]
pub fn handle_programmer_events(
    mut events_reader: MessageReader<CommandEnvelope<ProgrammerCommand>>,
    mut command_events: ParamSet<(
        MessageReader<EngineActionEnvelope<ProgrammerAction>>,
        MessageWriter<EngineActionEnvelope<CueLifecycleAction>>,
        MessageWriter<EngineActionEnvelope<PlaybackAction>>,
        MessageWriter<EngineActionEnvelope<ProgrammerAction>>,
        MessageReader<OperationResult<(), CommandError>>,
    )>,
    state: ProgrammerMutationState,
) {
    let ProgrammerMutationState {
        mut responder,
        mut programmer,
        selection_resolver,
        spatial_selection_resolver,
        fixture_data,
        settings,
        mut approvals,
        mut pending_plans,
        mut pending_action_workflows,
    } = state;

    /// Mutates programmer rows and returns lifecycle-managed cue cleanup, when delegated.
    fn release_programmer_values(
        correlation_id: uuid::Uuid,
        undo_id: uuid::Uuid,
        programmer: &mut Programmer,
        selection: Option<SelectionExpr>,
        attributes: &[Attribute],
        selection_resolver: &SelectionResolver,
        spatial_selection_resolver: &SpatialSelectionResolver,
        fixture_data: &FixtureDataProviderExt,
        inherit_command_context: bool,
        cue_lifecycle_actions: &mut MessageWriter<EngineActionEnvelope<CueLifecycleAction>>,
    ) -> Option<OperationId> {
        /// Returns whether an attribute-scoped release targets a live Blueprint row.
        fn release_targets_blueprint_application(
            application: &BlueprintApplication,
            attributes: &[Attribute],
        ) -> bool {
            attributes
                .iter()
                .any(|attribute| match &application.selector {
                    BlueprintSelector::All => true,
                    BlueprintSelector::Attribute(selected) => selected == attribute,
                    BlueprintSelector::Category(category) => attribute.category() == *category,
                })
        }

        let selection_filter: Option<Vec<FixtureRef>> = selection.map(|selection_expr| {
            selection_resolver
                .resolve_expr(&selection_expr)
                .into_value()
        });

        let mut updates: Vec<(uuid::Uuid, BoundCueInstruction)> = Vec::new();
        let mut removals: Vec<uuid::Uuid> = Vec::new();
        let mut additions: Vec<BoundCueInstruction> = Vec::new();

        for (uid, instruction) in programmer.active_instructions().iter() {
            let resolved_instruction_selection = spatial_selection_resolver
                .resolve(&instruction.selection)
                .into_value()
                .canonical;

            let (matched_fixtures, unmatched_fixtures) = if let Some(selection_filter) =
                &selection_filter
            {
                let mut matched = Vec::new();
                let mut unmatched = Vec::new();
                for fixture in &resolved_instruction_selection {
                    let (fixture_matched, fixture_unmatched) =
                        partition_fixture_ref_for_release(fixture, selection_filter, fixture_data);
                    matched.extend(fixture_matched);
                    unmatched.extend(fixture_unmatched);
                }
                (matched, unmatched)
            } else {
                (resolved_instruction_selection.clone(), Vec::new())
            };

            if matched_fixtures.is_empty() {
                continue;
            }

            if attributes.is_empty() {
                if unmatched_fixtures.is_empty() {
                    removals.push(*uid);
                } else {
                    updates.push((
                        *uid,
                        BoundCueInstruction {
                            selection: SelectionExpr::Resolved(unmatched_fixtures).into(),
                            cue_instruction: instruction.cue_instruction.clone(),
                        },
                    ));
                }
                continue;
            }

            let mut filtered_instruction = instruction.cue_instruction.clone();
            for attribute in attributes {
                filtered_instruction.values.remove(attribute);
                filtered_instruction
                    .transitions_by_attribute
                    .remove(attribute);
            }
            if filtered_instruction
                .blueprint_application
                .as_ref()
                .is_some_and(|application| {
                    release_targets_blueprint_application(application, attributes)
                })
            {
                filtered_instruction.blueprint_application = None;
            }

            let filtered_instruction_is_empty = filtered_instruction.values.is_empty()
                && filtered_instruction.blueprint_application.is_none();

            if unmatched_fixtures.is_empty() {
                if filtered_instruction_is_empty {
                    removals.push(*uid);
                } else {
                    updates.push((
                        *uid,
                        BoundCueInstruction {
                            selection: instruction.selection.clone(),
                            cue_instruction: filtered_instruction,
                        },
                    ));
                }
            } else {
                updates.push((
                    *uid,
                    BoundCueInstruction {
                        selection: SelectionExpr::Resolved(unmatched_fixtures).into(),
                        cue_instruction: instruction.cue_instruction.clone(),
                    },
                ));

                if !filtered_instruction_is_empty {
                    additions.push(BoundCueInstruction {
                        selection: SelectionExpr::Resolved(matched_fixtures).into(),
                        cue_instruction: filtered_instruction,
                    });
                }
            }
        }

        let mut released_uids = Vec::new();
        {
            let active_instructions = programmer.active_instructions_mut();
            for (uid, updated_instruction) in updates {
                if let Some(instruction) = active_instructions.get_mut(&uid) {
                    *instruction = updated_instruction;
                }
            }

            for uid in removals {
                if active_instructions.remove(&uid).is_some() {
                    released_uids.push(uid);
                }
            }
        }

        let release_operation_id = if released_uids.is_empty() {
            None
        } else {
            let action = CueLifecycleAction::ReleaseCueInstances {
                uids: released_uids,
            };
            let envelope = if inherit_command_context {
                EngineActionEnvelope::for_command_context(
                    correlation_id.into(),
                    undo_id.into(),
                    action,
                )
            } else {
                EngineActionEnvelope::detached(action)
            };
            let operation_id = envelope.operation_id;
            cue_lifecycle_actions.write(envelope);
            inherit_command_context.then_some(operation_id)
        };

        for instruction in additions {
            programmer.add_instruction(instruction);
        }

        if programmer.active_instructions().is_empty() {
            programmer.clear_recalled_cue_timing_defaults();
        }
        release_operation_id
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

    let release_results: Vec<_> = command_events
        .p4()
        .read()
        .filter_map(|result| {
            pending_action_workflows.resolve(result.operation_id, result.result.clone())
        })
        .collect();

    for (command_id, result) in release_results {
        match result {
            Ok(()) => write_command_success(&mut responder, command_id.into()),
            Err(error) => {
                if let Err(completion_error) = responder.fail(command_id, error) {
                    tracing::error!(
                        %command_id,
                        %completion_error,
                        "programmer_parameter_release_failure_failed"
                    );
                }
            }
        }
    }

    for event in events_reader.read() {
        let correlation_id = event.command_id.into();
        match &event.command {
            ProgrammerCommand::ClearProgrammer => {
                let action = if programmer.active_selection().is_empty() {
                    ProgrammerAction::ClearValues {
                        scope: Scope::All,
                        attributes: AttributeFilter::All,
                        allow_selection_flatten: false,
                    }
                } else {
                    ProgrammerAction::ClearSelection
                };

                command_events
                    .p3()
                    .write(EngineActionEnvelope::for_command(event, action));
            }

            ProgrammerCommand::ClearProgrammerSelection => {
                command_events.p3().write(EngineActionEnvelope::for_command(
                    event,
                    ProgrammerAction::ClearSelection,
                ));
            }

            ProgrammerCommand::ClearProgrammerValues => {
                command_events.p3().write(EngineActionEnvelope::for_command(
                    event,
                    ProgrammerAction::ClearValues {
                        scope: Scope::All,
                        attributes: AttributeFilter::All,
                        allow_selection_flatten: false,
                    },
                ));
            }

            ProgrammerCommand::ReleaseProgrammerValues {
                selection,
                attributes,
                allow_selection_flatten,
                selection_flatten_approval,
            } => {
                let approved = *allow_selection_flatten
                    && selection_flatten_approval.is_some_and(|approval_id| {
                        approvals.consume(approval_id, "ProgrammerCommand", &event.command)
                    });
                if *allow_selection_flatten && !approved {
                    write_command_error(
                        &mut responder,
                        correlation_id,
                        "programmer.selection_flatten_approval_invalid",
                        "Selection-flatten approval is invalid or has already been used"
                            .to_string(),
                    );
                    continue;
                }
                command_events.p3().write(EngineActionEnvelope::for_command(
                    event,
                    ProgrammerAction::ReleaseValues {
                        scope: selection.clone().map_or(Scope::All, Scope::Selection),
                        attributes: AttributeFilter::from_attributes(attributes),
                        allow_selection_flatten: approved,
                    },
                ));
            }

            ProgrammerCommand::AddProgrammerInstruction {
                selection,
                instruction,
            } => {
                // Validate selection before adding instruction
                let result = spatial_selection_resolver.resolve(selection);
                for warning in &result.issues {
                    write_command_warning(&mut responder, correlation_id, warning.clone());
                }
                if result.value.is_empty() && result.is_partial() {
                    // Skip adding instruction if selection couldn't be resolved at all
                    write_command_error(
                        &mut responder,
                        correlation_id,
                        "programmer.selection_invalid",
                        result.issues.join("; "),
                    );
                    continue;
                }

                add_programmer_instruction_with_overrides(
                    &mut programmer,
                    BoundCueInstruction {
                        selection: selection.clone(),
                        cue_instruction: instruction.to_owned(),
                    },
                    &spatial_selection_resolver,
                    &fixture_data,
                );

                // Auto-select: update active selection to match instruction's selection
                if settings.programmer_auto_select {
                    programmer.set_active_spatial_selection(selection.clone());
                }
                write_command_success(&mut responder, correlation_id);
            }

            ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) => {
                let selection = programmer.active_spatial_selection();
                add_programmer_instruction_with_overrides(
                    &mut programmer,
                    BoundCueInstruction {
                        selection,
                        cue_instruction: instruction.to_owned(),
                    },
                    &spatial_selection_resolver,
                    &fixture_data,
                );
                write_command_success(&mut responder, correlation_id);
            }

            ProgrammerCommand::SetProgrammerSelection(selection_expression) => {
                // Validate selection and report any warnings to UI
                let result = selection_resolver.resolve_expr(selection_expression);
                for warning in &result.issues {
                    write_command_warning(&mut responder, correlation_id, warning.clone());
                }
                if result.value.is_empty() && result.is_partial() {
                    // Don't update selection if it couldn't be resolved at all
                    write_command_error(
                        &mut responder,
                        correlation_id,
                        "programmer.selection_invalid",
                        result.issues.join("; "),
                    );
                    continue;
                }

                programmer.set_active_selection(selection_expression.clone());
                write_command_success(&mut responder, correlation_id);
            }

            ProgrammerCommand::SetProgrammerSpatialSelection(selection) => {
                let result = spatial_selection_resolver.resolve(selection);
                for warning in &result.issues {
                    write_command_warning(&mut responder, correlation_id, warning.clone());
                }
                if result.value.is_empty() && result.is_partial() {
                    write_command_error(
                        &mut responder,
                        correlation_id,
                        "programmer.selection_invalid",
                        result.issues.join("; "),
                    );
                    continue;
                }

                programmer.set_active_spatial_selection(selection.clone());
                write_command_success(&mut responder, correlation_id);
            }

            ProgrammerCommand::AddProgrammerSelection(selection_expression) => {
                // Validate selection and report any warnings to UI
                let result = selection_resolver.resolve_expr(selection_expression);
                for warning in &result.issues {
                    write_command_warning(&mut responder, correlation_id, warning.clone());
                }
                if result.value.is_empty() && result.is_partial() {
                    // Don't update selection if it couldn't be resolved at all
                    write_command_error(
                        &mut responder,
                        correlation_id,
                        "programmer.selection_invalid",
                        result.issues.join("; "),
                    );
                    continue;
                }

                // Create new selection by adding to the current selection
                let current = programmer.active_selection();
                let new_selection = SelectionExpr::Add {
                    lhs: Box::new(current),
                    rhs: Box::new(selection_expression.clone()),
                };
                programmer.set_active_selection(new_selection);
                write_command_success(&mut responder, correlation_id);
            }

            ProgrammerCommand::RemoveProgrammerSelection(selection_expression) => {
                // Validate selection and report any warnings to UI
                let result = selection_resolver.resolve_expr(selection_expression);
                for warning in &result.issues {
                    write_command_warning(&mut responder, correlation_id, warning.clone());
                }
                if result.value.is_empty() && result.is_partial() {
                    // Don't update selection if it couldn't be resolved at all
                    write_command_error(
                        &mut responder,
                        correlation_id,
                        "programmer.selection_invalid",
                        result.issues.join("; "),
                    );
                    continue;
                }

                // Create new selection by subtracting from the current selection
                let current = programmer.active_selection();
                let new_selection = SelectionExpr::Sub {
                    lhs: Box::new(current),
                    rhs: Box::new(selection_expression.clone()),
                };
                programmer.set_active_selection(new_selection);
                write_command_success(&mut responder, correlation_id);
            }

            _ => {}
        }
    }

    let mut clear_selection_events = Vec::new();
    let mut release_events = Vec::new();

    let programmer_action_events = command_events.p0().read().cloned().collect::<Vec<_>>();
    let planned_command_ids = programmer_action_events
        .iter()
        .filter_map(|event| event.command_id)
        .filter(|command_id| pending_plans.commands.contains_key(command_id))
        .collect::<HashSet<_>>();
    let rejected_plan_ids = programmer_action_events
        .iter()
        .filter_map(|event| {
            let command_id = event.command_id?;
            (pending_plans.commands.contains_key(&command_id)
                && programmer_action_requires_selection_flatten_confirmation(
                    &event.action,
                    &programmer,
                    &selection_resolver,
                    &spatial_selection_resolver,
                    &fixture_data,
                ))
            .then_some(command_id)
        })
        .collect::<HashSet<_>>();

    for command_id in &rejected_plan_ids {
        let Some(command) = pending_plans.commands.remove(command_id) else {
            continue;
        };
        let Some(retry) = approvals.issue("UserCommand", |approval_id| {
            command.with_selection_flatten_approval(approval_id)
        }) else {
            if let Err(completion_error) =
                responder.fail_immediately(*command_id, selection_flatten_approval_issue_error())
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
        if let Err(completion_error) = responder.fail_immediately(*command_id, error) {
            tracing::error!(
                %command_id,
                %completion_error,
                "Failed to reject stale user-command plan requiring confirmation"
            );
        }
    }
    for command_id in planned_command_ids.difference(&rejected_plan_ids) {
        pending_plans.commands.remove(command_id);
    }

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
        match &event.action {
            ProgrammerAction::ClearSelection => {
                clear_selection_events.push((correlation_id, respond_on_completion));
            }
            ProgrammerAction::ClearValues {
                scope,
                attributes,
                allow_selection_flatten,
            } => {
                release_events.push((
                    event.operation_id,
                    correlation_id,
                    undo_id,
                    scope_to_selection(scope.clone()),
                    attribute_filter_to_attributes(attributes.clone()),
                    false,
                    *allow_selection_flatten,
                    respond_on_completion,
                ));
            }
            ProgrammerAction::ReleaseValues {
                scope,
                attributes,
                allow_selection_flatten,
            } => {
                release_events.push((
                    event.operation_id,
                    correlation_id,
                    undo_id,
                    scope_to_selection(scope.clone()),
                    attribute_filter_to_attributes(attributes.clone()),
                    matches!(attributes, AttributeFilter::All),
                    *allow_selection_flatten,
                    respond_on_completion,
                ));
            }
        }
    }

    for (correlation_id, respond_on_completion) in clear_selection_events {
        programmer.set_active_selection(SelectionExpr::default());
        if respond_on_completion {
            write_command_success(&mut responder, correlation_id);
        }
    }

    for (
        action_id,
        correlation_id,
        undo_id,
        selection,
        attributes,
        emit_release_selection,
        allow_selection_flatten,
        respond_on_completion,
    ) in release_events
    {
        if !allow_selection_flatten
            && settings.selection_flatten_policy == SelectionFlattenPolicy::Prompt
            && release_would_flatten_non_resolved(
                &programmer,
                selection.clone(),
                &selection_resolver,
                &spatial_selection_resolver,
                &fixture_data,
            )
        {
            let response_command_id = CommandId::from(correlation_id);
            let Some(retry) = approvals.issue("ProgrammerCommand", |approval_id| {
                ProgrammerCommand::ReleaseProgrammerValues {
                    selection,
                    attributes,
                    allow_selection_flatten: true,
                    selection_flatten_approval: Some(approval_id),
                }
            }) else {
                if respond_on_completion {
                    if let Err(completion_error) = responder.fail(
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
                continue;
            };
            if !respond_on_completion
                && let Err(registration_error) = responder.register_context(
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
                continue;
            }
            let error = selection_flatten_confirmation_error("ProgrammerCommand", &retry);
            if let Err(completion_error) = responder.fail(response_command_id, error) {
                tracing::error!(
                    %correlation_id,
                    ?completion_error,
                    "Failed to reject programmer action requiring selection-flatten confirmation"
                );
            }
            continue;
        }

        let mut delegated_operations = Vec::new();
        if let Some(operation_id) = release_programmer_values(
            correlation_id,
            undo_id,
            &mut programmer,
            selection.clone(),
            &attributes,
            &selection_resolver,
            &spatial_selection_resolver,
            &fixture_data,
            respond_on_completion,
            &mut command_events.p1(),
        ) {
            delegated_operations.push(operation_id);
        }
        if emit_release_selection {
            let action = PlaybackAction::ReleaseParameters {
                scope: match selection {
                    Some(selection) => PlaybackScope::Selection(selection),
                    None => PlaybackScope::All,
                },
            };
            let envelope = if respond_on_completion {
                EngineActionEnvelope::for_command_context(
                    CommandId::from(correlation_id),
                    UndoId::from(undo_id),
                    action,
                )
            } else {
                EngineActionEnvelope::detached(action)
            };
            if respond_on_completion {
                delegated_operations.push(envelope.operation_id);
            }
            command_events.p2().write(envelope);
        }
        if respond_on_completion {
            finish_or_wait_for_programmer_action(
                &mut responder,
                &mut pending_action_workflows,
                action_id,
                CommandId::from(correlation_id),
                delegated_operations,
            );
        }
    }
}
