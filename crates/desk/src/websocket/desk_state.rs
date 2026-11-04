// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Host settings and device list projectors.

use super::*;

/// Sends host-owned external control and telemetry state when either changes.
pub fn send_host_state_on_change(
    external_control: Res<ExternalControlState>,
    telemetry: Res<crate::settings::TelemetryState>,
    broadcaster: Res<ClientEventSink>,
) {
    if external_control.is_changed() {
        send_external_control_state(&external_control, &broadcaster);
    }
    if telemetry.is_changed() {
        send_telemetry_state(&telemetry, &broadcaster);
    }
}

/// Send available audio devices when the desk-facing resource changes.
pub fn send_available_audio_devices_on_change(
    available_audio_devices: Res<AvailableAudioDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if !available_audio_devices.is_changed() {
        return;
    }

    send_available_audio_devices(available_audio_devices.as_ref(), &broadcaster);
}

/// Send compatible USB DMX devices when the desk-facing resource changes.
pub fn send_available_usb_dmx_devices_on_change(
    available_usb_dmx_devices: Res<AvailableUsbDmxDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if !available_usb_dmx_devices.is_changed() {
        return;
    }

    send_available_usb_dmx_devices(&available_usb_dmx_devices.0, &broadcaster);
}

/// Broadcast network interface list and current/default status from a single snapshot.
pub fn send_network_interface_state(
    settings: &IoRuntimeSettings,
    network_interface_state: &NetworkInterfaceState,
    broadcaster: &ClientEventSink,
) {
    let status = resolve_network_interface_status(settings, network_interface_state);
    broadcast_available_network_interfaces(
        &network_interface_state.available_interfaces,
        broadcaster,
    );
    broadcast_network_interface_status(&status, broadcaster);
}

/// Broadcast available audio devices (helper for callers)
pub fn send_available_audio_devices(
    devices: &AvailableAudioDevices,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::AvailableAudioDevices(&devices.0),
    );
    tracing::trace!("Sending available audio devices to websocket clients");
}

/// Broadcast compatible USB DMX devices to websocket clients.
pub fn send_available_usb_dmx_devices(devices: &[UsbDmxDeviceInfo], broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::AvailableUsbDmxDevices(devices),
    );
    tracing::trace!(
        count = devices.len(),
        "Sending available USB DMX devices to websocket clients"
    );
}

/// Serializes and broadcasts the available network-interface list.
fn broadcast_available_network_interfaces(
    interfaces: &[NetworkInterfaceInfo],
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::AvailableNetworkInterfaces(interfaces),
    );
    tracing::trace!("Sending available network interfaces to websocket clients");
}

/// Resolves and broadcasts the current/default network-interface status.
fn broadcast_network_interface_status(
    status: &NetworkInterfaceStatus,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::NetworkInterfaceStatus(status),
    );
    tracing::trace!("Sending network interface status to websocket clients");
}

/// Publishes host telemetry consent so every connected client shows the same choices.
pub fn send_telemetry_state(
    state: &crate::settings::TelemetryState,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::TelemetryState(state),
    );
}

/// Publishes host control preferences and actual listener status to clients.
pub fn send_external_control_state(state: &ExternalControlState, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::ExternalControlState(state),
    );
}
