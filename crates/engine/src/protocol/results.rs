// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Return values for engine commands

use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::engine_command::CommandId;

/// Domain-owned success data erased only at the generic response boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CommandOutput {
    /// Serialized domain result interpreted by the command's typed client.
    #[typeshare(serialized_as = "unknown")]
    pub value: Value,
}

impl CommandOutput {
    /// Serializes a typed domain result for transport through the generic result channel.
    pub fn from_serializable<T: Serialize>(value: T) -> Result<Self, serde_json::Error> {
        serde_json::to_value(value).map(|value| Self { value })
    }
}

/// Structured failure safe to return to the command's initiating client.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CommandError {
    /// Stable machine-readable code suitable for client-side branching.
    pub code: String,
    /// Concise operator-facing explanation of the failure.
    pub message: String,
    /// Optional structured domain details that are safe to expose to clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[typeshare(serialized_as = "Option<unknown>")]
    pub details: Option<Value>,
}

impl CommandError {
    /// Creates a failure without additional structured details.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// Attaches serialized domain details to a failure.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

/// Terminal semantic outcome of one accepted command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum CommandOutcome {
    /// All work required by the command finished successfully.
    Succeeded {
        /// Optional typed domain result erased for transport.
        output: Option<CommandOutput>,
    },
    /// The requested outcome did not complete.
    Failed(CommandError),
}

/// The single terminal response emitted for one accepted command.
#[derive(Debug, Clone, Message, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CommandResult {
    /// Identity of the command whose lifecycle finished.
    pub command_id: CommandId,
    /// Terminal success or failure after all required work completed.
    pub outcome: CommandOutcome,
}

impl CommandOutcome {
    /// Creates a successful outcome without domain output.
    pub fn succeeded() -> Self {
        Self::Succeeded { output: None }
    }

    /// Creates a successful outcome containing domain output.
    pub fn with_output(output: CommandOutput) -> Self {
        Self::Succeeded {
            output: Some(output),
        }
    }

    /// Creates a failed outcome.
    pub fn failed(error: CommandError) -> Self {
        Self::Failed(error)
    }
}

/// Severity of non-terminal operator feedback for an active command.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum NoticeLevel {
    /// Informational progress or context.
    Info,
    /// A recoverable concern that does not terminate the command.
    Warning,
}

/// Non-terminal operator feedback associated with an active command.
#[derive(Debug, Clone, Message, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CommandNotice {
    /// Active command receiving this notice.
    pub command_id: CommandId,
    /// Severity used when presenting the notice.
    pub level: NoticeLevel,
    /// Operator-facing feedback.
    pub message: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Verifies that structured command failures retain stable client-facing fields.
    #[test]
    fn command_error_serializes_code_message_and_details() {
        let error = CommandError::new("cue.store_failed", "Unable to store cue")
            .with_details(json!({ "cue": "11.1" }));

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "cue.store_failed",
                "message": "Unable to store cue",
                "details": { "cue": "11.1" }
            })
        );
    }

    /// Verifies that terminal success and failure use an unambiguous tagged wire shape.
    #[test]
    fn command_outcome_serializes_as_tagged_union() {
        let success = CommandOutcome::with_output(CommandOutput {
            value: json!({ "instance_id": "1234" }),
        });
        let failure = CommandOutcome::failed(CommandError::new("invalid", "Invalid command"));

        assert_eq!(
            serde_json::to_value(success).unwrap(),
            json!({
                "type": "Succeeded",
                "data": { "output": { "value": { "instance_id": "1234" } } }
            })
        );
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            json!({
                "type": "Failed",
                "data": { "code": "invalid", "message": "Invalid command" }
            })
        );
    }
}
