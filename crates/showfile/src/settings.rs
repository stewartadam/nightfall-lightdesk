// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile setting for how many backups disk saves keep.

use bevy_ecs::prelude::Resource;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Default number of timestamped showfile backups retained after each save.
pub const DEFAULT_SHOWFILE_BACKUP_RETENTION: u32 = 20;

/// Disk save choices saved with the showfile.
#[derive(Resource, Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct ShowfileSettings {
    /// Number of timestamped backups to keep after each save; 0 keeps them all.
    pub backup_retention: u32,
}

impl Default for ShowfileSettings {
    /// Keeps [`DEFAULT_SHOWFILE_BACKUP_RETENTION`] backups.
    fn default() -> Self {
        Self {
            backup_retention: DEFAULT_SHOWFILE_BACKUP_RETENTION,
        }
    }
}

impl ShowfileSettings {
    /// Section these settings are saved and sent under.
    pub const SECTION: SettingsSection<Self> = SettingsSection::new("showfile");
}

/// Commands that change [`ShowfileSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ShowfileSettingsCommand {
    /// Set how many timestamped backups each save keeps; 0 keeps them all.
    SetBackupRetention(u32),
}

impl IngressCommand for ShowfileSettingsCommand {}

/// Writes one showfile settings change; these edits cannot fail.
pub fn apply_showfile_settings_command(
    command: &ShowfileSettingsCommand,
    settings: &mut ShowfileSettings,
) -> Result<(), CommandError> {
    match command {
        ShowfileSettingsCommand::SetBackupRetention(count) => settings.backup_retention = *count,
    }
    Ok(())
}

/// Registers the [`ShowfileSettings`] section and its command, in every host.
pub struct ShowfileSettingsPlugin;

impl bevy_app::Plugin for ShowfileSettingsPlugin {
    /// Adds the section and the handler for [`ShowfileSettingsCommand`].
    fn build(&self, app: &mut bevy_app::App) {
        app.register_settings_section(ShowfileSettings::SECTION);
        app.add_settings_command(apply_showfile_settings_command);
    }
}
