// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The compatible USB DMX devices the host can see, and their client feed.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::UsbDmxDeviceInfo;
use serde::Serialize;

/// Compatible USB DMX devices currently visible to the host, as offered to clients.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq)]
pub struct AvailableUsbDmxDevices(pub Vec<UsbDmxDeviceInfo>);

/// USB DMX device messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum UsbDmxWsMessage<'a> {
    /// Compatible USB DMX devices currently visible to the host.
    AvailableUsbDmxDevices(&'a [UsbDmxDeviceInfo]),
}

/// Publishes the compatible USB DMX devices to clients.
fn send_available_usb_dmx_devices(devices: &[UsbDmxDeviceInfo], broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &UsbDmxWsMessage::AvailableUsbDmxDevices(devices),
    );
    tracing::trace!(
        count = devices.len(),
        "Sending available USB DMX devices to websocket clients"
    );
}

/// Publishes the device list whenever a hotplug refresh changes it.
pub(crate) fn send_available_usb_dmx_devices_on_change(
    devices: Res<AvailableUsbDmxDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if devices.is_changed() {
        send_available_usb_dmx_devices(&devices.0, &broadcaster);
    }
}

/// Sends the device list to a client that asked for a full resync.
pub(crate) fn handle_resync_state(mut resync: ResyncReplies, devices: Res<AvailableUsbDmxDevices>) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_available_usb_dmx_devices(&devices.0, &broadcaster);
}
