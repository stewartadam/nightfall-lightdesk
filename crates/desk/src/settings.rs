// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk-wide settings and settings command types

use std::collections::HashMap;
use std::time::Duration;

use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::BindingValidationMode;
use nightfall_io::prelude::{
    ExternalControlSettings, InputSignalLossPolicy, InputUniverseVisibilityMode,
    NetworkDmxOutputTargets, UsbDmxOutputTargets,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default number of timestamped showfile backups retained after each save.
pub const DEFAULT_SHOWFILE_BACKUP_RETENTION: u32 = 20;

/// Serialized Dockview panel metadata stored alongside a named panel layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct StoredPanelLayoutPanel {
    /// Stable panel id inside the serialized Dockview layout.
    pub id: String,
    /// User-visible panel title captured when the layout was stored.
    pub title: String,
    /// Panel parameters needed by Dockview to restore component state.
    #[typeshare(serialized_as = "unknown")]
    pub params: Value,
}

/// Serialized Dockview panel layout saved as the showfile's active UI layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct ActivePanelLayout {
    /// Named layout owning this working arrangement.
    pub layout_id: Option<String>,
    /// Layout storage format version.
    pub version: u32,
    /// Opaque Dockview layout payload.
    #[typeshare(serialized_as = "unknown")]
    pub layout: Value,
    /// Panel metadata captured when the layout was stored.
    pub panels: Vec<StoredPanelLayoutPanel>,
    /// Last layout update timestamp in milliseconds since Unix epoch.
    pub updated_at: f64,
}

/// Serialized Dockview panel layout that is named and saved with the showfile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct StoredPanelLayout {
    /// Whether this layout is shown in the switcher; list order defines its position.
    #[serde(default = "default_layout_shown_in_switcher")]
    pub shown_in_switcher: bool,
    /// Stable layout id used by the UI command palette and layout manager.
    pub id: String,
    /// User-visible layout name.
    pub name: String,
    /// Layout storage format version.
    pub version: u32,
    /// Opaque Dockview layout payload.
    #[typeshare(serialized_as = "unknown")]
    pub layout: Value,
    /// Panel metadata captured when the layout was stored.
    pub panels: Vec<StoredPanelLayoutPanel>,
    /// Layout creation timestamp in milliseconds since Unix epoch.
    pub created_at: f64,
    /// Last layout update timestamp in milliseconds since Unix epoch.
    pub updated_at: f64,
}

/// Keeps saved layouts discoverable when the showfile predates explicit switcher visibility.
fn default_layout_shown_in_switcher() -> bool {
    true
}

/// Desk-wide settings configuration
#[derive(bevy_ecs::prelude::Resource, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DeskSettings {
    /// When true, setting an attribute also updates the programmer selection
    pub programmer_auto_select: bool,
    /// Selected audio output device name (None = system default)
    pub audio_device: Option<String>,
    /// Policy for cue renumbering when sequence steps are reordered in the UI
    #[serde(default)]
    pub sequence_reorder_renumber_policy: SequenceReorderRenumberPolicy,
    /// Policy for handling operations that flatten programmer selection expressions
    #[serde(default)]
    pub selection_flatten_policy: SelectionFlattenPolicy,
    /// Preferred display unit for editable time values in the UI.
    #[serde(default)]
    pub time_display_preference: TimeDisplayPreference,
    /// Position source for timeline insert and paste operations.
    #[serde(default)]
    pub timeline_placement_preference: TimelinePlacementPreference,
    /// Number of timestamped showfile backups to retain after each save; 0 means unlimited.
    #[serde(default = "default_showfile_backup_retention")]
    pub showfile_backup_retention: u32,
    /// Showfile-scoped named UI panel layouts.
    #[serde(default)]
    pub panel_layouts: Vec<StoredPanelLayout>,
    /// Showfile-scoped active UI panel layout restored when the showfile loads.
    #[serde(default)]
    pub active_panel_layout: Option<ActivePanelLayout>,
}

impl Default for DeskSettings {
    fn default() -> Self {
        Self {
            programmer_auto_select: false,
            audio_device: None,
            sequence_reorder_renumber_policy: SequenceReorderRenumberPolicy::default(),
            selection_flatten_policy: SelectionFlattenPolicy::default(),
            time_display_preference: TimeDisplayPreference::default(),
            timeline_placement_preference: TimelinePlacementPreference::default(),
            showfile_backup_retention: DEFAULT_SHOWFILE_BACKUP_RETENTION,
            panel_layouts: Vec::new(),
            active_panel_layout: None,
        }
    }
}

/// Returns the default showfile backup retention count for serde defaults.
pub fn default_showfile_backup_retention() -> u32 {
    DEFAULT_SHOWFILE_BACKUP_RETENTION
}

/// Snapshot of audio outputs currently surfaced to desk clients.
#[derive(bevy_ecs::prelude::Resource, Debug, Default, Clone)]
pub struct AvailableAudioDevices(pub HashMap<String, String>);

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

/// Commands for modifying desk-wide settings
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum SettingsCommand {
    /// Set the programmer auto-select behavior
    SetProgrammerAutoSelect(bool),
    /// Set the selected network interface (None = system default)
    SetNetworkInterface(Option<String>),
    /// Sets host-owned external control permission and interface selection.
    SetExternalControl(ExternalControlSettings),
    /// Set whether network DMX output is enabled
    SetNetworkOutputEnabled(bool),
    /// Set whether network DMX input is enabled
    SetNetworkInputEnabled(bool),
    /// Set whether USB DMX output is enabled
    SetUsbOutputEnabled(bool),
    /// Set named network DMX output targets.
    SetNetworkDmxOutputs(NetworkDmxOutputTargets),
    /// Set named USB DMX output targets.
    SetUsbDmxOutputs(UsbDmxOutputTargets),
    /// Set the input signal-loss policy
    SetInputSignalLossPolicy(InputSignalLossPolicy),
    /// Set the stale input age threshold
    SetInputSignalLossTimeout(Duration),
    /// Set patch overlap validation mode
    SetBindingValidationMode(BindingValidationMode),
    /// Set the selected audio device (None = system default)
    SetAudioDevice(Option<String>),
    /// Set cue renumbering behavior when sequence steps are reordered in UI
    SetSequenceReorderRenumberPolicy(SequenceReorderRenumberPolicy),
    /// Set whether input views show only external inputs or all detected inputs
    SetInputUniverseVisibilityMode(InputUniverseVisibilityMode),
    /// Set behavior for operations that may flatten programmer selection expressions
    SetSelectionFlattenPolicy(SelectionFlattenPolicy),
    /// Set preferred display unit for editable time values
    SetTimeDisplayPreference(TimeDisplayPreference),
    /// Set whether timeline insert and paste operations use the playhead or cursor
    SetTimelinePlacementPreference(TimelinePlacementPreference),
    /// Set number of timestamped showfile backups to retain; 0 means unlimited
    SetShowfileBackupRetention(u32),
    /// Set showfile-scoped named UI panel layouts
    SetPanelLayouts(Vec<StoredPanelLayout>),
    /// Set showfile-scoped active UI panel layout
    SetActivePanelLayout(Option<ActivePanelLayout>),
    /// Request list of available network interfaces
    GetAvailableNetworkInterfaces,
    /// Request list of available audio devices
    GetAvailableAudioDevices,
    /// Request list of compatible USB DMX devices
    GetAvailableUsbDmxDevices,
}

impl IngressCommand for SettingsCommand {}

#[cfg(test)]
mod tests {
    use super::StoredPanelLayout;

    /// Saved layouts without visibility metadata remain accessible, while explicit hiding survives a round trip.
    #[test]
    fn saved_layout_visibility_defaults_to_shown() {
        let value = serde_json::json!({
            "id": "saved", "name": "Saved layout", "version": 2,
            "layout": { "panels": {}, "grid": {} }, "panels": [],
            "createdAt": 1, "updatedAt": 1
        });
        let mut layout: StoredPanelLayout = serde_json::from_value(value).unwrap();
        assert!(layout.shown_in_switcher);
        layout.shown_in_switcher = false;
        let restored: StoredPanelLayout =
            serde_json::from_value(serde_json::to_value(layout).unwrap()).unwrap();
        assert!(!restored.shown_in_switcher);
    }
}
