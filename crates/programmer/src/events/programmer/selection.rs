// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer active-selection commands.

use super::*;

/// Replaces, extends, or narrows the programmer's active selection.
///
/// Each selection is resolved first so resolution warnings reach the caller; a selection that
/// resolves to nothing because of those issues fails the command and leaves the active
/// selection untouched.
pub(super) fn handle_command(
    state: &mut ProgrammerMutationState,
    event: &CommandEnvelope<ProgrammerCommand>,
) {
    let correlation_id = event.command_id.into();
    match &event.command {
        ProgrammerCommand::SetProgrammerSelection(selection_expression) => {
            let result = state.selection_resolver.resolve_expr(selection_expression);
            if !accept_resolved_selection(
                &mut state.responder,
                correlation_id,
                &result,
                result.value.is_empty(),
            ) {
                return;
            }

            state
                .programmer
                .set_active_selection(selection_expression.clone());
            write_command_success(&mut state.responder, correlation_id);
        }

        ProgrammerCommand::SetProgrammerSpatialSelection(selection) => {
            let result = state.spatial_selection_resolver.resolve(selection);
            if !accept_resolved_selection(
                &mut state.responder,
                correlation_id,
                &result,
                result.value.is_empty(),
            ) {
                return;
            }

            state
                .programmer
                .set_active_spatial_selection(selection.clone());
            write_command_success(&mut state.responder, correlation_id);
        }

        ProgrammerCommand::AddProgrammerSelection(selection_expression) => {
            let result = state.selection_resolver.resolve_expr(selection_expression);
            if !accept_resolved_selection(
                &mut state.responder,
                correlation_id,
                &result,
                result.value.is_empty(),
            ) {
                return;
            }

            let current = state.programmer.active_selection();
            let new_selection = SelectionExpr::Add {
                lhs: Box::new(current),
                rhs: Box::new(selection_expression.clone()),
            };
            state.programmer.set_active_selection(new_selection);
            write_command_success(&mut state.responder, correlation_id);
        }

        ProgrammerCommand::RemoveProgrammerSelection(selection_expression) => {
            let result = state.selection_resolver.resolve_expr(selection_expression);
            if !accept_resolved_selection(
                &mut state.responder,
                correlation_id,
                &result,
                result.value.is_empty(),
            ) {
                return;
            }

            let current = state.programmer.active_selection();
            let new_selection = SelectionExpr::Sub {
                lhs: Box::new(current),
                rhs: Box::new(selection_expression.clone()),
            };
            state.programmer.set_active_selection(new_selection);
            write_command_success(&mut state.responder, correlation_id);
        }

        _ => {}
    }
}
