// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo-aware command dispatch integration.
//!
//! This module provides infrastructure for intercepting undoable commands
//! before they execute, generating inverse commands, and pushing them to
//! the undo manager.

use std::any::TypeId;
use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;

use crate::context::UndoContext;
use crate::manager::{UndoEntry, UndoManager};
use crate::traits::UndoableOperation;

/// Type alias for inverse generator functions.
///
/// These functions take a boxed engine command and an undo context,
/// and return the inverse command if the command is undoable.
type InverseGenerator = Box<
    dyn Fn(&dyn EnginePayload, Option<CommandId>, &UndoContext) -> Option<UndoEntry> + Send + Sync,
>;

/// Context available while rebuilding a stored inverse for replay.
#[derive(Clone, Copy)]
pub(crate) struct UndoReplayContext {
    /// User undo/redo command that initiated the replay.
    pub command_id: CommandId,
    /// Undo group owned by the user undo/redo command.
    pub undo_id: UndoId,
}

/// Type-erased payload ready to cross its semantic replay boundary.
#[derive(Debug)]
pub(crate) enum UndoReplay {
    /// An inverse whose handler still consumes the legacy command route.
    LegacyCommand(PayloadEnvelope),
    /// A concrete inverse operation dispatched through its domain action router.
    EngineAction(DynEngineActionEnvelope),
}

/// Rebuilds one stored inverse as the semantic payload type registered by its domain.
type ReplayFactory =
    Box<dyn Fn(&dyn UndoableOperation, UndoReplayContext) -> Option<UndoReplay> + Send + Sync>;

/// Registry for undoable command types.
///
/// Commands that implement `UndoableOperation` must be registered here
/// for the undo system to capture their inverses during dispatch.
#[derive(Resource, Default)]
pub struct UndoRegistry {
    generators: HashMap<TypeId, InverseGenerator>,
    replay_factories: HashMap<TypeId, ReplayFactory>,
}

impl UndoRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            generators: HashMap::new(),
            replay_factories: HashMap::new(),
        }
    }

    /// Register a command type that implements UndoableOperation.
    ///
    /// This enables automatic inverse generation when commands of this
    /// type are dispatched.
    pub fn register<C>(&mut self)
    where
        C: UndoableOperation + Clone + 'static,
    {
        self.register_inverse_generator::<C>();
        self.replay_factories.insert(
            TypeId::of::<C>(),
            Box::new(|operation, context| {
                let operation = operation.as_any().downcast_ref::<C>()?;
                Some(UndoReplay::LegacyCommand(PayloadEnvelope::with_context(
                    context.command_id,
                    context.undo_id,
                    Box::new(operation.clone()),
                )))
            }),
        );
    }

    /// Registers an undoable concrete engine action and its typed replay route.
    pub fn register_action<A>(&mut self)
    where
        A: UndoableOperation + EngineAction + Clone + 'static,
    {
        self.register_inverse_generator::<A>();
        self.replay_factories.insert(
            TypeId::of::<A>(),
            Box::new(|operation, context| {
                let operation = operation.as_any().downcast_ref::<A>()?;
                Some(UndoReplay::EngineAction(
                    DynEngineActionEnvelope::for_command(
                        context.command_id,
                        context.undo_id,
                        Box::new(operation.clone()),
                    ),
                ))
            }),
        );
    }

    /// Registers inverse generation shared by command and action replay routes.
    fn register_inverse_generator<C>(&mut self)
    where
        C: UndoableOperation + Clone + 'static,
    {
        let type_id = TypeId::of::<C>();
        tracing::trace!(?type_id, "Registering undoable operation handler");
        self.generators.insert(
            type_id,
            Box::new(move |payload, command_id, ctx| {
                let operation = payload.as_any().downcast_ref::<C>()?;
                Some(UndoEntry {
                    command: operation.inverse(ctx)?,
                    description: operation.description(),
                    command_id,
                })
            }),
        );
    }

    /// Try to generate an inverse for a command.
    ///
    /// Returns `Some(UndoEntry)` if the command is registered and undoable,
    /// `None` otherwise.
    pub fn try_generate_inverse(
        &self,
        envelope: &PayloadEnvelope,
        ctx: &UndoContext,
    ) -> Option<UndoEntry> {
        let type_id = envelope.payload.as_any().type_id();
        let generator = self.generators.get(&type_id)?;
        generator(envelope.payload.as_ref(), Some(envelope.command_id), ctx)
    }

    /// Tries to generate an inverse for a typed engine action crossing the erased queue.
    pub fn try_generate_action_inverse(
        &self,
        envelope: &DynEngineActionEnvelope,
        ctx: &UndoContext,
    ) -> Option<UndoEntry> {
        let type_id = envelope.action.as_any().type_id();
        let generator = self.generators.get(&type_id)?;
        generator(envelope.action.as_ref(), envelope.command_id, ctx)
    }

    /// Rebuilds a stored inverse using the command or action route registered for its type.
    pub(crate) fn prepare_replay(
        &self,
        operation: &dyn UndoableOperation,
        context: UndoReplayContext,
    ) -> Option<UndoReplay> {
        let factory = self.replay_factories.get(&operation.as_any().type_id())?;
        factory(operation, context)
    }

    /// Check if a command type is registered as undoable.
    pub fn is_undoable(&self, type_id: TypeId) -> bool {
        self.generators.contains_key(&type_id)
    }
}

/// Command-stage undo processing.
///
/// This system:
/// 1. Reads command intents from `PendingCommandBuffer`
/// 2. Captures inverses for undoable commands
/// 3. Queues commands for typed dispatch
pub fn process_pending_commands(world: &mut World) {
    // Check if buffer is empty
    let buffer_empty = world.resource::<PendingCommandBuffer>().is_empty();
    if buffer_empty {
        return;
    }

    // Drain the buffer into a local vector
    let commands_to_process: Vec<_> = world
        .resource_mut::<PendingCommandBuffer>()
        .drain()
        .into_iter()
        .collect();

    // Process each command and generate inverses.
    let mut entries_to_add = Vec::new();
    let mut commands_to_dispatch = Vec::new();
    {
        let ctx = UndoContext { world };
        let registry = world.resource::<UndoRegistry>();

        for envelope in commands_to_process {
            if let Some(entry) = registry.try_generate_inverse(&envelope, &ctx) {
                tracing::debug!("Captured undo inverse for: {}", entry.description);
                let command_id = envelope.command_id;
                let lifecycle_managed = world
                    .get_resource::<CommandTracker>()
                    .is_some_and(|tracker| tracker.is_active(command_id));
                entries_to_add.push((entry, envelope.undo_id, lifecycle_managed));
            }

            commands_to_dispatch.push(envelope);
        }
    }

    // Push entries to undo manager
    {
        let mut undo_manager = world.resource_mut::<UndoManager>();
        for (entry, undo_id, lifecycle_managed) in entries_to_add {
            undo_manager.push(entry, undo_id, lifecycle_managed);
        }
    }

    // Queue commands for dispatch
    for envelope in commands_to_dispatch {
        tracing::debug!(?envelope, "Dispatching pending command");
        world.commands().queue(envelope);
    }
}

/// Action-stage undo processing.
///
/// This system:
/// 1. Reads actions from `PendingEngineActionBuffer`
/// 2. Captures inverses for undoable actions
/// 3. Queues actions for runtime dispatch
pub fn process_pending_actions(world: &mut World) {
    if world.resource::<PendingEngineActionBuffer>().is_empty() {
        return;
    }

    let actions_to_process: Vec<_> = world
        .resource_mut::<PendingEngineActionBuffer>()
        .drain()
        .into_iter()
        .collect();

    let mut entries_to_add = Vec::new();
    {
        let ctx = UndoContext { world };
        let registry = world.resource::<UndoRegistry>();

        for correlated_action in &actions_to_process {
            if let Some(entry) = registry.try_generate_action_inverse(correlated_action, &ctx) {
                tracing::debug!(
                    "Captured action-stage undo inverse for: {}",
                    entry.description
                );
                if let Some(undo_id) = correlated_action.undo_id {
                    let lifecycle_managed =
                        correlated_action.command_id.is_some_and(|command_id| {
                            world
                                .get_resource::<CommandTracker>()
                                .is_some_and(|tracker| tracker.is_active(command_id))
                        });
                    entries_to_add.push((entry, undo_id, lifecycle_managed));
                }
            }
        }
    }

    {
        let mut undo_manager = world.resource_mut::<UndoManager>();
        for (entry, undo_id, lifecycle_managed) in entries_to_add {
            undo_manager.push(entry, undo_id, lifecycle_managed);
        }
    }

    for correlated_action in actions_to_process {
        tracing::debug!(?correlated_action, "Dispatching pending action");
        world.commands().queue(correlated_action);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal undoable action used to verify semantic replay registration.
    #[derive(Clone, Debug, EnginePayload, PartialEq)]
    struct TestUndoAction(u32);

    impl EngineAction for TestUndoAction {}

    impl UndoableOperation for TestUndoAction {
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
            Some(Box::new(self.clone()))
        }

        fn description(&self) -> String {
            "Test undo action".to_string()
        }
    }

    fn setup_world() -> World {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();
        world.init_resource::<PendingEngineActionBuffer>();
        world.init_resource::<UndoManager>();
        world.init_resource::<UndoRegistry>();
        world.init_resource::<CommandTracker>();
        world
    }

    /// Verifies command-stage processing dispatches ordinary commands without using the action queue.
    #[test]
    fn process_pending_commands_leaves_action_buffer_separate() {
        let mut world = setup_world();

        process_pending_commands(&mut world);

        assert!(world.resource::<PendingCommandBuffer>().is_empty());
        assert!(world.resource::<PendingEngineActionBuffer>().is_empty());
    }

    /// Verifies action-stage processing drains every queued action.
    #[test]
    fn process_pending_actions_drains_action_buffer() {
        let mut world = setup_world();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        world.resource_mut::<PendingEngineActionBuffer>().push(
            DynEngineActionEnvelope::for_command(command_id, undo_id, Box::new(TestUndoAction(1))),
        );

        process_pending_actions(&mut world);

        assert!(
            world.resource::<PendingEngineActionBuffer>().is_empty(),
            "action-stage processing should drain PendingEngineActionBuffer",
        );
    }

    /// Verifies action registrations rebuild stored inverses as typed engine-action envelopes.
    #[test]
    fn action_registration_prepares_semantic_replay() {
        let mut registry = UndoRegistry::new();
        registry.register_action::<TestUndoAction>();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        let replay = registry
            .prepare_replay(
                &TestUndoAction(7),
                UndoReplayContext {
                    command_id,
                    undo_id,
                },
            )
            .expect("registered action should prepare replay");

        let UndoReplay::EngineAction(envelope) = replay else {
            panic!("action registration should not use the legacy command route");
        };
        assert_eq!(envelope.command_id, Some(command_id));
        assert_eq!(envelope.undo_id, Some(undo_id));
        assert_eq!(
            envelope.action.as_any().downcast_ref::<TestUndoAction>(),
            Some(&TestUndoAction(7))
        );
    }

    /// Verifies command replays inherit the initiating undo lifecycle identities.
    #[test]
    fn command_registration_prepares_joined_replay() {
        let mut registry = UndoRegistry::new();
        registry.register::<TestUndoAction>();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        let replay = registry
            .prepare_replay(
                &TestUndoAction(9),
                UndoReplayContext {
                    command_id,
                    undo_id,
                },
            )
            .expect("registered command should prepare replay");

        let UndoReplay::LegacyCommand(envelope) = replay else {
            panic!("command registration should use the ingress replay route");
        };
        assert_eq!(envelope.command_id, command_id);
        assert_eq!(envelope.undo_id, undo_id);
        assert_eq!(
            envelope.payload.as_any().downcast_ref::<TestUndoAction>(),
            Some(&TestUndoAction(9))
        );
    }
}
