// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Keeps each USB DMX output's adapter status current and tells operators when an output needs
//! them to confirm which adapter it drives.
//!
//! Adapters that report the same serial number can only be told apart by the USB port they are
//! plugged into. These toasts point at the I/O Transports panel and offer one-click fixes that
//! save the port an adapter is on now.

use std::collections::{BTreeMap, BTreeSet};

use bevy_ecs::prelude::*;
use nightfall_io::prelude::{
    AvailableUsbDmxDevices, IoRuntimeSettings, TransportRuntimePolicy, UsbDmxDeviceAssignment,
    UsbDmxDeviceInfo, UsbDmxOutputTargets, UsbDmxTargetStates, UsbDmxTargetStatus,
    usb_dmx_selector_port,
};

use crate::ui_notification::{ToastAction, ToastLevel, UiNotification};

/// Recomputes every USB output's adapter status when the saved outputs or the attached adapters
/// change.
pub fn resolve_usb_dmx_target_states(
    targets: Res<UsbDmxOutputTargets>,
    devices: Res<AvailableUsbDmxDevices>,
    mut states: ResMut<UsbDmxTargetStates>,
) {
    if !targets.is_changed() && !devices.is_changed() {
        return;
    }
    states.set_if_neq(UsbDmxTargetStates::resolve(&targets.targets, &devices.0));
}

/// What was last announced, so each problem is toasted once when it appears.
#[derive(Default)]
pub struct AnnouncedUsbDmxProblems {
    /// Status each target had at the last check.
    statuses: BTreeMap<String, UsbDmxTargetStatus>,
    /// Serial numbers shared by attached adapters that are not all assigned to outputs.
    unassigned_shared_serials: BTreeSet<String>,
}

/// Toasts USB output problems as they appear: an adapter found on a new port, an adapter that
/// several outputs could claim, a missing adapter whose twin is on another port, and adapters
/// sharing a serial number that are not all assigned yet.
///
/// Nothing is announced while USB output is off. Turning it on announces the problems present
/// at that moment.
pub fn announce_usb_dmx_target_changes(
    states: Res<UsbDmxTargetStates>,
    devices: Res<AvailableUsbDmxDevices>,
    targets: Res<UsbDmxOutputTargets>,
    io_settings: Res<IoRuntimeSettings>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    mut announced: Local<AnnouncedUsbDmxProblems>,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    if !states.is_changed() && !io_settings.is_changed() {
        return;
    }
    let policy = transport_policy.map(|policy| *policy).unwrap_or_default();
    if !policy.usb_output_enabled(&io_settings) {
        *announced = AnnouncedUsbDmxProblems::default();
        return;
    }
    let current = UsbDmxProblems::new(&states, &devices.0);
    ui_notifications.write_batch(usb_dmx_toasts(&announced, &current, &targets, &devices.0));
    *announced = current.into_announced();
}

/// Current problem state derived from the target statuses and attached adapters.
struct UsbDmxProblems {
    statuses: BTreeMap<String, UsbDmxTargetStatus>,
    /// Serial number to the adapters reporting it, for serials shared by unassigned adapters.
    unassigned_shared_serials: BTreeMap<String, Vec<UsbDmxDeviceInfo>>,
}

impl UsbDmxProblems {
    /// Collects the statuses and the serial numbers shared by adapters not all driving an output.
    fn new(states: &UsbDmxTargetStates, devices: &[UsbDmxDeviceInfo]) -> Self {
        let statuses = states
            .states
            .iter()
            .map(|state| (state.target.clone(), state.status.clone()))
            .collect::<BTreeMap<_, _>>();
        let assigned = statuses
            .values()
            .filter_map(UsbDmxTargetStatus::output_device)
            .collect::<BTreeSet<_>>();
        let mut by_serial = BTreeMap::<String, Vec<UsbDmxDeviceInfo>>::new();
        for device in devices {
            if let Some(serial) = device.serial_number.as_deref().map(str::trim)
                && !serial.is_empty()
            {
                by_serial
                    .entry(serial.to_string())
                    .or_default()
                    .push(device.clone());
            }
        }
        by_serial.retain(|_, group| {
            group.len() > 1
                && group
                    .iter()
                    .any(|device| !assigned.contains(device.id.as_str()))
        });
        Self {
            statuses,
            unassigned_shared_serials: by_serial,
        }
    }

    /// Keeps what later checks compare against.
    fn into_announced(self) -> AnnouncedUsbDmxProblems {
        AnnouncedUsbDmxProblems {
            statuses: self.statuses,
            unassigned_shared_serials: self.unassigned_shared_serials.into_keys().collect(),
        }
    }
}

/// Builds the toasts for problems in `current` that were not already announced.
fn usb_dmx_toasts(
    announced: &AnnouncedUsbDmxProblems,
    current: &UsbDmxProblems,
    targets: &UsbDmxOutputTargets,
    devices: &[UsbDmxDeviceInfo],
) -> Vec<UiNotification> {
    let saved_port = |target: &str| {
        targets
            .get(target)
            .and_then(|target| usb_dmx_selector_port(&target.device))
            .unwrap_or("?")
            .to_string()
    };
    let new_statuses = current
        .statuses
        .iter()
        .filter(|(target, status)| announced.statuses.get(*target) != Some(*status))
        .collect::<Vec<_>>();

    let mut toasts = Vec::new();
    let mut covered_serials = BTreeSet::new();
    let mut choice_devices = BTreeSet::<&str>::new();
    for (target, status) in &new_statuses {
        match status {
            UsbDmxTargetStatus::Moved { device } => {
                toasts.push(UiNotification::toast_with_actions(
                    ToastLevel::Info,
                    format!(
                        "The USB DMX adapter for output \"{target}\" is now on port {} instead of \
                     port {}. Output follows it there.",
                        device_port(device),
                        saved_port(target)
                    ),
                    vec![ToastAction::UpdateUsbDmxPort(assignment(target, device))],
                ))
            }
            UsbDmxTargetStatus::OtherPort { device } => {
                covered_serials.extend(device_serial(devices, device));
                toasts.push(UiNotification::toast_with_actions(
                    ToastLevel::Warning,
                    format!(
                        "USB output \"{target}\" has no adapter on port {}. A matching adapter is \
                         on port {}, but adapters that share a serial number are told apart by \
                         port, so output stays off until you confirm it.",
                        saved_port(target),
                        device_port(device)
                    ),
                    vec![
                        ToastAction::UpdateUsbDmxPort(assignment(target, device)),
                        ToastAction::OpenUsbDmxOutputs,
                    ],
                ));
            }
            UsbDmxTargetStatus::NeedsChoice { device } => {
                choice_devices.insert(device);
            }
            _ => {}
        }
    }
    for device in choice_devices {
        // Name every output the adapter could drive, including ones already waiting on it.
        let mut candidates = current
            .statuses
            .iter()
            .filter(|(_, status)| {
                matches!(status, UsbDmxTargetStatus::NeedsChoice { device: other } if other == device)
            })
            .map(|(target, _)| target.as_str())
            .collect::<Vec<_>>();
        candidates.sort_unstable();
        let mut actions = candidates
            .iter()
            .map(|target| ToastAction::ChooseUsbDmxOutput(assignment(target, device)))
            .collect::<Vec<_>>();
        actions.push(ToastAction::OpenUsbDmxOutputs);
        toasts.push(UiNotification::toast_with_actions(
            ToastLevel::Warning,
            format!(
                "The USB DMX adapter on port {} could be output {}. Choose which output it drives.",
                device_port(device),
                quoted_list(&candidates, "or")
            ),
            actions,
        ));
    }
    for (serial, group) in &current.unassigned_shared_serials {
        if announced.unassigned_shared_serials.contains(serial) || covered_serials.contains(serial)
        {
            continue;
        }
        let ports = group
            .iter()
            .map(|device| format!("port {}", device_port(&device.id)))
            .collect::<Vec<_>>();
        let port_refs = ports.iter().map(String::as_str).collect::<Vec<_>>();
        toasts.push(UiNotification::toast_with_actions(
            ToastLevel::Warning,
            format!(
                "USB DMX adapters on {} report the same serial number, so Nightfall tells them \
                 apart by port. Assign each one to an output and keep it plugged into that port.",
                plain_list(&port_refs, "and")
            ),
            vec![ToastAction::OpenUsbDmxOutputs],
        ));
    }
    toasts
}

/// Builds the assignment a toast action sends back.
fn assignment(target: &str, device: &str) -> UsbDmxDeviceAssignment {
    UsbDmxDeviceAssignment {
        target: target.to_string(),
        device: device.to_string(),
    }
}

/// Returns the port named by an attached adapter's selector.
fn device_port(device: &str) -> &str {
    usb_dmx_selector_port(device).unwrap_or("?")
}

/// Returns the serial number of the attached adapter with the given selector.
fn device_serial(devices: &[UsbDmxDeviceInfo], device: &str) -> Option<String> {
    devices
        .iter()
        .find(|candidate| candidate.id == device)
        .and_then(|device| device.serial_number.as_deref())
        .map(|serial| serial.trim().to_string())
}

/// Joins quoted names as `"a"`, `"a" or "b"`, or `"a", "b" or "c"`.
fn quoted_list(names: &[&str], conjunction: &str) -> String {
    let quoted = names
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>();
    let refs = quoted.iter().map(String::as_str).collect::<Vec<_>>();
    plain_list(&refs, conjunction)
}

/// Joins items as `a`, `a and b`, or `a, b and c`.
fn plain_list(items: &[&str], conjunction: &str) -> String {
    match items {
        [] => String::new(),
        [only] => (*only).to_string(),
        [rest @ .., last] => format!("{} {conjunction} {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::App;
    use nightfall_io::prelude::{UDMX_PRODUCT_ID, UDMX_VENDOR_ID, UsbDmxOutputTarget};

    use super::*;

    /// Builds attached uDMX info with serial `0001` on port `20:<port>`.
    fn twin(port: &str) -> UsbDmxDeviceInfo {
        UsbDmxDeviceInfo {
            id: format!("id-16c0:05dc,serial-0001,port-20:{port}"),
            label: "Anyma uDMX".to_string(),
            vendor_id: UDMX_VENDOR_ID,
            product_id: UDMX_PRODUCT_ID,
            manufacturer: Some("Anyma".to_string()),
            product: Some("uDMX".to_string()),
            serial_number: Some("0001".to_string()),
            location: Some(format!("bus 20 port {port}")),
        }
    }

    /// Builds a target saved for the twin on port `20:<port>`.
    fn target(id: &str, port: &str) -> UsbDmxOutputTarget {
        UsbDmxOutputTarget {
            id: id.to_string(),
            device: format!("id-16c0:05dc,serial-0001,port-20:{port}"),
            device_label: Some("Anyma uDMX".to_string()),
        }
    }

    /// Builds an app running both systems with USB output on and the given saved targets.
    fn app(targets: Vec<UsbDmxOutputTarget>) -> App {
        let mut app = App::new();
        app.add_message::<UiNotification>();
        app.insert_resource(UsbDmxOutputTargets { targets });
        app.init_resource::<AvailableUsbDmxDevices>();
        app.init_resource::<UsbDmxTargetStates>();
        app.insert_resource(IoRuntimeSettings {
            usb_output_enabled: true,
            ..Default::default()
        });
        app.add_systems(
            bevy_app::Update,
            (
                resolve_usb_dmx_target_states,
                announce_usb_dmx_target_changes,
            )
                .chain(),
        );
        app
    }

    /// Attaches `devices`, runs one update and returns the toasts it produced.
    fn attach(app: &mut App, devices: Vec<UsbDmxDeviceInfo>) -> Vec<(String, Vec<ToastAction>)> {
        app.world_mut().resource_mut::<AvailableUsbDmxDevices>().0 = devices;
        app.update();
        app.world_mut()
            .resource_mut::<Messages<UiNotification>>()
            .drain()
            .filter_map(|notification| match notification {
                UiNotification::ShowToast {
                    message, actions, ..
                } => Some((message, actions)),
                _ => None,
            })
            .collect()
    }

    /// Verifies a lone twin on a new port prompts once with a choice for each saved twin output,
    /// and output stays off until one is chosen.
    #[test]
    fn lone_twin_prompts_for_which_output_it_drives() {
        let mut app = app(vec![target("left", "1"), target("right", "2")]);
        let device = twin("3");

        let toasts = attach(&mut app, vec![device.clone()]);

        assert_eq!(toasts.len(), 1, "{toasts:?}");
        assert!(
            toasts[0].0.contains("\"left\" or \"right\""),
            "{}",
            toasts[0].0
        );
        assert_eq!(
            toasts[0].1,
            vec![
                ToastAction::ChooseUsbDmxOutput(assignment("left", &device.id)),
                ToastAction::ChooseUsbDmxOutput(assignment("right", &device.id)),
                ToastAction::OpenUsbDmxOutputs,
            ]
        );
        let states = app.world().resource::<UsbDmxTargetStates>();
        assert_eq!(states.output_selector(&target("left", "1").device), None);

        app.world_mut()
            .resource_mut::<AvailableUsbDmxDevices>()
            .set_changed();
        app.update();
        assert!(
            app.world()
                .resource::<Messages<UiNotification>>()
                .is_empty(),
            "an unchanged problem is announced once"
        );
    }

    /// Verifies a twin plugged into a port no output names offers to update the port of the
    /// output waiting for it.
    #[test]
    fn twin_on_other_port_offers_update_port() {
        let mut app = app(vec![target("left", "1"), target("right", "2")]);
        let moved = twin("3");

        let toasts = attach(&mut app, vec![twin("2"), moved.clone()]);

        assert_eq!(toasts.len(), 1, "{toasts:?}");
        assert!(toasts[0].0.contains("port 20:1"), "{}", toasts[0].0);
        assert!(toasts[0].0.contains("port 20:3"), "{}", toasts[0].0);
        assert_eq!(
            toasts[0].1,
            vec![
                ToastAction::UpdateUsbDmxPort(assignment("left", &moved.id)),
                ToastAction::OpenUsbDmxOutputs,
            ]
        );
    }

    /// Verifies a second adapter with an assigned adapter's serial warns until it is assigned,
    /// and twins on their own saved ports raise nothing.
    #[test]
    fn shared_serial_warns_only_while_an_adapter_is_unassigned() {
        let mut app = app(vec![target("left", "1")]);

        let toasts = attach(&mut app, vec![twin("1"), twin("2")]);
        assert_eq!(toasts.len(), 1, "{toasts:?}");
        assert!(
            toasts[0].0.contains("port 20:1 and port 20:2"),
            "{}",
            toasts[0].0
        );
        assert_eq!(toasts[0].1, vec![ToastAction::OpenUsbDmxOutputs]);

        let mut paired = app_with_twins_assigned();
        assert!(attach(&mut paired, vec![twin("1"), twin("2")]).is_empty());
    }

    /// Builds an app whose two outputs are saved for twins on ports 1 and 2.
    fn app_with_twins_assigned() -> App {
        app(vec![target("left", "1"), target("right", "2")])
    }

    /// Verifies a unique adapter on a new port is followed and offers to save its new port.
    #[test]
    fn moved_adapter_offers_update_port() {
        let mut app = app(vec![target("left", "1")]);
        let moved = twin("4");

        let toasts = attach(&mut app, vec![moved.clone()]);

        assert_eq!(toasts.len(), 1, "{toasts:?}");
        assert_eq!(
            toasts[0].1,
            vec![ToastAction::UpdateUsbDmxPort(assignment("left", &moved.id))]
        );
        let states = app.world().resource::<UsbDmxTargetStates>();
        assert_eq!(
            states.output_selector(&target("left", "1").device),
            Some(moved.id.as_str())
        );
    }

    /// Verifies nothing is announced while USB output is off, and turning it on announces the
    /// problems present at that moment.
    #[test]
    fn usb_output_off_stays_quiet_until_turned_on() {
        let mut app = app(vec![target("left", "1"), target("right", "2")]);
        app.world_mut()
            .resource_mut::<IoRuntimeSettings>()
            .usb_output_enabled = false;

        assert!(attach(&mut app, vec![twin("3")]).is_empty());

        app.world_mut()
            .resource_mut::<IoRuntimeSettings>()
            .usb_output_enabled = true;
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<UiNotification>>()
                .drain()
                .count(),
            1
        );
    }
}
