// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo command types

use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Commands for undo/redo operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
// We have to use an empty named fields until 1Password/typeshare#35 is fixed
/// Undo stack commands that can be applied or reversed.
#[serde(deny_unknown_fields)]
pub enum UndoCommand {
    /// Execute undo
    Undo {},
    /// Execute redo
    Redo {},
    /// Clear undo history
    ClearHistory {},
}

impl IngressCommand for UndoCommand {}
