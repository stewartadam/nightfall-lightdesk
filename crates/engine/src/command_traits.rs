// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Traits for user-facing command intent and planning.

/// Trait for command intent types that can be rendered to CLI text.
pub trait CliCommand {
    /// Render this command into canonical CLI form.
    ///
    /// Returns `None` when the command cannot be represented losslessly.
    fn to_cli(&self) -> Option<String>;
}
