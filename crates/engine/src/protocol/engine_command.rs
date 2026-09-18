// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::fmt::{Display, Formatter};

use bevy_ecs::prelude::*;
pub use nightfall::engine::{EngineAction, EngineIngressMeta, EnginePayload, IngressCommand};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identifies one externally accepted command from ingress through its terminal result.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CommandId(#[serde(with = "nightfall::serde_uuid_simple")] pub Uuid);

impl CommandId {
    /// Creates a fresh command identity.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for CommandId {
    fn default() -> Self {
        Self::new()
    }
}

impl Display for CommandId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        Display::fmt(&self.0, formatter)
    }
}

impl From<Uuid> for CommandId {
    fn from(value: Uuid) -> Self {
        Self(value)
    }
}

impl From<CommandId> for Uuid {
    fn from(value: CommandId) -> Self {
        value.0
    }
}

/// Identifies the undo group that owns mutations produced by related work.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct UndoId(#[serde(with = "nightfall::serde_uuid_simple")] pub Uuid);

impl UndoId {
    /// Creates a fresh undo-group identity.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for UndoId {
    fn default() -> Self {
        Self::new()
    }
}

impl Display for UndoId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        Display::fmt(&self.0, formatter)
    }
}

impl From<Uuid> for UndoId {
    fn from(value: Uuid) -> Self {
        Self(value)
    }
}

impl From<CommandId> for UndoId {
    fn from(value: CommandId) -> Self {
        Self(value.0)
    }
}

impl From<UndoId> for Uuid {
    fn from(value: UndoId) -> Self {
        value.0
    }
}

/// Identifies one internal engine action or cross-domain request execution.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OperationId(#[serde(with = "nightfall::serde_uuid_simple")] pub Uuid);

impl OperationId {
    /// Creates a fresh internal operation identity.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for OperationId {
    fn default() -> Self {
        Self::new()
    }
}

impl Display for OperationId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        Display::fmt(&self.0, formatter)
    }
}

impl From<Uuid> for OperationId {
    fn from(value: Uuid) -> Self {
        Self(value)
    }
}

impl From<OperationId> for Uuid {
    fn from(value: OperationId) -> Self {
        value.0
    }
}

/// Describes the external surface that accepted a command.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum CommandOrigin {
    /// A command submitted through the Web UI transport.
    WebUi,
    /// A command submitted through the process command-line interface.
    Cli,
    /// A command submitted by another named remote-control transport.
    Remote(String),
}

/// Identifies where a command's result should be delivered.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplyTarget {
    /// Publish through the attached client host adapter.
    ClientBroadcast,
    /// Return to the local process command-line interface.
    Cli,
    /// Execute without an attached reply transport while retaining lifecycle tracking.
    Detached,
}

/// Carries one user command and the context inherited by its descendants.
#[derive(Clone, Debug, Message)]
pub struct CommandEnvelope<T> {
    /// Identity used to correlate the command with its terminal result.
    pub command_id: CommandId,
    /// Undo group that owns mutations produced by the command.
    pub undo_id: UndoId,
    /// External surface that accepted the command.
    pub origin: CommandOrigin,
    /// Destination for the terminal result.
    pub reply_target: ReplyTarget,
    /// Domain-owned command payload.
    pub command: T,
}

impl<T> CommandEnvelope<T> {
    /// Creates an independently undoable command with fresh identity.
    pub fn new(command: T, origin: CommandOrigin, reply_target: ReplyTarget) -> Self {
        let command_id = CommandId::new();
        Self {
            command_id,
            undo_id: command_id.into(),
            origin,
            reply_target,
            command,
        }
    }

    /// Creates a command with context assigned by its ingress adapter.
    pub fn with_context(
        command_id: CommandId,
        undo_id: UndoId,
        origin: CommandOrigin,
        reply_target: ReplyTarget,
        command: T,
    ) -> Self {
        Self {
            command_id,
            undo_id,
            origin,
            reply_target,
            command,
        }
    }
}

/// Carries one concrete internal action and optional originating command context.
#[derive(Clone, Debug, Message)]
pub struct EngineActionEnvelope<T> {
    /// Identity used to correlate the action with its internal result.
    pub operation_id: OperationId,
    /// User command that caused this action, when one exists.
    pub command_id: Option<CommandId>,
    /// Undo group that owns mutations produced by this action, when applicable.
    pub undo_id: Option<UndoId>,
    /// Domain-owned concrete action payload.
    pub action: T,
}

impl<T> EngineActionEnvelope<T> {
    /// Creates an action that is not the descendant of a user command.
    pub fn detached(action: T) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: None,
            undo_id: None,
            action,
        }
    }

    /// Creates an action with explicit operation and inherited lifecycle context.
    pub fn with_context(
        operation_id: OperationId,
        command_id: Option<CommandId>,
        undo_id: Option<UndoId>,
        action: T,
    ) -> Self {
        Self {
            operation_id,
            command_id,
            undo_id,
            action,
        }
    }

    /// Creates an action inheriting identity and undo context from a command.
    pub fn for_command<C>(command: &CommandEnvelope<C>, action: T) -> Self {
        Self::for_command_context(command.command_id, command.undo_id, action)
    }

    /// Creates an action from command context retained by a multi-frame workflow.
    pub fn for_command_context(command_id: CommandId, undo_id: UndoId, action: T) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: Some(command_id),
            undo_id: Some(undo_id),
            action,
        }
    }
}

/// Carries one unresolved internal request and optional originating command context.
#[derive(Clone, Debug, Message)]
pub struct RequestEnvelope<T> {
    /// Identity used to correlate the request with its internal result.
    pub operation_id: OperationId,
    /// User command that caused this request, when one exists.
    pub command_id: Option<CommandId>,
    /// Undo group inherited by work resolved from this request, when applicable.
    pub undo_id: Option<UndoId>,
    /// Domain-owned request payload.
    pub request: T,
}

impl<T> RequestEnvelope<T> {
    /// Creates a request that is not the descendant of a user command.
    pub fn detached(request: T) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: None,
            undo_id: None,
            request,
        }
    }

    /// Creates a request inheriting identity and undo context from a command.
    pub fn for_command<C>(command: &CommandEnvelope<C>, request: T) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: Some(command.command_id),
            undo_id: Some(command.undo_id),
            request,
        }
    }

    /// Creates a request with explicit operation and inherited lifecycle context.
    pub fn with_context(
        operation_id: OperationId,
        command_id: Option<CommandId>,
        undo_id: Option<UndoId>,
        request: T,
    ) -> Self {
        Self {
            operation_id,
            command_id,
            undo_id,
            request,
        }
    }
}

/// Carries a domain fact and the operation context that produced it.
#[derive(Clone, Debug, Message)]
pub struct EventEnvelope<T> {
    /// Internal operation associated with the event.
    pub operation_id: OperationId,
    /// User command that caused the event, when one exists.
    pub command_id: Option<CommandId>,
    /// Undo group inherited by the producing operation, when applicable.
    pub undo_id: Option<UndoId>,
    /// Domain-owned fact that occurred.
    pub event: T,
}

impl<T> EventEnvelope<T> {
    /// Creates a fact with no user-command or undo lifecycle.
    pub fn detached(event: T) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: None,
            undo_id: None,
            event,
        }
    }

    /// Creates a fact emitted by one concrete engine action.
    pub fn for_action<A>(action: &EngineActionEnvelope<A>, event: T) -> Self {
        Self {
            operation_id: action.operation_id,
            command_id: action.command_id,
            undo_id: action.undo_id,
            event,
        }
    }

    /// Creates a fact with explicit operation and inherited lifecycle context.
    pub fn with_context(
        operation_id: OperationId,
        command_id: Option<CommandId>,
        undo_id: Option<UndoId>,
        event: T,
    ) -> Self {
        Self {
            operation_id,
            command_id,
            undo_id,
            event,
        }
    }
}

/// Carries an operator-facing observation without creating a command lifecycle.
#[derive(Clone, Debug, Message)]
pub struct NotificationEnvelope<T> {
    /// Internal operation associated with the observation.
    pub operation_id: OperationId,
    /// User command that caused the observation, when one exists.
    pub command_id: Option<CommandId>,
    /// Undo group inherited by the producing operation, when applicable.
    pub undo_id: Option<UndoId>,
    /// Domain-owned observation.
    pub notification: T,
}

impl<T> NotificationEnvelope<T> {
    /// Creates an observation with no user-command or undo lifecycle.
    pub fn detached(notification: T) -> Self {
        Self {
            operation_id: OperationId::new(),
            command_id: None,
            undo_id: None,
            notification,
        }
    }

    /// Creates an observation emitted by one concrete engine action.
    pub fn for_action<A>(action: &EngineActionEnvelope<A>, notification: T) -> Self {
        Self {
            operation_id: action.operation_id,
            command_id: action.command_id,
            undo_id: action.undo_id,
            notification,
        }
    }

    /// Creates an observation with explicit operation and inherited lifecycle context.
    pub fn with_context(
        operation_id: OperationId,
        command_id: Option<CommandId>,
        undo_id: Option<UndoId>,
        notification: T,
    ) -> Self {
        Self {
            operation_id,
            command_id,
            undo_id,
            notification,
        }
    }
}

/// Reports the typed internal outcome of one engine action or request.
#[derive(Clone, Debug, Message)]
pub struct OperationResult<T, E> {
    /// Internal operation whose execution finished.
    pub operation_id: OperationId,
    /// Domain-owned success value or error.
    pub result: Result<T, E>,
}

impl<T, E> OperationResult<T, E> {
    /// Creates a successful internal operation result.
    pub fn succeeded(operation_id: OperationId, value: T) -> Self {
        Self {
            operation_id,
            result: Ok(value),
        }
    }

    /// Creates a failed internal operation result.
    pub fn failed(operation_id: OperationId, error: E) -> Self {
        Self {
            operation_id,
            result: Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that an independent command uses one UUID value for command and undo identity.
    #[test]
    fn new_command_defaults_undo_identity_to_command_identity() {
        let envelope = CommandEnvelope::new(
            "fixture command",
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        );

        assert_eq!(envelope.command_id.0, envelope.undo_id.0);
    }

    /// Verifies that internal actions inherit command and undo context but receive a new operation ID.
    #[test]
    fn command_action_inherits_context() {
        let command = CommandEnvelope::new(
            "store cue",
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        );

        let action = EngineActionEnvelope::for_command(&command, "persist cue");

        assert_eq!(action.command_id, Some(command.command_id));
        assert_eq!(action.undo_id, Some(command.undo_id));
        assert_ne!(action.operation_id.0, command.command_id.0);
    }

    /// Verifies that requests retain explicitly assigned operation, command, and undo context.
    #[test]
    fn request_with_context_preserves_lifecycle_identity() {
        let operation_id = OperationId::new();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        let request = RequestEnvelope::with_context(
            operation_id,
            Some(command_id),
            Some(undo_id),
            "resolve clip",
        );

        assert_eq!(request.operation_id, operation_id);
        assert_eq!(request.command_id, Some(command_id));
        assert_eq!(request.undo_id, Some(undo_id));
    }

    /// Verifies that facts emitted by actions inherit the producing operation's lifecycle context.
    #[test]
    fn action_event_inherits_operation_context() {
        let operation_id = OperationId::new();
        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        let action = EngineActionEnvelope::with_context(
            operation_id,
            Some(command_id),
            Some(undo_id),
            "start effect",
        );

        let event = EventEnvelope::for_action(&action, "effect started");

        assert_eq!(event.operation_id, operation_id);
        assert_eq!(event.command_id, Some(command_id));
        assert_eq!(event.undo_id, Some(undo_id));
    }

    /// Verifies that detached observations do not fabricate command or undo lifecycle context.
    #[test]
    fn detached_notification_has_no_command_lifecycle() {
        let notification = NotificationEnvelope::detached("module output changed");

        assert_eq!(notification.command_id, None);
        assert_eq!(notification.undo_id, None);
    }

    /// Verifies that internal operation results preserve their operation identity and typed result.
    #[test]
    fn operation_result_preserves_typed_outcome() {
        let operation_id = OperationId::new();
        let result = OperationResult::<u32, String>::succeeded(operation_id, 11);

        assert_eq!(result.operation_id, operation_id);
        assert_eq!(result.result, Ok(11));
    }

    /// Verifies that protocol identity newtypes use the repository's simple UUID representation.
    #[test]
    fn command_id_serializes_as_simple_uuid() {
        let command_id =
            CommandId(Uuid::parse_str("12345678-1234-5678-9abc-def012345678").unwrap());

        assert_eq!(
            serde_json::to_string(&command_id).unwrap(),
            "\"12345678123456789abcdef012345678\""
        );
    }
}
