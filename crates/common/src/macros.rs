// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Persisted macro definitions: command-line text run as one action.

use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;

use crate::data::{HasIdentifiers, Identifiers};

/// Shared showfile object holding command-line text that runs in order when started.
///
/// Both bodies hold the text exactly as the operator typed it, one statement per line, so
/// blank lines and layout survive a save. The runner splits them into statements when a run
/// starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct Macro {
    /// Stable showfile identifiers ("Macro 3").
    pub identifiers: Identifiers,
    /// Command text run when the macro starts.
    #[serde(default)]
    pub commands: String,
    /// Command text run when a held button that started the macro is let go.
    ///
    /// Empty means letting go does nothing, so a quick tap runs the whole press body.
    #[serde(default)]
    pub release_commands: String,
}

impl HasIdentifiers for Macro {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}
