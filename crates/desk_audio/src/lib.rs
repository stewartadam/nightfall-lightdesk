// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::thread::JoinHandle;
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

/// Owns at most one discovery worker and the latest completed device snapshot.
#[derive(Resource, Debug, Default)]
struct AudioOutputDiscovery {
    pending: Option<JoinHandle<AudioOutputDeviceSnapshot>>,
    last_poll_at: Option<Instant>,
    snapshot: Option<AudioOutputDeviceSnapshot>,
}

impl AudioOutputDiscovery {
    /// Starts one OS query without waiting for device enumeration or stream configuration.
    fn start(
        &mut self,
        now: Instant,
        capture: impl FnOnce() -> AudioOutputDeviceSnapshot + Send + 'static,
    ) {
        if self.pending.is_some() {
            return;
        }
        self.last_poll_at = Some(now);
        match std::thread::Builder::new()
            .name("audio-device-discovery".to_string())
            .spawn(capture)
        {
            Ok(worker) => self.pending = Some(worker),
            Err(error) => tracing::warn!(%error, "Could not start audio device discovery"),
        }
    }

    /// Consumes only finished workers, retaining the cache on failure and retrying at poll cadence.
    fn poll(&mut self, now: Instant) -> bool {
        let mut updated = false;
        if self.pending.as_ref().is_some_and(JoinHandle::is_finished) {
            // A finished worker cannot hold up the engine while joining.
            match self
                .pending
                .take()
                .expect("finished discovery worker")
                .join()
            {
                Ok(snapshot) => {
                    self.snapshot = Some(snapshot);
                    updated = true;
                }
                Err(_) => tracing::warn!("Audio device discovery worker panicked"),
            }
        }
        if self.pending.is_none()
            && self
                .last_poll_at
                .is_none_or(|last| now.duration_since(last) >= AUDIO_DEVICE_POLL_INTERVAL)
        {
            self.start(now, AudioOutputDeviceSnapshot::capture);
        }
        updated
    }
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

        app.init_resource::<AudioOutputDiscovery>();
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

/// Consumes background device discovery and queues routing changes without waiting on OS audio APIs.
fn monitor_audio_output_changes(
    settings: Res<DeskSettings>,
    mut available_audio_devices: ResMut<AvailableAudioDevices>,
    mut audio_controller: ResMut<AudioController>,
    mut ui_notifications: MessageWriter<UiNotification>,
    mut state: Local<AudioOutputMonitorState>,
    mut discovery: ResMut<AudioOutputDiscovery>,
) {
    let snapshot_updated = discovery.poll(Instant::now());
    let selected_device_changed = state.last_selected_device != settings.audio_device;

    if state.initialized && !selected_device_changed && !snapshot_updated {
        return;
    }
    let Some(snapshot) = discovery.snapshot.clone() else {
        return;
    };

    let previous_devices = available_audio_devices.0.clone();
    let plan = plan_audio_output_monitor_changes(&settings, &previous_devices, snapshot, &state);

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

    /// Counts engine updates independently of discovery progress.
    fn count_updates(mut updates: ResMut<UpdateCount>) {
        updates.0 += 1;
    }

    #[derive(Resource, Default)]
    struct UpdateCount(usize);

    /// Proves a blocked OS query neither blocks Update nor allows overlapping polls.
    #[test]
    fn slow_discovery_does_not_stall_engine_updates() {
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let engine_thread = std::thread::current().id();
        let mut discovery = AudioOutputDiscovery::default();
        discovery.start(Instant::now(), move || {
            assert_ne!(std::thread::current().id(), engine_thread);
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            snapshot(&[("usb", "USB DAC")], Some("usb"), "USB DAC")
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // Make another periodic poll due while the first query remains blocked.
        discovery.last_poll_at = Some(Instant::now() - AUDIO_DEVICE_POLL_INTERVAL);
        discovery.start(Instant::now(), || panic!("overlapping discovery"));

        let mut app = App::new();
        app.insert_resource(discovery)
            .init_resource::<DeskSettings>()
            .init_resource::<AvailableAudioDevices>()
            .init_resource::<UpdateCount>()
            .insert_resource(AudioController::new(Default::default()))
            .add_message::<UiNotification>()
            .add_systems(Update, (monitor_audio_output_changes, count_updates));
        let started = Instant::now();
        for _ in 0..100 {
            app.update();
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(app.world().resource::<UpdateCount>().0, 100);
        assert!(app.world().resource::<AvailableAudioDevices>().0.is_empty());
        assert!(
            !app.world()
                .resource::<AudioOutputDiscovery>()
                .pending
                .as_ref()
                .unwrap()
                .is_finished()
        );

        // Avoid starting a real OS query when consuming the synthetic result.
        app.world_mut()
            .resource_mut::<AudioOutputDiscovery>()
            .last_poll_at = Some(Instant::now());
        app.world_mut().resource_mut::<DeskSettings>().audio_device = Some("usb".to_string());
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !app
            .world()
            .resource::<AudioOutputDiscovery>()
            .pending
            .as_ref()
            .unwrap()
            .is_finished()
        {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        app.update();
        assert_eq!(
            app.world().resource::<AvailableAudioDevices>().0,
            devices(&[("usb", "USB DAC")])
        );
        assert!(
            app.world()
                .resource::<AudioOutputDiscovery>()
                .pending
                .is_none()
        );
        app.update();
        assert_eq!(app.world().resource::<UpdateCount>().0, 102);
    }

    /// Setting edits use the cached snapshot immediately, including fallback notifications.
    #[test]
    fn selection_changes_use_cached_devices_between_polls() {
        let mut app = App::new();
        app.insert_resource(AudioOutputDiscovery {
            snapshot: Some(snapshot(&[("usb", "USB DAC")], Some("usb"), "USB DAC")),
            last_poll_at: Some(Instant::now()),
            ..Default::default()
        })
        .init_resource::<DeskSettings>()
        .init_resource::<AvailableAudioDevices>()
        .insert_resource(AudioController::new(Default::default()))
        .add_message::<UiNotification>()
        .add_systems(Update, monitor_audio_output_changes);
        app.update();
        let mut cursor = app
            .world()
            .resource::<Messages<UiNotification>>()
            .get_cursor();
        app.world_mut().resource_mut::<DeskSettings>().audio_device = Some("missing".to_string());
        app.update();
        let notifications = app.world().resource::<Messages<UiNotification>>();
        assert!(cursor.read(notifications).any(|notification| matches!(notification,
            UiNotification::ShowToast { level: ToastLevel::Warning, message } if message.contains("unavailable")
        )));
        app.world_mut().resource_mut::<DeskSettings>().audio_device = Some("usb".to_string());
        app.update();
        let notifications = app.world().resource::<Messages<UiNotification>>();
        assert!(cursor.read(notifications).any(|notification| matches!(notification,
            UiNotification::ShowToast { level: ToastLevel::Info, message } if message.contains("available again")
        )));
        assert!(
            app.world()
                .resource::<AudioOutputDiscovery>()
                .pending
                .is_none()
        );
    }

    /// A failed worker leaves the last device list usable and permits a later retry.
    #[test]
    fn discovery_recovers_after_worker_panic() {
        let cached = snapshot(&[("usb", "USB DAC")], Some("usb"), "USB DAC");
        let mut discovery = AudioOutputDiscovery {
            snapshot: Some(cached.clone()),
            ..Default::default()
        };
        discovery.start(Instant::now(), || panic!("simulated discovery failure"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !discovery.pending.as_ref().unwrap().is_finished() {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(!discovery.poll(Instant::now()));
        assert_eq!(discovery.snapshot, Some(cached));
        assert!(discovery.pending.is_none());
        discovery.start(Instant::now(), || snapshot(&[], None, "system default"));
        while !discovery.pending.as_ref().unwrap().is_finished() {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(discovery.poll(Instant::now()));
        assert_eq!(
            discovery.snapshot,
            Some(snapshot(&[], None, "system default"))
        );
    }

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
