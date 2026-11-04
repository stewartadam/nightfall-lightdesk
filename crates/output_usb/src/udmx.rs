// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! USB DMX output via process-lifetime service host.

use std::time::{Duration, Instant};

use bevy_ecs::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::{
    IoRuntimeSettings, OutputTransport, TransportRuntimePolicy, UsbDmxTargetStates,
};

use crate::service::UdmxOutputClient;

/// Minimum interval between frame submissions to the USB worker (40Hz), the fastest rate any
/// supported interface refreshes at. The worker rate limits slower devices further.
const DMX_FRAME_INTERVAL: Duration = Duration::from_millis(25);

/// Submits every composed USB DMX wire frame to its selected device.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each USB device. Each frame goes to the
/// adapter [`UsbDmxTargetStates`] resolved its saved selector to. Submission is skipped
/// while USB output is disabled and rate limited to [`DMX_FRAME_INTERVAL`].
pub fn output(
    udmx_client: Option<Res<UdmxOutputClient>>,
    mut last_send: Local<Option<Instant>>,
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
    if !usb_output_enabled {
        return;
    }

    let Some(udmx_client) = udmx_client else {
        return;
    };

    // Rate limit to avoid flooding the USB DMX worker channel.
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
        // Output goes to the adapter the saved selector resolved to, and waits while an output
        // has no adapter or its adapter is still to be chosen.
        let device = match target_states.as_deref() {
            Some(states) => match states.output_selector(device) {
                Some(device) => device,
                None => continue,
            },
            None => device.as_str(),
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
    use nightfall_io::{SacnDelivery, UsbDmxDeviceInfo, UsbDmxOutputTarget};
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
        submit_resolved_frames(settings, frames, None)
    }

    /// Runs the output system once with the given settings, frames and USB target statuses,
    /// returning submissions.
    fn submit_resolved_frames(
        settings: IoRuntimeSettings,
        frames: Vec<OutputDmxFrame>,
        target_states: Option<UsbDmxTargetStates>,
    ) -> Vec<SentFrame> {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();
        app.insert_resource(client);
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

    /// Verifies frames go to the adapter each saved selector resolved to, and outputs whose
    /// adapter must still be chosen send nothing.
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
            vec![SentFrame {
                device: moved.id,
                data: frame(targets[2].output_transport(), 2).channels.to_vec(),
            }]
        );
    }
}
