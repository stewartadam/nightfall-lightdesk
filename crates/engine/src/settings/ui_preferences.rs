// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile-wide preferences that only clients act on, such as how times are displayed.

use bevy_app::App;
use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};

use super::{SettingsAppExt, SettingsSection};
use crate::prelude::{CommandError, EnginePayload, IngressCommand};

/// Preferences saved with the showfile that change how clients present and edit the show, but
/// that no engine system acts on.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct UiPreferences {
    /// Preferred display unit for editable time values.
    pub time_display: TimeDisplayPreference,
    /// Position source for timeline insert and paste operations.
    pub timeline_placement: TimelinePlacementPreference,
    /// What happens to cue numbers when sequence steps are reordered.
    pub sequence_reorder_renumber_policy: SequenceReorderRenumberPolicy,
}

impl UiPreferences {
    /// Section these preferences are saved and sent under.
    pub const SECTION: SettingsSection<Self> = SettingsSection::new("ui");
}

/// Policy for cue ID renumbering when reordering sequence steps in the UI.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub enum SequenceReorderRenumberPolicy {
    /// Preserve existing cue IDs after reordering sequence steps.
    #[default]
    Preserve,
    /// Automatically renumber cues to 1..N in their new order after reordering.
    AutoRenumber,
    /// Prompt in UI before renumbering after reorder.
    Prompt,
}

/// Preferred display unit for editable time values in the UI.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub enum TimeDisplayPreference {
    /// Choose a compact unit based on the duration value.
    #[default]
    Auto,
    /// Always display seconds.
    Seconds,
    /// Always display milliseconds.
    Milliseconds,
    /// Always display one-beat tempo.
    Bpm,
    /// Always display frequency.
    Hertz,
}

/// Position source for timeline insert and paste operations.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub enum TimelinePlacementPreference {
    /// Place timeline inserts and pastes at the current playhead.
    #[default]
    Playhead,
    /// Place timeline inserts and pastes at the current timeline cursor when available.
    Cursor,
}

/// Commands that change [`UiPreferences`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum UiPreferencesCommand {
    /// Set the preferred display unit for editable time values.
    SetTimeDisplay(TimeDisplayPreference),
    /// Set whether timeline insert and paste operations use the playhead or the cursor.
    SetTimelinePlacement(TimelinePlacementPreference),
    /// Set what happens to cue numbers when sequence steps are reordered.
    SetSequenceReorderRenumberPolicy(SequenceReorderRenumberPolicy),
}

impl IngressCommand for UiPreferencesCommand {}

/// Writes one preference change; these edits cannot fail.
fn apply(
    command: &UiPreferencesCommand,
    preferences: &mut UiPreferences,
) -> Result<(), CommandError> {
    match command {
        UiPreferencesCommand::SetTimeDisplay(value) => preferences.time_display = *value,
        UiPreferencesCommand::SetTimelinePlacement(value) => {
            preferences.timeline_placement = *value
        }
        UiPreferencesCommand::SetSequenceReorderRenumberPolicy(value) => {
            preferences.sequence_reorder_renumber_policy = *value;
        }
    }
    Ok(())
}

/// Registers the preferences section and its command.
pub(super) fn build(app: &mut App) {
    app.register_settings_section(UiPreferences::SECTION);
    app.add_settings_command(apply);
}
