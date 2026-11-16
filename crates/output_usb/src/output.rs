// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Hands the composed USB DMX frames to the process-lifetime output worker.

use bevy_ecs::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::{DmxOutputStandby, IoRuntimeSettings, OutputTransport, TransportRuntimePolicy};

use crate::service::{UsbDmxFrame, UsbDmxOutputClient};

/// Publishes every composed USB DMX wire frame for its selected device.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each USB device. The output worker writes
/// whatever was published last on the shared tick grid, sending each device only the channels
/// that changed. While USB output is disabled, or this node is a standby backup, nothing is
/// published, so devices keep their last values.
pub(crate) fn output(
    usb_client: Option<Res<UsbDmxOutputClient>>,
    mut last_effective_output_enabled: Local<Option<bool>>,
    settings: Res<IoRuntimeSettings>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    standby: Option<Res<DmxOutputStandby>>,
    frames: Res<OutputDmxFrames>,
) {
    // USB DMX has no source priority, so a standby backup must not send alongside the primary.
    let usb_output_enabled = transport_policy
        .as_deref()
        .map_or(settings.usb_output_enabled, |policy| {
            policy.usb_output_enabled(&settings)
        })
        && standby
            .as_deref()
            .is_none_or(|standby| standby.allows_unprioritized_output());
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
                Some(UsbDmxFrame {
                    device: device.clone(),
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
    use nightfall_io::SacnDelivery;

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
        submit_frames_with_standby(settings, frames, DmxOutputStandby(false))
    }

    /// Runs the output system once on a node in the given standby state, returning what it
    /// published for the output worker.
    fn submit_frames_with_standby(
        settings: IoRuntimeSettings,
        frames: Vec<OutputDmxFrame>,
        standby: DmxOutputStandby,
    ) -> Vec<UsbDmxFrame> {
        let mut app = App::new();
        let client = UsbDmxOutputClient::default();
        app.insert_resource(client.clone());
        app.insert_resource(settings);
        app.insert_resource(standby);
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

    /// Verifies a standby backup keeps USB DMX silent, since USB DMX has no priority to let the
    /// primary win.
    #[test]
    fn output_does_not_send_on_a_standby_backup() {
        let sent = submit_frames_with_standby(
            IoRuntimeSettings::default(),
            vec![frame(
                OutputTransport::Usb {
                    device: "default".to_string(),
                },
                42,
            )],
            DmxOutputStandby(true),
        );

        assert!(sent.is_empty());
    }
}
