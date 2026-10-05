// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Hands composed sACN frames to the process-lifetime output worker.

use bevy_ecs::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::prelude::*;

use crate::service::{SacnFrame, SacnOutputClient, SacnOutputReport, SacnSendError};

/// Publishes every composed sACN wire frame to the output worker and applies its send report.
///
/// Frames come from [`OutputDmxFrames`], which already combines routed console windows,
/// direct fixture output, and input passthrough for each concrete sACN delivery. The worker
/// transmits whatever was published last on its own fixed 44 Hz clock, so this system never
/// waits on the network and extra engine frames change neither the output rate nor its timing.
pub fn output(
    sacn_client: Option<Res<SacnOutputClient>>,
    frames: Res<OutputDmxFrames>,
    mut network_stats: ResMut<NetworkStats>,
) {
    let Some(sacn_client) = sacn_client else {
        return;
    };
    apply_report(sacn_client.take_report(), &mut network_stats);
    if !sacn_client.is_available() {
        return;
    }

    sacn_client.publish(
        frames
            .iter()
            .filter_map(|frame| {
                let OutputTransport::Sacn { mode } = &frame.transport else {
                    return None;
                };
                let unicast_ip = match mode {
                    SacnDelivery::Multicast => None,
                    SacnDelivery::Unicast { ip } => Some(*ip),
                };
                Some(SacnFrame {
                    universe: frame.universe,
                    unicast_ip,
                    data: frame.channels,
                })
            })
            .collect(),
    );
}

/// Records the worker's send failures, recoveries, and tick timing in [`NetworkStats`].
fn apply_report(report: SacnOutputReport, network_stats: &mut NetworkStats) {
    for ((universe_id, unicast_ip), outcome) in report.outcomes {
        match outcome {
            Ok(()) => network_stats.clear_send_failure("Sacn", universe_id, unicast_ip),
            Err(SacnSendError::AddrNotAvailable) => network_stats.record_send_failure(
                "Sacn",
                universe_id,
                unicast_ip,
                "AddrNotAvailable",
                "selected output interface address is unavailable",
            ),
            Err(SacnSendError::Failed { kind, message }) => network_stats.record_send_failure(
                "Sacn",
                universe_id,
                unicast_ip,
                kind.map(network_error_kind_label).unwrap_or("SendFailed"),
                message,
            ),
        }
    }
    if let Some((elapsed, sent_count)) = report.last_tick {
        network_stats.set_sacn_timing(elapsed, sent_count);
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
    fn output_app(client: &SacnOutputClient, frames: Vec<OutputDmxFrame>) -> App {
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
        let client = SacnOutputClient::default();
        client.set_running(true);
        output_app(&client, frames).update();
        client
            .published()
            .iter()
            .map(|frame| (frame.universe, frame.data[0], frame.unicast_ip))
            .collect()
    }

    /// Every composed sACN frame is published once per concrete delivery with its own payload.
    #[test]
    fn output_publishes_each_composed_sacn_frame() {
        let unicast_ip = Ipv4Addr::new(10, 0, 0, 4);
        let published = publish_frames(vec![
            frame(
                OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                1,
                11,
            ),
            frame(
                OutputTransport::Sacn {
                    mode: SacnDelivery::Unicast { ip: unicast_ip },
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

        assert_eq!(
            published,
            vec![(1, 11, None), (1, 22, Some(unicast_ip)), (10, 33, None)]
        );
    }

    /// Frames composed for other transports are never handed to the sACN worker.
    #[test]
    fn output_ignores_non_sacn_frames() {
        let published = publish_frames(vec![
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

        assert!(published.is_empty());
    }

    /// Worker outcomes reach network stats, and a later success clears the recorded failure.
    #[test]
    fn output_applies_worker_report() {
        let client = SacnOutputClient::default();
        let mut app = output_app(&client, Vec::new());
        client.record_tick(
            [(
                (7, None),
                Err(SacnSendError::Failed {
                    kind: None,
                    message: "boom".to_string(),
                }),
            )],
            Duration::from_millis(2),
            0,
        );
        app.update();

        let stats = app.world().resource::<NetworkStats>();
        assert_eq!(stats.recent_send_failures().len(), 1);

        client.record_tick([((7, None), Ok(()))], Duration::from_millis(1), 1);
        app.update();

        let stats = app.world().resource::<NetworkStats>();
        assert!(stats.recent_send_failures().is_empty());
        assert_eq!(stats.sacn_universe_count(), 1);
    }
}
