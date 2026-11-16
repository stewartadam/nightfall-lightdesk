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

use crate::discovery::discover_devices;

/// Compatible USB DMX devices currently visible to the host, as offered to clients.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq)]
pub struct AvailableUsbDmxDevices(pub Vec<UsbDmxDeviceInfo>);

impl AvailableUsbDmxDevices {
    /// Lists the compatible USB DMX devices the host can see now, sorted by label, or none when
    /// the OS device list cannot be read.
    pub(crate) fn scan() -> Self {
        let mut devices = discover_devices()
            .unwrap_or_default()
            .iter()
            .map(|device| device.to_device_info())
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
        Self(devices)
    }
}

/// USB DMX device messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum UsbDmxWsMessage<'a> {
    /// Compatible USB DMX devices currently visible to the host.
    AvailableUsbDmxDevices(&'a [UsbDmxDeviceInfo]),
}

impl ResourceFeed for AvailableUsbDmxDevices {
    /// Publishes the compatible USB DMX devices, refreshed on hotplug.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &UsbDmxWsMessage::AvailableUsbDmxDevices(&self.0),
        );
    }
}
