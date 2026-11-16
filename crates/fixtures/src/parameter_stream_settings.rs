// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile setting for how parameter values stream to clients.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::parameter_state::ParameterStateProjection;

/// How the parameter state projection streams values to clients, saved with the showfile.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct ParameterStreamSettings {
    /// Sends clients every parameter value each frame instead of only the changed ones, a
    /// fallback for when the UI shows values that do not match the output.
    pub keyframes_only: bool,
}

impl ParameterStreamSettings {
    /// Section these settings are saved and sent under.
    pub const SECTION: SettingsSection<Self> = SettingsSection::new("parameterStream");
}

/// Commands that change [`ParameterStreamSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ParameterStreamSettingsCommand {
    /// Set whether clients receive every parameter value each frame instead of only changes.
    SetKeyframesOnly(bool),
}

impl IngressCommand for ParameterStreamSettingsCommand {}

/// Writes one parameter stream settings change; these edits cannot fail.
pub(crate) fn apply(
    command: &ParameterStreamSettingsCommand,
    settings: &mut ParameterStreamSettings,
) -> Result<(), CommandError> {
    match command {
        ParameterStreamSettingsCommand::SetKeyframesOnly(value) => settings.keyframes_only = *value,
    }
    Ok(())
}

/// Applies the parameter stream mode to the client projection whenever the settings change,
/// whether from a command or a loaded showfile.
pub(crate) fn sync_parameter_stream(
    settings: Res<ParameterStreamSettings>,
    mut projection: ResMut<ParameterStateProjection>,
) {
    if settings.is_changed() {
        projection.set_keyframes_only(settings.keyframes_only);
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// The projection follows the setting, including when the settings are replaced wholesale as
    /// a showfile load does.
    #[test]
    fn keyframes_only_reaches_the_projection() {
        let mut app = App::new();
        app.init_resource::<ParameterStreamSettings>();
        app.init_resource::<ParameterStateProjection>();
        app.add_systems(Update, sync_parameter_stream);

        app.world_mut()
            .resource_mut::<ParameterStreamSettings>()
            .keyframes_only = true;
        app.update();
        assert!(
            app.world()
                .resource::<ParameterStateProjection>()
                .keyframes_only()
        );

        app.insert_resource(ParameterStreamSettings::default());
        app.update();
        assert!(
            !app.world()
                .resource::<ParameterStateProjection>()
                .keyframes_only()
        );
    }
}
