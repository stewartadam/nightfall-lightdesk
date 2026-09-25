// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles sACN output via process-lifetime service host.

use std::time::Instant;

use bevy_ecs::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::prelude::*;

use crate::service::{SacnOutputClient, SacnSendError};

/// Sends every composed sACN wire frame.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each concrete sACN delivery.
pub fn output(
    sacn_client: Option<Res<SacnOutputClient>>,
    frames: Res<OutputDmxFrames>,
    mut network_stats: ResMut<NetworkStats>,
) {
    let Some(sacn_client) = sacn_client else {
        return;
    };
    if !sacn_client.is_available() {
        return;
    }

    let start = Instant::now();
    let mut sent_count = 0u32;

    for frame in frames.iter() {
        let OutputTransport::Sacn { mode } = &frame.transport else {
            continue;
        };
        let universe_id = frame.universe;
        let unicast_ip = match mode {
            SacnDelivery::Multicast => None,
            SacnDelivery::Unicast { ip } => Some(*ip),
        };

        match sacn_client.send_frame(universe_id, &frame.channels, unicast_ip) {
            Ok(()) => {
                network_stats.clear_send_failure("Sacn", universe_id, unicast_ip);
                sent_count += 1;
            }
            Err(SacnSendError::AddrNotAvailable) => {
                network_stats.record_send_failure(
                    "Sacn",
                    universe_id,
                    unicast_ip,
                    "AddrNotAvailable",
                    "selected output interface address is unavailable",
                );
                // Worker already disabled itself; stop sending this update cycle.
                break;
            }
            Err(SacnSendError::Unavailable) => {
                network_stats.record_send_failure(
                    "Sacn",
                    universe_id,
                    unicast_ip,
                    "Unavailable",
                    "sACN output service is unavailable",
                );
                break;
            }
            Err(SacnSendError::Failed { kind, message }) => {
                network_stats.record_send_failure(
                    "Sacn",
                    universe_id,
                    unicast_ip,
                    kind.map(network_error_kind_label).unwrap_or("SendFailed"),
                    message,
                );
            }
        }
    }

    network_stats.set_sacn_timing(start.elapsed(), sent_count);
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
    use std::sync::{Arc, Mutex};

    use bevy_app::App;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
    use tokio::sync::mpsc;

    use super::*;
    use crate::service::SacnWorkerCommand;

    fn spawn_mock_client() -> (
        SacnOutputClient,
        Arc<Mutex<Vec<(u16, Vec<u8>)>>>,
        std::thread::JoinHandle<()>,
    ) {
        let client = SacnOutputClient::default();
        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<SacnWorkerCommand>();
        client.set_sender_and_cid(Some(command_tx), Some([1; 16]));

        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_for_thread = Arc::clone(&sent);
        let handle = std::thread::spawn(move || {
            while let Some(command) = command_rx.blocking_recv() {
                match command {
                    SacnWorkerCommand::SendFrame {
                        universe,
                        data,
                        unicast_ip: _,
                        response_tx,
                    } => {
                        sent_for_thread
                            .lock()
                            .expect("send capture lock poisoned")
                            .push((universe, data));
                        let _ = response_tx.send(Ok(()));
                    }
                    SacnWorkerCommand::Shutdown => break,
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
    fn send_frames(frames: Vec<OutputDmxFrame>) -> Vec<(u16, Vec<u8>)> {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();
        app.insert_resource(client);
        app.init_resource::<OutputDmxFrames>();
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

    /// Every composed sACN frame is sent once per concrete delivery with its own payload.
    #[test]
    fn output_sends_each_composed_sacn_frame() {
        let sent = send_frames(vec![
            frame(
                OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                1,
                11,
            ),
            frame(
                OutputTransport::Sacn {
                    mode: SacnDelivery::Unicast {
                        ip: std::net::Ipv4Addr::new(10, 0, 0, 4),
                    },
                },
                1,
                22,
            ),
            frame(
                OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                10,
                33,
            ),
        ]);

        let sent: Vec<(u16, u8)> = sent.iter().map(|(u, data)| (*u, data[0])).collect();
        assert_eq!(sent, vec![(1, 11), (1, 22), (10, 33)]);
    }

    /// Frames composed for other transports are never sent over sACN.
    #[test]
    fn output_ignores_non_sacn_frames() {
        let sent = send_frames(vec![
            frame(
                OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Broadcast,
                },
                1,
                5,
            ),
            frame(
                OutputTransport::Udmx {
                    device: "any".to_string(),
                },
                1,
                6,
            ),
        ]);

        assert!(sent.is_empty());
    }
}
