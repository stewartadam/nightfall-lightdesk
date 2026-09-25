// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles Art-Net output via process-lifetime service host.

use std::time::Instant;

use bevy_ecs::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::ArtNetRecentFramesByUniverse;
use nightfall_io::prelude::*;

use crate::service::{ArtNetOutputClient, ArtNetSendError, DEFAULT_ARTNET_FRAME_INTERVAL};

/// Sends every composed Art-Net wire frame, rate limited to the Art-Net frame interval.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each concrete Art-Net delivery.
pub fn output(
    artnet_client: Option<Res<ArtNetOutputClient>>,
    mut last_emit: Local<Option<Instant>>,
    frames: Res<OutputDmxFrames>,
    mut artnet_recent_frames: ResMut<ArtNetRecentFramesByUniverse>,
    mut network_stats: ResMut<NetworkStats>,
) {
    let Some(artnet_client) = artnet_client else {
        return;
    };
    if !artnet_client.is_available() {
        return;
    }

    if let Some(last_emit_at) = *last_emit
        && last_emit_at.elapsed() < DEFAULT_ARTNET_FRAME_INTERVAL
    {
        return;
    }

    let start = Instant::now();
    let mut sent_count = 0u32;

    for frame in frames.iter() {
        let OutputTransport::ArtNet { mode } = &frame.transport else {
            continue;
        };
        let universe_id = frame.universe;
        let data = &frame.channels;
        let unicast_ip = match mode {
            ArtNetDelivery::Broadcast => None,
            ArtNetDelivery::Unicast { ip } => Some(*ip),
        };

        match artnet_client.send_frame(universe_id, data, unicast_ip) {
            Ok(meta) => {
                network_stats.clear_send_failure("ArtNet", universe_id, unicast_ip);
                artnet_recent_frames.record_recent_frame(
                    universe_id,
                    meta.sequence,
                    data,
                    meta.local_source_addr,
                    Instant::now(),
                );
                sent_count += 1;
            }
            Err(ArtNetSendError::AddrNotAvailable) => {
                network_stats.record_send_failure(
                    "ArtNet",
                    universe_id,
                    unicast_ip,
                    "AddrNotAvailable",
                    "selected output interface address is unavailable",
                );
                // Worker already disabled itself; stop sending this update cycle.
                break;
            }
            Err(ArtNetSendError::Unavailable) => {
                network_stats.record_send_failure(
                    "ArtNet",
                    universe_id,
                    unicast_ip,
                    "Unavailable",
                    "Art-Net output service is unavailable",
                );
                break;
            }
            Err(ArtNetSendError::Failed { kind, message }) => {
                network_stats.record_send_failure(
                    "ArtNet",
                    universe_id,
                    unicast_ip,
                    network_error_kind_label(kind),
                    message,
                );
            }
        }
    }

    if sent_count > 0 {
        *last_emit = Some(Instant::now());
    }
    network_stats.set_artnet_timing(start.elapsed(), sent_count);
}

fn network_error_kind_label(kind: std::io::ErrorKind) -> &'static str {
    match kind {
        std::io::ErrorKind::AddrNotAvailable => "AddrNotAvailable",
        std::io::ErrorKind::HostUnreachable => "HostUnreachable",
        std::io::ErrorKind::NetworkUnreachable => "NetworkUnreachable",
        std::io::ErrorKind::ConnectionRefused => "ConnectionRefused",
        std::io::ErrorKind::TimedOut => "TimedOut",
        _ => "SendFailed",
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Mutex};

    use bevy_app::App;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
    use tokio::sync::mpsc;

    use super::*;
    use crate::service::{ArtNetSendMeta, ArtNetWorkerCommand};

    fn spawn_mock_client() -> (
        ArtNetOutputClient,
        Arc<Mutex<Vec<(u16, Vec<u8>, Option<Ipv4Addr>)>>>,
        std::thread::JoinHandle<()>,
    ) {
        let client = ArtNetOutputClient::default();
        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<ArtNetWorkerCommand>();
        client.set_sender(Some(command_tx));

        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_for_thread = Arc::clone(&sent);
        let handle = std::thread::spawn(move || {
            let mut sequence = 0u8;
            while let Some(command) = command_rx.blocking_recv() {
                match command {
                    ArtNetWorkerCommand::SendFrame {
                        universe,
                        data,
                        unicast_ip,
                        response_tx,
                    } => {
                        sequence = sequence.wrapping_add(1).max(1);
                        sent_for_thread
                            .lock()
                            .expect("send capture lock poisoned")
                            .push((universe, data, unicast_ip));
                        let _ = response_tx.send(Ok(ArtNetSendMeta {
                            sequence,
                            local_source_addr: None,
                        }));
                    }
                    ArtNetWorkerCommand::Shutdown => break,
                }
            }
        });

        (client, sent, handle)
    }

    /// Builds a composed frame whose first channel holds `first`.
    fn frame(transport: OutputTransport, universe: u16, first: u8) -> OutputDmxFrame {
        let mut channels = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        channels[0] = first;
        OutputDmxFrame {
            transport,
            universe,
            channels,
        }
    }

    /// Runs the output system once over `frames` and returns the captured sends.
    fn send_frames(frames: Vec<OutputDmxFrame>) -> Vec<(u16, Vec<u8>, Option<Ipv4Addr>)> {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();
        app.insert_resource(client);
        app.init_resource::<OutputDmxFrames>();
        app.init_resource::<ArtNetRecentFramesByUniverse>();
        app.init_resource::<NetworkStats>();
        app.world_mut()
            .resource_mut::<OutputDmxFrames>()
            .set(frames);

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");
        sent.lock().expect("send capture lock poisoned").clone()
    }

    /// Named outputs on the same universe are sent separately with their own payloads.
    #[test]
    fn output_sends_transport_specific_data_for_same_universe() {
        let unicast_ip = Ipv4Addr::new(10, 0, 0, 44);
        let sent = send_frames(vec![
            frame(
                OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Broadcast,
                },
                1,
                11,
            ),
            frame(
                OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Unicast { ip: unicast_ip },
                },
                1,
                22,
            ),
        ]);

        let sent: Vec<(u16, u8, Option<Ipv4Addr>)> = sent
            .iter()
            .map(|(universe, data, ip)| (*universe, data[0], *ip))
            .collect();
        assert_eq!(sent, vec![(1, 11, None), (1, 22, Some(unicast_ip))]);
    }

    /// Frames composed for other transports are never sent over Art-Net.
    #[test]
    fn output_ignores_non_artnet_frames() {
        let sent = send_frames(vec![frame(
            OutputTransport::Sacn {
                mode: SacnDelivery::Multicast,
            },
            1,
            5,
        )]);

        assert!(sent.is_empty());
    }
}
