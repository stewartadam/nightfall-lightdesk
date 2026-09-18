// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles sACN output via process-lifetime service host.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use bevy_ecs::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::BindingTransport;
use nightfall_io::prelude::*;

use crate::service::{SacnOutputClient, SacnSendError};

/// Mapping from console universe data to a transport-specific passthrough output.
#[derive(Debug, Clone)]
struct TransportPassthroughMapping {
    source_transport: BindingTransport,
    source_universe: u16,
    source_address: u16,
    target_mode: SacnDelivery,
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

/// Outputs finalized DMX values to hardware.
pub fn output(
    sacn_client: Option<Res<SacnOutputClient>>,
    universes: Res<ConsoleDmxUniverses>,
    input_universes: Res<InputDmxUniverses>,
    resolved_input_bindings: Res<ResolvedInputBindings>,
    transport_map: Res<UniverseTransportMap>,
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
        if target.protocol != BindingTransport::Sacn {
            continue;
        }
        let OutputTransport::Sacn { mode: target_mode } = &target.transport else {
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
    let mut universe_ids: HashSet<u16> = transport_map
        .universes()
        .filter(|&universe_id| {
            transport_map.has_transport(universe_id, |t| matches!(t, OutputTransport::Sacn { .. }))
        })
        .collect();
    universe_ids.extend(transport_input_target_universes.iter().copied());
    let mut universe_ids: Vec<u16> = universe_ids.into_iter().collect();
    universe_ids.sort_unstable();

    for universe_id in universe_ids {
        let mut sacn_transports: Vec<_> = transport_map
            .transports_for_universe(universe_id)
            .filter_map(|transport| match transport {
                OutputTransport::Sacn { mode } => Some(mode.clone()),
                _ => None,
            })
            .collect();
        if let Some(passthrough_mappings) = passthrough_mappings_by_universe.get(&universe_id) {
            for mapping in passthrough_mappings {
                if !sacn_transports.contains(&mapping.target_mode) {
                    sacn_transports.push(mapping.target_mode.clone());
                }
            }
        }

        for mode in sacn_transports {
            let output_transport = OutputTransport::Sacn { mode: mode.clone() };
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
                SacnDelivery::Multicast => None,
                SacnDelivery::Unicast { ip } => Some(ip),
            };

            match sacn_client.send_frame(universe_id, &data, unicast_ip) {
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
    use std::time::Instant;

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

    #[test]
    fn output_prefers_transport_input_targets_even_without_transport_map_entry() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<NetworkStats>();

        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(1, 1, 7, ConsoleChannelOrigin::System);
        }
        {
            let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            data[0] = 123;
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, data, Instant::now());
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
                        target: "sacn".to_string(),
                        protocol: BindingTransport::Sacn,
                        transport: OutputTransport::Sacn {
                            mode: SacnDelivery::Multicast,
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
        assert_eq!(sent[0].1[0], 123);
    }

    #[test]
    fn output_uses_console_data_without_transport_input_target_binding() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<NetworkStats>();

        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(1, 1, 42, ConsoleChannelOrigin::System);
        }
        {
            let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            data[0] = 255;
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, data, Instant::now());
        }
        {
            let mut map = app.world_mut().resource_mut::<UniverseTransportMap>();
            map.add_transport(
                1,
                OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
            );
        }

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");

        let sent = sent.lock().expect("send capture lock poisoned");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, 1);
        assert_eq!(sent[0].1[0], 42);
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
        app.init_resource::<NetworkStats>();

        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_value(1, 1, 7, ConsoleChannelOrigin::System);
            universes.set_value(1, 2, 8, ConsoleChannelOrigin::System);
        }
        {
            let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            data[0] = 123;
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            input_universes.set_universe(BindingTransport::Sacn, 1, data, Instant::now());
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
                        target: "sacn".to_string(),
                        protocol: BindingTransport::Sacn,
                        transport: OutputTransport::Sacn {
                            mode: SacnDelivery::Multicast,
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

    #[test]
    fn output_uses_binding_source_transport_data_for_passthrough() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<NetworkStats>();

        {
            let mut input_universes = app.world_mut().resource_mut::<InputDmxUniverses>();
            let mut source_data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            source_data[0] = 200;
            input_universes.set_universe(BindingTransport::ArtNet, 3, source_data, Instant::now());

            let mut target_raw_data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            target_raw_data[0] = 111;
            input_universes.set_universe(
                BindingTransport::Sacn,
                1,
                target_raw_data,
                Instant::now(),
            );
        }
        {
            let mut resolved = app.world_mut().resource_mut::<ResolvedInputBindings>();
            resolved.bindings = vec![ResolvedInputBinding {
                source: ResolvedInputSource::Transport {
                    transport: BindingTransport::ArtNet,
                    universe: 3,
                    address: 1,
                },
                priority: 0,
                destination: ResolvedInputDestination::Transport {
                    target: ResolvedTransportTarget {
                        target: "sacn".to_string(),
                        protocol: BindingTransport::Sacn,
                        transport: OutputTransport::Sacn {
                            mode: SacnDelivery::Multicast,
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
        assert_eq!(sent[0].1[0], 200);
    }
}
