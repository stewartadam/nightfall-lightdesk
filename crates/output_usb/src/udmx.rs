// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! uDMX USB output via process-lifetime service host.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use bevy_ecs::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_io::BindingTransport;
use nightfall_io::{IoRuntimeSettings, OutputTransport, TransportRuntimePolicy};

use crate::service::UdmxOutputClient;

/// Minimum interval between DMX frames (15Hz = ~66.66ms)
/// See: https://www.illutzminator.de/udmx-timing.html?L=1
const DMX_FRAME_INTERVAL: Duration = Duration::from_micros(66667);

/// Mapping from console universe data to a transport-specific passthrough output.
#[derive(Debug, Clone, Copy)]
struct TransportPassthroughMapping {
    source_transport: BindingTransport,
    source_universe: u16,
    source_address: u16,
    target_address: u16,
}

fn overlay_mapped_window(
    source: &[u8],
    source_address: u16,
    target: &mut [u8],
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

/// Outputs finalized DMX values to uDMX.
pub fn output(
    udmx_client: Option<Res<UdmxOutputClient>>,
    mut last_send: Local<Option<Instant>>,
    mut last_effective_output_enabled: Local<Option<bool>>,
    settings: Res<IoRuntimeSettings>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    universes: Res<ConsoleDmxUniverses>,
    input_universes: Res<InputDmxUniverses>,
    resolved_input_bindings: Res<ResolvedInputBindings>,
    transport_map: Res<UniverseTransportMap>,
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

    let available_input_sources: HashSet<(BindingTransport, u16)> = input_universes
        .iter()
        .map(|(transport, universe_id, _)| (transport, universe_id))
        .collect();
    let mut passthrough_mappings_by_transport_universe: HashMap<
        (OutputTransport, u16),
        Vec<TransportPassthroughMapping>,
    > = HashMap::new();
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
        if target.protocol != BindingTransport::Udmx {
            continue;
        }
        passthrough_mappings_by_transport_universe
            .entry((target.transport.clone(), target.universe))
            .or_default()
            .push(TransportPassthroughMapping {
                source_transport: *source_transport,
                source_universe: *source_universe,
                source_address: *source_address,
                target_address: target.address,
            });
    }

    let mut transport_universes: HashSet<(OutputTransport, u16)> = HashSet::new();
    for universe_id in transport_map.universes() {
        for transport in transport_map.transports_for_universe(universe_id) {
            if matches!(transport, OutputTransport::Udmx { .. }) {
                transport_universes.insert((transport.clone(), universe_id));
            }
        }
    }
    transport_universes.extend(passthrough_mappings_by_transport_universe.keys().cloned());
    let mut transport_universes: Vec<(OutputTransport, u16)> =
        transport_universes.into_iter().collect();
    transport_universes.sort_by_key(|(transport, universe)| (format!("{transport:?}"), *universe));

    for (output_transport, universe_id) in transport_universes {
        let mut data = if universes.has_output_universe(&output_transport, universe_id) {
            universes.get_output_universe(&output_transport, universe_id)
        } else if universes.has_universe(universe_id) {
            universes.get_universe(universe_id)
        } else {
            [0; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE]
        };
        let mut has_data = universes.has_output_universe(&output_transport, universe_id)
            || universes.has_universe(universe_id);

        if let Some(passthrough_mappings) =
            passthrough_mappings_by_transport_universe.get(&(output_transport.clone(), universe_id))
        {
            for mapping in passthrough_mappings {
                if !available_input_sources
                    .contains(&(mapping.source_transport, mapping.source_universe))
                {
                    continue;
                }

                let source_data =
                    input_universes.get_universe(mapping.source_transport, mapping.source_universe);
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

        let OutputTransport::Udmx { device } = &output_transport else {
            continue;
        };
        let _ = udmx_client.submit_frame(device, &data);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use bevy_app::App;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
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

    #[test]
    fn output_uses_binding_source_transport_data_for_passthrough() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();

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
                        target: "udmx".to_string(),
                        protocol: BindingTransport::Udmx,
                        transport: OutputTransport::Udmx {
                            device: "default".to_string(),
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
        assert_eq!(sent[0].device, "default");
        assert_eq!(sent[0].data[0], 201);
    }

    #[test]
    fn output_overlays_passthrough_window_onto_console_data() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();

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
                        target: "udmx".to_string(),
                        protocol: BindingTransport::Udmx,
                        transport: OutputTransport::Udmx {
                            device: "default".to_string(),
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
        assert_eq!(sent[0].device, "default");
        assert_eq!(sent[0].data[0], 7);
        assert_eq!(sent[0].data[1], 123);
    }

    /// Verifies distinct uDMX transports submit frames to their selected devices.
    #[test]
    fn output_routes_each_udmx_transport_to_its_selected_device() {
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.init_resource::<IoRuntimeSettings>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();

        let device_a = OutputTransport::Udmx {
            device: "16c0:05dc:port:20:1.2".to_string(),
        };
        let device_b = OutputTransport::Udmx {
            device: "16c0:05dc:port:20:1.3".to_string(),
        };
        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_output_value(
                device_a.clone(),
                1,
                1,
                11,
                ConsoleChannelOrigin::OutputBinding,
            );
            universes.set_output_value(
                device_b.clone(),
                1,
                1,
                22,
                ConsoleChannelOrigin::OutputBinding,
            );
        }
        {
            let mut transport_map = app.world_mut().resource_mut::<UniverseTransportMap>();
            transport_map.add_transport(1, device_a);
            transport_map.add_transport(1, device_b);
        }

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");

        let sent = sent.lock().expect("send capture lock poisoned");
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
        let mut app = App::new();
        let (client, sent, handle) = spawn_mock_client();

        app.insert_resource(client);
        app.insert_resource(IoRuntimeSettings {
            usb_output_enabled: false,
            ..Default::default()
        });
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();

        let device = OutputTransport::Udmx {
            device: "default".to_string(),
        };
        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            universes.set_output_value(
                device.clone(),
                1,
                1,
                42,
                ConsoleChannelOrigin::OutputBinding,
            );
        }
        {
            let mut transport_map = app.world_mut().resource_mut::<UniverseTransportMap>();
            transport_map.add_transport(1, device);
        }

        app.add_systems(bevy_app::Update, output);
        app.update();

        drop(app);
        handle.join().expect("mock worker should exit");

        let sent = sent.lock().expect("send capture lock poisoned");
        assert!(sent.is_empty());
    }
}
