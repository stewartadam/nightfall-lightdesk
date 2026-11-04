// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile setting for which audio output device plays timeline audio.

use bevy_ecs::prelude::Resource;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Audio output choices saved with the showfile.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct AudioSettings {
    /// Name of the output device to play through; `None` follows the system default.
    pub output_device: Option<String>,
}

impl AudioSettings {
    /// Section these settings are saved and sent under.
    pub const SECTION: SettingsSection<Self> = SettingsSection::new("audio");
}

/// Commands that change [`AudioSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum AudioSettingsCommand {
    /// Set the output device to play through; `None` follows the system default.
    SetOutputDevice(Option<String>),
}

impl IngressCommand for AudioSettingsCommand {}

/// Writes one audio settings change; these edits cannot fail.
pub(crate) fn apply(
    command: &AudioSettingsCommand,
    settings: &mut AudioSettings,
) -> Result<(), CommandError> {
    match command {
        AudioSettingsCommand::SetOutputDevice(device) => settings.output_device = device.clone(),
    }
    Ok(())
}
