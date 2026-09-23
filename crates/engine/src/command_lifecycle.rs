// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Exact-once lifecycle tracking for externally accepted commands.

use std::collections::{HashMap, HashSet, VecDeque};

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use thiserror::Error;
use web_time::Instant;

use crate::prelude::{
    CommandEnvelope, CommandError, CommandId, CommandNotice, CommandOrigin, CommandOutcome,
    CommandOutput, CommandResult, NoticeLevel, ReplyTarget, UndoId,
};

/// Context retained while one accepted command is active.
#[derive(Clone, Debug)]
pub struct ActiveCommand {
    /// Trusted connection that submitted this command, when supplied by the host.
    pub client_connection: Option<crate::client_bridge::ClientConnection>,
    /// Undo group that owns mutations produced by the command.
    pub undo_id: UndoId,
    /// External surface that accepted the command.
    pub origin: CommandOrigin,
    /// Destination for the terminal result.
    pub reply_target: ReplyTarget,
    /// Monotonic time at which lifecycle tracking began for diagnostics.
    pub started_at: Instant,
    /// Number of operation outcomes required before the command can finish.
    expected_completions: usize,
    /// Operation outcomes already received for this command.
    received_completions: usize,
    /// Successful operation outcomes already received for this command.
    successful_completions: usize,
    /// First operation failure retained while remaining work settles.
    first_error: Option<CommandError>,
    /// Per-operation outputs retained until the command-level success is complete.
    success_outputs: Vec<Option<CommandOutput>>,
}

/// Terminal command data returned when the tracker accepts a finish operation.
#[derive(Clone, Debug, Message)]
pub struct FinishedCommand {
    /// Identity of the command that reached a terminal state.
    pub command_id: CommandId,
    /// Context retained from command registration.
    pub command: ActiveCommand,
    /// Terminal semantic result supplied by the owning handler or workflow.
    pub outcome: CommandOutcome,
    /// Whether captured inverses should remain available after this terminal outcome.
    pub commit_undo_group: bool,
}

/// Transport-routing instruction emitted for one admitted terminal command result.
#[derive(Clone, Debug, Message)]
pub struct CommandReply {
    /// Transport-neutral terminal command result.
    pub result: CommandResult,
    /// Adapter that should deliver the result to its initiating client.
    pub reply_target: ReplyTarget,
}

/// Failure to register a new command lifecycle.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum CommandRegistrationError {
    /// The supplied command identity is active or was recently completed.
    #[error("command {0} is already registered")]
    Duplicate(CommandId),
}

/// Failure to finish or publish feedback for a command lifecycle.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum CommandLifecycleError {
    /// No active or recently completed command has the supplied identity.
    #[error("command {0} is not registered")]
    Unknown(CommandId),
    /// The supplied command already emitted its terminal result.
    #[error("command {0} already reached a terminal state")]
    AlreadyFinished(CommandId),
    /// A command attempted to declare zero work or change its expectation after progress.
    #[error("command {0} has an invalid delegated completion expectation")]
    InvalidCompletionExpectation(CommandId),
    /// More outcomes arrived than the command declared before dispatch.
    #[error("command {0} received more operation results than expected")]
    UnexpectedCompletion(CommandId),
}

/// Tracks active and completed commands for exact-once result enforcement.
#[derive(Default, Resource)]
pub struct CommandTracker {
    active: HashMap<CommandId, ActiveCommand>,
    completed: HashSet<CommandId>,
    completed_order: VecDeque<CommandId>,
}

/// Maximum number of terminal identities retained to reject delayed duplicates.
const COMPLETED_COMMAND_RETENTION: usize = 4_096;

impl CommandTracker {
    /// Registers a command before domain deserialization or dispatch begins.
    pub fn register<T>(
        &mut self,
        envelope: &CommandEnvelope<T>,
    ) -> Result<(), CommandRegistrationError> {
        self.register_context(
            envelope.command_id,
            envelope.undo_id,
            envelope.origin.clone(),
            envelope.reply_target.clone(),
        )
    }

    /// Registers command context parsed by an ingress adapter before its payload is typed.
    pub fn register_context(
        &mut self,
        command_id: CommandId,
        undo_id: UndoId,
        origin: CommandOrigin,
        reply_target: ReplyTarget,
    ) -> Result<(), CommandRegistrationError> {
        if self.active.contains_key(&command_id) || self.completed.contains(&command_id) {
            return Err(CommandRegistrationError::Duplicate(command_id));
        }

        self.active.insert(
            command_id,
            ActiveCommand {
                client_connection: None,
                undo_id,
                origin,
                reply_target,
                started_at: Instant::now(),
                expected_completions: 1,
                received_completions: 0,
                successful_completions: 0,
                first_error: None,
                success_outputs: Vec::new(),
            },
        );
        Ok(())
    }

    /// Attaches trusted host context to a command after successful identity registration.
    pub(crate) fn attach_client_connection(
        &mut self,
        command_id: CommandId,
        connection: Option<crate::client_bridge::ClientConnection>,
    ) {
        if let Some(command) = self.active.get_mut(&command_id) {
            command.client_connection = connection;
        }
    }

    /// Returns whether the supplied command is currently awaiting a terminal result.
    pub fn is_active(&self, command_id: CommandId) -> bool {
        self.active.contains_key(&command_id)
    }

    /// Returns the number of commands currently awaiting terminal results.
    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    /// Returns active command context for workflow diagnostics.
    pub fn active_command(&self, command_id: CommandId) -> Option<&ActiveCommand> {
        self.active.get(&command_id)
    }

    /// Sets how many delegated operation outcomes complete one accepted command.
    pub fn expect_completions(
        &mut self,
        command_id: CommandId,
        expected_completions: usize,
    ) -> Result<(), CommandLifecycleError> {
        let Some(command) = self.active.get_mut(&command_id) else {
            if self.completed.contains(&command_id) {
                return Err(CommandLifecycleError::AlreadyFinished(command_id));
            }
            return Err(CommandLifecycleError::Unknown(command_id));
        };
        if expected_completions == 0 || command.received_completions != 0 {
            return Err(CommandLifecycleError::InvalidCompletionExpectation(
                command_id,
            ));
        }
        command.expected_completions = expected_completions;
        command.success_outputs.reserve(expected_completions);
        Ok(())
    }

    /// Adds planner-produced work to a command's delegated completion join.
    pub fn add_expected_completions(
        &mut self,
        command_id: CommandId,
        additional_completions: usize,
    ) -> Result<(), CommandLifecycleError> {
        let Some(command) = self.active.get_mut(&command_id) else {
            if self.completed.contains(&command_id) {
                return Err(CommandLifecycleError::AlreadyFinished(command_id));
            }
            return Err(CommandLifecycleError::Unknown(command_id));
        };
        if command.received_completions != 0 {
            return Err(CommandLifecycleError::InvalidCompletionExpectation(
                command_id,
            ));
        }
        command.expected_completions = command
            .expected_completions
            .saturating_add(additional_completions);
        command.success_outputs.reserve(additional_completions);
        Ok(())
    }

    /// Records one delegated success and returns a terminal fact when all work has succeeded.
    pub fn record_success(
        &mut self,
        command_id: CommandId,
        output: Option<CommandOutput>,
    ) -> Result<Option<FinishedCommand>, CommandLifecycleError> {
        let Some(command) = self.active.get_mut(&command_id) else {
            if self.completed.contains(&command_id) {
                return Err(CommandLifecycleError::AlreadyFinished(command_id));
            }
            return Err(CommandLifecycleError::Unknown(command_id));
        };
        command.received_completions += 1;
        command.successful_completions += 1;
        command.success_outputs.push(output);
        if command.received_completions < command.expected_completions {
            return Ok(None);
        }
        if command.received_completions > command.expected_completions {
            return Err(CommandLifecycleError::UnexpectedCompletion(command_id));
        }
        if let Some(error) = command.first_error.clone() {
            return self
                .finish(command_id, CommandOutcome::failed(error))
                .map(Some);
        }

        let outcome = if command.expected_completions == 1 {
            match command.success_outputs.pop().flatten() {
                Some(output) => CommandOutcome::with_output(output),
                None => CommandOutcome::succeeded(),
            }
        } else if command.success_outputs.iter().all(Option::is_none) {
            CommandOutcome::succeeded()
        } else {
            CommandOutcome::with_output(CommandOutput {
                value: serde_json::Value::Array(
                    command
                        .success_outputs
                        .iter()
                        .map(|output| {
                            output
                                .as_ref()
                                .map(|output| output.value.clone())
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect(),
                ),
            })
        };
        self.finish(command_id, outcome).map(Some)
    }

    /// Records one delegated failure and returns a terminal fact after all work settles.
    pub fn record_failure(
        &mut self,
        command_id: CommandId,
        error: CommandError,
    ) -> Result<Option<FinishedCommand>, CommandLifecycleError> {
        let Some(command) = self.active.get_mut(&command_id) else {
            if self.completed.contains(&command_id) {
                return Err(CommandLifecycleError::AlreadyFinished(command_id));
            }
            return Err(CommandLifecycleError::Unknown(command_id));
        };
        command.received_completions += 1;
        if command.first_error.is_none() {
            command.first_error = Some(error);
        }
        if command.received_completions < command.expected_completions {
            return Ok(None);
        }
        if command.received_completions > command.expected_completions {
            return Err(CommandLifecycleError::UnexpectedCompletion(command_id));
        }
        let error = command
            .first_error
            .clone()
            .expect("recorded failure should retain its error");
        self.finish(command_id, CommandOutcome::failed(error))
            .map(Some)
    }

    /// Transitions an active command to its single terminal result.
    pub fn finish(
        &mut self,
        command_id: CommandId,
        outcome: CommandOutcome,
    ) -> Result<FinishedCommand, CommandLifecycleError> {
        let Some(command) = self.active.remove(&command_id) else {
            if self.completed.contains(&command_id) {
                return Err(CommandLifecycleError::AlreadyFinished(command_id));
            }
            return Err(CommandLifecycleError::Unknown(command_id));
        };

        self.completed.insert(command_id);
        self.completed_order.push_back(command_id);
        while self.completed_order.len() > COMPLETED_COMMAND_RETENTION {
            if let Some(expired_command_id) = self.completed_order.pop_front() {
                self.completed.remove(&expired_command_id);
            }
        }
        let commit_undo_group = matches!(outcome, CommandOutcome::Succeeded { .. })
            || command.successful_completions > 0;
        Ok(FinishedCommand {
            command_id,
            command,
            outcome,
            commit_undo_group,
        })
    }

    /// Verifies that a non-terminal notice targets an active command.
    pub fn verify_active(&self, command_id: CommandId) -> Result<(), CommandLifecycleError> {
        if self.active.contains_key(&command_id) {
            return Ok(());
        }
        if self.completed.contains(&command_id) {
            return Err(CommandLifecycleError::AlreadyFinished(command_id));
        }
        Err(CommandLifecycleError::Unknown(command_id))
    }
}

/// Finishes one command from an exclusive-world adapter while preserving responder invariants.
pub fn finish_command_in_world(
    world: &mut World,
    command_id: CommandId,
    outcome: CommandOutcome,
) -> Result<(), CommandLifecycleError> {
    let finished = world
        .resource_mut::<CommandTracker>()
        .finish(command_id, outcome)?;
    let result = CommandResult {
        command_id: finished.command_id,
        outcome: finished.outcome.clone(),
    };
    world.write_message(result.clone());
    world.write_message(CommandReply {
        result,
        reply_target: finished.command.reply_target.clone(),
    });
    world.write_message(finished);
    Ok(())
}

/// Bevy system parameter for publishing terminal results and non-terminal notices.
///
/// The responder atomically transitions the command tracker and publishes the
/// admitted terminal result. This keeps exact-once enforcement independent of
/// any transport adapter that later forwards the result.
#[derive(SystemParam)]
pub struct CommandResponder<'w> {
    tracker: ResMut<'w, CommandTracker>,
    results: MessageWriter<'w, CommandResult>,
    replies: MessageWriter<'w, CommandReply>,
    finished_commands: MessageWriter<'w, FinishedCommand>,
    notices: MessageWriter<'w, CommandNotice>,
}

impl CommandResponder<'_> {
    /// Reads trusted connection context before completing the command.
    pub fn client_connection(
        &self,
        command_id: CommandId,
    ) -> Option<crate::client_bridge::ClientConnection> {
        self.tracker
            .active
            .get(&command_id)
            .and_then(|command| command.client_connection.clone())
    }

    /// Registers a short-lived lifecycle for internally initiated work that must publish a result.
    pub fn register_context(
        &mut self,
        command_id: CommandId,
        undo_id: UndoId,
        origin: CommandOrigin,
        reply_target: ReplyTarget,
    ) -> Result<(), CommandRegistrationError> {
        self.tracker
            .register_context(command_id, undo_id, origin, reply_target)
    }

    /// Returns whether a command is currently awaiting a terminal outcome.
    pub fn is_active(&self, command_id: CommandId) -> bool {
        self.tracker.is_active(command_id)
    }

    /// Declares how many delegated outcomes must be joined before completion.
    pub fn expect_completions(
        &mut self,
        command_id: CommandId,
        expected_completions: usize,
    ) -> Result<(), CommandLifecycleError> {
        self.tracker
            .expect_completions(command_id, expected_completions)
    }

    /// Adds planner-produced operations to an existing delegated completion join.
    pub fn add_expected_completions(
        &mut self,
        command_id: CommandId,
        additional_completions: usize,
    ) -> Result<(), CommandLifecycleError> {
        self.tracker
            .add_expected_completions(command_id, additional_completions)
    }

    /// Publishes successful terminal status for an active command.
    pub fn succeed(&mut self, command_id: CommandId) -> Result<(), CommandLifecycleError> {
        if let Some(finished) = self.tracker.record_success(command_id, None)? {
            self.publish_finished(finished);
        }
        Ok(())
    }

    /// Publishes successful terminal status containing typed domain output.
    pub fn succeed_with_output<T: serde::Serialize>(
        &mut self,
        command_id: CommandId,
        output: T,
    ) -> Result<(), CommandLifecycleError> {
        match CommandOutput::from_serializable(output) {
            Ok(output) => {
                if let Some(finished) = self.tracker.record_success(command_id, Some(output))? {
                    self.publish_finished(finished);
                }
                Ok(())
            }
            Err(error) => {
                tracing::error!(%command_id, %error, "command_output_serialization_failed");
                self.fail(
                    command_id,
                    CommandError::new(
                        "engine.output_serialization_failed",
                        "The command completed but its result could not be serialized",
                    ),
                )
            }
        }
    }

    /// Records a delegated failure and publishes it after declared sibling work settles.
    pub fn fail(
        &mut self,
        command_id: CommandId,
        error: CommandError,
    ) -> Result<(), CommandLifecycleError> {
        if let Some(finished) = self.tracker.record_failure(command_id, error)? {
            self.publish_finished(finished);
        }
        Ok(())
    }

    /// Publishes an immediate failure after canceling every outstanding operation.
    pub fn fail_immediately(
        &mut self,
        command_id: CommandId,
        error: CommandError,
    ) -> Result<(), CommandLifecycleError> {
        self.finish(command_id, CommandOutcome::failed(error))
    }

    /// Publishes non-terminal operator feedback for an active command.
    pub fn notice(
        &mut self,
        command_id: CommandId,
        level: NoticeLevel,
        message: impl Into<String>,
    ) -> Result<(), CommandLifecycleError> {
        self.tracker.verify_active(command_id)?;
        self.notices.write(CommandNotice {
            command_id,
            level,
            message: message.into(),
        });
        Ok(())
    }

    /// Admits and publishes one terminal outcome for an active command.
    fn finish(
        &mut self,
        command_id: CommandId,
        outcome: CommandOutcome,
    ) -> Result<(), CommandLifecycleError> {
        let finished = self.tracker.finish(command_id, outcome)?;
        self.publish_finished(finished);
        Ok(())
    }

    /// Publishes messages derived from one exact-once tracker transition.
    fn publish_finished(&mut self, finished: FinishedCommand) {
        let result = CommandResult {
            command_id: finished.command_id,
            outcome: finished.outcome.clone(),
        };
        self.results.write(result.clone());
        self.replies.write(CommandReply {
            result,
            reply_target: finished.command.reply_target.clone(),
        });
        self.finished_commands.write(finished);
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::system::SystemState;

    use super::*;
    use crate::prelude::{CommandError, CommandOrigin, ReplyTarget};

    /// Creates a representative tracked Web UI command for lifecycle tests.
    fn command() -> CommandEnvelope<&'static str> {
        CommandEnvelope::new(
            "store cue",
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        )
    }

    /// Verifies that one registered command can emit exactly one terminal result.
    #[test]
    fn command_can_finish_exactly_once() {
        let mut tracker = CommandTracker::default();
        let command = command();
        tracker.register(&command).unwrap();

        let finished = tracker
            .finish(command.command_id, CommandOutcome::succeeded())
            .unwrap();

        assert_eq!(finished.command_id, command.command_id);
        assert_eq!(finished.command.undo_id, command.undo_id);
        assert!(matches!(
            tracker.finish(command.command_id, CommandOutcome::succeeded()),
            Err(CommandLifecycleError::AlreadyFinished(id)) if id == command.command_id
        ));
    }

    /// Verifies that duplicate ingress identity is rejected before dispatch.
    #[test]
    fn duplicate_command_registration_is_rejected() {
        let mut tracker = CommandTracker::default();
        let command = command();

        tracker.register(&command).unwrap();

        assert_eq!(
            tracker.register(&command),
            Err(CommandRegistrationError::Duplicate(command.command_id))
        );
    }

    /// Verifies planner fan-out delays terminal success until every action reports.
    #[test]
    fn additional_completions_extend_the_existing_join() {
        let mut tracker = CommandTracker::default();
        let command = command();
        tracker.register(&command).unwrap();
        tracker
            .add_expected_completions(command.command_id, 1)
            .unwrap();

        assert!(
            tracker
                .record_success(command.command_id, None)
                .unwrap()
                .is_none()
        );
        assert!(
            tracker
                .record_success(command.command_id, None)
                .unwrap()
                .is_some()
        );
    }

    /// Verifies terminal identity tombstones remain bounded in long-running sessions.
    #[test]
    fn completed_identity_retention_is_bounded() {
        let mut tracker = CommandTracker::default();
        let first = command();
        let first_id = first.command_id;
        tracker.register(&first).unwrap();
        tracker
            .finish(first_id, CommandOutcome::succeeded())
            .unwrap();

        for _ in 0..COMPLETED_COMMAND_RETENTION {
            let command = command();
            tracker.register(&command).unwrap();
            tracker
                .finish(command.command_id, CommandOutcome::succeeded())
                .unwrap();
        }

        assert_eq!(tracker.completed.len(), COMPLETED_COMMAND_RETENTION);
        assert!(!tracker.completed.contains(&first_id));
    }

    /// Verifies that notices cannot target unknown or already completed commands.
    #[test]
    fn notice_target_must_be_active() {
        let mut tracker = CommandTracker::default();
        let command = command();

        assert_eq!(
            tracker.verify_active(command.command_id),
            Err(CommandLifecycleError::Unknown(command.command_id))
        );

        tracker.register(&command).unwrap();
        assert_eq!(tracker.verify_active(command.command_id), Ok(()));

        tracker
            .finish(
                command.command_id,
                CommandOutcome::failed(CommandError::new("test", "failed")),
            )
            .unwrap();
        assert_eq!(
            tracker.verify_active(command.command_id),
            Err(CommandLifecycleError::AlreadyFinished(command.command_id))
        );
    }

    /// Verifies that completed identities remain protected from later reuse.
    #[test]
    fn completed_identity_cannot_be_reused() {
        let mut tracker = CommandTracker::default();
        let first = command();
        let second = command();
        tracker.register(&first).unwrap();
        tracker
            .finish(first.command_id, CommandOutcome::succeeded())
            .unwrap();
        tracker.register(&second).unwrap();
        tracker
            .finish(second.command_id, CommandOutcome::succeeded())
            .unwrap();

        assert_eq!(
            tracker.verify_active(first.command_id),
            Err(CommandLifecycleError::AlreadyFinished(first.command_id))
        );
        assert_eq!(
            tracker.verify_active(second.command_id),
            Err(CommandLifecycleError::AlreadyFinished(second.command_id))
        );
        assert_eq!(
            tracker.register(&first),
            Err(CommandRegistrationError::Duplicate(first.command_id))
        );
    }

    /// Verifies that a command expanded into multiple operations succeeds only after every report.
    #[test]
    fn delegated_successes_join_before_terminal_result() {
        let mut tracker = CommandTracker::default();
        let command = command();
        tracker.register(&command).unwrap();
        tracker.expect_completions(command.command_id, 2).unwrap();

        assert!(
            tracker
                .record_success(command.command_id, None)
                .unwrap()
                .is_none()
        );
        assert!(tracker.is_active(command.command_id));

        let finished = tracker
            .record_success(command.command_id, None)
            .unwrap()
            .expect("second delegated success should finish the command");
        assert_eq!(finished.outcome, CommandOutcome::succeeded());
        assert!(finished.commit_undo_group);
        assert!(!tracker.is_active(command.command_id));
    }

    /// Verifies that multi-operation output preserves one ordered slot per delegated operation.
    #[test]
    fn delegated_outputs_are_aggregated_in_report_order() {
        let mut tracker = CommandTracker::default();
        let command = command();
        tracker.register(&command).unwrap();
        tracker.expect_completions(command.command_id, 2).unwrap();
        let output = CommandOutput::from_serializable("first").unwrap();

        tracker
            .record_success(command.command_id, Some(output))
            .unwrap();
        let finished = tracker
            .record_success(command.command_id, None)
            .unwrap()
            .unwrap();

        assert_eq!(
            finished.outcome,
            CommandOutcome::with_output(CommandOutput {
                value: serde_json::json!(["first", null]),
            })
        );
    }

    /// Verifies that an early failure waits for siblings and retains their undo group.
    #[test]
    fn delegated_failure_joins_before_terminal_result() {
        let mut tracker = CommandTracker::default();
        let command = command();
        tracker.register(&command).unwrap();
        tracker.expect_completions(command.command_id, 2).unwrap();

        assert!(
            tracker
                .record_failure(
                    command.command_id,
                    CommandError::new("operation.failed", "failed"),
                )
                .unwrap()
                .is_none()
        );
        assert!(tracker.is_active(command.command_id));

        let finished = tracker
            .record_success(command.command_id, None)
            .unwrap()
            .expect("the sibling outcome should settle the failed command");

        assert_eq!(
            finished.outcome,
            CommandOutcome::failed(CommandError::new("operation.failed", "failed"))
        );
        assert!(finished.commit_undo_group);
        assert!(!tracker.is_active(command.command_id));
        assert!(matches!(
            tracker.record_failure(
                command.command_id,
                CommandError::new("late.failed", "late"),
            ),
            Err(CommandLifecycleError::AlreadyFinished(id)) if id == command.command_id
        ));
    }

    /// Verifies that the responder rejects result publication for untracked identity.
    #[test]
    fn responder_requires_active_command() {
        let mut world = World::new();
        world.init_resource::<CommandTracker>();
        world.init_resource::<Messages<CommandResult>>();
        world.init_resource::<Messages<CommandReply>>();
        world.init_resource::<Messages<FinishedCommand>>();
        world.init_resource::<Messages<CommandNotice>>();
        let mut state = SystemState::<CommandResponder>::new(&mut world);
        let command_id = CommandId::new();

        let result = state.get_mut(&mut world).unwrap().succeed(command_id);

        assert_eq!(result, Err(CommandLifecycleError::Unknown(command_id)));
        state.apply(&mut world);
        assert!(
            world
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .next()
                .is_none()
        );
    }

    /// Verifies that responder completion updates the tracker before publishing a result.
    #[test]
    fn responder_finishes_and_publishes_atomically() {
        let mut world = World::new();
        world.init_resource::<CommandTracker>();
        world.init_resource::<Messages<CommandResult>>();
        world.init_resource::<Messages<CommandReply>>();
        world.init_resource::<Messages<FinishedCommand>>();
        world.init_resource::<Messages<CommandNotice>>();
        let command = command();
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .unwrap();
        let mut state = SystemState::<CommandResponder>::new(&mut world);

        state
            .get_mut(&mut world)
            .unwrap()
            .succeed(command.command_id)
            .unwrap();
        state.apply(&mut world);

        assert!(
            !world
                .resource::<CommandTracker>()
                .is_active(command.command_id)
        );
        let results = world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command.command_id);
        assert_eq!(results[0].outcome, CommandOutcome::succeeded());
        let reply = world
            .resource_mut::<Messages<CommandReply>>()
            .drain()
            .next()
            .expect("responder should publish one routed reply");
        assert_eq!(reply.result, results[0]);
        assert_eq!(reply.reply_target, ReplyTarget::ClientBroadcast);
        let finished = world
            .resource_mut::<Messages<FinishedCommand>>()
            .drain()
            .next()
            .expect("responder should publish the internal lifecycle fact");
        assert_eq!(finished.command_id, command.command_id);
        assert_eq!(finished.command.undo_id, command.undo_id);
    }
}
