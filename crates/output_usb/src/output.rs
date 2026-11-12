// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Hands the composed USB DMX frames to the process-lifetime output worker.

use bevy_ecs::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::{IoRuntimeSettings, OutputTransport, TransportRuntimePolicy};

use crate::{
    service::{UsbDmxFrame, UsbDmxOutputClient},
    targets::UsbDmxTargetStates,
};

/// Publishes every composed USB DMX wire frame for its selected device.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each USB device. Each frame goes to the
/// adapter [`UsbDmxTargetStates`] resolved its saved selector to, and nothing is published for
/// an output whose adapter is missing or still to be chosen. The output worker writes
/// whatever was published last on the shared tick grid, sending each device only the channels
/// that changed. While USB output is disabled nothing is published, so devices keep their
/// last values.
pub(crate) fn output(
    usb_client: Option<Res<UsbDmxOutputClient>>,
    mut last_effective_output_enabled: Local<Option<bool>>,
    settings: Res<IoRuntimeSettings>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    frames: Res<OutputDmxFrames>,
    target_states: Option<Res<UsbDmxTargetStates>>,
) {
    let usb_output_enabled = transport_policy
        .as_deref()
        .map_or(settings.usb_output_enabled, |policy| {
            policy.usb_output_enabled(&settings)
        });
    if *last_effective_output_enabled != Some(usb_output_enabled) {
        if !usb_output_enabled {
            tracing::info!("USB DMX output is disabled by effective USB output state");
        }
        *last_effective_output_enabled = Some(usb_output_enabled);
    }
    let Some(usb_client) = usb_client else {
        return;
    };
    if !usb_output_enabled {
        usb_client.publish(Vec::new());
        return;
    }

    usb_client.publish(
        frames
            .iter()
            .filter_map(|frame| {
                let OutputTransport::Usb { device } = &frame.transport else {
                    return None;
                };
                let device = match target_states.as_deref() {
                    Some(states) => states.output_selector(device)?,
                    None => device.as_str(),
                };
                Some(UsbDmxFrame {
                    device: device.to_string(),
                    data: frame.channels,
                })
            })
            .collect(),
    );
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use bevy_app::App;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
    use nightfall_io::{SacnDelivery, UsbDmxDeviceInfo, UsbDmxOutputTarget};

    use super::*;

    /// Builds a composed frame whose first channel holds `first`.
    fn frame(transport: OutputTransport, first: u8) -> OutputDmxFrame {
        let mut channels = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        channels[0] = first;
        OutputDmxFrame {
            transport,
            universe: 1,
            channels,
        }
    }

    /// Runs the output system once with the given settings and frames, returning what it
    /// published for the output worker.
    fn submit_frames(settings: IoRuntimeSettings, frames: Vec<OutputDmxFrame>) -> Vec<UsbDmxFrame> {
        submit_resolved_frames(settings, frames, None)
    }

    /// Runs the output system once with the given settings, frames and USB target statuses,
    /// returning what it published for the output worker.
    fn submit_resolved_frames(
        settings: IoRuntimeSettings,
        frames: Vec<OutputDmxFrame>,
        target_states: Option<UsbDmxTargetStates>,
    ) -> Vec<UsbDmxFrame> {
        let mut app = App::new();
        let client = UsbDmxOutputClient::default();
        app.insert_resource(client.clone());
        app.insert_resource(settings);
        if let Some(target_states) = target_states {
            app.insert_resource(target_states);
        }
        app.init_resource::<OutputDmxFrames>();
        app.world_mut()
            .resource_mut::<OutputDmxFrames>()
            .set(frames);

        app.add_systems(bevy_app::Update, output);
        app.update();

        client.published().as_ref().clone()
    }

    /// Verifies distinct USB transports publish frames for their selected devices and frames
    /// composed for other transports are ignored.
    #[test]
    fn output_routes_each_usb_transport_to_its_selected_device() {
        let sent = submit_frames(
            IoRuntimeSettings::default(),
            vec![
                frame(
                    OutputTransport::Usb {
                        device: "16c0:05dc:port:20:1.2".to_string(),
                    },
                    11,
                ),
                frame(
                    OutputTransport::Usb {
                        device: "16c0:05dc:port:20:1.3".to_string(),
                    },
                    22,
                ),
                frame(
                    OutputTransport::Sacn {
                        mode: SacnDelivery::Multicast,
                    },
                    33,
                ),
            ],
        );

        assert_eq!(sent.len(), 2);
        let sent_by_device = sent
            .iter()
            .map(|frame| (frame.device.as_str(), frame.data[0]))
            .collect::<HashMap<_, _>>();
        assert_eq!(sent_by_device["16c0:05dc:port:20:1.2"], 11);
        assert_eq!(sent_by_device["16c0:05dc:port:20:1.3"], 22);
    }

    /// Verifies disabled USB output publishes nothing for the USB DMX worker.
    #[test]
    fn output_does_not_send_when_usb_output_is_disabled() {
        let sent = submit_frames(
            IoRuntimeSettings {
                usb_output_enabled: false,
                ..Default::default()
            },
            vec![frame(
                OutputTransport::Usb {
                    device: "default".to_string(),
                },
                42,
            )],
        );

        assert!(sent.is_empty());
    }

    /// Verifies frames go to the adapter each saved selector resolved to, and outputs whose
    /// adapter must still be chosen publish nothing.
    #[test]
    fn output_sends_to_resolved_adapters_only() {
        let saved = |id: &str, port: &str| UsbDmxOutputTarget {
            id: id.to_string(),
            device: format!("id-16c0:05dc,serial-0001,port-20:{port}"),
            device_label: None,
        };
        let moved = UsbDmxDeviceInfo {
            id: "id-16c0:05dc,serial-0002,port-20:4".to_string(),
            label: "uDMX".to_string(),
            vendor_id: 0x16c0,
            product_id: 0x05dc,
            manufacturer: None,
            product: None,
            serial_number: Some("0002".to_string()),
            location: None,
        };
        let lone_twin = UsbDmxDeviceInfo {
            id: "id-16c0:05dc,serial-0001,port-20:3".to_string(),
            serial_number: Some("0001".to_string()),
            ..moved.clone()
        };
        let targets = vec![
            saved("left", "1"),
            saved("right", "2"),
            UsbDmxOutputTarget {
                id: "spare".to_string(),
                device: "id-16c0:05dc,serial-0002,port-20:1".to_string(),
                device_label: None,
            },
        ];
        let states = UsbDmxTargetStates::resolve(&targets, &[lone_twin, moved.clone()]);
        let frames = targets
            .iter()
            .enumerate()
            .map(|(index, target)| frame(target.output_transport(), index as u8))
            .collect();

        let sent = submit_resolved_frames(IoRuntimeSettings::default(), frames, Some(states));

        assert_eq!(
            sent,
            vec![UsbDmxFrame {
                device: moved.id,
                data: frame(targets[2].output_transport(), 2).channels,
            }]
        );
    }
}
