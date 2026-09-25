// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Registration helpers that lower actions onto the existing command and update paths.
//!
//! Actions are bindable entry points, not a separate execution mechanism. Discrete actions
//! become tracked, undoable ingress commands; continuous actions become untracked update
//! messages. Domains describe the mapping from typed arguments to their own command or
//! update types and never mutate the world from an action invoker directly.

use bevy_app::App;
use bevy_ecs::prelude::{Message, World};
use nightfall_engine::prelude::{
    CommandId, CommandOrigin, CommandTracker, IngressCommand, PayloadEnvelope,
    PendingCommandBuffer, ReplyTarget, UndoId,
};
use serde::de::DeserializeOwned;

use crate::descriptor::{ActionDescriptor, ActionInputKind};
use crate::invocation::{ActionInvocation, InvocationDispatch, InvocationError};
use crate::registry::ActionRegistry;

/// Submits one ingress command on behalf of an action invocation.
///
/// The command is registered with the command tracker under an automation origin and
/// queued through the pending command buffer, so it receives the same undo capture,
/// lifecycle tracking, and result reporting as commands sent by the Web UI.
pub fn submit_command<C>(
    world: &mut World,
    invocation: &ActionInvocation,
    command: C,
) -> Result<CommandId, InvocationError>
where
    C: IngressCommand + Clone + 'static,
{
    let command_id = CommandId::new();
    let undo_id = UndoId::from(command_id);
    world
        .get_resource_mut::<CommandTracker>()
        .ok_or_else(|| {
            InvocationError::new(
                "action.command_tracker_unavailable",
                "Command tracking is unavailable",
            )
        })?
        .register_context(
            command_id,
            undo_id,
            CommandOrigin::Automation {
                surface: invocation.surface.label().to_string(),
                source: invocation.source.clone(),
            },
            ReplyTarget::ClientBroadcast,
        )
        .map_err(|error| {
            InvocationError::new(
                "action.command_registration_failed",
                format!("Unable to register command: {error}"),
            )
        })?;
    world
        .get_resource_mut::<PendingCommandBuffer>()
        .ok_or_else(|| {
            InvocationError::new(
                "action.command_queue_unavailable",
                "Command queue is unavailable",
            )
        })?
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(command_id)
}

/// App-level registration helpers used by domain plugins to expose bindable actions.
///
/// Every helper initializes the [`ActionRegistry`] on first use, so domain plugins do not
/// depend on plugin ordering relative to [`crate::ActionsPlugin`].
pub trait ActionAppExt {
    /// Registers an action with a custom invoker.
    ///
    /// Reserve this for actions that orchestrate around the command path, and route any
    /// discrete work through [`submit_command`].
    fn register_action<A, F>(&mut self, descriptor: ActionDescriptor, invoker: F) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        F: Fn(&mut World, A, &ActionInvocation) -> Result<InvocationDispatch, InvocationError>
            + Send
            + Sync
            + 'static;

    /// Registers a trigger action that lowers its arguments to one tracked ingress command.
    ///
    /// # Panics
    ///
    /// Panics when the descriptor does not declare trigger input.
    fn register_command_action<A, C, F>(
        &mut self,
        descriptor: ActionDescriptor,
        lower: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        C: IngressCommand + Clone + 'static,
        F: Fn(&World, A) -> Result<C, InvocationError> + Send + Sync + 'static;

    /// Registers how to read an absolute action's current normalized level, enabling Flash.
    ///
    /// # Panics
    ///
    /// Panics when the action is not registered yet or is not absolute.
    fn register_flash_level<A, F>(&mut self, action_id: &str, reader: F) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        F: Fn(&World, A) -> Result<Option<f32>, InvocationError> + Send + Sync + 'static;

    /// Registers an absolute action that lowers each normalized value to an untracked update.
    ///
    /// Continuous hardware input is live performance state, so updates bypass undo capture.
    ///
    /// # Panics
    ///
    /// Panics when the descriptor does not declare absolute input.
    fn register_update_action<A, U, F>(
        &mut self,
        descriptor: ActionDescriptor,
        lower: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        U: Message,
        F: Fn(&World, A, f32) -> Result<U, InvocationError> + Send + Sync + 'static;

    /// Registers a deterministic capability for an already registered action.
    fn register_action_capability<A, C, F>(
        &mut self,
        action_id: &str,
        name: &'static str,
        capability: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        C: Send + Sync + 'static,
        F: Fn(A) -> Result<C, InvocationError> + Send + Sync + 'static;
}

impl ActionAppExt for App {
    fn register_action<A, F>(&mut self, descriptor: ActionDescriptor, invoker: F) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        F: Fn(&mut World, A, &ActionInvocation) -> Result<InvocationDispatch, InvocationError>
            + Send
            + Sync
            + 'static,
    {
        self.init_resource::<ActionRegistry>();
        self.world_mut()
            .resource_mut::<ActionRegistry>()
            .register(descriptor, invoker);
        self
    }

    fn register_command_action<A, C, F>(
        &mut self,
        descriptor: ActionDescriptor,
        lower: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        C: IngressCommand + Clone + 'static,
        F: Fn(&World, A) -> Result<C, InvocationError> + Send + Sync + 'static,
    {
        assert_eq!(
            descriptor.input,
            ActionInputKind::Trigger,
            "command action '{}' must declare trigger input",
            descriptor.id.as_str()
        );
        self.register_action::<A, _>(descriptor, move |world, arguments, invocation| {
            let command = lower(world, arguments)?;
            let command_id = submit_command(world, invocation, command)?;
            Ok(InvocationDispatch::Submitted { command_id })
        })
    }

    fn register_flash_level<A, F>(&mut self, action_id: &str, reader: F) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        F: Fn(&World, A) -> Result<Option<f32>, InvocationError> + Send + Sync + 'static,
    {
        self.init_resource::<ActionRegistry>();
        self.world_mut()
            .resource_mut::<ActionRegistry>()
            .register_flash_level::<A, F>(action_id, reader);
        self
    }

    fn register_update_action<A, U, F>(
        &mut self,
        descriptor: ActionDescriptor,
        lower: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        U: Message,
        F: Fn(&World, A, f32) -> Result<U, InvocationError> + Send + Sync + 'static,
    {
        assert_eq!(
            descriptor.input,
            ActionInputKind::Absolute,
            "update action '{}' must declare absolute input",
            descriptor.id.as_str()
        );
        self.register_action::<A, _>(descriptor, move |world, arguments, invocation| {
            let value = invocation.scalar_value().ok_or_else(|| {
                InvocationError::new(
                    "action.scalar_required",
                    "Absolute actions require a scalar input value",
                )
            })?;
            let update = lower(world, arguments, value)?;
            if world
                .get_resource::<bevy_ecs::message::Messages<U>>()
                .is_none()
            {
                return Err(InvocationError::new(
                    "action.update_unavailable",
                    format!(
                        "Update dispatch for '{}' is unavailable",
                        invocation.action.id.as_str()
                    ),
                ));
            }
            world.write_message(update);
            Ok(InvocationDispatch::succeeded())
        })
    }

    fn register_action_capability<A, C, F>(
        &mut self,
        action_id: &str,
        name: &'static str,
        capability: F,
    ) -> &mut Self
    where
        A: DeserializeOwned + 'static,
        C: Send + Sync + 'static,
        F: Fn(A) -> Result<C, InvocationError> + Send + Sync + 'static,
    {
        self.init_resource::<ActionRegistry>();
        self.world_mut()
            .resource_mut::<ActionRegistry>()
            .register_capability::<A, C, F>(action_id, name, capability);
        self
    }
}
