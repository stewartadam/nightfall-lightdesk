// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Art-Net input handling crate

#![warn(missing_docs)]

use std::time::{Duration, Instant};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::*;
use nightfall_io::{ArtNetRecentFramesByUniverse, BindingTransport};
use tokio::sync::mpsc::UnboundedReceiver;

mod service;

use crate::service::{ArtNetInputFrame, NetworkInputBindStatus};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::InputArtnetPlugin;
}

/// Plugin for handling Art-Net input.
///
/// Shared Art-Net listener support is intended for broadcast reception across
/// multiple backend instances on the same host. Unicast Art-Net remains
/// singleton-by-design and is not replicated to every local listener.
pub struct InputArtnetPlugin {
    /// Whether network input is enabled.
    pub network_input_enabled: bool,
}

impl Default for InputArtnetPlugin {
    /// Verifies default.
    fn default() -> Self {
        Self {
            network_input_enabled: true,
        }
    }
}

/// Synchronize the input listener and disable input if binding fails.
fn sync_artnet_input_binding(
    settings: Option<ResMut<IoRuntimeSettings>>,
    network_interface_state: Option<Res<NetworkInterfaceState>>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    notifications: MessageWriter<NotificationEnvelope<IoRuntimeNotification>>,
) {
    let (Some(network_interface_state), Some(transport_policy)) =
        (network_interface_state, transport_policy)
    else {
        return;
    };
    let Some(mut settings) = settings else {
        return;
    };
    let should_disable_input = {
        if !settings.is_changed() && !network_interface_state.is_changed() {
            return;
        }

        let status = service::process_artnet_input_service().sync_with_settings(
            &settings,
            &network_interface_state,
            &transport_policy,
        );
        status == NetworkInputBindStatus::Failed
            && transport_policy.network_input_enabled(&settings)
    };

    if !should_disable_input {
        return;
    }

    disable_network_input_after_bind_failure(
        NetworkInputBindStatus::Failed,
        BindingTransport::ArtNet,
        6454,
        settings.as_mut(),
        notifications,
    );
}

/// Disable network input and emit an IO observation after Art-Net listener binding fails.
fn disable_network_input_after_bind_failure(
    status: NetworkInputBindStatus,
    transport: BindingTransport,
    port: u16,
    settings: &mut IoRuntimeSettings,
    mut notifications: MessageWriter<NotificationEnvelope<IoRuntimeNotification>>,
) {
    if status != NetworkInputBindStatus::Failed || !settings.network_input_enabled {
        return;
    }

    settings.network_input_enabled = false;
    notifications.write(NotificationEnvelope::detached(
        IoRuntimeNotification::InputBindFailed { transport, port },
    ));
}

impl Plugin for InputArtnetPlugin {
    /// Verifies build.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering InputArtnetPlugin");
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();
        app.init_resource::<TransportRuntimePolicy>();
        app.add_message::<AcceptedDmxFrame>();
        let artnet_service = service::process_artnet_input_service();
        let _ = artnet_service.configure_network_input_enabled(self.network_input_enabled);
        let artnet_rx = artnet_service.client().subscribe().unwrap_or_else(|| {
            let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();
            rx
        });

        app.insert_resource(ArtnetEventReceiver(artnet_rx));
        app.insert_resource(ArtNetInputStartup::default());
        app.add_systems(Update, sync_artnet_input_binding.after(EventHandling));
        app.add_systems(
            Update,
            artnet_event_system
                .in_set(DmxInputSet::Ingress)
                .in_set(LayerGeneration),
        );
    }
}

type RawArtnetFrame = ArtNetInputFrame;

/// Resource that receives decoded Art-Net input events from the listener thread.
#[derive(Resource)]
struct ArtnetEventReceiver(UnboundedReceiver<RawArtnetFrame>);

/// Startup task state for bringing up the Art-Net input listener.
#[derive(Resource, Clone, Copy, Default)]
struct ArtNetInputStartup {
    grace_start_at: Option<Instant>,
}

/// Drain decoded Art-Net frames, publishing only frames accepted by input policy.
fn artnet_event_system(
    mut artnet_rx: ResMut<ArtnetEventReceiver>,
    artnet_recent_frames: Option<Res<ArtNetRecentFramesByUniverse>>,
    input_universe_visibility_mode: Option<Res<InputUniverseVisibilityMode>>,
    mut startup: Option<ResMut<ArtNetInputStartup>>,
    mut frames: MessageWriter<AcceptedDmxFrame>,
) {
    while let Ok(frame) = artnet_rx.0.try_recv() {
        if let Some(frame) = accept_frame(
            artnet_recent_frames.as_deref(),
            input_universe_visibility_mode
                .as_deref()
                .copied()
                .unwrap_or_default(),
            startup.as_deref_mut(),
            frame,
        ) {
            frames.write(frame);
        }
    }
}

/// Classifies local output and applies Art-Net visibility policy before publishing a frame.
fn accept_frame(
    artnet_recent_frames: Option<&ArtNetRecentFramesByUniverse>,
    input_universe_visibility_mode: InputUniverseVisibilityMode,
    startup: Option<&mut ArtNetInputStartup>,
    frame: RawArtnetFrame,
) -> Option<AcceptedDmxFrame> {
    let is_self_frame = is_frame_from_local_artnet_output_source(&frame, artnet_recent_frames);

    if input_universe_visibility_mode == InputUniverseVisibilityMode::ExternalOnly {
        const ARTNET_INPUT_STARTUP_GRACE: Duration = Duration::from_millis(250);
        if let Some(startup) = startup {
            let grace_start_at = startup.grace_start_at.get_or_insert(frame.received_at);
            if frame.received_at.saturating_duration_since(*grace_start_at)
                < ARTNET_INPUT_STARTUP_GRACE
            {
                return None;
            }
        }
        if is_self_frame {
            return None;
        }
    }

    tracing::trace!(
        universe_id = frame.universe_id,
        source_addr = ?frame.source_addr,
        received_at = ?frame.received_at,
        "Applying Art-Net frame"
    );
    Some(AcceptedDmxFrame {
        transport: BindingTransport::ArtNet,
        universe: frame.universe_id,
        data: frame.data,
        received_at: frame.received_at,
        is_self_frame,
    })
}

/// Return true when a frame matches recent local Art-Net output and should be ignored.
fn is_frame_from_local_artnet_output_source(
    frame: &RawArtnetFrame,
    artnet_recent_frames: Option<&ArtNetRecentFramesByUniverse>,
) -> bool {
    const ARTNET_LOCAL_FRAME_MATCH_WINDOW: Duration = Duration::from_secs(2);

    let Some(identity) = artnet_recent_frames else {
        return false;
    };
    identity.has_recent_local_sender_sequence_match(
        frame.universe_id,
        frame.sequence,
        &frame.source_addr,
        frame.received_at,
        ARTNET_LOCAL_FRAME_MATCH_WINDOW,
    )
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
    use std::sync::{Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use artnet_protocol::{ArtCommand, Output, PortAddress};
    use bevy_ecs::system::RunSystemOnce;
    use nightfall_compositor::prelude::Layer;
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
    use nightfall_dmx::prelude::{DmxValueResolution, ParameterValue};
    use nightfall_fixtures::input_apply::TransportInputPlugin;
    use nightfall_fixtures::prelude::TRANSPORT_INPUT_LAYER_PRIORITY;
    use nightfall_fixtures::prelude::*;
    use socket2::{Domain, Protocol, Socket, Type};

    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Verifies Art-Net bind failures disable network input and publish their cause.
    #[test]
    fn artnet_bind_failure_disables_network_input_and_emits_observation() {
        let mut app = App::new();
        app.insert_resource(IoRuntimeSettings::default());
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();

        app.world_mut()
            .run_system_once(
                |mut settings: ResMut<IoRuntimeSettings>,
                 notifications: MessageWriter<NotificationEnvelope<IoRuntimeNotification>>| {
                    disable_network_input_after_bind_failure(
                        NetworkInputBindStatus::Failed,
                        BindingTransport::ArtNet,
                        6454,
                        settings.as_mut(),
                        notifications,
                    );
                },
            )
            .expect("failure handler system should run");

        assert!(
            !app.world()
                .resource::<IoRuntimeSettings>()
                .network_input_enabled,
            "network input should be disabled after bind failure"
        );

        let notifications: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<NotificationEnvelope<IoRuntimeNotification>>>()
            .drain()
            .collect();
        assert!(
            notifications.iter().any(|notification| {
                matches!(
                    notification.notification,
                    IoRuntimeNotification::InputBindFailed {
                        transport: BindingTransport::ArtNet,
                        port: 6454
                    }
                )
            }),
            "expected a bind-failure observation for the Art-Net bind failure"
        );
    }

    /// Returns whether the current host cannot route interface broadcast traffic.
    fn broadcast_route_unavailable(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            io::ErrorKind::HostUnreachable | io::ErrorKind::NetworkUnreachable
        )
    }

    /// Creates a fixture assertion layer for adapter-to-routing integration checks.
    fn spawn_transport_input_layer(app: &mut App) -> Entity {
        app.world_mut()
            .spawn((
                Layer::new(
                    "test transport input".to_string(),
                    TRANSPORT_INPUT_LAYER_PRIORITY,
                ),
                TransportInputLayer,
                TransportInputAssertionOwners::default(),
            ))
            .id()
    }

    /// Creates an unsigned single-channel parameter for routing assertions.
    fn make_coarse_parameter() -> Parameter {
        Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Coarse,
                min: 0.0,
                max: 255.0,
                ..Default::default()
            },
            values: Default::default(),
        }
    }

    /// Builds a decoded protocol frame from sparse DMX channel values.
    fn make_frame(universe_id: u16, channels: &[(u16, u8)]) -> RawArtnetFrame {
        make_frame_with_source_addr_and_sequence(
            universe_id,
            channels,
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 6454),
            1,
        )
    }

    /// Builds an Art-Net frame from a specified sender endpoint.
    fn make_frame_with_source_addr(
        universe_id: u16,
        channels: &[(u16, u8)],
        source_addr: SocketAddr,
    ) -> RawArtnetFrame {
        make_frame_with_source_addr_and_sequence(universe_id, channels, source_addr, 1)
    }

    /// Builds an Art-Net frame with explicit sender and sequence metadata.
    fn make_frame_with_source_addr_and_sequence(
        universe_id: u16,
        channels: &[(u16, u8)],
        source_addr: SocketAddr,
        sequence: u8,
    ) -> RawArtnetFrame {
        let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        for (address, value) in channels {
            if *address == 0 || *address > MAX_CHANNELS_PER_UNIVERSE as u16 {
                continue;
            }
            data[(*address - 1) as usize] = *value;
        }

        RawArtnetFrame {
            universe_id,
            sequence,
            data,
            source_addr,
            received_at: Instant::now(),
        }
    }

    /// Binds a reusable UDP listener for local broadcast integration checks.
    fn init_shared_artnet_listener_socket(bind_addr: SocketAddr) -> std::io::Result<UdpSocket> {
        let domain = if bind_addr.is_ipv4() {
            Domain::IPV4
        } else {
            Domain::IPV6
        };
        let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))?;
        #[cfg(unix)]
        socket.set_reuse_port(true)?;
        socket.set_reuse_address(true)?;
        socket.bind(&bind_addr.into())?;
        Ok(socket.into())
    }

    /// Encodes a DMX universe into an Art-Net broadcast packet.
    fn make_artnet_broadcast_packet(universe_id: u16, sequence: u8) -> Vec<u8> {
        let port_address =
            PortAddress::try_from(universe_id).expect("invalid Art-Net universe for test");
        let output = Output {
            sequence,
            port_address,
            data: vec![0u8; 512].into(),
            ..Output::default()
        };
        ArtCommand::Output(output)
            .write_to_buffer()
            .expect("failed to encode Art-Net packet")
    }

    /// Verifies artnet input accepts frames from local source without metadata match.
    #[test]
    fn artnet_input_accepts_frames_from_local_source_without_metadata_match() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let local_source_addr = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40123);
        app.insert_resource(ArtNetRecentFramesByUniverse::new());

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(make_frame_with_source_addr(
            2,
            &[(1, 99)],
            local_source_addr,
        ))
        .expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input accepts frames from local ip with different port without metadata match.
    #[test]
    fn artnet_input_accepts_frames_from_local_ip_with_different_port_without_metadata_match() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        app.insert_resource(ArtNetRecentFramesByUniverse::new());

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(make_frame_with_source_addr(
            2,
            &[(1, 99)],
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40124),
        ))
        .expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input accepts frames from non matching source ip.
    #[test]
    fn artnet_input_accepts_frames_from_non_matching_source_ip() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        app.insert_resource(ArtNetRecentFramesByUniverse::new());

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(make_frame_with_source_addr(
            2,
            &[(1, 99)],
            SocketAddr::new(Ipv4Addr::new(203, 0, 113, 10).into(), 40124),
        ))
        .expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input ignores frames matching recent output metadata.
    #[test]
    fn artnet_input_ignores_frames_matching_recent_output_metadata() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let frame = make_frame_with_source_addr_and_sequence(
            2,
            &[(1, 99), (2, 77)],
            SocketAddr::new(Ipv4Addr::new(198, 51, 100, 10).into(), 6454),
            77,
        );

        let mut identity = ArtNetRecentFramesByUniverse::default();
        identity.record_recent_frame(
            frame.universe_id,
            frame.sequence,
            &frame.data,
            Some(frame.source_addr),
            frame.received_at,
        );
        app.insert_resource(identity);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(frame).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert!(!universes.has_universe(2));
    }

    /// Verifies artnet input accepts matching recent output metadata from same ip different port.
    #[test]
    fn artnet_input_accepts_matching_recent_output_metadata_from_same_ip_different_port() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let frame = make_frame_with_source_addr_and_sequence(
            2,
            &[(1, 99), (2, 77)],
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40124),
            77,
        );

        let mut identity = ArtNetRecentFramesByUniverse::default();
        identity.record_recent_frame(
            frame.universe_id,
            frame.sequence,
            &frame.data,
            Some(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40123)),
            frame.received_at,
        );
        app.insert_resource(identity);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(frame).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input ignores delayed loopback when many newer frames were sent.
    #[test]
    fn artnet_input_ignores_delayed_loopback_when_many_newer_frames_were_sent() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let source_addr = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40123);
        let sent_at = Instant::now();
        let mut delayed_loopback_frame =
            make_frame_with_source_addr_and_sequence(2, &[(1, 99), (2, 77)], source_addr, 77);
        delayed_loopback_frame.received_at = sent_at + Duration::from_millis(900);

        let mut identity = ArtNetRecentFramesByUniverse::default();
        identity.record_recent_frame(
            delayed_loopback_frame.universe_id,
            delayed_loopback_frame.sequence,
            &delayed_loopback_frame.data,
            Some(source_addr),
            sent_at,
        );

        for i in 1..80u8 {
            let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
            data[0] = i;
            identity.record_recent_frame(
                delayed_loopback_frame.universe_id,
                i,
                &data,
                Some(source_addr),
                sent_at + Duration::from_millis((i as u64) * 10),
            );
        }
        app.insert_resource(identity);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(delayed_loopback_frame)
            .expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert!(!universes.has_universe(2));
    }

    /// Verifies artnet input accepts recent loopback from same ip with non matching sequence.
    #[test]
    fn artnet_input_accepts_recent_loopback_from_same_ip_with_non_matching_sequence() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let source_addr = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40123);
        let sent_at = Instant::now();

        let mut identity = ArtNetRecentFramesByUniverse::default();
        let original =
            make_frame_with_source_addr_and_sequence(2, &[(1, 10), (2, 20)], source_addr, 10);
        identity.record_recent_frame(
            original.universe_id,
            original.sequence,
            &original.data,
            Some(source_addr),
            sent_at,
        );
        app.insert_resource(identity);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        let mut incoming = make_frame_with_source_addr_and_sequence(
            2,
            &[(1, 99), (2, 77)],
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 6454),
            88,
        );
        incoming.received_at = sent_at + Duration::from_millis(500);

        tx.send(incoming).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input accepts matching recent output metadata from different source ip.
    #[test]
    fn artnet_input_accepts_matching_recent_output_metadata_from_different_source_ip() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let sent_at = Instant::now();
        let mut frame = make_frame_with_source_addr_and_sequence(
            2,
            &[(1, 99), (2, 77)],
            SocketAddr::new(Ipv4Addr::new(203, 0, 113, 10).into(), 40124),
            77,
        );
        frame.received_at = sent_at + Duration::from_millis(100);

        let mut identity = ArtNetRecentFramesByUniverse::default();
        identity.record_recent_frame(
            frame.universe_id,
            frame.sequence,
            &frame.data,
            Some(SocketAddr::new(
                Ipv4Addr::new(198, 51, 100, 10).into(),
                frame.source_addr.port(),
            )),
            sent_at,
        );
        app.insert_resource(identity);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(frame).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input marks local frames as self in all detected mode.
    #[test]
    fn artnet_input_marks_local_frames_as_self_in_all_detected_mode() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.insert_resource(InputUniverseVisibilityMode::AllDetected);
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let sent_at = Instant::now();
        let mut frame = make_frame_with_source_addr_and_sequence(
            2,
            &[(1, 99), (2, 77)],
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 40124),
            77,
        );
        frame.received_at = sent_at + Duration::from_millis(100);

        let mut identity = ArtNetRecentFramesByUniverse::default();
        identity.record_recent_frame(
            frame.universe_id,
            frame.sequence,
            &frame.data,
            Some(frame.source_addr),
            sent_at,
        );
        app.insert_resource(identity);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(frame).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
        let input_universes = app.world().resource::<InputDmxUniverses>();
        assert_eq!(
            input_universes.is_self_frame(BindingTransport::ArtNet, 2),
            Some(true)
        );
    }

    /// Verifies artnet input ignores frames during startup grace for external only mode.
    #[test]
    fn artnet_input_ignores_frames_during_startup_grace_for_external_only_mode() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.insert_resource(InputUniverseVisibilityMode::ExternalOnly);
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let started_at = Instant::now();
        app.insert_resource(ArtNetInputStartup {
            grace_start_at: Some(started_at),
        });
        let mut frame = make_frame(2, &[(1, 99)]);
        frame.received_at = started_at + Duration::from_millis(100);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(frame).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert!(!universes.has_universe(2));
    }

    /// Verifies artnet input accepts frames during startup grace for all detected mode.
    #[test]
    fn artnet_input_accepts_frames_during_startup_grace_for_all_detected_mode() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();

        app.insert_resource(ArtnetEventReceiver(rx));
        app.insert_resource(InputUniverseVisibilityMode::AllDetected);
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let started_at = Instant::now();
        app.insert_resource(ArtNetInputStartup {
            grace_start_at: Some(started_at),
        });
        let mut frame = make_frame(2, &[(1, 99)]);
        frame.received_at = started_at + Duration::from_millis(100);

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![],
            },
        }];

        app.add_systems(Update, artnet_event_system.in_set(DmxInputSet::Ingress));

        tx.send(frame).expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
    }

    /// Verifies artnet input runs in layer generation before dmx output.
    #[test]
    fn artnet_input_runs_in_layer_generation_before_dmx_output() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        app.configure_sets(
            Update,
            (
                InputHandling,
                LayerGeneration.after(InputHandling),
                DmxOutput.after(LayerGeneration),
            ),
        );
        app.add_plugins(InputArtnetPlugin {
            network_input_enabled: false,
        });

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawArtnetFrame>();
        app.insert_resource(ArtnetEventReceiver(rx));
        app.insert_resource(InputUniverseVisibilityMode::AllDetected);

        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();
        let input_layer = spawn_transport_input_layer(&mut app);

        let parameter_entity = app
            .world_mut()
            .spawn((
                make_coarse_parameter(),
                ResolvedOutputDestinations {
                    destinations: vec![OutputDestination {
                        transport: OutputTransport::ArtNet {
                            mode: ArtNetDelivery::Broadcast,
                        },
                        universe: 2,
                        address: 1,
                    }],
                },
            ))
            .id();

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Console {
                target: ResolvedConsoleTarget {
                    universe: 2,
                    address: 1,
                },
                targets: vec![ResolvedInputTarget {
                    entity: parameter_entity,
                    offset: 0,
                }],
            },
        }];

        tx.send(make_frame(2, &[(1, 91)]))
            .expect("failed to enqueue frame");
        app.update();

        let layer = app
            .world()
            .get::<Layer>(input_layer)
            .expect("input layer must exist");
        assert_eq!(
            layer.absolute.values().next().map(|(value, _)| *value),
            Some(ParameterValue::AbsolutePercent {
                value: (91.0_f32 / 255.0).into()
            })
        );

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(91));
    }

    /// Verifies artnet shared listeners receive broadcast frames.
    #[test]
    fn artnet_shared_listeners_receive_broadcast_frames() {
        let _guard = TEST_LOCK.lock().expect("test lock poisoned");

        let first =
            init_shared_artnet_listener_socket(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), 0))
                .expect("first shared Art-Net listener should bind");
        let bind_addr = first
            .local_addr()
            .expect("first shared Art-Net listener should expose local address");

        let second = init_shared_artnet_listener_socket(bind_addr)
            .expect("second shared Art-Net listener should bind the same port");

        first
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("first listener should accept a read timeout");
        second
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("second listener should accept a read timeout");

        let (ready_tx, ready_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();

        for socket in [first, second] {
            let ready_tx = ready_tx.clone();
            let result_tx = result_tx.clone();
            thread::spawn(move || {
                let _ = ready_tx.send(());
                let mut buffer = [0u8; 2048];
                let received = socket.recv_from(&mut buffer).map(|(len, _addr)| {
                    matches!(
                        ArtCommand::from_buffer(&buffer[..len]),
                        Ok(ArtCommand::Output(output))
                            if output.sequence == 1 && u16::from(output.port_address) == 1
                    )
                });
                let _ = result_tx.send(received.unwrap_or(false));
            });
        }

        for _ in 0..2 {
            ready_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("listeners should be ready before broadcast is sent");
        }

        let sender =
            UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("broadcast sender should bind");
        sender
            .set_broadcast(true)
            .expect("broadcast sender should enable broadcast");
        let packet = make_artnet_broadcast_packet(1, 1);
        if let Err(error) = sender.send_to(
            &packet,
            SocketAddrV4::new(Ipv4Addr::BROADCAST, bind_addr.port()),
        ) {
            if broadcast_route_unavailable(&error) {
                eprintln!("skipping broadcast listener assertion: {error}");
                return;
            }
            panic!("broadcast Art-Net packet should send: {error}");
        }

        let mut received_count = 0;
        for _ in 0..2 {
            if result_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("both listeners should report a result")
            {
                received_count += 1;
            }
        }

        assert_eq!(
            received_count, 2,
            "both shared listeners should receive broadcast traffic"
        );
    }
}
