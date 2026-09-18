// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pending programmer command and delegated-operation workflow state.

use super::*;

/// Delegated operations that must all finish before one programmer action reports.
struct PendingProgrammerActionWorkflow {
    command_id: CommandId,
    operations: HashSet<OperationId>,
    first_error: Option<CommandError>,
}

/// Tracks nested cue and playback operations by their owning programmer action.
#[derive(Default)]
pub struct PendingProgrammerActionWorkflows {
    actions: HashMap<OperationId, PendingProgrammerActionWorkflow>,
    operation_parents: HashMap<OperationId, OperationId>,
}

/// Single-use capabilities issued with rejected selection-flatten retries.
#[derive(Default, Resource)]
pub struct SelectionFlattenApprovals {
    approvals: HashMap<uuid::Uuid, SelectionFlattenApproval>,
    issued_order: VecDeque<uuid::Uuid>,
}

/// Exact serialized retry authorized by one selection-flatten approval.
struct SelectionFlattenApproval {
    module: &'static str,
    command: serde_json::Value,
}

const SELECTION_FLATTEN_APPROVAL_RETENTION: usize = 4_096;

impl SelectionFlattenApprovals {
    /// Issues a fresh approval capability bound to one exact retry payload.
    pub(super) fn issue<T: Serialize>(
        &mut self,
        module: &'static str,
        make_retry: impl FnOnce(uuid::Uuid) -> T,
    ) -> Option<T> {
        let approval_id = uuid::Uuid::new_v4();
        let retry = make_retry(approval_id);
        let command = serde_json::to_value(&retry).ok()?;
        self.approvals
            .insert(approval_id, SelectionFlattenApproval { module, command });
        self.issued_order.push_back(approval_id);
        while self.issued_order.len() > SELECTION_FLATTEN_APPROVAL_RETENTION {
            if let Some(expired_id) = self.issued_order.pop_front() {
                self.approvals.remove(&expired_id);
            }
        }
        Some(retry)
    }

    /// Consumes an approval only when its module and complete retry payload match.
    pub(super) fn consume<T: Serialize>(
        &mut self,
        approval_id: uuid::Uuid,
        module: &'static str,
        command: &T,
    ) -> bool {
        let Ok(command) = serde_json::to_value(command) else {
            return false;
        };
        let matches = self
            .approvals
            .get(&approval_id)
            .is_some_and(|approval| approval.module == module && approval.command == command);
        if matches {
            self.approvals.remove(&approval_id);
        }
        matches
    }
}

/// Original high-level commands retained until their planned actions reach runtime dispatch.
#[derive(Default, Resource)]
pub struct PendingUserCommandPlans {
    pub(super) commands: HashMap<CommandId, UserCommand>,
}

impl PendingUserCommandPlans {
    /// Returns whether no high-level programmer plan remains queued for dispatch.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

impl PendingProgrammerActionWorkflows {
    /// Registers all delegated operations before their parent action can report success.
    pub(super) fn start(
        &mut self,
        action_id: OperationId,
        command_id: CommandId,
        operations: impl IntoIterator<Item = OperationId>,
    ) {
        let operations = operations.into_iter().collect::<HashSet<_>>();
        debug_assert!(!operations.is_empty());
        for operation_id in &operations {
            self.operation_parents.insert(*operation_id, action_id);
        }
        self.actions.insert(
            action_id,
            PendingProgrammerActionWorkflow {
                command_id,
                operations,
                first_error: None,
            },
        );
    }

    /// Applies one delegated result and returns the parent action's terminal outcome when ready.
    pub(super) fn resolve(
        &mut self,
        operation_id: OperationId,
        result: Result<(), CommandError>,
    ) -> Option<(CommandId, Result<(), CommandError>)> {
        let action_id = self.operation_parents.remove(&operation_id)?;
        let action = self.actions.get_mut(&action_id)?;
        action.operations.remove(&operation_id);

        if let Err(error) = result
            && action.first_error.is_none()
        {
            action.first_error = Some(error);
        }

        if !action.operations.is_empty() {
            return None;
        }
        let action = self.actions.remove(&action_id)?;
        Some((action.command_id, action.first_error.map_or(Ok(()), Err)))
    }
}

/// In-flight programmer workflows awaiting a cues-domain store result.
#[derive(Default, Resource)]
pub struct StoreCueWorkflows {
    pub(super) commands: HashMap<OperationId, CommandId>,
}

/// In-flight programmer workflows awaiting group or blueprint store actions.
#[derive(Default, Resource)]
pub struct StoreObjectWorkflows {
    pub(super) commands: HashMap<OperationId, CommandId>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action_model::ReleaseCommand;

    /// Verifies a failed delegated operation does not finish its parent before siblings settle.
    #[test]
    fn programmer_action_workflow_waits_for_siblings_after_failure() {
        let mut workflows = PendingProgrammerActionWorkflows::default();
        let action_id = OperationId::new();
        let first_operation_id = OperationId::new();
        let second_operation_id = OperationId::new();
        let command_id = CommandId::new();
        workflows.start(
            action_id,
            command_id,
            [first_operation_id, second_operation_id],
        );

        let first_result = workflows.resolve(
            first_operation_id,
            Err(CommandError::new("cue.release_failed", "release failed")),
        );
        assert!(
            first_result.is_none(),
            "a sibling operation must remain joined after the first failure"
        );

        let terminal = workflows
            .resolve(second_operation_id, Ok(()))
            .expect("the final sibling should complete the parent workflow");
        assert_eq!(terminal.0, command_id);
        assert!(matches!(
            terminal.1,
            Err(CommandError { ref code, .. }) if code == "cue.release_failed"
        ));
    }

    /// Verifies approvals authorize one exact command in one command module.
    #[test]
    fn selection_flatten_approval_is_payload_and_module_bound() {
        let mut approvals = SelectionFlattenApprovals::default();
        let retry = approvals
            .issue("UserCommand", |approval_id| {
                UserCommand::Release(ReleaseCommand {
                    target: None,
                    allow_selection_flatten: true,
                    selection_flatten_approval: Some(approval_id),
                })
            })
            .expect("serializable retry should receive an approval");
        let approval_id = retry
            .selection_flatten_approval()
            .expect("approved retry should carry its capability");
        let cross_module_retry = ProgrammerCommand::ReleaseProgrammerValues {
            selection: None,
            attributes: Vec::new(),
            allow_selection_flatten: true,
            selection_flatten_approval: Some(approval_id),
        };

        assert!(!approvals.consume(approval_id, "ProgrammerCommand", &cross_module_retry));
        assert!(approvals.consume(approval_id, "UserCommand", &retry));
        assert!(!approvals.consume(approval_id, "UserCommand", &retry));
    }
}
