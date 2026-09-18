// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Native Axum WebSocket and HTTP host adapter.
//!
//! The transport-neutral client bridge lives in `nightfall-engine`. This crate owns
//! socket lifecycle, heartbeat handling, native HTTP routes, and byte forwarding.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use tokio::sync::broadcast::Sender as BroadcastSender;

use crate::websocket::create_axum_task;

mod external_control;
pub mod routes;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::WebsocketPlugin;
    pub use crate::routes::HttpRouteRegistry;
    pub use crate::websocket::{AxumAppState, websocket_router};
}

/// Resource used to signal axum task shutdown once we receive an AppExit event.
///
/// See also: start_axum_task() system.
#[derive(Resource)]
struct AxumShutdownSignal {
    tx: BroadcastSender<()>,
}

/// Resource used to pass configuration for the axum task creation.
///
/// See also: notify_axum_shutdown_on_exit() system.
#[derive(Resource)]
struct AxumTaskConfig {
    bind_port: u16,
    shutdown_tx: BroadcastSender<()>,
}

/// Plugin for adding WebSocket output on a configured backend port.
pub struct WebsocketPlugin {
    bind_port: u16,
}

impl WebsocketPlugin {
    /// Builds a WebSocket plugin for the supplied backend port.
    #[must_use]
    pub const fn new(bind_port: u16) -> Self {
        Self { bind_port }
    }
}

impl Plugin for WebsocketPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering WebsocketPlugin");
        assert!(
            app.is_plugin_added::<ClientBridgePlugin>(),
            "WebsocketPlugin requires ClientBridgePlugin"
        );
        let (axum_shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);

        // HTTP route registry for plugin-owned endpoint registration
        app.init_resource::<routes::HttpRouteRegistry>();
        app.insert_resource(AxumShutdownSignal {
            tx: axum_shutdown_tx.clone(),
        });
        app.insert_resource(AxumTaskConfig {
            bind_port: self.bind_port,
            shutdown_tx: axum_shutdown_tx,
        });

        app.init_resource::<nightfall_io::ExternalControlState>();
        app.init_resource::<nightfall_io::NetworkInterfaceState>();
        app.add_systems(
            Startup,
            external_control::initialize_listener_control.pipe(start_axum_task),
        );
        app.add_systems(Update, external_control::sync_listener_control);
        app.add_systems(Update, notify_axum_shutdown_on_exit.in_set(EventHandling));
    }
}

/// Launches the Axum transport with prepared listener configuration and client routes.
fn start_axum_task(
    In(listener_config): In<external_control::ListenerTaskConfig>,
    config: Res<AxumTaskConfig>,
    mut client_bridge: ResMut<ClientBridgeHost>,
    mut route_registry: ResMut<routes::HttpRouteRegistry>,
) {
    let Some(client_event_rx) = client_bridge.take_output_receiver() else {
        return;
    };

    // Take the router with all registered routes
    let plugin_routes = route_registry.take_router();
    let stateful_plugin_routes = route_registry.take_stateful_router();

    let shutdown_rx = config.shutdown_tx.subscribe();
    create_axum_task(
        listener_config,
        shutdown_rx,
        client_event_rx,
        client_bridge.command_sender(),
        client_bridge.update_sender(),
        plugin_routes,
        stateful_plugin_routes,
    );
}

/// Notify the shutdown signal in Axum-land when an AppExit event is received in Bevy-land
fn notify_axum_shutdown_on_exit(
    mut app_exit_events: MessageReader<AppExit>,
    shutdown: Res<AxumShutdownSignal>,
) {
    if app_exit_events.read().next().is_some() {
        let _ = shutdown.tx.send(());
    }
}
