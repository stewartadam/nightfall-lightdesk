// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! uDMX USB output via process-lifetime service host.

use std::time::{Duration, Instant};

use bevy_ecs::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::{IoRuntimeSettings, OutputTransport, TransportRuntimePolicy};

use crate::service::UdmxOutputClient;

/// Minimum interval between DMX frames (15Hz = ~66.66ms)
/// See: https://www.illutzminator.de/udmx-timing.html?L=1
const DMX_FRAME_INTERVAL: Duration = Duration::from_micros(66667);

/// Submits every composed uDMX wire frame to its selected device.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each USB device. Submission is skipped
/// while USB output is disabled and rate limited to the uDMX frame interval.
pub fn output(
    udmx_client: Option<Res<UdmxOutputClient>>,
    mut last_send: Local<Option<Instant>>,
    mut last_effective_output_enabled: Local<Option<bool>>,
    settings: Res<IoRuntimeSettings>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    frames: Res<OutputDmxFrames>,
) {
    let usb_output_enabled = transport_policy
        .as_deref()
        .map_or(settings.usb_output_enabled, |policy| {
            policy.usb_output_enabled(&settings)
        });
    if *last_effective_output_enabled != Some(usb_output_enabled) {
        if !usb_output_enabled {
            tracing::info!("uDMX output is disabled by effective USB output state");
        }
        *last_effective_output_enabled = Some(usb_output_enabled);
    }
    if !usb_output_enabled {
        return;
    }

    let Some(udmx_client) = udmx_client else {
        return;
    };

    // Rate limit to avoid flooding the uDMX worker channel.
    let now = Instant::now();
    if let Some(last) = *last_send
        && now.duration_since(last) < DMX_FRAME_INTERVAL
    {
        return;
    }
    *last_send = Some(now);

    for frame in frames.iter() {
        let OutputTransport::Udmx { device } = &frame.transport else {
            continue;
        };
        let _ = udmx_client.submit_frame(device, &frame.channels);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use bevy_app::App;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
    use nightfall_io::SacnDelivery;
    use tokio::sync::mpsc;

    use super::*;
    use crate::service::UdmxCommand;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct SentFrame {
        device: String,
        data: Vec<u8>,
    }

    fn spawn_mock_client() -> (
        UdmxOutputClient,
        Arc<Mutex<Vec<SentFrame>>>,
        std::thread::JoinHandle<()>,
    ) {
        let client = UdmxOutputClient::default();
        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<UdmxCommand>();
        client.set_sender(Some(command_tx));

        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_for_thread = Arc::clone(&sent);
        let handle = std::thread::spawn(move || {
            while let Some(command) = command_rx.blocking_recv() {
                match command {
                    UdmxCommand::SubmitFrame { device, data } => {
                        sent_for_thread
                            .lock()
                            .expect("send capture lock poisoned")
                            .push(SentFrame { device, data });
                    }
                    UdmxCommand::Shutdown => break,
                }
            }
        });

        (client, sent, handle)
    }

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

    /// Runs the output system once with the given settings and frames, returning submissions.
    fn submit_frames(settings: IoRuntimeSettings, frames: Vec<OutputDmxFrame>) -> Vec<SentFrame> {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();
        app.insert_resource(client);
        app.insert_resource(settings);
        app.init_resource::<OutputDmxFrames>();
        app.world_mut()
            .resource_mut::<OutputDmxFrames>()
            .set(frames);

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");
        sent.lock().expect("send capture lock poisoned").clone()
    }

    /// Verifies distinct uDMX transports submit frames to their selected devices and frames
    /// composed for other transports are ignored.
    #[test]
    fn output_routes_each_udmx_transport_to_its_selected_device() {
        let sent = submit_frames(
            IoRuntimeSettings::default(),
            vec![
                frame(
                    OutputTransport::Udmx {
                        device: "16c0:05dc:port:20:1.2".to_string(),
                    },
                    11,
                ),
                frame(
                    OutputTransport::Udmx {
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

    /// Verifies disabled USB output does not submit frames to the uDMX worker.
    #[test]
    fn output_does_not_send_when_usb_output_is_disabled() {
        let sent = submit_frames(
            IoRuntimeSettings {
                usb_output_enabled: false,
                ..Default::default()
            },
            vec![frame(
                OutputTransport::Udmx {
                    device: "default".to_string(),
                },
                42,
            )],
        );

        assert!(sent.is_empty());
    }
}
