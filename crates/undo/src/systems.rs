// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemState;
use nightfall_engine::prelude::*;

use crate::commands::UndoCommand;
use crate::context::UndoContext;
use crate::dispatcher::{UndoRegistry, UndoReplay, UndoReplayContext};
use crate::manager::{UndoEntry, UndoGroup, UndoManager};

/// Builds inverse history entries only when every command in a group is valid in current state.
fn generate_inverse_entries(world: &World, group: &UndoGroup) -> Option<Vec<UndoEntry>> {
    let undo_ctx = UndoContext { world };
    group
        .entries
        .iter()
        .map(|entry| {
            entry.command.inverse(&undo_ctx).map(|inverse| UndoEntry {
                command: inverse,
                description: entry.description.clone(),
                command_id: None,
            })
        })
        .collect()
}

/// Rebuilds every stored inverse through the replay route registered by its owning domain.
fn prepare_group_replays(
    world: &World,
    group: &UndoGroup,
    command_id: CommandId,
    undo_id: UndoId,
) -> Option<Vec<UndoReplay>> {
    let registry = world.resource::<UndoRegistry>();
    group
        .entries
        .iter()
        .rev()
        .map(|entry| {
            registry.prepare_replay(
                entry.command.as_ref(),
                UndoReplayContext {
                    command_id,
                    undo_id,
                },
            )
        })
        .collect()
}

/// Queues prepared inverses at their registered command or engine-action boundary.
fn queue_group_replays(world: &mut World, replays: Vec<UndoReplay>) {
    for replay in replays {
        match replay {
            UndoReplay::LegacyCommand(command) => world.commands().queue(command),
            UndoReplay::EngineAction(action) => world.commands().queue(action),
        }
    }
}

/// System that handles undo/redo command events.
///
/// Reads UndoCommand events and executes the appropriate undo/redo operations.
///
/// This is an exclusive system that uses SystemState to access system parameters
/// while also providing World access for UndoContext.
pub fn handle_undo_commands(
    world: &mut World,
    state: &mut SystemState<MessageReader<CommandEnvelope<UndoCommand>>>,
) {
    // Collect all events first before processing
    let events_to_process: Vec<CommandEnvelope<UndoCommand>> = {
        let mut events = state
            .get_mut(world)
            .expect("undo command reader should be available while handling undo commands");
        events.read().cloned().collect()
    };

    // Process each event
    for event in events_to_process {
        match &event.command {
            UndoCommand::Undo {} => {
                let group_opt = world.resource_mut::<UndoManager>().pop_undo();

                if let Some(group) = group_opt {
                    tracing::debug!("Executing undo: {}", group.description);

                    // Generate redo entries from the inverse commands
                    let Some(redo_entries) = generate_inverse_entries(world, &group) else {
                        let description = group.description.clone();
                        world
                            .resource_mut::<UndoManager>()
                            .push_undo_group_direct(group);
                        finish_command_in_world(
                            world,
                            event.command_id,
                            CommandOutcome::failed(CommandError::new(
                                "undo.state_conflict",
                                format!(
                                    "Cannot undo {description}: current state conflicts with the saved operation"
                                ),
                            )),
                        )
                        .expect("active undo command should fail once");
                        continue;
                    };

                    let Some(replays) =
                        prepare_group_replays(world, &group, event.command_id, event.undo_id)
                    else {
                        let description = group.description.clone();
                        world
                            .resource_mut::<UndoManager>()
                            .push_undo_group_direct(group);
                        finish_command_in_world(
                            world,
                            event.command_id,
                            CommandOutcome::failed(CommandError::new(
                                "undo.replay_route_missing",
                                format!(
                                    "Cannot undo {description}: an inverse operation has no registered replay route"
                                ),
                            )),
                        )
                        .expect("active undo command should fail once");
                        continue;
                    };

                    // Push redo group
                    world.resource_mut::<UndoManager>().push_redo(UndoGroup {
                        entries: redo_entries,
                        description: group.description.clone(),
                        timestamp: web_time::Instant::now(),
                        is_gurq_preserved: group.is_gurq_preserved,
                        undo_id: UndoId::new(),
                    });

                    world
                        .resource_mut::<CommandTracker>()
                        .expect_completions(event.command_id, replays.len())
                        .expect("active undo command should join every replay operation");
                    queue_group_replays(world, replays);
                } else {
                    tracing::debug!("Nothing to undo");
                    finish_command_in_world(
                        world,
                        event.command_id,
                        CommandOutcome::failed(CommandError::new(
                            "undo.empty_history",
                            "Nothing to undo",
                        )),
                    )
                    .expect("active undo command should fail once");
                }
            }

            UndoCommand::Redo {} => {
                let group_opt = world.resource_mut::<UndoManager>().pop_redo();

                if let Some(group) = group_opt {
                    tracing::debug!("Executing redo: {}", group.description);

                    // Generate undo entries from the inverse commands
                    let Some(undo_entries) = generate_inverse_entries(world, &group) else {
                        let description = group.description.clone();
                        world.resource_mut::<UndoManager>().push_redo(group);
                        finish_command_in_world(
                            world,
                            event.command_id,
                            CommandOutcome::failed(CommandError::new(
                                "redo.state_conflict",
                                format!(
                                    "Cannot redo {description}: current state conflicts with the saved operation"
                                ),
                            )),
                        )
                        .expect("active redo command should fail once");
                        continue;
                    };

                    let Some(replays) =
                        prepare_group_replays(world, &group, event.command_id, event.undo_id)
                    else {
                        let description = group.description.clone();
                        world.resource_mut::<UndoManager>().push_redo(group);
                        finish_command_in_world(
                            world,
                            event.command_id,
                            CommandOutcome::failed(CommandError::new(
                                "redo.replay_route_missing",
                                format!(
                                    "Cannot redo {description}: an inverse operation has no registered replay route"
                                ),
                            )),
                        )
                        .expect("active redo command should fail once");
                        continue;
                    };

                    // Push undo group
                    world
                        .resource_mut::<UndoManager>()
                        .push_undo_group_direct(UndoGroup {
                            entries: undo_entries,
                            description: group.description.clone(),
                            timestamp: web_time::Instant::now(),
                            is_gurq_preserved: group.is_gurq_preserved,
                            undo_id: UndoId::new(),
                        });

                    world
                        .resource_mut::<CommandTracker>()
                        .expect_completions(event.command_id, replays.len())
                        .expect("active redo command should join every replay operation");
                    queue_group_replays(world, replays);
                } else {
                    tracing::debug!("Nothing to redo");
                    finish_command_in_world(
                        world,
                        event.command_id,
                        CommandOutcome::failed(CommandError::new(
                            "redo.empty_history",
                            "Nothing to redo",
                        )),
                    )
                    .expect("active redo command should fail once");
                }
            }

            UndoCommand::ClearHistory {} => {
                tracing::debug!("Clearing undo/redo history");
                world.resource_mut::<UndoManager>().clear();
                finish_command_in_world(world, event.command_id, CommandOutcome::succeeded())
                    .expect("active clear-history command should succeed once");
            }
        }
    }
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

/// System that broadcasts undo state to WebSocket clients when it changes.
///
/// NOTE: This system is currently disabled because it requires the websocket crate,
/// which would create a circular dependency. The websocket crate should implement
/// its own system to observe UndoManager changes.
#[allow(dead_code)]
pub fn broadcast_undo_state() {
    // This functionality should be moved to the websocket crate to avoid circular dependencies
}

#[cfg(test)]
mod tests {
    use nightfall_engine::prelude::EnginePayload;

    use super::*;
    use crate::traits::UndoableOperation;

    /// Command whose inverse is unavailable, modeling a state conflict during undo.
    #[derive(Debug, Clone, EnginePayload)]
    struct ConflictingCommand;

    impl UndoableOperation for ConflictingCommand {
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
            None
        }

        fn description(&self) -> String {
            "Conflicting command".to_string()
        }
    }

    /// Undoable action used to verify the action replay boundary end to end.
    #[derive(Debug, Clone, EnginePayload, PartialEq)]
    struct ReplayAction(u32);

    impl EngineAction for ReplayAction {}

    impl UndoableOperation for ReplayAction {
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
            Some(Box::new(self.clone()))
        }

        fn description(&self) -> String {
            "Replay action".to_string()
        }
    }

    /// Verifies a preflight conflict leaves the undo group available and reports an error.
    #[test]
    fn undo_conflict_preserves_history() {
        let mut world = World::new();
        world.insert_resource(UndoManager::default());
        world.insert_resource(Messages::<CommandEnvelope<UndoCommand>>::default());
        world.init_resource::<CommandTracker>();
        world.insert_resource(Messages::<CommandResult>::default());
        world.insert_resource(Messages::<CommandReply>::default());
        world.insert_resource(Messages::<FinishedCommand>::default());
        let undo_id = UndoId::new();
        world.resource_mut::<UndoManager>().push(
            UndoEntry {
                command: Box::new(ConflictingCommand),
                description: "Conflicting operation".to_string(),
                command_id: None,
            },
            undo_id,
            false,
        );
        world
            .resource_mut::<UndoManager>()
            .finalize_detached_groups();
        let command = CommandEnvelope::new(
            UndoCommand::Undo {},
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        let command_id = command.command_id;
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("undo command should register");
        world
            .resource_mut::<Messages<CommandEnvelope<UndoCommand>>>()
            .write(command);
        let mut state = SystemState::<MessageReader<CommandEnvelope<UndoCommand>>>::new(&mut world);

        handle_undo_commands(&mut world, &mut state);

        let manager = world.resource::<UndoManager>();
        assert_eq!(manager.undo_depth(), 1);
        assert_eq!(manager.redo_depth(), 0);
        let results: Vec<_> = world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command_id);
        assert!(matches!(
            results[0].outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.state_conflict"
        ));
    }

    /// Verifies undo dispatch waits for every registered action replay to report success.
    #[test]
    fn undo_replays_registered_engine_action() {
        let mut world = World::new();
        world.init_resource::<UndoManager>();
        world.init_resource::<UndoRegistry>();
        world.init_resource::<EngineActionRouter>();
        world.init_resource::<CommandTracker>();
        world.insert_resource(Messages::<CommandEnvelope<UndoCommand>>::default());
        world.insert_resource(Messages::<EngineActionEnvelope<ReplayAction>>::default());
        world.insert_resource(Messages::<CommandResult>::default());
        world.insert_resource(Messages::<CommandReply>::default());
        world.insert_resource(Messages::<FinishedCommand>::default());
        world
            .resource_mut::<UndoRegistry>()
            .register_action::<ReplayAction>();
        world
            .resource_mut::<EngineActionRouter>()
            .register::<ReplayAction>();
        let stored_undo_id = UndoId::new();
        world.resource_mut::<UndoManager>().push(
            UndoEntry {
                command: Box::new(ReplayAction(7)),
                description: "Replay action".to_string(),
                command_id: None,
            },
            stored_undo_id,
            false,
        );
        world.resource_mut::<UndoManager>().push(
            UndoEntry {
                command: Box::new(ReplayAction(8)),
                description: "Second replay action".to_string(),
                command_id: None,
            },
            stored_undo_id,
            false,
        );
        world
            .resource_mut::<UndoManager>()
            .finalize_detached_groups();
        let command = CommandEnvelope::new(
            UndoCommand::Undo {},
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        );
        let command_id = command.command_id;
        let undo_id = command.undo_id;
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("undo command should register");
        world
            .resource_mut::<Messages<CommandEnvelope<UndoCommand>>>()
            .write(command);
        let mut state = SystemState::<MessageReader<CommandEnvelope<UndoCommand>>>::new(&mut world);

        handle_undo_commands(&mut world, &mut state);
        world.flush();

        assert!(
            world.resource::<CommandTracker>().is_active(command_id),
            "queuing replay actions must not finish the undo command",
        );
        assert!(
            world
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .next()
                .is_none(),
            "undo must not publish success before replay handlers run",
        );

        let actions = world
            .resource_mut::<Messages<EngineActionEnvelope<ReplayAction>>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(actions.len(), 2);
        for action in &actions {
            assert_eq!(action.command_id, Some(command_id));
            assert_eq!(action.undo_id, Some(undo_id));
        }
        assert_eq!(actions[0].action, ReplayAction(8));
        assert_eq!(actions[1].action, ReplayAction(7));

        let mut tracker = world.resource_mut::<CommandTracker>();
        assert!(tracker.record_success(command_id, None).unwrap().is_none());
        assert!(tracker.record_success(command_id, None).unwrap().is_some());
    }
}
