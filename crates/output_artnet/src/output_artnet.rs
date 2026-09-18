// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles Art-Net output via process-lifetime service host.

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::time::Instant;

use bevy_ecs::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::prelude::*;
use nightfall_io::{ArtNetRecentFramesByUniverse, BindingTransport};

use crate::service::{ArtNetOutputClient, ArtNetSendError, DEFAULT_ARTNET_FRAME_INTERVAL};

/// Mapping from console universe data to a transport-specific passthrough output.
#[derive(Debug, Clone)]
struct TransportPassthroughMapping {
    source_transport: BindingTransport,
    source_universe: u16,
    source_address: u16,
    target_mode: ArtNetDelivery,
    target_address: u16,
}

fn overlay_mapped_window(
    source: &[u8; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE],
    source_address: u16,
    target: &mut [u8; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE],
    target_address: u16,
) {
    if source_address == 0 || target_address == 0 {
        return;
    }

    let source_start = (source_address - 1) as usize;
    let target_start = (target_address - 1) as usize;
    if source_start >= source.len() || target_start >= target.len() {
        return;
    }

    let copy_len = (source.len() - source_start).min(target.len() - target_start);
    target[target_start..(target_start + copy_len)]
        .copy_from_slice(&source[source_start..(source_start + copy_len)]);
}

/// Gets all universes configured for Art-Net output.
pub fn artnet_universes(map: &UniverseTransportMap) -> impl Iterator<Item = u16> + '_ {
    map.universes()
        .filter(|&id| map.has_transport(id, |t| matches!(t, OutputTransport::ArtNet { .. })))
}

/// Checks if a universe is configured for Art-Net output.
pub fn is_artnet_universe(map: &UniverseTransportMap, universe_id: u16) -> bool {
    map.has_transport(universe_id, |t| matches!(t, OutputTransport::ArtNet { .. }))
}

/// Gets Art-Net unicast IP for a universe if configured, `None` for broadcast.
pub fn artnet_unicast_ip(map: &UniverseTransportMap, universe_id: u16) -> Option<Ipv4Addr> {
    map.transports_for_universe(universe_id).find_map(|t| {
        if let OutputTransport::ArtNet {
            mode: ArtNetDelivery::Unicast { ip },
        } = t
        {
            Some(*ip)
        } else {
            None
        }
    })
}

/// Outputs finalized DMX values via Art-Net.
pub fn output(
    artnet_client: Option<Res<ArtNetOutputClient>>,
    mut last_emit: Local<Option<Instant>>,
    universes: Res<ConsoleDmxUniverses>,
    input_universes: Res<InputDmxUniverses>,
    resolved_input_bindings: Res<ResolvedInputBindings>,
    transport_map: Res<UniverseTransportMap>,
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
    let available_input_sources: HashSet<(BindingTransport, u16)> = input_universes
        .iter()
        .map(|(transport, universe_id, _)| (transport, universe_id))
        .collect();
    let mut passthrough_mappings_by_universe: HashMap<u16, Vec<TransportPassthroughMapping>> =
        HashMap::new();
    for binding in &resolved_input_bindings.bindings {
        let ResolvedInputSource::Transport {
            transport: source_transport,
            universe: source_universe,
            address: source_address,
        } = &binding.source
        else {
            continue;
        };
        let ResolvedInputDestination::Transport { target } = &binding.destination else {
            continue;
        };
        if target.protocol != BindingTransport::ArtNet {
            continue;
        }
        let OutputTransport::ArtNet { mode: target_mode } = &target.transport else {
            continue;
        };
        passthrough_mappings_by_universe
            .entry(target.universe)
            .or_default()
            .push(TransportPassthroughMapping {
                source_transport: *source_transport,
                source_universe: *source_universe,
                source_address: *source_address,
                target_mode: target_mode.clone(),
                target_address: target.address,
            });
    }

    let transport_input_target_universes: HashSet<u16> =
        passthrough_mappings_by_universe.keys().copied().collect();
    let mut universe_ids: HashSet<u16> = artnet_universes(&transport_map).collect();
    universe_ids.extend(transport_input_target_universes.iter().copied());
    let mut universe_ids: Vec<_> = universe_ids.into_iter().collect();
    universe_ids.sort_unstable();
    let mut sent_count = 0u32;

    for universe_id in universe_ids {
        let mut artnet_transports: Vec<_> = transport_map
            .transports_for_universe(universe_id)
            .filter_map(|transport| match transport {
                OutputTransport::ArtNet { mode } => Some(mode.clone()),
                _ => None,
            })
            .collect();
        if let Some(passthrough_mappings) = passthrough_mappings_by_universe.get(&universe_id) {
            for mapping in passthrough_mappings {
                if !artnet_transports.contains(&mapping.target_mode) {
                    artnet_transports.push(mapping.target_mode.clone());
                }
            }
        }

        for mode in artnet_transports {
            let output_transport = OutputTransport::ArtNet { mode: mode.clone() };
            let mut data = if universes.has_output_universe(&output_transport, universe_id) {
                universes.get_output_universe(&output_transport, universe_id)
            } else if universes.has_universe(universe_id) {
                universes.get_universe(universe_id)
            } else {
                [0; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE]
            };
            let mut has_data = universes.has_output_universe(&output_transport, universe_id)
                || universes.has_universe(universe_id);

            if let Some(passthrough_mappings) = passthrough_mappings_by_universe.get(&universe_id) {
                for mapping in passthrough_mappings {
                    if mapping.target_mode != mode
                        || !available_input_sources
                            .contains(&(mapping.source_transport, mapping.source_universe))
                    {
                        continue;
                    }

                    let source_data = input_universes
                        .get_universe(mapping.source_transport, mapping.source_universe);
                    overlay_mapped_window(
                        &source_data,
                        mapping.source_address,
                        &mut data,
                        mapping.target_address,
                    );
                    has_data = true;
                }
            }

            if !has_data {
                continue;
            }

            let unicast_ip = match mode {
                ArtNetDelivery::Broadcast => None,
                ArtNetDelivery::Unicast { ip } => Some(ip),
            };

            match artnet_client.send_frame(universe_id, &data, unicast_ip) {
                Ok(meta) => {
                    network_stats.clear_send_failure("ArtNet", universe_id, unicast_ip);
                    artnet_recent_frames.record_recent_frame(
                        universe_id,
                        meta.sequence,
                        &data,
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
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

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

    #[test]
    fn output_uses_binding_source_transport_data_for_passthrough() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<ArtNetRecentFramesByUniverse>();
        app.init_resource::<NetworkStats>();

        {
            let mut source_data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            source_data[0] = 201;
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 3, source_data, Instant::now());
        }
        {
            let mut resolved = app.world_mut().resource_mut::<ResolvedInputBindings>();
            resolved.bindings = vec![ResolvedInputBinding {
                source: ResolvedInputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: 3,
                    address: 1,
                },
                priority: 0,
                destination: ResolvedInputDestination::Transport {
                    target: ResolvedTransportTarget {
                        target: "artnet".to_string(),
                        protocol: BindingTransport::ArtNet,
                        transport: OutputTransport::ArtNet {
                            mode: ArtNetDelivery::Broadcast,
                        },
                        universe: 1,
                        address: 1,
                    },
                },
            }];
        }

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");

        let sent = sent.lock().expect("send capture lock poisoned");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, 1);
        assert_eq!(sent[0].1[0], 201);
    }

    #[test]
    fn output_overlays_passthrough_window_onto_console_data() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<ArtNetRecentFramesByUniverse>();
        app.init_resource::<NetworkStats>();

        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(1, 1, 7, ConsoleChannelOrigin::System);
            universes.set_value(1, 2, 8, ConsoleChannelOrigin::System);
        }
        {
            let mut source_data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            source_data[0] = 123;
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, source_data, Instant::now());
        }
        {
            let mut resolved = app.world_mut().resource_mut::<ResolvedInputBindings>();
            resolved.bindings = vec![ResolvedInputBinding {
                source: ResolvedInputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                    address: 1,
                },
                priority: 0,
                destination: ResolvedInputDestination::Transport {
                    target: ResolvedTransportTarget {
                        target: "artnet".to_string(),
                        protocol: BindingTransport::ArtNet,
                        transport: OutputTransport::ArtNet {
                            mode: ArtNetDelivery::Broadcast,
                        },
                        universe: 1,
                        address: 2,
                    },
                },
            }];
        }

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");

        let sent = sent.lock().expect("send capture lock poisoned");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, 1);
        assert_eq!(sent[0].1[0], 7);
        assert_eq!(sent[0].1[1], 123);
    }

    /// Verifies named outputs on the same universe keep separate payload buffers.
    #[test]
    fn output_sends_transport_specific_data_for_same_universe() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();
        let unicast_ip = Ipv4Addr::new(10, 0, 0, 44);
        let broadcast = OutputTransport::ArtNet {
            mode: ArtNetDelivery::Broadcast,
        };
        let unicast = OutputTransport::ArtNet {
            mode: ArtNetDelivery::Unicast { ip: unicast_ip },
        };

        app.insert_resource(client);
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<ArtNetRecentFramesByUniverse>();
        app.init_resource::<NetworkStats>();

        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_output_value(
                broadcast.clone(),
                1,
                1,
                11,
                ConsoleChannelOrigin::OutputBinding,
            );
            universes.set_output_value(
                unicast.clone(),
                1,
                1,
                22,
                ConsoleChannelOrigin::OutputBinding,
            );
        }
        {
            let mut map = app.world_mut().resource_mut::<UniverseTransportMap>();
            map.add_transport(1, broadcast);
            map.add_transport(1, unicast);
        }

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");

        let sent = sent.lock().expect("send capture lock poisoned");
        assert_eq!(sent.len(), 2);
        let broadcast_frame = sent
            .iter()
            .find(|(_, _, ip)| ip.is_none())
            .expect("broadcast frame should be sent");
        let unicast_frame = sent
            .iter()
            .find(|(_, _, ip)| *ip == Some(unicast_ip))
            .expect("unicast frame should be sent");
        assert_eq!(broadcast_frame.1[0], 11);
        assert_eq!(unicast_frame.1[0], 22);
    }
}
