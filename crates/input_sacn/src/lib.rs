// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! sACN input handling crate

#![warn(missing_docs)]

#[cfg(test)]
use std::time::Instant;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
#[cfg(test)]
use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::*;
use nightfall_io::{BindingTransport, SacnOutputIdentity};
use tokio::sync::mpsc::UnboundedReceiver;

mod service;

use crate::service::{NetworkInputBindStatus, SacnInputFrame};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::InputSacnPlugin;
}

/// Plugin for handling sACN input
pub struct InputSacnPlugin {
    /// Whether network input is enabled.
    pub network_input_enabled: bool,
}

impl Default for InputSacnPlugin {
    /// Verifies default.
    fn default() -> Self {
        Self {
            network_input_enabled: true,
        }
    }
}

/// Synchronize the input listener and disable input if binding fails.
fn sync_sacn_input_binding(
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

        let status = service::process_sacn_input_service().sync_with_settings(
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
        BindingTransport::Sacn,
        5568,
        settings.as_mut(),
        notifications,
    );
}

/// Disable network input and emit an IO observation after sACN listener binding fails.
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

impl Plugin for InputSacnPlugin {
    /// Verifies build.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering InputSacnPlugin");
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();
        app.init_resource::<TransportRuntimePolicy>();
        app.add_message::<AcceptedDmxFrame>();
        let sacn_service = service::process_sacn_input_service();
        let _ = sacn_service.configure_network_input_enabled(self.network_input_enabled);
        let sacn_rx = sacn_service.client().subscribe().unwrap_or_else(|| {
            let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawSacnFrame>();
            rx
        });

        app.insert_resource(SacnEventReceiver(sacn_rx));
        app.add_systems(Update, sync_sacn_input_binding.after(EventHandling));
        app.add_systems(
            Update,
            sacn_event_system
                .in_set(DmxInputSet::Ingress)
                .in_set(LayerGeneration),
        );
    }
}

type RawSacnFrame = SacnInputFrame;

/// Resource that receives decoded sACN input events from the listener thread.
#[derive(Resource)]
struct SacnEventReceiver(UnboundedReceiver<RawSacnFrame>);

/// Drain decoded sACN frames, publishing only frames accepted by input policy.
fn sacn_event_system(
    mut sacn_rx: ResMut<SacnEventReceiver>,
    sacn_output_identity: Option<Res<SacnOutputIdentity>>,
    input_universe_visibility_mode: Option<Res<InputUniverseVisibilityMode>>,
    mut frames: MessageWriter<AcceptedDmxFrame>,
) {
    while let Ok(frame) = sacn_rx.0.try_recv() {
        if let Some(frame) = accept_frame(
            sacn_output_identity.as_deref(),
            input_universe_visibility_mode
                .as_deref()
                .copied()
                .unwrap_or_default(),
            frame,
        ) {
            frames.write(frame);
        }
    }
}

/// Classifies local output and applies sACN visibility policy before publishing a frame.
fn accept_frame(
    sacn_output_identity: Option<&SacnOutputIdentity>,
    input_universe_visibility_mode: InputUniverseVisibilityMode,
    frame: RawSacnFrame,
) -> Option<AcceptedDmxFrame> {
    let is_self_frame = is_frame_from_local_sacn_output(&frame, sacn_output_identity);
    if input_universe_visibility_mode == InputUniverseVisibilityMode::ExternalOnly && is_self_frame
    {
        return None;
    }

    tracing::trace!(
        universe_id = frame.universe_id,
        received_at = ?frame.received_at,
        "Applying sACN frame"
    );
    Some(AcceptedDmxFrame {
        transport: BindingTransport::Sacn,
        universe: frame.universe_id,
        data: frame.data,
        received_at: frame.received_at,
        is_self_frame,
    })
}

/// Return true when a frame originated from this process' sACN output source CID.
fn is_frame_from_local_sacn_output(
    frame: &RawSacnFrame,
    sacn_output_identity: Option<&SacnOutputIdentity>,
) -> bool {
    let Some(identity) = sacn_output_identity else {
        return false;
    };
    let Some(local_cid) = identity.cid else {
        return false;
    };
    frame
        .source_cid
        .is_some_and(|source_cid| source_cid == local_cid)
}

#[cfg(test)]
mod tests {
    use bevy_ecs::system::RunSystemOnce;
    use nightfall_compositor::prelude::Layer;
    use nightfall_dmx::prelude::{DmxValueResolution, ParameterValue};
    use nightfall_fixtures::input_apply::TransportInputPlugin;
    use nightfall_fixtures::prelude::TRANSPORT_INPUT_LAYER_PRIORITY;
    use nightfall_fixtures::prelude::*;

    use super::*;

    /// Verifies sACN bind failures disable network input and publish their cause.
    #[test]
    fn sacn_bind_failure_disables_network_input_and_emits_observation() {
        let mut app = App::new();
        app.insert_resource(IoRuntimeSettings::default());
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();

        app.world_mut()
            .run_system_once(
                |mut settings: ResMut<IoRuntimeSettings>,
                 notifications: MessageWriter<NotificationEnvelope<IoRuntimeNotification>>| {
                    disable_network_input_after_bind_failure(
                        NetworkInputBindStatus::Failed,
                        BindingTransport::Sacn,
                        5568,
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
                        transport: BindingTransport::Sacn,
                        port: 5568
                    }
                )
            }),
            "expected a bind-failure observation for the sACN bind failure"
        );
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
    fn make_frame(universe_id: u16, channels: &[(u16, u8)]) -> RawSacnFrame {
        make_frame_with_source_cid(universe_id, channels, None)
    }

    /// Builds a decoded sACN frame with explicit source identity.
    fn make_frame_with_source_cid(
        universe_id: u16,
        channels: &[(u16, u8)],
        source_cid: Option<[u8; 16]>,
    ) -> RawSacnFrame {
        let mut data = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        for (address, value) in channels {
            if *address == 0 || *address > MAX_CHANNELS_PER_UNIVERSE as u16 {
                continue;
            }
            data[(*address - 1) as usize] = *value;
        }

        RawSacnFrame {
            universe_id,
            data,
            source_cid,
            received_at: Instant::now(),
        }
    }

    /// Verifies sacn input ignores frames from local sacn output source.
    #[test]
    fn sacn_input_ignores_frames_from_local_sacn_output_source() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawSacnFrame>();

        app.insert_resource(SacnEventReceiver(rx));
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let local_cid = [7u8; 16];
        app.insert_resource(SacnOutputIdentity {
            cid: Some(local_cid),
        });

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::Sacn,
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

        app.add_systems(Update, sacn_event_system.in_set(DmxInputSet::Ingress));

        tx.send(make_frame_with_source_cid(2, &[(1, 99)], Some(local_cid)))
            .expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert!(!universes.has_universe(2));
    }

    /// Verifies sacn input accepts frames from local sacn output source in all detected mode.
    #[test]
    fn sacn_input_accepts_frames_from_local_sacn_output_source_in_all_detected_mode() {
        let mut app = App::new();
        app.add_plugins(TransportInputPlugin);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawSacnFrame>();

        app.insert_resource(SacnEventReceiver(rx));
        app.insert_resource(InputUniverseVisibilityMode::AllDetected);
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();

        let local_cid = [7u8; 16];
        app.insert_resource(SacnOutputIdentity {
            cid: Some(local_cid),
        });

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::Sacn,
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

        app.add_systems(Update, sacn_event_system.in_set(DmxInputSet::Ingress));

        tx.send(make_frame_with_source_cid(2, &[(1, 99)], Some(local_cid)))
            .expect("failed to enqueue frame");
        app.update();

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(99));
        let input_universes = app.world().resource::<InputDmxUniverses>();
        assert_eq!(
            input_universes.is_self_frame(BindingTransport::Sacn, 2),
            Some(true)
        );
    }

    /// Verifies sacn input runs in layer generation before dmx output.
    #[test]
    fn sacn_input_runs_in_layer_generation_before_dmx_output() {
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
        app.add_plugins(InputSacnPlugin {
            network_input_enabled: false,
        });

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RawSacnFrame>();
        app.insert_resource(SacnEventReceiver(rx));

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
                        transport: OutputTransport::Sacn {
                            mode: SacnDelivery::Multicast,
                        },
                        universe: 2,
                        addresses: vec![1],
                    }],
                },
            ))
            .id();

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::Sacn,
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

        tx.send(make_frame(2, &[(1, 77)]))
            .expect("failed to enqueue frame");
        app.update();

        let layer = app
            .world()
            .get::<Layer>(input_layer)
            .expect("input layer must exist");
        assert_eq!(
            layer.absolute.values().next().map(|(value, _)| *value),
            Some(ParameterValue::AbsolutePercent {
                value: (77.0_f32 / 255.0).into()
            })
        );

        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(2, 1), Some(77));
    }
}
