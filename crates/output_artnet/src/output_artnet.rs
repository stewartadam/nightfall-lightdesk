// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Hands composed Art-Net frames to the process-lifetime output worker.

use bevy_ecs::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::prelude::*;

use crate::service::{ArtNetFrame, ArtNetOutputClient, ArtNetOutputReport, ArtNetSendError};

/// Publishes every composed Art-Net wire frame to the output worker and applies its send report.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each concrete Art-Net delivery. The worker
/// transmits whatever was published last on its own clock at the configured output rate, so
/// this system never waits on the network and extra engine frames change neither the output
/// rate nor its timing.
pub fn output(
    artnet_client: Option<Res<ArtNetOutputClient>>,
    frames: Res<OutputDmxFrames>,
    mut network_stats: ResMut<NetworkStats>,
) {
    let Some(artnet_client) = artnet_client else {
        return;
    };
    apply_report(artnet_client.take_report(), &mut network_stats);
    if !artnet_client.is_available() {
        return;
    }

    artnet_client.publish(
        frames
            .iter()
            .filter_map(|frame| {
                let OutputTransport::ArtNet { mode } = &frame.transport else {
                    return None;
                };
                let unicast_ip = match mode {
                    ArtNetDelivery::Broadcast => None,
                    ArtNetDelivery::Unicast { ip } => Some(*ip),
                };
                Some(ArtNetFrame {
                    universe: frame.universe,
                    unicast_ip,
                    data: frame.channels,
                })
            })
            .collect(),
    );
}

/// Records the worker's send failures, recoveries, and tick timing in [`NetworkStats`].
fn apply_report(report: ArtNetOutputReport, network_stats: &mut NetworkStats) {
    for ((universe_id, unicast_ip), outcome) in report.outcomes {
        match outcome {
            Ok(()) => network_stats.clear_send_failure("ArtNet", universe_id, unicast_ip),
            Err(ArtNetSendError::AddrNotAvailable) => network_stats.record_send_failure(
                "ArtNet",
                universe_id,
                unicast_ip,
                "AddrNotAvailable",
                "selected output interface address is unavailable",
            ),
            Err(ArtNetSendError::Failed { kind, message }) => network_stats.record_send_failure(
                "ArtNet",
                universe_id,
                unicast_ip,
                network_error_kind_label(kind),
                message,
            ),
        }
    }
    if let Some((elapsed, sent_count)) = report.last_tick {
        network_stats.set_artnet_timing(elapsed, sent_count);
    }
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
    use std::time::Duration;

    use bevy_app::App;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;

    use super::*;

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

    /// Builds an app running the output system against `client` with `frames` composed.
    fn output_app(client: &ArtNetOutputClient, frames: Vec<OutputDmxFrame>) -> App {
        let mut app = App::new();
        app.insert_resource(client.clone());
        app.init_resource::<OutputDmxFrames>();
        app.init_resource::<NetworkStats>();
        app.world_mut()
            .resource_mut::<OutputDmxFrames>()
            .set(frames);
        app.add_systems(bevy_app::Update, output);
        app
    }

    /// Runs the output system once with a running worker and returns what it published.
    fn publish_frames(frames: Vec<OutputDmxFrame>) -> Vec<(u16, u8, Option<Ipv4Addr>)> {
        let client = ArtNetOutputClient::default();
        client.set_running(true);
        output_app(&client, frames).update();
        client
            .published()
            .iter()
            .map(|frame| (frame.universe, frame.data[0], frame.unicast_ip))
            .collect()
    }

    /// Named outputs on the same universe are published separately with their own payloads.
    #[test]
    fn output_publishes_transport_specific_data_for_same_universe() {
        let unicast_ip = Ipv4Addr::new(10, 0, 0, 44);
        let published = publish_frames(vec![
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

        assert_eq!(published, vec![(1, 11, None), (1, 22, Some(unicast_ip))]);
    }

    /// Frames composed for other transports are never handed to the Art-Net worker.
    #[test]
    fn output_ignores_non_artnet_frames() {
        let published = publish_frames(vec![frame(
            OutputTransport::Sacn {
                mode: SacnDelivery::Multicast,
            },
            1,
            5,
        )]);

        assert!(published.is_empty());
    }

    /// Nothing is published while no worker is running.
    #[test]
    fn output_skips_publishing_without_worker() {
        let client = ArtNetOutputClient::default();
        output_app(
            &client,
            vec![frame(
                OutputTransport::ArtNet {
                    mode: ArtNetDelivery::Broadcast,
                },
                1,
                5,
            )],
        )
        .update();

        assert!(client.published().is_empty());
    }

    /// Worker outcomes reach network stats even after the worker stopped, and a later success
    /// clears the recorded failure.
    #[test]
    fn output_applies_worker_report() {
        let client = ArtNetOutputClient::default();
        let mut app = output_app(&client, Vec::new());
        client.record_tick(
            [((3, None), Err(ArtNetSendError::AddrNotAvailable))],
            Duration::from_millis(2),
            0,
        );
        app.update();

        let stats = app.world().resource::<NetworkStats>();
        assert_eq!(stats.recent_send_failures().len(), 1);
        assert_eq!(stats.artnet_universe_count(), 0);

        client.record_tick([((3, None), Ok(()))], Duration::from_millis(1), 1);
        app.update();

        let stats = app.world().resource::<NetworkStats>();
        assert!(stats.recent_send_failures().is_empty());
        assert_eq!(stats.artnet_universe_count(), 1);
    }
}
