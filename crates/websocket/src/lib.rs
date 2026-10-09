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

use std::sync::{Arc, Mutex};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::{ExternalControlState, NetworkInterfaceState};
use tokio::sync::broadcast::Sender as BroadcastSender;

use crate::websocket::create_axum_task;

mod external_control;
mod origin;
mod outbox;
mod pairing;
pub mod routes;
mod web_ui;
pub mod websocket;

pub use web_ui::{SharedWebUiAssets, WebUiAssets};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::routes::HttpRouteRegistry;
    pub use crate::websocket::AxumAppState;
    pub use crate::{SharedWebUiAssets, WebUiAssets, WebsocketHost, WebsocketPlugin};
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

/// Process-scoped handle that keeps one Axum server running across Bevy world replacement.
///
/// Insert a clone of the same host into every world a process builds, together
/// with a shared client bridge, and clients stay connected while showfile loads
/// swap worlds. The first world to start spawns the server; later worlds attach
/// to it and install their own plugin routes. Without a pre-inserted host each
/// world owns a private server that stops when the world is dropped.
#[derive(Resource, Clone)]
pub struct WebsocketHost {
    shutdown_tx: BroadcastSender<()>,
    running: Arc<Mutex<Option<RunningServer>>>,
    web_ui: Option<SharedWebUiAssets>,
}

impl Default for WebsocketHost {
    fn default() -> Self {
        let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
        Self {
            shutdown_tx,
            running: Arc::default(),
            web_ui: None,
        }
    }
}

impl WebsocketHost {
    /// Serves the built web UI from the backend port for requests no backend route claims.
    ///
    /// Takes effect when the first world starts the server, so set it before building worlds.
    #[must_use]
    pub fn with_web_ui(mut self, assets: SharedWebUiAssets) -> Self {
        self.web_ui = Some(assets);
        self
    }
}

/// World-independent handles of a server spawned by an earlier world.
struct RunningServer {
    routes: websocket::SwappableRoutes,
    listener_control: external_control::ListenerControl,
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
        let host = app
            .world()
            .get_resource::<WebsocketHost>()
            .cloned()
            .unwrap_or_default();

        // HTTP route registry for plugin-owned endpoint registration
        app.init_resource::<routes::HttpRouteRegistry>();
        app.insert_resource(AxumShutdownSignal {
            tx: host.shutdown_tx.clone(),
        });
        app.insert_resource(AxumTaskConfig {
            bind_port: self.bind_port,
            shutdown_tx: host.shutdown_tx.clone(),
        });
        app.insert_resource(host);

        app.init_resource::<ExternalControlState>();
        app.init_resource::<NetworkInterfaceState>();
        app.add_systems(Startup, start_or_attach_axum_task);
        app.add_systems(Update, external_control::sync_listener_control);
        app.add_systems(Update, notify_axum_shutdown_on_exit.in_set(EventHandling));
    }
}

/// Launches the Axum transport, or attaches this world to the one an earlier world launched.
///
/// Attaching installs this world's plugin routes and listener control handles
/// without rebinding sockets, so connected clients are unaffected.
fn start_or_attach_axum_task(
    mut commands: Commands,
    mut state: ResMut<ExternalControlState>,
    interfaces: Res<NetworkInterfaceState>,
    config: Res<AxumTaskConfig>,
    host: Res<WebsocketHost>,
    mut client_bridge: ResMut<ClientBridgeHost>,
    mut route_registry: ResMut<routes::HttpRouteRegistry>,
) {
    let plugin_routes = route_registry.take_router();
    let stateful_plugin_routes = route_registry.take_stateful_router();
    let mut running = host
        .running
        .lock()
        .expect("websocket host lock should not be poisoned");

    if let Some(server) = running.as_ref() {
        tracing::debug!("Attaching world to running websocket server");
        server.routes.replace(plugin_routes, stateful_plugin_routes);
        external_control::attach_listener_control(&server.listener_control, &mut state);
        commands.insert_resource(server.listener_control.clone());
        return;
    }

    let Some(client_event_rx) = client_bridge.take_output_receiver() else {
        return;
    };
    let (listener_control, listener_config) =
        external_control::initialize_listener_control(&mut state, &interfaces, config.bind_port);
    commands.insert_resource(listener_control.clone());

    let shutdown_rx = config.shutdown_tx.subscribe();
    let (_task, routes) = create_axum_task(
        listener_config,
        shutdown_rx,
        client_event_rx,
        client_bridge.command_sender(),
        client_bridge.update_sender(),
        plugin_routes,
        stateful_plugin_routes,
        host.web_ui.clone(),
    );
    *running = Some(RunningServer {
        routes,
        listener_control,
    });
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

#[cfg(test)]
mod host_tests {
    use std::time::Duration;

    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// Builds and starts one world attached to the shared host, serving a marker route.
    fn start_world(
        host: &WebsocketHost,
        bridge: &SharedClientBridge,
        port: u16,
        marker: &'static str,
    ) -> App {
        let mut app = App::new();
        app.insert_resource(host.clone());
        app.insert_resource(bridge.clone());
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        app.add_plugins(WebsocketPlugin::new(port));
        app.world_mut()
            .resource_mut::<routes::HttpRouteRegistry>()
            .register("/marker", axum::routing::get(move || async move { marker }));
        app.update();
        app
    }

    /// Fetches the marker route body over a plain HTTP/1.1 request.
    async fn fetch_marker(port: u16) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream
            .write_all(b"GET /marker HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    /// Verifies a replacement world keeps existing websocket clients connected,
    /// serves its own plugin routes, and publishes through the same connection.
    #[tokio::test(flavor = "multi_thread")]
    async fn replacement_world_keeps_clients_and_swaps_routes() {
        let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let host = WebsocketHost::default();
        let bridge = SharedClientBridge::new();

        let first = start_world(&host, &bridge, port, "first");
        let mut client = None;
        for _ in 0..50 {
            if let Ok((socket, _)) =
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws")).await
            {
                client = Some(socket);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mut client = client.expect("first world should start the server");
        let _version = client.next().await.unwrap().unwrap();
        assert!(fetch_marker(port).await.ends_with("first"));

        drop(first);
        let second = start_world(&host, &bridge, port, "second");
        assert!(fetch_marker(port).await.ends_with("second"));

        second.world().resource::<ClientEventSink>().publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::WorldReplaced,
        );
        let delivered = tokio::time::timeout(Duration::from_secs(5), client.next())
            .await
            .expect("the existing client should receive the new world's output")
            .unwrap()
            .unwrap();
        assert!(delivered.is_binary());
        client
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"WebSocketHeartbeat","data":{"id":1}}"#.into(),
            ))
            .await
            .expect("the existing connection should stay open");
    }
}
