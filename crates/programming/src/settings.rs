// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile settings that change how the programmer responds to edits.

use bevy_ecs::prelude::Resource;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Programmer behavior saved with the showfile.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct ProgrammingSettings {
    /// When true, setting an attribute also adds its fixtures to the programmer selection.
    pub auto_select: bool,
    /// What happens before an operation that flattens programmer selection expressions.
    pub selection_flatten_policy: SelectionFlattenPolicy,
}

impl ProgrammingSettings {
    /// Section these settings are saved and sent under.
    pub const SECTION: SettingsSection<Self> = SettingsSection::new("programming");
}

/// Policy for handling operations that flatten programmer selection expressions.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub enum SelectionFlattenPolicy {
    /// Flatten selections immediately without prompting.
    #[default]
    Silent,
    /// Prompt in UI before running operations that may flatten selections.
    Prompt,
}

/// Commands that change [`ProgrammingSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ProgrammingSettingsCommand {
    /// Set whether setting an attribute also selects its fixtures.
    SetAutoSelect(bool),
    /// Set what happens before operations that may flatten programmer selection expressions.
    SetSelectionFlattenPolicy(SelectionFlattenPolicy),
}

impl IngressCommand for ProgrammingSettingsCommand {}

/// Writes one programming settings change; these edits cannot fail.
pub(crate) fn apply(
    command: &ProgrammingSettingsCommand,
    settings: &mut ProgrammingSettings,
) -> Result<(), CommandError> {
    match command {
        ProgrammingSettingsCommand::SetAutoSelect(value) => settings.auto_select = *value,
        ProgrammingSettingsCommand::SetSelectionFlattenPolicy(value) => {
            settings.selection_flatten_policy = *value;
        }
    }
    Ok(())
}
