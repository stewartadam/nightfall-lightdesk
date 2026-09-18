// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Type-erased engine command handling for dynamic (de)serialization during input and output processing
//!
use bevy_ecs::prelude::*;
use web_time::Instant;

use crate::prelude::*;

/// Type-erased wrapper for dispatchable payloads carrying correlation and undo identities.
pub type DynEnginePayload = Box<dyn EnginePayload>;

/// Type-erased user command retained only while crossing queue and routing boundaries.
#[derive(Debug)]
pub struct PayloadEnvelope {
    /// User command identity propagated to typed ingress dispatch.
    pub command_id: CommandId,
    /// Undo group that owns mutations produced by this command.
    pub undo_id: UndoId,
    /// Concrete command payload erased for queue storage.
    pub payload: DynEnginePayload,
}

impl PayloadEnvelope {
    /// Creates an erased command with explicit lifecycle context.
    pub fn with_context(
        command_id: impl Into<CommandId>,
        undo_id: impl Into<UndoId>,
        payload: DynEnginePayload,
    ) -> Self {
        Self {
            command_id: command_id.into(),
            undo_id: undo_id.into(),
            payload,
        }
    }
}

/// Type-erased concrete engine action used only while crossing queue boundaries.
pub type DynEngineAction = Box<dyn EngineAction>;

/// Type-erased action envelope awaiting dispatch to its concrete typed message.
#[derive(Debug)]
pub struct DynEngineActionEnvelope {
    /// Identity of this internal action execution.
    pub operation_id: OperationId,
    /// User command that caused this action, when one exists.
    pub command_id: Option<CommandId>,
    /// Undo group inherited from the originating command, when applicable.
    pub undo_id: Option<UndoId>,
    /// Concrete domain action erased for queue storage.
    pub action: DynEngineAction,
}

impl DynEngineActionEnvelope {
    /// Creates a queued action inheriting user-command and undo context.
    pub fn for_command(command_id: CommandId, undo_id: UndoId, action: DynEngineAction) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: Some(command_id),
            undo_id: Some(undo_id),
            action,
        }
    }

    /// Creates a queued action with explicit optional lifecycle context.
    pub fn with_context(
        operation_id: OperationId,
        command_id: Option<CommandId>,
        undo_id: Option<UndoId>,
        action: DynEngineAction,
    ) -> Self {
        Self {
            operation_id,
            command_id,
            undo_id,
            action,
        }
    }

    /// Creates a queued action with no user-command or undo lifecycle.
    pub fn detached(action: DynEngineAction) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: None,
            undo_id: None,
            action,
        }
    }
}

/// Buffer for pending commands that need processing before dispatch.
///
/// Command sources (client bridge, terminal) write to this buffer. The undo
/// system reads from it to generate inverses before dispatching the commands.
#[derive(Resource, Default)]
pub struct PendingCommandBuffer {
    commands: Vec<PayloadEnvelope>,
}

impl PendingCommandBuffer {
    /// Add a command to the pending buffer.
    pub fn push(&mut self, cmd: PayloadEnvelope) {
        self.commands.push(cmd);
    }

    /// Take all pending commands, leaving the buffer empty.
    pub fn drain(&mut self) -> Vec<PayloadEnvelope> {
        std::mem::take(&mut self.commands)
    }

    /// Check if there are pending commands.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

/// Buffer for pending runtime actions awaiting action-stage processing.
///
/// Action payloads planned from command intent are moved here so undo capture
/// can run at the action boundary before runtime systems execute them.
#[derive(Resource, Default)]
pub struct PendingEngineActionBuffer {
    actions: Vec<DynEngineActionEnvelope>,
}

impl PendingEngineActionBuffer {
    /// Add an action to the pending action buffer.
    pub fn push(&mut self, action: DynEngineActionEnvelope) {
        self.actions.push(action);
    }

    /// Take all pending actions, leaving the buffer empty.
    pub fn drain(&mut self) -> Vec<DynEngineActionEnvelope> {
        std::mem::take(&mut self.actions)
    }

    /// Check if there are pending actions.
    pub fn is_empty(&self) -> bool {
        self.actions.is_empty()
    }
}

/// Queue for commands that should execute at a future time.
///
/// Used for implementing sleep/delay functionality. Commands are held until
/// their scheduled execution time, then moved to PendingCommandBuffer.
#[derive(Resource, Default)]
pub struct DelayedCommandQueue {
    commands: Vec<(Instant, PayloadEnvelope)>,
    completions: Vec<(Instant, CommandId)>,
}

impl DelayedCommandQueue {
    /// Schedule a command to execute at a specific time.
    pub fn schedule(&mut self, when: Instant, cmd: PayloadEnvelope) {
        self.commands.push((when, cmd));
        // Keep sorted by timestamp for efficient processing
        self.commands.sort_by_key(|(instant, _)| *instant);
    }

    /// Schedule a command to execute immediately.
    pub fn schedule_now(&mut self, cmd: PayloadEnvelope) {
        self.schedule(Instant::now(), cmd);
    }

    /// Schedule a command's successful completion after an asynchronous delay.
    pub fn schedule_completion(&mut self, when: Instant, command_id: CommandId) {
        self.completions.push((when, command_id));
        self.completions.sort_by_key(|(instant, _)| *instant);
    }

    /// Take all commands whose scheduled time has arrived.
    pub fn take_ready(&mut self) -> Vec<PayloadEnvelope> {
        let now = Instant::now();

        // Find the split point where commands transition from ready to future
        let split_idx = self
            .commands
            .iter()
            .position(|(when, _)| *when > now)
            .unwrap_or(self.commands.len());

        // Drain ready commands and collect them
        self.commands
            .drain(..split_idx)
            .map(|(_, cmd)| cmd)
            .collect()
    }

    /// Takes command completions whose scheduled delay has elapsed.
    pub fn take_ready_completions(&mut self) -> Vec<CommandId> {
        let now = Instant::now();
        let split_idx = self
            .completions
            .iter()
            .position(|(when, _)| *when > now)
            .unwrap_or(self.completions.len());
        self.completions
            .drain(..split_idx)
            .map(|(_, command_id)| command_id)
            .collect()
    }

    /// Check if there are scheduled commands.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty() && self.completions.is_empty()
    }

    /// Clear all scheduled commands without executing them.
    pub fn clear(&mut self) {
        self.commands.clear();
        self.completions.clear();
    }

    /// Get the number of scheduled commands.
    pub fn len(&self) -> usize {
        self.commands.len() + self.completions.len()
    }
}
