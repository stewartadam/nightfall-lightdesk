// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client message types for engine-level communication.
//!
//! These types provide a typeshare-compatible format for messages sent
//! between the engine and attached clients.

use nightfall_dmx::prelude::AttributeMetadata;
use serde::Serialize;

use super::results::{CommandNotice, CommandResult};
use crate::{AppState, runtime_capabilities::RuntimeCapabilities};

/// Wrapper for serializing engine-level client messages.
///
/// This enum follows the standard `{type, data}` discriminated union format
/// used throughout the application for client messages.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum EngineClientMessage<'a> {
    /// Server version sent on client connection
    ServerVersion(&'a str),
    /// Current backend lifecycle state
    AppState(&'a AppState),
    /// Canonical fixture attribute presentation metadata
    AttributeMetadata(&'a [AttributeMetadata]),
    /// Capabilities supplied by the active engine host and runtime policy.
    RuntimeCapabilities(&'a RuntimeCapabilities),
    /// Result of a command (success or error with correlation ID)
    CommandResult(&'a CommandResult),
    /// Non-terminal operator feedback for an active command.
    CommandNotice(&'a CommandNotice),
    /// Notification that all resync handlers published their current state.
    ResyncComplete,
}
