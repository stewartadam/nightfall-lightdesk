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
pub trait Undoable: EnginePayload + DynClone + Debug + Send + Sync + 'static {
    /// Generate the inverse command that undoes this command's effects.
    ///
    /// This is called BEFORE the command executes, using current state to
    /// capture what needs to be restored on undo.
    ///
    /// Returns `None` if the command cannot be undone (e.g., no state to restore).
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>>;

    /// Human-readable description for display in the UI.
    fn description(&self) -> String;

    /// Names the target of an edit that operators repeat in quick succession, such as dragging
    /// the same beatgrid into place over several attempts.
    ///
    /// When the newest undo step holds only edits with the same key, made within the undo
    /// manager's coalesce window, and nothing has been undone since, this edit joins that step
    /// instead of adding its own, so a single undo returns to the state before the first
    /// repeat. Only standalone commands join: a macro run or client batch sharing one undo ID
    /// keeps its own step, and a step put back by redo starts a new run. The joined step keeps
    /// its earliest inverse and drops this one, so return a key only when the inverse restores
    /// absolute state (a snapshot of what the edit replaces), never when it reverses a relative
    /// change.
    fn coalesce_key(&self) -> Option<UndoCoalesceKey> {
        None
    }
}

/// Identifies one kind of edit on one target, for joining back-to-back repeats into one undo
/// step (see [`Undoable::coalesce_key`]).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UndoCoalesceKey {
    /// Kind of edit, unique across domains, e.g. `"timeline.beatgrid_start"`.
    kind: &'static str,
    /// The edited object, e.g. its UID.
    target: String,
}

impl UndoCoalesceKey {
    /// Builds a key for repeats of the `kind` edit on `target`; edits coalesce only when both
    /// parts are equal.
    pub fn new(kind: &'static str, target: impl std::fmt::Display) -> Self {
        Self {
            kind,
            target: target.to_string(),
        }
    }
}

// Enable cloning of Box<dyn Undoable>
dyn_clone::clone_trait_object!(Undoable);
