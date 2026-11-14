// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::VecDeque;

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemState;
use nightfall_engine::prelude::*;
use web_time::Instant;

use crate::commands::UndoCommand;
use crate::context::UndoContext;
use crate::dispatcher::{UndoRegistry, UndoReplay, UndoReplayContext};
use crate::manager::{RedoGroup, UndoEntry, UndoGroup, UndoManager};

/// System state read by [`handle_undo_commands`]: new history commands, and finished
/// commands so replay steps learn their outcome.
pub type UndoCommandReaders = (
    MessageReader<'static, 'static, CommandEnvelope<UndoCommand>>,
    MessageReader<'static, 'static, FinishedCommand>,
);

/// The history group an in-flight replay took off its stack, with its entries moved into the
/// replay's step lists.
enum ReplaySource {
    /// An undo replaying an undo group; its captured inverses become a redo group.
    Undo(UndoGroup),
    /// A redo replaying a redo group; its captured inverses become an undo group.
    Redo(RedoGroup),
}

impl ReplaySource {
    /// Returns the group being replayed.
    fn group(&self) -> &UndoGroup {
        match self {
            ReplaySource::Undo(group) => group,
            ReplaySource::Redo(redo) => &redo.group,
        }
    }
}

/// The entry whose replay is running as its own tracked step command.
struct InFlightStep {
    entry: UndoEntry,
    /// Inverse captured just before the step was queued.
    inverse: UndoEntry,
    step_id: CommandId,
    /// Outcome of the step command, once it has finished.
    outcome: Option<CommandOutcome>,
}

/// An undo or redo that replays its group one entry at a time.
///
/// Each entry's inverse is captured right before that entry replays, against the state the
/// earlier entries left behind. A group that creates an object and then deletes or renames it
/// therefore reverses, where capturing every inverse against the state before the first replay
/// would look up an object that doesn't exist yet. The captured inverses are kept in replay
/// order, which is the order that, replayed backwards by the next undo or redo, reverses this
/// replay.
///
/// Every entry replays as its own step command, registered as a replay under the undo or redo
/// command's undo group. Handlers that split their work into several operations can then
/// track it as usual, and the undo or redo command finishes once, when the replay settles.
struct HistoryReplay {
    command_id: CommandId,
    undo_id: UndoId,
    origin: CommandOrigin,
    /// History generation the group was taken from; a clear in between abandons the replay.
    generation: u64,
    source: ReplaySource,
    /// Entries still to replay, in stored order. Replay walks a group backwards, so the next
    /// step is always the last one.
    pending: Vec<UndoEntry>,
    in_flight: Option<InFlightStep>,
    /// Entries whose replay succeeded, in replay order.
    replayed: Vec<UndoEntry>,
    /// Inverses of `replayed`, in replay order.
    captured: Vec<UndoEntry>,
}

/// Undo, redo and clear-history commands in the order they arrived, with the replay that is
/// currently stepping through its group.
///
/// Commands wait in the queue while a replay is in flight, so a second undo always sees the
/// history the first one left and never interleaves its steps with it. Each queued command
/// keeps the history generation it arrived in, so one sent before a show load doesn't act on
/// the new show's history.
#[derive(Resource, Default)]
pub struct HistoryReplays {
    queued: VecDeque<QueuedReplay>,
    active: Option<HistoryReplay>,
}

/// Which way a queued history command steps.
#[derive(Clone, Copy)]
enum Direction {
    Undo,
    Redo,
}

impl Direction {
    /// Returns the lowercase name used in error codes and messages.
    fn kind(self) -> &'static str {
        match self {
            Direction::Undo => "undo",
            Direction::Redo => "redo",
        }
    }
}

/// An undo or redo command waiting for the replay in flight to settle.
struct QueuedReplay {
    /// History generation when the command arrived.
    generation: u64,
    direction: Direction,
    command_id: CommandId,
    undo_id: UndoId,
    origin: CommandOrigin,
}

impl HistoryReplays {
    /// Moves the active replay forward and starts queued history commands once it settles.
    ///
    /// Stops when a replay is waiting on its step or the queue is empty, so each call does all
    /// the work that the current world state allows.
    fn advance(&mut self, world: &mut World) {
        loop {
            if let Some(replay) = self.active.take() {
                if let Some(waiting) = replay.poll(world) {
                    self.active = Some(waiting);
                    return;
                }
            }
            let Some(queued) = self.queued.pop_front() else {
                return;
            };
            self.active = start_history_command(world, queued);
        }
    }
}

impl HistoryReplay {
    /// Returns the command-error code prefix for this replay's direction.
    fn kind(&self) -> &'static str {
        match self.source {
            ReplaySource::Undo(_) => Direction::Undo.kind(),
            ReplaySource::Redo(_) => Direction::Redo.kind(),
        }
    }

    /// Builds an error for this replay with a `<kind>.<code>` code and a message that names
    /// the group, such as "Cannot undo Store Group 5: ...".
    fn error(&self, code: &str, verb: &str, reason: &str) -> CommandError {
        CommandError::new(
            format!("{}.{code}", self.kind()),
            format!(
                "{verb} {} {}: {reason}",
                self.kind(),
                self.source.group().description
            ),
        )
    }

    /// Checks the step in flight and, when it has succeeded, captures and starts the next one.
    ///
    /// Returns the replay while a step is still running. Returns `None` once the replay has
    /// finished its command: after the last step succeeded, after a step failed, or when the next entry's inverse can't be captured in the current state. Except when
    /// the history was cleared, the history is settled first, so whatever replayed is
    /// reversible and whatever did not stays where it was.
    fn poll(mut self, world: &mut World) -> Option<Self> {
        if world.resource::<UndoManager>().generation() != self.generation {
            let error = self.error(
                "history_cleared",
                "Stopped",
                "the history was cleared while it replayed",
            );
            if world
                .resource::<CommandTracker>()
                .is_active(self.command_id)
            {
                finish_command_in_world(world, self.command_id, CommandOutcome::failed(error))
                    .expect("active history replay should fail once");
            }
            return None;
        }

        if let Some(mut step) = self.in_flight.take() {
            match step.outcome.take() {
                Some(CommandOutcome::Failed(error)) => {
                    self.in_flight = Some(step);
                    return self.fail(world, error);
                }
                Some(_) => {
                    self.replayed.push(step.entry);
                    self.captured.push(step.inverse);
                }
                None => {
                    self.in_flight = Some(step);
                    return Some(self);
                }
            }
        }

        let Some(entry) = self.pending.pop() else {
            let command_id = self.command_id;
            self.settle(world);
            finish_command_in_world(world, command_id, CommandOutcome::succeeded())
                .expect("active history replay should succeed once");
            return None;
        };
        let inverse = entry
            .command
            .inverse(&UndoContext { world })
            .map(|command| UndoEntry {
                command,
                description: entry.description.clone(),
                command_id: None,
                coalesce_key: None,
            });
        let Some(inverse) = inverse else {
            let error = if self.replayed.is_empty() {
                self.error(
                    "state_conflict",
                    "Cannot",
                    "current state conflicts with the saved operation",
                )
            } else {
                self.error(
                    "state_conflict",
                    "Stopped partway through",
                    "current state conflicts with the rest of the saved operation",
                )
            };
            self.pending.push(entry);
            return self.fail(world, error);
        };

        let step_id = CommandId::new();
        let replay = world.resource::<UndoRegistry>().prepare_replay(
            entry.command.as_ref(),
            UndoReplayContext {
                command_id: step_id,
                undo_id: self.undo_id,
            },
        );
        let Some(replay) = replay else {
            let error = self.error(
                "replay_route_missing",
                "Cannot",
                "an inverse operation has no registered replay route",
            );
            self.pending.push(entry);
            return self.fail(world, error);
        };
        let mut tracker = world.resource_mut::<CommandTracker>();
        let macro_statement = tracker.is_macro_statement(self.command_id);
        tracker
            .register_context(
                step_id,
                self.undo_id,
                self.origin.clone(),
                ReplyTarget::Detached,
            )
            .expect("a fresh replay step ID should register");
        tracker.mark_undo_replay(step_id);
        if macro_statement {
            tracker.mark_macro_statement(step_id);
        }
        match replay {
            UndoReplay::LegacyCommand(command) => world.commands().queue(command),
            UndoReplay::EngineOperation(action) => world.commands().queue(action),
        }
        self.in_flight = Some(InFlightStep {
            entry,
            inverse,
            step_id,
            outcome: None,
        });
        Some(self)
    }

    /// Settles the history and fails the undo or redo command with `error`.
    fn fail(self, world: &mut World, error: CommandError) -> Option<Self> {
        let command_id = self.command_id;
        self.settle(world);
        finish_command_in_world(world, command_id, CommandOutcome::failed(error))
            .expect("active history replay should fail once");
        None
    }

    /// Returns the replayed and unreplayed parts of the group to history and ends the replay.
    ///
    /// The inverses captured for entries that replayed form a group on the opposite stack, so
    /// that work can be reversed. Entries that never replayed, including a step that failed,
    /// go back on the stack they came from. A replay that finished every step leaves nothing
    /// behind on its source stack. Edits that finished during the replay are committed after
    /// that.
    fn settle(self, world: &mut World) {
        let HistoryReplay {
            source,
            pending,
            in_flight,
            replayed,
            captured,
            ..
        } = self;
        let mut remainder = pending;
        remainder.extend(in_flight.map(|step| step.entry));
        let reversing = (!captured.is_empty()).then(|| UndoGroup {
            entries: captured,
            description: source.group().description.clone(),
            timestamp: Instant::now(),
            is_gurq_preserved: source.group().is_gurq_preserved,
            undo_id: UndoId::new(),
        });

        let mut manager = world.resource_mut::<UndoManager>();
        match source {
            ReplaySource::Undo(group) => {
                if let Some(reversing) = reversing {
                    manager.push_redo(RedoGroup {
                        group: reversing,
                        undone: UndoGroup {
                            entries: replayed.into_iter().rev().collect(),
                            ..group.clone()
                        },
                    });
                }
                if !remainder.is_empty() {
                    manager.push_undo_group_direct(UndoGroup {
                        entries: remainder,
                        ..group
                    });
                }
            }
            ReplaySource::Redo(RedoGroup { group, mut undone }) => {
                // A redo group's entries are the inverses of its undone group's entries in
                // reverse, so the first `replayed.len()` undone entries belong to the part
                // that replayed and the rest belong to the remainder.
                debug_assert_eq!(
                    undone.entries.len(),
                    replayed.len() + remainder.len(),
                    "a redo group pairs each entry with one undone entry"
                );
                let undone_remainder = undone
                    .entries
                    .split_off(replayed.len().min(undone.entries.len()));
                if let Some(reversing) = reversing {
                    manager.push_undo_group_direct(reversing);
                }
                if !remainder.is_empty() {
                    manager.push_redo(RedoGroup {
                        group: UndoGroup {
                            entries: remainder,
                            ..group
                        },
                        undone: UndoGroup {
                            entries: undone_remainder,
                            ..undone
                        },
                    });
                }
            }
        }
        manager.end_replay();
    }
}

/// Starts one undo, redo or clear-history command and returns the replay it began, if any.
///
/// A command that arrived before the history was last cleared fails instead of acting on the
/// new history. Undo and redo take their group off its stack and check that every entry has a
/// replay route before anything changes.
fn start_history_command(world: &mut World, queued: QueuedReplay) -> Option<HistoryReplay> {
    let QueuedReplay {
        generation,
        direction,
        command_id,
        undo_id,
        origin,
    } = queued;
    let kind = direction.kind();
    if world.resource::<UndoManager>().generation() != generation {
        finish_command_in_world(
            world,
            command_id,
            CommandOutcome::failed(CommandError::new(
                format!("{kind}.history_cleared"),
                format!("Stopped {kind}: the history was cleared before it ran"),
            )),
        )
        .expect("active history command should fail once");
        return None;
    }

    let mut manager = world.resource_mut::<UndoManager>();
    let source = match direction {
        Direction::Undo => manager.pop_undo().map(ReplaySource::Undo),
        Direction::Redo => manager.pop_redo().map(ReplaySource::Redo),
    };
    let Some(mut source) = source else {
        tracing::debug!("Nothing to {kind}");
        finish_command_in_world(
            world,
            command_id,
            CommandOutcome::failed(CommandError::new(
                format!("{kind}.empty_history"),
                format!("Nothing to {kind}"),
            )),
        )
        .expect("active history command should fail once");
        return None;
    };

    tracing::debug!("Executing {kind}: {}", source.group().description);
    let registry = world.resource::<UndoRegistry>();
    let routed = source
        .group()
        .entries
        .iter()
        .all(|entry| registry.has_replay_route(entry.command.as_ref()));
    if !routed {
        let error = CommandError::new(
            format!("{kind}.replay_route_missing"),
            format!(
                "Cannot {kind} {}: an inverse operation has no registered replay route",
                source.group().description
            ),
        );
        let mut manager = world.resource_mut::<UndoManager>();
        match source {
            ReplaySource::Undo(group) => manager.push_undo_group_direct(group),
            ReplaySource::Redo(redo) => manager.push_redo(redo),
        }
        finish_command_in_world(world, command_id, CommandOutcome::failed(error))
            .expect("active history command should fail once");
        return None;
    }

    let pending = match &mut source {
        ReplaySource::Undo(group) => std::mem::take(&mut group.entries),
        ReplaySource::Redo(redo) => std::mem::take(&mut redo.group.entries),
    };
    world.resource_mut::<UndoManager>().begin_replay();
    world
        .resource_mut::<CommandTracker>()
        .mark_undo_replay(command_id);
    Some(HistoryReplay {
        command_id,
        undo_id,
        origin,
        generation,
        source,
        pending,
        in_flight: None,
        replayed: Vec::new(),
        captured: Vec::new(),
    })
}

/// System that handles undo/redo command events.
///
/// Records the outcome of the replay step in flight, queues undo and redo commands, then
/// advances the replay. Undo and redo replay their group one entry per step, so a group of
/// several entries takes several frames, and undo and redo commands that arrive meanwhile wait
/// their turn.
///
/// Clear history runs as soon as it arrives. It stops a replay in flight and fails the undo
/// and redo commands queued before it, so it always works, even while a replay waits on a step.
///
/// This is an exclusive system that uses SystemState to access system parameters
/// while also providing World access for UndoContext.
pub fn handle_undo_commands(world: &mut World, state: &mut SystemState<UndoCommandReaders>) {
    let step_id = world
        .resource::<HistoryReplays>()
        .active
        .as_ref()
        .and_then(|replay| replay.in_flight.as_ref())
        .map(|step| step.step_id);
    let (events, step_outcome) = {
        let (mut events, mut finished) = state
            .get_mut(world)
            .expect("undo command readers should be available while handling undo commands");
        (
            events.read().cloned().collect::<Vec<_>>(),
            finished
                .read()
                .filter(|finished| Some(finished.command_id) == step_id)
                .map(|finished| finished.outcome.clone())
                .last(),
        )
    };

    world.resource_scope(|world, mut replays: Mut<HistoryReplays>| {
        if let Some(outcome) = step_outcome
            && let Some(step) = replays
                .active
                .as_mut()
                .and_then(|replay| replay.in_flight.as_mut())
        {
            step.outcome = Some(outcome);
        }
        for event in events {
            let direction = match event.command {
                UndoCommand::Undo {} => Direction::Undo,
                UndoCommand::Redo {} => Direction::Redo,
                UndoCommand::ClearHistory {} => {
                    tracing::debug!("Clearing undo/redo history");
                    world.resource_mut::<UndoManager>().clear();
                    finish_command_in_world(world, event.command_id, CommandOutcome::succeeded())
                        .expect("active clear-history command should succeed once");
                    continue;
                }
            };
            replays.queued.push_back(QueuedReplay {
                generation: world.resource::<UndoManager>().generation(),
                direction,
                command_id: event.command_id,
                undo_id: event.undo_id,
                origin: event.origin,
            });
        }
        replays.advance(world);
    });
}

/// Commits successful command undo groups and discards groups for failed commands.
pub fn finish_command_undo_groups(
    mut finished_commands: MessageReader<FinishedCommand>,
    mut undo_manager: ResMut<UndoManager>,
) {
    for finished in finished_commands.read() {
        undo_manager.finish_group(finished.command.undo_id, finished.commit_undo_group);
    }
}

/// Finalizes undo groups created by detached actions without a tracked command.
pub fn finalize_detached_undo_groups(mut undo_manager: ResMut<UndoManager>) {
    if !undo_manager.has_detached_groups() {
        return;
    }
    undo_manager.finalize_detached_groups();
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use nightfall_engine::prelude::EnginePayload;

    use super::*;
    use crate::traits::Undoable;

    /// Command whose inverse is unavailable, modeling a state conflict during undo.
    #[derive(Debug, Clone, EnginePayload)]
    struct ConflictingCommand;

    impl Undoable for ConflictingCommand {
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
            None
        }

        fn description(&self) -> String {
            "Conflicting command".to_string()
        }
    }

    /// Keyed values standing in for ID-addressed show objects such as groups.
    #[derive(Resource, Default)]
    struct Objects(HashMap<u32, u32>);

    /// Edits `Objects` the way ID-based show commands do: deleting needs the object to exist
    /// to capture what it restores, so its inverse depends on the state it replays into.
    #[derive(Debug, Clone, EnginePayload, PartialEq)]
    enum ObjectOperation {
        Store { id: u32, value: u32 },
        Delete { id: u32 },
    }

    impl EngineOperation for ObjectOperation {}

    impl Undoable for ObjectOperation {
        /// Restores the earlier value, deletes a newly stored object, and refuses to invert
        /// the delete of an object that doesn't exist.
        fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
            let objects = &ctx.world.resource::<Objects>().0;
            let id = match self {
                ObjectOperation::Store { id, .. } | ObjectOperation::Delete { id } => *id,
            };
            match (self, objects.get(&id)) {
                (_, Some(value)) => Some(Box::new(ObjectOperation::Store { id, value: *value })),
                (ObjectOperation::Store { .. }, None) => {
                    Some(Box::new(ObjectOperation::Delete { id }))
                }
                (ObjectOperation::Delete { .. }, None) => None,
            }
        }

        fn description(&self) -> String {
            "Object edit".to_string()
        }
    }

    /// Builds a world with the undo resources, the object store and the object operation
    /// routed for replay.
    fn replay_world() -> World {
        let mut world = World::new();
        world.init_resource::<UndoManager>();
        world.init_resource::<HistoryReplays>();
        world.init_resource::<UndoRegistry>();
        world.init_resource::<EngineOperationRouter>();
        world.init_resource::<CommandTracker>();
        world.init_resource::<Objects>();
        world.insert_resource(Messages::<CommandEnvelope<UndoCommand>>::default());
        world.insert_resource(Messages::<EngineOperationEnvelope<ObjectOperation>>::default());
        world.insert_resource(Messages::<CommandResult>::default());
        world.insert_resource(Messages::<CommandReply>::default());
        world.insert_resource(Messages::<FinishedCommand>::default());
        world
            .resource_mut::<UndoRegistry>()
            .register_operation::<ObjectOperation>();
        world
            .resource_mut::<EngineOperationRouter>()
            .register::<ObjectOperation>();
        world
    }

    /// Commits `entries` as one undo group, as if a single command had produced them in order.
    fn commit_group(world: &mut World, entries: Vec<Box<dyn Undoable>>) {
        let undo_id = UndoId::new();
        let mut manager = world.resource_mut::<UndoManager>();
        for command in entries {
            manager.push(
                UndoEntry {
                    description: command.description(),
                    command,
                    command_id: None,
                    coalesce_key: None,
                },
                undo_id,
                false,
            );
        }
        manager.finalize_detached_groups();
    }

    /// Registers and sends an undo or redo command, returning its ID.
    fn send(world: &mut World, command: UndoCommand) -> CommandId {
        let command = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = command.command_id;
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("history command should register");
        world
            .resource_mut::<Messages<CommandEnvelope<UndoCommand>>>()
            .write(command);
        command_id
    }

    /// Runs the history system and then applies every queued object replay the way its domain
    /// handler would, finishing its step command with success or failure. `fail_delete` makes
    /// delete replays fail, standing in for a handler that rejects a step.
    fn frame(
        world: &mut World,
        state: &mut SystemState<UndoCommandReaders>,
        fail_delete: bool,
    ) -> Vec<ObjectOperation> {
        handle_undo_commands(world, state);
        world.flush();
        let replays = world
            .resource_mut::<Messages<EngineOperationEnvelope<ObjectOperation>>>()
            .drain()
            .collect::<Vec<_>>();
        for replay in &replays {
            let step_id = replay.command_id.expect("replays carry their step command");
            assert!(
                world.resource::<CommandTracker>().is_undo_replay(step_id),
                "replayed inverses must be recognizable as restores, not new edits",
            );
            let failed = fail_delete && matches!(replay.operation, ObjectOperation::Delete { .. });
            let finished = if failed {
                world
                    .resource_mut::<CommandTracker>()
                    .record_failure(step_id, CommandError::new("test.rejected", "rejected"))
            } else {
                let objects = &mut world.resource_mut::<Objects>().0;
                match replay.operation {
                    ObjectOperation::Store { id, value } => objects.insert(id, value),
                    ObjectOperation::Delete { id } => objects.remove(&id),
                };
                world
                    .resource_mut::<CommandTracker>()
                    .record_success(step_id, None)
            };
            let finished = finished
                .expect("replay step should report")
                .expect("a replay step finishes its own command");
            world.write_message(finished);
        }
        replays.into_iter().map(|replay| replay.operation).collect()
    }

    /// Runs frames until `command_id` finishes and returns its outcome with every replayed
    /// operation in order, checking that no frame ever runs more than one step.
    fn run_until_finished(
        world: &mut World,
        state: &mut SystemState<UndoCommandReaders>,
        command_id: CommandId,
        fail_delete: bool,
    ) -> (CommandOutcome, Vec<ObjectOperation>) {
        let mut replayed = Vec::new();
        for _ in 0..10 {
            let step = frame(world, state, fail_delete);
            assert!(step.len() <= 1, "only one step may be in flight");
            replayed.extend(step);
            let (mut matched, others): (Vec<_>, Vec<_>) = world
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .partition(|result| result.command_id == command_id);
            world
                .resource_mut::<Messages<CommandResult>>()
                .write_batch(others);
            if let Some(result) = matched.pop() {
                return (result.outcome, replayed);
            }
        }
        panic!("history command {command_id} did not finish");
    }

    /// Verifies a conflict on the first entry leaves the undo group available and reports an
    /// error without changing anything.
    #[test]
    fn undo_conflict_preserves_history() {
        let mut world = replay_world();
        world
            .resource_mut::<UndoRegistry>()
            .register::<ConflictingCommand>();
        commit_group(&mut world, vec![Box::new(ConflictingCommand)]);
        let command_id = send(&mut world, UndoCommand::Undo {});
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);

        let (outcome, replayed) = run_until_finished(&mut world, &mut state, command_id, false);

        assert!(matches!(
            outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.state_conflict"
        ));
        assert!(replayed.is_empty());
        let manager = world.resource::<UndoManager>();
        assert_eq!(manager.undo_depth(), 1);
        assert_eq!(manager.redo_depth(), 0);
    }

    /// Verifies a group that stored an object and then deleted it undoes and redoes: each
    /// inverse is captured in the state the earlier steps left, undo replays the newest entry
    /// first, and redo replays the entries in their original order.
    #[test]
    fn create_then_delete_group_undoes_and_redoes_in_order() {
        let mut world = replay_world();
        commit_group(
            &mut world,
            vec![
                Box::new(ObjectOperation::Delete { id: 5 }),
                Box::new(ObjectOperation::Store { id: 5, value: 1 }),
            ],
        );
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);

        let undo = send(&mut world, UndoCommand::Undo {});
        let (outcome, replayed) = run_until_finished(&mut world, &mut state, undo, false);
        assert_eq!(outcome, CommandOutcome::succeeded());
        assert_eq!(
            replayed,
            [
                ObjectOperation::Store { id: 5, value: 1 },
                ObjectOperation::Delete { id: 5 },
            ],
            "undo reverses the newest entry first"
        );
        assert!(world.resource::<Objects>().0.is_empty());

        let redo = send(&mut world, UndoCommand::Redo {});
        let (outcome, replayed) = run_until_finished(&mut world, &mut state, redo, false);
        assert_eq!(outcome, CommandOutcome::succeeded());
        assert_eq!(
            replayed,
            [
                ObjectOperation::Store { id: 5, value: 1 },
                ObjectOperation::Delete { id: 5 },
            ],
            "redo repeats the original edits in the order they first ran"
        );
        assert!(world.resource::<Objects>().0.is_empty());

        let undo = send(&mut world, UndoCommand::Undo {});
        let (outcome, _) = run_until_finished(&mut world, &mut state, undo, false);
        assert_eq!(outcome, CommandOutcome::succeeded());
        let manager = world.resource::<UndoManager>();
        assert_eq!((manager.undo_depth(), manager.redo_depth()), (0, 1));
    }

    /// Verifies a step that fails partway through an undo keeps the history consistent: the
    /// entries that replayed move to redo, and the failed and unreplayed entries stay on top
    /// of the undo stack.
    #[test]
    fn failed_step_splits_group_between_undo_and_redo() {
        let mut world = replay_world();
        world.resource_mut::<Objects>().0.insert(5, 2);
        commit_group(
            &mut world,
            vec![
                Box::new(ObjectOperation::Delete { id: 5 }),
                Box::new(ObjectOperation::Store { id: 6, value: 3 }),
            ],
        );
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);

        let undo = send(&mut world, UndoCommand::Undo {});
        let (outcome, replayed) = run_until_finished(&mut world, &mut state, undo, true);

        assert!(matches!(
            outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "test.rejected"
        ));
        assert_eq!(replayed.len(), 2);
        assert_eq!(
            world.resource::<Objects>().0,
            HashMap::from([(5, 2), (6, 3)])
        );
        let manager = world.resource::<UndoManager>();
        let undo_top = manager
            .peek_undo()
            .expect("unreplayed entry stays undoable");
        assert_eq!(undo_top.entries.len(), 1);
        let redo_top = manager
            .peek_redo()
            .expect("replayed entry becomes redoable");
        assert_eq!(redo_top.entries.len(), 1);
    }

    /// Verifies an undo sent while another undo is still replaying waits for it, then undoes
    /// the next older group.
    #[test]
    fn undo_waits_for_the_replay_in_flight() {
        let mut world = replay_world();
        commit_group(
            &mut world,
            vec![Box::new(ObjectOperation::Store { id: 1, value: 1 })],
        );
        commit_group(
            &mut world,
            vec![
                Box::new(ObjectOperation::Delete { id: 2 }),
                Box::new(ObjectOperation::Delete { id: 3 }),
            ],
        );
        world
            .resource_mut::<Objects>()
            .0
            .extend([(1, 9), (2, 2), (3, 3)]);
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);

        let first = send(&mut world, UndoCommand::Undo {});
        let second = send(&mut world, UndoCommand::Undo {});
        let (outcome, mut replayed) = run_until_finished(&mut world, &mut state, first, false);
        assert_eq!(outcome, CommandOutcome::succeeded());
        let (outcome, more) = run_until_finished(&mut world, &mut state, second, false);
        assert_eq!(outcome, CommandOutcome::succeeded());
        replayed.extend(more);

        assert_eq!(
            replayed,
            [
                ObjectOperation::Delete { id: 3 },
                ObjectOperation::Delete { id: 2 },
                ObjectOperation::Store { id: 1, value: 1 },
            ]
        );
        assert_eq!(world.resource::<UndoManager>().redo_depth(), 2);
    }

    /// Verifies an edit that finishes while an undo is replaying lands after the undo's redo
    /// group, so the usual rule applies: the new edit moves the undone work back into history
    /// instead of leaving it redoable over the newer change.
    #[test]
    fn edit_during_replay_commits_after_the_replay() {
        let mut world = replay_world();
        world.resource_mut::<Objects>().0.extend([(2, 2), (3, 3)]);
        commit_group(
            &mut world,
            vec![
                Box::new(ObjectOperation::Delete { id: 2 }),
                Box::new(ObjectOperation::Delete { id: 3 }),
            ],
        );
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);
        let undo = send(&mut world, UndoCommand::Undo {});
        frame(&mut world, &mut state, false);

        commit_group(
            &mut world,
            vec![Box::new(ObjectOperation::Delete { id: 9 })],
        );
        assert_eq!(
            world.resource::<UndoManager>().undo_depth(),
            0,
            "the edit waits for the replay to settle"
        );
        let (outcome, _) = run_until_finished(&mut world, &mut state, undo, false);

        assert_eq!(outcome, CommandOutcome::succeeded());
        let manager = world.resource::<UndoManager>();
        assert_eq!(manager.redo_depth(), 0, "the new edit ends the redo branch");
        let preserved = manager
            .undo_stack()
            .map(|group| group.is_gurq_preserved)
            .collect::<Vec<_>>();
        assert_eq!(preserved, [false, true, false]);
    }

    /// Verifies an undo still replaying when the history is cleared, as a show load does,
    /// stops with an error and writes nothing into the new history, and that an undo queued
    /// behind it doesn't act on the new history either.
    #[test]
    fn clearing_history_stops_the_replay_in_flight() {
        let mut world = replay_world();
        world.resource_mut::<Objects>().0.extend([(2, 2), (3, 3)]);
        commit_group(
            &mut world,
            vec![
                Box::new(ObjectOperation::Delete { id: 2 }),
                Box::new(ObjectOperation::Delete { id: 3 }),
            ],
        );
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);
        let undo = send(&mut world, UndoCommand::Undo {});
        let queued = send(&mut world, UndoCommand::Undo {});
        frame(&mut world, &mut state, false);

        world.resource_mut::<UndoManager>().clear();
        commit_group(
            &mut world,
            vec![Box::new(ObjectOperation::Store { id: 7, value: 7 })],
        );
        let (outcome, replayed) = run_until_finished(&mut world, &mut state, undo, false);
        assert!(matches!(
            outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.history_cleared"
        ));
        assert!(replayed.is_empty(), "no step may run after the clear");
        let (outcome, replayed) = run_until_finished(&mut world, &mut state, queued, false);
        assert!(matches!(
            outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.history_cleared"
        ));
        assert!(replayed.is_empty());

        let manager = world.resource::<UndoManager>();
        assert_eq!((manager.undo_depth(), manager.redo_depth()), (1, 0));
    }

    /// Verifies clear history runs at once even while a replay waits on a step that never
    /// reports, stops that replay, and lets a later undo run against the cleared history.
    #[test]
    fn clear_history_releases_a_stuck_replay() {
        let mut world = replay_world();
        world.resource_mut::<Objects>().0.insert(3, 3);
        commit_group(
            &mut world,
            vec![Box::new(ObjectOperation::Delete { id: 3 })],
        );
        let mut state = SystemState::<UndoCommandReaders>::new(&mut world);
        let undo = send(&mut world, UndoCommand::Undo {});
        handle_undo_commands(&mut world, &mut state);
        world.flush();
        world
            .resource_mut::<Messages<EngineOperationEnvelope<ObjectOperation>>>()
            .clear();

        handle_undo_commands(&mut world, &mut state);
        assert!(world.resource::<CommandTracker>().is_active(undo));

        let clear = send(&mut world, UndoCommand::ClearHistory {});
        let later = send(&mut world, UndoCommand::Undo {});
        handle_undo_commands(&mut world, &mut state);

        let results = world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .map(|result| (result.command_id, result.outcome))
            .collect::<HashMap<_, _>>();
        assert_eq!(results[&clear], CommandOutcome::succeeded());
        assert!(matches!(
            results[&undo],
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.history_cleared"
        ));
        assert!(matches!(
            results[&later],
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.empty_history"
        ));
    }
}
