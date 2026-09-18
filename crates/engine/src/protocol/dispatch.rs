// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Semantic command and engine-action dispatch via downcasting.

use std::{any::TypeId, collections::HashMap};

use bevy_ecs::prelude::*;

use crate::{
    prelude::*,
    protocol::erased::{DynEngineActionEnvelope, PayloadEnvelope},
};

/// A handler that can process a specific type of command.
///
/// Note: this is a plain function pointer (no allocation, no vtable for `dyn Fn`).
/// Avoids per-handler heap allocation by storing plain function pointers, while
/// keeping the dispatch logic centralized and generic.
type CommandHandlerFn = fn(&mut World, &PayloadEnvelope);

/// Handler that restores a concrete typed action message from an erased queue entry.
type ActionHandlerFn = fn(&mut World, &DynEngineActionEnvelope);

/// Fails an originating command when queued action dispatch cannot continue.
fn fail_action_dispatch(
    world: &mut World,
    envelope: &DynEngineActionEnvelope,
    code: &'static str,
    message: String,
) {
    let Some(command_id) = envelope.command_id else {
        return;
    };
    let is_active = world
        .get_resource::<CommandTracker>()
        .is_some_and(|tracker| tracker.is_active(command_id));
    if !is_active {
        return;
    }
    if let Err(error) = finish_command_in_world(
        world,
        command_id,
        CommandOutcome::failed(CommandError::new(code, message)),
    ) {
        tracing::error!(%command_id, %error, "engine_action_dispatch_failure_response_failed");
    }
}

/// Fails an active command when erased ingress cannot reach its typed handler.
fn fail_command_dispatch(
    world: &mut World,
    envelope: &PayloadEnvelope,
    code: &'static str,
    message: String,
) {
    let is_active = world
        .get_resource::<CommandTracker>()
        .is_some_and(|tracker| tracker.is_active(envelope.command_id));
    if !is_active {
        return;
    }
    if let Err(error) = finish_command_in_world(
        world,
        envelope.command_id,
        CommandOutcome::failed(CommandError::new(code, message)),
    ) {
        tracing::error!(
            command_id = %envelope.command_id,
            %error,
            "command_dispatch_failure_response_failed"
        );
    }
}

/// Dispatches one transitional erased payload into a semantic command envelope.
fn handle_ingress_typed<C: IngressCommand + Clone + 'static>(
    world: &mut World,
    envelope: &PayloadEnvelope,
) {
    let Some(command) = envelope.payload.as_any().downcast_ref::<C>() else {
        return;
    };
    let command_id = envelope.command_id;
    let undo_id = envelope.undo_id;
    let active_context = world
        .get_resource::<CommandTracker>()
        .and_then(|tracker| tracker.active_command(command_id))
        .map(|active| (active.origin.clone(), active.reply_target.clone()));
    let needs_registration = active_context.is_none();
    let (origin, reply_target) = active_context.unwrap_or((CommandOrigin::Cli, ReplyTarget::Cli));

    if needs_registration
        && let Some(mut tracker) = world.get_resource_mut::<CommandTracker>()
        && let Err(error) =
            tracker.register_context(command_id, undo_id, origin.clone(), reply_target.clone())
    {
        tracing::warn!(%command_id, %error, "semantic_command_registration_failed");
        return;
    }

    let Some(mut messages) = world.get_resource_mut::<Messages<CommandEnvelope<C>>>() else {
        tracing::warn!(
            command_type = %std::any::type_name::<C>(),
            "semantic_command_message_resource_missing"
        );
        fail_command_dispatch(
            world,
            envelope,
            "command.message_unavailable",
            format!(
                "Ingress command message resource is unavailable for {}",
                std::any::type_name::<C>()
            ),
        );
        return;
    };
    messages.write(CommandEnvelope::with_context(
        command_id,
        undo_id,
        origin,
        reply_target,
        command.clone(),
    ));
}

/// Restores one registered engine action to its domain-owned typed envelope.
fn handle_action_typed<A: EngineAction + Clone + 'static>(
    world: &mut World,
    envelope: &DynEngineActionEnvelope,
) {
    let Some(action) = envelope.action.as_any().downcast_ref::<A>() else {
        return;
    };
    let Some(mut messages) = world.get_resource_mut::<Messages<EngineActionEnvelope<A>>>() else {
        let message = format!(
            "Engine action message resource is unavailable for {}",
            std::any::type_name::<A>()
        );
        tracing::warn!(
            action_type = %std::any::type_name::<A>(),
            "engine_action_message_resource_missing"
        );
        fail_action_dispatch(
            world,
            envelope,
            "engine.action_message_unavailable",
            message,
        );
        return;
    };
    messages.write(EngineActionEnvelope {
        operation_id: envelope.operation_id,
        command_id: envelope.command_id,
        undo_id: envelope.undo_id,
        action: action.clone(),
    });
}

/// Registry that dispatches erased ingress commands to domain-owned typed messages.
#[derive(Resource, Default)]
pub struct CommandIngressRouter {
    handlers: HashMap<TypeId, CommandHandlerFn>,
}

/// Registry that dispatches erased engine actions to domain-owned typed messages.
#[derive(Resource, Default)]
pub struct EngineActionRouter {
    handlers: HashMap<TypeId, ActionHandlerFn>,
}

impl EngineActionRouter {
    /// Registers a concrete engine action type for typed dispatch.
    pub fn register<A: EngineAction + Clone + 'static>(&mut self) {
        self.handlers.insert(
            TypeId::of::<A>(),
            handle_action_typed::<A> as ActionHandlerFn,
        );
    }

    /// Dispatches one erased action through its registered concrete handler.
    pub fn dispatch(&self, world: &mut World, envelope: &DynEngineActionEnvelope) {
        let action_type_id = envelope.action.as_any().type_id();
        let _span = tracing::debug_span!(
            "engine_action_dispatch",
            operation_id = %envelope.operation_id,
            command_id = ?envelope.command_id,
            undo_id = ?envelope.undo_id,
            action_type = ?action_type_id,
        )
        .entered();

        match self.handlers.get(&action_type_id) {
            Some(handler) => handler(world, envelope),
            None => {
                tracing::warn!("no_engine_action_handler_found");
                fail_action_dispatch(
                    world,
                    envelope,
                    "engine.action_handler_missing",
                    format!("No engine action handler is registered for {action_type_id:?}"),
                );
            }
        }
    }
}

impl CommandIngressRouter {
    /// Creates an empty ingress command router.
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Registers semantic dispatch for an ingress command.
    pub fn register_ingress<C: IngressCommand + Clone + 'static>(&mut self) {
        let type_id = TypeId::of::<C>();
        tracing::trace!(
            command_type = %std::any::type_name::<C>(),
            ?type_id,
            "Registering semantic command dispatch handler"
        );
        self.handlers
            .insert(type_id, handle_ingress_typed::<C> as CommandHandlerFn);
    }

    /// Dispatches an erased command to its registered typed ingress handler.
    pub fn dispatch(&self, world: &mut World, envelope: &PayloadEnvelope) {
        let cmd_type_id = envelope.payload.as_any().type_id();

        // Span covers the synchronous dispatch path including handle_typed()
        let _span = tracing::debug_span!(
            "command_dispatch",
            command_id = %envelope.command_id,
            undo_id = %envelope.undo_id,
            command_type = ?cmd_type_id,
        )
        .entered();

        match self.handlers.get(&cmd_type_id) {
            Some(handler) => handler(world, envelope),
            None => {
                tracing::warn!("no_ingress_command_handler_found");
                fail_command_dispatch(
                    world,
                    envelope,
                    "command.handler_missing",
                    format!("No ingress command handler is registered for {cmd_type_id:?}"),
                );
            }
        }
    }
}

/// A Bevy command that dispatches erased user ingress through the registered router.
impl Command for PayloadEnvelope {
    type Out = ();

    fn apply(self, world: &mut World) {
        world.resource_scope(|world, dispatcher: Mut<CommandIngressRouter>| {
            dispatcher.dispatch(world, &self);
        });
    }
}

/// Dispatches one queued engine action through the registered action router.
impl Command for DynEngineActionEnvelope {
    type Out = ();

    fn apply(self, world: &mut World) {
        world.resource_scope(|world, router: Mut<EngineActionRouter>| {
            router.dispatch(world, &self);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Concrete action used to verify enum-free action routing.
    #[derive(Clone, Debug, PartialEq)]
    struct TestAction(u32);

    impl EnginePayload for TestAction {}
    impl EngineAction for TestAction {}

    /// Concrete command used to verify semantic ingress routing.
    #[derive(Clone, Debug, PartialEq)]
    struct TestCommand(u32);

    impl EnginePayload for TestCommand {}
    impl IngressCommand for TestCommand {}

    /// Adds lifecycle resources required by exclusive-world failure reporting.
    fn init_lifecycle(world: &mut World) {
        world.init_resource::<CommandTracker>();
        world.init_resource::<Messages<CommandResult>>();
        world.init_resource::<Messages<CommandReply>>();
        world.init_resource::<Messages<FinishedCommand>>();
        world.init_resource::<Messages<CommandNotice>>();
    }

    /// Verifies a registered erased action is restored to its concrete typed envelope.
    #[test]
    fn registered_action_dispatches_to_typed_message() {
        let mut world = World::new();
        world.init_resource::<EngineActionRouter>();
        world.init_resource::<Messages<EngineActionEnvelope<TestAction>>>();
        world
            .resource_mut::<EngineActionRouter>()
            .register::<TestAction>();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        DynEngineActionEnvelope::for_command(command_id, undo_id, Box::new(TestAction(7)))
            .apply(&mut world);

        let dispatched = world
            .resource_mut::<Messages<EngineActionEnvelope<TestAction>>>()
            .drain()
            .next()
            .expect("registered action should dispatch");
        assert_eq!(dispatched.command_id, Some(command_id));
        assert_eq!(dispatched.undo_id, Some(undo_id));
        assert_eq!(dispatched.action, TestAction(7));
    }

    /// Verifies registered erased ingress is restored to a semantic command envelope.
    #[test]
    fn registered_ingress_dispatches_to_typed_message() {
        let mut world = World::new();
        world.init_resource::<CommandIngressRouter>();
        world.init_resource::<Messages<CommandEnvelope<TestCommand>>>();
        init_lifecycle(&mut world);
        world
            .resource_mut::<CommandIngressRouter>()
            .register_ingress::<TestCommand>();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        PayloadEnvelope::with_context(command_id, undo_id, Box::new(TestCommand(7)))
            .apply(&mut world);

        let dispatched = world
            .resource_mut::<Messages<CommandEnvelope<TestCommand>>>()
            .drain()
            .next()
            .expect("registered ingress should dispatch");
        assert_eq!(dispatched.command_id, command_id);
        assert_eq!(dispatched.undo_id, undo_id);
        assert_eq!(dispatched.command, TestCommand(7));
        assert!(
            world.resource::<CommandTracker>().is_active(command_id),
            "dispatch should register a command that was not registered by an adapter"
        );
    }

    /// Verifies missing ingress registration fails an already accepted command.
    #[test]
    fn missing_ingress_handler_fails_originating_command() {
        let mut world = World::new();
        world.init_resource::<CommandIngressRouter>();
        init_lifecycle(&mut world);
        let command =
            CommandEnvelope::new(TestCommand(7), CommandOrigin::Cli, ReplyTarget::Detached);
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("test command should register");

        PayloadEnvelope::with_context(
            command.command_id,
            command.undo_id,
            Box::new(command.command),
        )
        .apply(&mut world);

        let result = world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("missing ingress handler should fail the command");
        let CommandOutcome::Failed(error) = result.outcome else {
            panic!("missing ingress handler should produce failure");
        };
        assert_eq!(error.code, "command.handler_missing");
    }

    /// Verifies a missing typed message resource fails registered ingress immediately.
    #[test]
    fn missing_ingress_message_resource_fails_originating_command() {
        let mut world = World::new();
        world.init_resource::<CommandIngressRouter>();
        init_lifecycle(&mut world);
        world
            .resource_mut::<CommandIngressRouter>()
            .register_ingress::<TestCommand>();
        let command =
            CommandEnvelope::new(TestCommand(7), CommandOrigin::Cli, ReplyTarget::Detached);
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("test command should register");

        PayloadEnvelope::with_context(
            command.command_id,
            command.undo_id,
            Box::new(command.command),
        )
        .apply(&mut world);

        let result = world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("missing ingress message resource should fail the command");
        let CommandOutcome::Failed(error) = result.outcome else {
            panic!("missing ingress message resource should produce failure");
        };
        assert_eq!(error.code, "command.message_unavailable");
    }

    /// Verifies a missing registration fails the originating command instead of timing out.
    #[test]
    fn missing_action_handler_fails_originating_command() {
        let mut world = World::new();
        world.init_resource::<EngineActionRouter>();
        init_lifecycle(&mut world);
        let command =
            CommandEnvelope::new("test command", CommandOrigin::Cli, ReplyTarget::Detached);
        world
            .resource_mut::<CommandTracker>()
            .register(&command)
            .expect("test command should register");

        DynEngineActionEnvelope::for_command(
            command.command_id,
            command.undo_id,
            Box::new(TestAction(7)),
        )
        .apply(&mut world);

        let result = world
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("missing action handler should fail the command");
        let CommandOutcome::Failed(error) = result.outcome else {
            panic!("missing action handler should produce failure");
        };
        assert_eq!(error.code, "engine.action_handler_missing");
    }
}
