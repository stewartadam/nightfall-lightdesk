// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_audio::{
    AudioController, AudioPlugin, available_output_devices, default_output_device,
};
use nightfall_desk::prelude::{
    AvailableAudioDevices, DeskPlugin, DeskSettings, ToastLevel, UiNotification,
};
use nightfall_desk::systems::event_handlers;
use nightfall_engine::prelude::EventHandling;

const AUDIO_DEVICE_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Resource that tracks the selected audio device and current monitor level.
#[derive(Debug, Default)]
struct AudioOutputMonitorState {
    initialized: bool,
    last_poll_at: Option<Instant>,
    last_default_device: Option<String>,
    last_routed_device: Option<String>,
    last_selected_device: Option<String>,
    selected_device_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AudioOutputDeviceSnapshot {
    devices: HashMap<String, String>,
    default_device_id: Option<String>,
    default_device_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AudioOutputToast {
    level: ToastLevel,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AudioOutputMonitorPlan {
    devices: HashMap<String, String>,
    devices_changed: bool,
    default_device_id: Option<String>,
    selected_device_id: Option<String>,
    selected_device_missing: bool,
    reroute_device: Option<Option<String>>,
    immediate_toasts: Vec<AudioOutputToast>,
    reroute_success_toast: Option<AudioOutputToast>,
}

/// Plugin that wires desk audio monitoring into the Bevy app.
pub struct DeskAudioPlugin;

impl Plugin for DeskAudioPlugin {
    /// Registers desk audio resources and monitor systems.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering DeskAudioPlugin");
        assert!(
            app.is_plugin_added::<DeskPlugin>(),
            "DeskAudioPlugin requires DeskPlugin (provides desk settings and websocket resources)"
        );
        assert!(
            app.is_plugin_added::<AudioPlugin>(),
            "DeskAudioPlugin requires AudioPlugin (provides AudioController)"
        );

        app.add_systems(
            Update,
            monitor_audio_output_changes
                .after(event_handlers::settings_events::handle_events)
                .in_set(EventHandling),
        );
    }
}

impl AudioOutputDeviceSnapshot {
    /// Captures the current OS audio output devices and default route.
    fn capture() -> Self {
        let devices = available_output_devices()
            .into_iter()
            .map(|device| (device.id, device.display_name))
            .collect::<HashMap<_, _>>();
        let default_device = default_output_device();
        let default_device_id = default_device.as_ref().map(|device| device.id.clone());
        let default_device_name = default_device
            .as_ref()
            .map(|device| device.display_name.clone())
            .unwrap_or_else(|| "system default".to_string());

        Self {
            devices,
            default_device_id,
            default_device_name,
        }
    }
}

/// Resolves the configured output device when it is currently available.
fn desired_audio_output_device(
    settings: &DeskSettings,
    devices: &HashMap<String, String>,
) -> Option<String> {
    settings
        .audio_device
        .as_ref()
        .filter(|device_id| devices.contains_key(*device_id))
        .cloned()
}

/// Returns whether the selected output device disappeared from the available set.
fn selected_audio_device_missing(
    settings: &DeskSettings,
    devices: &HashMap<String, String>,
) -> bool {
    settings
        .audio_device
        .as_ref()
        .is_some_and(|device_id| !devices.contains_key(device_id))
}

/// Computes display names for newly added and removed output devices.
fn changed_audio_device_names(
    previous: &HashMap<String, String>,
    current: &HashMap<String, String>,
) -> (Vec<String>, Vec<String>) {
    let mut added = current
        .iter()
        .filter(|(device_id, _)| !previous.contains_key(*device_id))
        .map(|(_, name)| name.clone())
        .collect::<Vec<_>>();
    added.sort();

    let mut removed = previous
        .iter()
        .filter(|(device_id, _)| !current.contains_key(*device_id))
        .map(|(_, name)| name.clone())
        .collect::<Vec<_>>();
    removed.sort();

    (added, removed)
}

/// Builds the monitor side effects for a single observed audio-device snapshot.
fn plan_audio_output_monitor_changes(
    settings: &DeskSettings,
    previous_devices: &HashMap<String, String>,
    snapshot: AudioOutputDeviceSnapshot,
    state: &AudioOutputMonitorState,
) -> AudioOutputMonitorPlan {
    let desired_device = desired_audio_output_device(settings, &snapshot.devices);
    let selected_device_missing = selected_audio_device_missing(settings, &snapshot.devices);
    let devices_changed = snapshot.devices != *previous_devices;
    let default_changed = state.last_default_device != snapshot.default_device_id;
    let should_reroute_default = state.initialized && desired_device.is_none() && default_changed;
    let should_reroute = desired_device != state.last_routed_device || should_reroute_default;
    let mut immediate_toasts = Vec::new();

    if selected_device_missing && !state.selected_device_missing {
        let missing_name = settings
            .audio_device
            .as_ref()
            .and_then(|device_id| previous_devices.get(device_id))
            .cloned()
            .or_else(|| settings.audio_device.clone())
            .unwrap_or_else(|| "selected audio output".to_string());
        immediate_toasts.push(AudioOutputToast {
            level: ToastLevel::Warning,
            message: format!(
                "Audio output '{}' is unavailable. Using system default until it returns.",
                missing_name
            ),
        });
    }

    if !selected_device_missing && state.selected_device_missing {
        let restored_name = settings
            .audio_device
            .as_ref()
            .and_then(|device_id| snapshot.devices.get(device_id))
            .cloned()
            .unwrap_or_else(|| "Selected audio output".to_string());
        immediate_toasts.push(AudioOutputToast {
            level: ToastLevel::Info,
            message: format!("Audio output '{}' is available again.", restored_name),
        });
    }

    let reroute_success_toast = should_reroute_default.then(|| AudioOutputToast {
        level: ToastLevel::Info,
        message: format!(
            "System default audio output changed to {}. Re-routing playback.",
            snapshot.default_device_name
        ),
    });

    AudioOutputMonitorPlan {
        devices: snapshot.devices,
        devices_changed,
        default_device_id: snapshot.default_device_id,
        selected_device_id: settings.audio_device.clone(),
        selected_device_missing,
        reroute_device: should_reroute.then_some(desired_device),
        immediate_toasts,
        reroute_success_toast,
    }
}

/// Emits a UI notification for an audio output monitor observation.
fn write_audio_output_toast(
    ui_notifications: &mut MessageWriter<UiNotification>,
    toast: AudioOutputToast,
) {
    ui_notifications.write(UiNotification::ShowToast {
        level: toast.level,
        message: toast.message,
    });
}

/// Polls OS audio outputs and re-routes playback when selections or defaults change.
fn monitor_audio_output_changes(
    settings: Res<DeskSettings>,
    mut available_audio_devices: ResMut<AvailableAudioDevices>,
    mut audio_controller: ResMut<AudioController>,
    mut ui_notifications: MessageWriter<UiNotification>,
    mut state: Local<AudioOutputMonitorState>,
) {
    let now = Instant::now();
    let selected_device_changed = state.last_selected_device != settings.audio_device;
    let poll_due = state
        .last_poll_at
        .is_none_or(|last_poll_at| now.duration_since(last_poll_at) >= AUDIO_DEVICE_POLL_INTERVAL);

    if state.initialized && !selected_device_changed && !poll_due {
        return;
    }

    state.last_poll_at = Some(now);

    let previous_devices = available_audio_devices.0.clone();
    let plan = plan_audio_output_monitor_changes(
        &settings,
        &previous_devices,
        AudioOutputDeviceSnapshot::capture(),
        &state,
    );

    if plan.devices_changed {
        let (added, removed) = changed_audio_device_names(&previous_devices, &plan.devices);
        if !added.is_empty() || !removed.is_empty() {
            tracing::info!(
                added = ?added,
                removed = ?removed,
                "Audio output devices changed"
            );
        }
        available_audio_devices.0 = plan.devices.clone();
    }

    for toast in plan.immediate_toasts.clone() {
        write_audio_output_toast(&mut ui_notifications, toast);
    }

    if let Some(reroute_device) = plan.reroute_device.clone()
        && audio_controller.reconfigure_output_device(reroute_device.clone())
    {
        if let Some(toast) = plan.reroute_success_toast.clone() {
            write_audio_output_toast(&mut ui_notifications, toast);
        }
        state.last_routed_device = reroute_device;
    }

    state.initialized = true;
    state.last_default_device = plan.default_device_id;
    state.last_selected_device = plan.selected_device_id;
    state.selected_device_missing = plan.selected_device_missing;
}

pub mod prelude {
    pub use crate::DeskAudioPlugin;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an audio device map for monitor planner tests.
    fn devices(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(id, name)| ((*id).to_string(), (*name).to_string()))
            .collect()
    }

    /// Builds an audio output snapshot with a selected default device.
    fn snapshot(
        entries: &[(&str, &str)],
        default_device_id: Option<&str>,
        default_device_name: &str,
    ) -> AudioOutputDeviceSnapshot {
        AudioOutputDeviceSnapshot {
            devices: devices(entries),
            default_device_id: default_device_id.map(str::to_string),
            default_device_name: default_device_name.to_string(),
        }
    }

    /// Applies a plan to the monitor state as if reconfiguration succeeded.
    fn apply_successful_monitor_plan(
        state: &mut AudioOutputMonitorState,
        plan: &AudioOutputMonitorPlan,
    ) {
        if let Some(reroute_device) = plan.reroute_device.clone() {
            state.last_routed_device = reroute_device;
        }

        state.initialized = true;
        state.last_default_device = plan.default_device_id.clone();
        state.last_selected_device = plan.selected_device_id.clone();
        state.selected_device_missing = plan.selected_device_missing;
    }

    /// Verifies selected audio output resolution prefers an available setting.
    #[test]
    fn desired_audio_output_device_prefers_available_selection() {
        let settings = DeskSettings {
            audio_device: Some("device-b".to_string()),
            ..DeskSettings::default()
        };

        assert_eq!(
            desired_audio_output_device(
                &settings,
                &devices(&[("device-a", "Built-in Output"), ("device-b", "USB DAC")])
            ),
            Some("device-b".to_string())
        );
    }

    /// Verifies selected audio output resolution falls back when the setting is missing.
    #[test]
    fn desired_audio_output_device_falls_back_when_selection_is_missing() {
        let settings = DeskSettings {
            audio_device: Some("device-missing".to_string()),
            ..DeskSettings::default()
        };

        assert_eq!(
            desired_audio_output_device(&settings, &devices(&[("device-a", "Built-in Output")])),
            None
        );
        assert!(selected_audio_device_missing(
            &settings,
            &devices(&[("device-a", "Built-in Output")])
        ));
    }

    /// Verifies device diffing reports stable display names for hotplug changes.
    #[test]
    fn changed_audio_device_names_reports_added_and_removed_devices() {
        let previous = devices(&[("device-a", "Built-in Output"), ("device-b", "USB DAC")]);
        let current = devices(&[("device-a", "Built-in Output"), ("device-c", "HDMI")]);

        let (added, removed) = changed_audio_device_names(&previous, &current);

        assert_eq!(added, vec!["HDMI".to_string()]);
        assert_eq!(removed, vec!["USB DAC".to_string()]);
    }

    /// Verifies a simulated system-default device change requests default re-routing.
    #[test]
    fn monitor_plan_reroutes_system_default_when_default_device_changes() {
        let settings = DeskSettings::default();
        let mut available_devices = devices(&[]);
        let mut state = AudioOutputMonitorState::default();

        let initial_plan = plan_audio_output_monitor_changes(
            &settings,
            &available_devices,
            snapshot(
                &[("built-in", "Built-in Output")],
                Some("built-in"),
                "Built-in Output",
            ),
            &state,
        );

        assert!(initial_plan.devices_changed);
        assert_eq!(initial_plan.reroute_device, None);
        assert_eq!(initial_plan.reroute_success_toast, None);
        available_devices = initial_plan.devices.clone();
        apply_successful_monitor_plan(&mut state, &initial_plan);

        let changed_default_plan = plan_audio_output_monitor_changes(
            &settings,
            &available_devices,
            snapshot(
                &[("built-in", "Built-in Output"), ("usb", "USB DAC")],
                Some("usb"),
                "USB DAC",
            ),
            &state,
        );

        assert!(changed_default_plan.devices_changed);
        assert_eq!(changed_default_plan.reroute_device, Some(None));
        assert_eq!(
            changed_default_plan.reroute_success_toast,
            Some(AudioOutputToast {
                level: ToastLevel::Info,
                message: "System default audio output changed to USB DAC. Re-routing playback."
                    .to_string(),
            })
        );
        available_devices = changed_default_plan.devices.clone();
        apply_successful_monitor_plan(&mut state, &changed_default_plan);

        let removed_old_default_plan = plan_audio_output_monitor_changes(
            &settings,
            &available_devices,
            snapshot(&[("usb", "USB DAC")], Some("usb"), "USB DAC"),
            &state,
        );

        assert!(removed_old_default_plan.devices_changed);
        assert_eq!(removed_old_default_plan.reroute_device, None);
        assert_eq!(removed_old_default_plan.reroute_success_toast, None);
    }

    /// Verifies a simulated selected-device unplug and replug emits fallback notifications.
    #[test]
    fn monitor_plan_reports_selected_device_disappearing_and_returning() {
        let settings = DeskSettings {
            audio_device: Some("usb".to_string()),
            ..DeskSettings::default()
        };
        let mut available_devices = devices(&[]);
        let mut state = AudioOutputMonitorState::default();

        let initial_plan = plan_audio_output_monitor_changes(
            &settings,
            &available_devices,
            snapshot(
                &[("built-in", "Built-in Output"), ("usb", "USB DAC")],
                Some("built-in"),
                "Built-in Output",
            ),
            &state,
        );

        assert_eq!(initial_plan.reroute_device, Some(Some("usb".to_string())));
        assert!(initial_plan.immediate_toasts.is_empty());
        available_devices = initial_plan.devices.clone();
        apply_successful_monitor_plan(&mut state, &initial_plan);

        let unplug_plan = plan_audio_output_monitor_changes(
            &settings,
            &available_devices,
            snapshot(
                &[("built-in", "Built-in Output")],
                Some("built-in"),
                "Built-in Output",
            ),
            &state,
        );

        assert!(unplug_plan.selected_device_missing);
        assert_eq!(unplug_plan.reroute_device, Some(None));
        assert_eq!(
            unplug_plan.immediate_toasts,
            vec![AudioOutputToast {
                level: ToastLevel::Warning,
                message:
                    "Audio output 'USB DAC' is unavailable. Using system default until it returns."
                        .to_string(),
            }]
        );
        available_devices = unplug_plan.devices.clone();
        apply_successful_monitor_plan(&mut state, &unplug_plan);

        let replug_plan = plan_audio_output_monitor_changes(
            &settings,
            &available_devices,
            snapshot(
                &[("built-in", "Built-in Output"), ("usb", "USB DAC")],
                Some("built-in"),
                "Built-in Output",
            ),
            &state,
        );

        assert!(!replug_plan.selected_device_missing);
        assert_eq!(replug_plan.reroute_device, Some(Some("usb".to_string())));
        assert_eq!(
            replug_plan.immediate_toasts,
            vec![AudioOutputToast {
                level: ToastLevel::Info,
                message: "Audio output 'USB DAC' is available again.".to_string(),
            }]
        );
    }
}
