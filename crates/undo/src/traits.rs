// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::fmt::Debug;

use dyn_clone::DynClone;
use nightfall_engine::prelude::*;

use crate::context::UndoContext;

/// Commands that support undo/redo must implement this trait.
///
/// The trait extends `EnginePayload` with the ability to generate an inverse
/// command and provide a human-readable description for UI display.
///
/// Uses `DynClone` instead of `Clone` supertrait for dyn-compatibility.
/// Implementors should derive `Clone` normally; `DynClone` is auto-implemented.
pub trait UndoableOperation: EnginePayload + DynClone + Debug + Send + Sync + 'static {
    /// Generate the inverse command that undoes this command's effects.
    ///
    /// This is called BEFORE the command executes, using current state to
    /// capture what needs to be restored on undo.
    ///
    /// Returns `None` if the command cannot be undone (e.g., no state to restore).
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>>;

    /// Human-readable description for display in the UI.
    fn description(&self) -> String;
}

// Enable cloning of Box<dyn UndoableOperation>
dyn_clone::clone_trait_object!(UndoableOperation);
