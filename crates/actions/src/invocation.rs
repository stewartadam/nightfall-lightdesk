// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime invocation messages exchanged between automation surfaces and the registry.

use bevy_ecs::prelude::Message;
use nightfall_engine::prelude::CommandId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::descriptor::{ActionId, ActionInputKind, ActionSurface};

/// Failure reported while resolving or invoking a registered action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InvocationError {
    /// Stable machine-readable failure code.
    pub code: String,
    /// User-presentable description of the failure.
    pub message: String,
}

impl InvocationError {
    /// Creates a structured invocation failure.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Stable identity for one runtime use of a registered action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InvocationId(#[typeshare(serialized_as = "String")] pub Uuid);

impl InvocationId {
    /// Creates a fresh action invocation identity.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for InvocationId {
    fn default() -> Self {
        Self::new()
    }
}

/// Runtime input supplied by an automation surface.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ActionInput {
    /// A discrete edge without a held state, such as a timeline event or palette entry.
    Trigger,
    /// A button or key was pressed.
    Press,
    /// A previously pressed button or key was released.
    Release,
    /// A normalized value in the inclusive range `0.0..=1.0`.
    Scalar(f32),
}

impl ActionInput {
    /// Adapts surface input to the shape an action consumes.
    ///
    /// Returns `Ok(None)` when the input is valid but has no effect for the action kind, such
    /// as the release half of a press used to fire a trigger.
    pub fn resolve_for(self, kind: ActionInputKind) -> Result<Option<Self>, InvocationError> {
        match (kind, self) {
            (ActionInputKind::Trigger, Self::Trigger | Self::Press) => Ok(Some(Self::Trigger)),
            (ActionInputKind::Trigger, Self::Release) => Ok(None),
            (ActionInputKind::Momentary, Self::Press | Self::Release) => Ok(Some(self)),
            (ActionInputKind::Absolute, Self::Scalar(value)) if value.is_finite() => {
                Ok(Some(Self::Scalar(value.clamp(0.0, 1.0))))
            }
            (ActionInputKind::Absolute, Self::Scalar(_)) => Err(InvocationError::new(
                "action.invalid_input",
                "Absolute action input must be a finite number",
            )),
            (kind, input) => Err(InvocationError::new(
                "action.input_mismatch",
                format!("{kind:?} actions cannot consume {input:?} input"),
            )),
        }
    }
}

/// Stored reference to a registered action plus domain-owned arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionReference {
    /// Stable action identifier to dispatch.
    pub id: ActionId,
    /// Arguments interpreted only by the domain that registered the action.
    #[typeshare(serialized_as = "unknown")]
    pub arguments: Value,
}

impl ActionReference {
    /// Creates an action reference from already-erased JSON arguments.
    pub fn new(id: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: ActionId::new(id),
            arguments,
        }
    }

    /// Serializes typed domain arguments into a persisted action reference.
    pub fn with_arguments<T: Serialize>(
        id: impl Into<String>,
        arguments: &T,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self::new(id, serde_json::to_value(arguments)?))
    }
}

/// One action invocation submitted by an automation surface.
#[derive(Debug, Clone, Message)]
pub struct ActionInvocation {
    /// Identity of this individual invocation.
    pub invocation_id: InvocationId,
    /// Persisted action ID and arguments to resolve.
    pub action: ActionReference,
    /// Surface that produced the invocation.
    pub surface: ActionSurface,
    /// Runtime trigger, button edge, or continuous input value.
    pub input: ActionInput,
    /// Optional human-readable source detail for diagnostics and UI feedback.
    pub source: Option<String>,
}

impl ActionInvocation {
    /// Creates an invocation with explicit input and a fresh identity.
    pub fn new(action: ActionReference, surface: ActionSurface, input: ActionInput) -> Self {
        Self {
            invocation_id: InvocationId::new(),
            action,
            surface,
            input,
            source: None,
        }
    }

    /// Creates a discrete action invocation with a fresh identity.
    pub fn trigger(action: ActionReference, surface: ActionSurface) -> Self {
        Self::new(action, surface, ActionInput::Trigger)
    }

    /// Creates a normalized scalar invocation with a fresh identity.
    pub fn scalar(action: ActionReference, surface: ActionSurface, value: f32) -> Self {
        Self::new(action, surface, ActionInput::Scalar(value))
    }

    /// Attaches human-readable source detail to an invocation.
    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    /// Returns the source label, falling back to the surface name.
    pub fn source_label(&self) -> String {
        self.source
            .clone()
            .unwrap_or_else(|| self.surface.label().to_string())
    }

    /// Returns the normalized scalar carried by an absolute invocation.
    pub fn scalar_value(&self) -> Option<f32> {
        match self.input {
            ActionInput::Scalar(value) => Some(value),
            _ => None,
        }
    }
}

/// Immediate disposition returned by a domain-owned live invoker.
#[derive(Debug, Clone, PartialEq)]
pub enum InvocationDispatch {
    /// The domain queued internal work whose terminal outcome is not reported.
    Accepted,
    /// The invocation submitted a tracked command whose result arrives as a `CommandResult`.
    Submitted {
        /// Identity of the tracked command.
        command_id: CommandId,
    },
    /// The domain completed the invocation synchronously.
    Succeeded {
        /// Optional domain-owned output erased at the registry boundary.
        output: Option<Value>,
    },
    /// The input was valid but has no effect for this action, such as a trigger release.
    Ignored,
}

impl InvocationDispatch {
    /// Creates a synchronous success without domain output.
    pub fn succeeded() -> Self {
        Self::Succeeded { output: None }
    }

    /// Creates a synchronous success containing domain-owned output.
    pub fn with_output(output: Value) -> Self {
        Self::Succeeded {
            output: Some(output),
        }
    }
}

/// Observable state of registry lookup, dispatch, or terminal domain work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InvocationOutcome {
    /// The owning domain accepted internal work whose terminal outcome is not reported.
    Accepted,
    /// A tracked command was submitted; correlate its `CommandResult` by command ID.
    Submitted {
        /// Identity of the tracked command.
        command_id: CommandId,
    },
    /// The owning domain completed the invocation successfully.
    Succeeded {
        /// Optional domain-owned output erased at the registry boundary.
        #[typeshare(serialized_as = "Option<unknown>")]
        output: Option<Value>,
    },
    /// The input had no effect for this action.
    Ignored,
    /// The registry or owning domain rejected the invocation.
    Failed(InvocationError),
}

impl From<Result<InvocationDispatch, InvocationError>> for InvocationOutcome {
    fn from(result: Result<InvocationDispatch, InvocationError>) -> Self {
        match result {
            Ok(InvocationDispatch::Accepted) => Self::Accepted,
            Ok(InvocationDispatch::Submitted { command_id }) => Self::Submitted { command_id },
            Ok(InvocationDispatch::Succeeded { output }) => Self::Succeeded { output },
            Ok(InvocationDispatch::Ignored) => Self::Ignored,
            Err(error) => Self::Failed(error),
        }
    }
}

/// Invocation state observable by an automation surface after dispatch or completion.
#[derive(Debug, Clone, Message)]
pub struct InvocationResult {
    /// Invocation whose dispatch completed.
    pub invocation_id: InvocationId,
    /// Registered action that was resolved.
    pub action_id: ActionId,
    /// Surface that produced the invocation.
    pub surface: ActionSurface,
    /// Accepted, submitted, terminal success, ignored, or failure state.
    pub outcome: InvocationOutcome,
}

/// Notification that a registered action intentionally started a user-visible command.
#[derive(Debug, Clone, Message)]
pub struct ExternalCommandInvocation {
    /// Action invocation that created the command.
    pub invocation_id: InvocationId,
    /// Correlation identity of the created command lifecycle.
    pub command_id: CommandId,
    /// Command text presented to the operator.
    pub command: String,
    /// Automation surface that originated the command.
    pub surface: ActionSurface,
    /// Human-readable source label.
    pub source: String,
}

/// Request for connected Web UI clients to run one of their hosted `ui.*` actions.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
pub struct ClientActionInvocation {
    /// Client-hosted action to run.
    pub action: ActionReference,
    /// Adapted runtime input.
    pub input: ActionInput,
    /// Surface that invoked the action.
    pub surface: ActionSurface,
    /// Human-readable source label.
    pub source: String,
}
