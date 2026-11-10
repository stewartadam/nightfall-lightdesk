// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! DMX output through USB DMX interfaces.
//!
//! A process-lifetime worker writes the composed frame for each USB output target to its
//! device. Each device's USB vendor and product ID pick the protocol that drives it.

#![warn(missing_docs)]

use std::sync::mpsc::{Receiver, TryRecvError};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::{IoRuntimeSettings, TransportRuntimePolicy};

mod device_list;
mod discovery;
mod driver;
mod output;
mod serial_port;
mod service;
mod udmx;
mod usb_pro;

pub use device_list::AvailableUsbDmxDevices;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::{AvailableUsbDmxDevices, OutputUsbDmxPlugin};
}

/// Plugin for adding USB DMX output to the app
pub struct OutputUsbDmxPlugin;

/// Receiver for compatible USB DMX hotplug notifications from the output service.
struct UsbDmxHotplugNotifications {
    event_rx: Receiver<()>,
    disconnected: bool,
}

/// Retimes the USB DMX output worker whenever IO settings change, including a showfile load
/// replacing them, so USB devices are written on the same ticks as network DMX output.
fn sync_usb_dmx_output_rate(settings: Res<IoRuntimeSettings>) {
    service::process_usb_dmx_output_service().sync_with_settings(&settings);
}

/// Refreshes the USB DMX device list after output-service hotplug events.
fn refresh_available_usb_dmx_devices(
    mut available_usb_dmx_devices: ResMut<AvailableUsbDmxDevices>,
    mut notifications: NonSendMut<UsbDmxHotplugNotifications>,
) {
    if notifications.disconnected {
        return;
    }

    let mut saw_event = false;
    loop {
        match notifications.event_rx.try_recv() {
            Ok(()) => saw_event = true,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                tracing::warn!(
                    "USB hotplug notification stream disconnected; USB device list will not auto-refresh"
                );
                notifications.disconnected = true;
                break;
            }
        }
    }

    if !saw_event {
        return;
    }

    let next_devices = AvailableUsbDmxDevices::scan();
    if *available_usb_dmx_devices != next_devices {
        tracing::info!(
            previous_count = available_usb_dmx_devices.0.len(),
            current_count = next_devices.0.len(),
            "USB DMX devices changed"
        );
        *available_usb_dmx_devices = next_devices;
    }
}

impl Plugin for OutputUsbDmxPlugin {
    /// Registers the USB DMX output worker, hotplug-driven USB discovery refresh, and the
    /// device list feed.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering OutputUsbDmxPlugin");
        app.init_resource::<TransportRuntimePolicy>();
        let usb_service = service::process_usb_dmx_output_service();
        let _ = usb_service.ensure_started();
        app.insert_resource(AvailableUsbDmxDevices::scan());
        app.insert_non_send(UsbDmxHotplugNotifications {
            event_rx: usb_service.subscribe_hotplug_events(),
            disconnected: false,
        });
        app.insert_resource(usb_service.client());
        app.add_systems(
            Update,
            (
                refresh_available_usb_dmx_devices.in_set(EventHandling),
                sync_usb_dmx_output_rate
                    .after(EventHandling)
                    .run_if(resource_exists_and_changed::<IoRuntimeSettings>),
            ),
        );
        app.add_resource_feed::<AvailableUsbDmxDevices>();
        app.add_systems(
            Render,
            output::output
                .after(nightfall_fixtures::output_frames::compose_output_frames)
                .in_set(DmxOutput),
        );
    }
}
