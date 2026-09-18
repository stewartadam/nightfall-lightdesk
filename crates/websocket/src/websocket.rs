// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Axum integration for managing a websocket endpoint and its clients
use std::{
    io::ErrorKind,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use async_channel::{Receiver as ClientReceiver, Sender as ClientSender};
use axum::{
    Extension, Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{ConnectInfo, State},
    http::{Method, header},
    response::IntoResponse,
    routing::get,
};
use futures_util::SinkExt;
use futures_util::StreamExt;
use minicbor_serde;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{broadcast::Receiver as BroadcastReceiver, mpsc::UnboundedSender},
};
use tower_http::cors::{Any, CorsLayer};

const TRANSPORT_HEARTBEAT_RESPONSE_TYPE: &str = "WebSocketHeartbeatResponse";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TransportHeartbeatData {
    id: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type")]
enum TransportMessage {
    #[serde(rename = "WebSocketHeartbeat")]
    Heartbeat { data: TransportHeartbeatData },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum InboundWebsocketText {
    Command(CommandJsonEnvelope),
    Update(UpdateJsonEnvelope),
    Transport(TransportMessage),
}

#[derive(Clone, Debug, Serialize)]
struct TransportHeartbeatResponse<'a> {
    #[serde(rename = "type")]
    t: &'static str,
    data: &'a TransportHeartbeatData,
}

/// A connected session and whether it arrived through the loopback interface.
#[derive(Clone)]
pub struct ConnectedClient {
    /// Outbound message channel for this session.
    pub sender: UnboundedSender<Message>,
    /// Cancels both I/O tasks without depending on the peer reading an outgoing frame.
    pub cancellation: tokio::sync::watch::Sender<bool>,
    /// Whether the session is local and survives external permission changes.
    pub local: bool,
}

#[derive(Clone)]
/// State shared for the axum app
pub struct AxumAppState {
    /// Channel for sending JSON command envelopes from Axum
    pub command_json_tx: ClientSender<CommandJsonEnvelope>,
    /// Channel for sending untracked JSON update envelopes from Axum.
    pub update_json_tx: ClientSender<UpdateJsonEnvelope>,
    /// Maintains references the message channels of connected client
    pub clients: Arc<Mutex<Vec<ConnectedClient>>>,
    /// Admission generation used to reject remote upgrades from retired listeners.
    pub remote_generation: Arc<AtomicU64>,
}

/// Handle an incoming HTTP websocket request
async fn handle_socket(
    ws: WebSocketUpgrade,
    State(state): State<AxumAppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(generation): Extension<u64>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client_ws(socket, state, peer.ip().is_loopback(), generation))
}

/// Encodes a non-droppable CBOR payload using the websocket binary wire format.
fn non_droppable_binary_message<T: Serialize>(payload: &T) -> Option<Message> {
    minicbor_serde::to_vec(payload).ok().map(|cbor_data| {
        let mut encoded = Vec::with_capacity(1 + cbor_data.len());
        encoded.push(DISCRIMINATOR_NON_DROPPABLE);
        encoded.extend(cbor_data);
        Message::Binary(encoded.into())
    })
}

/// Returns a direct websocket heartbeat response for transport-owned latency probes.
fn encode_transport_heartbeat_response(data: &TransportHeartbeatData) -> Option<Message> {
    non_droppable_binary_message(&TransportHeartbeatResponse {
        t: TRANSPORT_HEARTBEAT_RESPONSE_TYPE,
        data,
    })
}

/// Handle a new client connection (post upgrade)
async fn client_ws(mut socket: WebSocket, state: AxumAppState, local: bool, generation: u64) {
    tracing::debug!("WebSocket client connected");

    // Get the current crate version to send to the client
    let version = env!("CARGO_PKG_VERSION");

    // Send server version to this new client using the typeshare'd EngineClientMessage
    let payload = EngineClientMessage::ServerVersion(version);

    if let Some(message) = non_droppable_binary_message(&payload) {
        // Send directly to this client
        // We can't use the normal outbound path since the client isn't fully registered yet
        let _ = socket.send(message).await;
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let (cancellation, cancellation_rx) = tokio::sync::watch::channel(false);
    let clients = state.clients.clone();
    let command_json_tx = state.command_json_tx.clone();
    let update_json_tx = state.update_json_tx.clone();

    // Register client and then drop reference to the guard
    // Required to that this async fn is Send-compatible
    {
        let mut guard = clients.lock().unwrap();
        if !local && state.remote_generation.load(Ordering::Acquire) != generation {
            return;
        }
        guard.push(ConnectedClient {
            sender: tx.clone(),
            cancellation,
            local,
        });
    }

    // Task: forward backend → client
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let should_close = matches!(msg, Message::Close(_));
            if ws_sender.send(msg).await.is_err() {
                break;
            }
            if should_close {
                break;
            }
        }
    });

    // Task: client → backend
    let tx_for_recv = tx.clone();
    let recv_task = tokio::spawn({
        let clients = clients.clone();
        async move {
            while let Some(Ok(msg)) = ws_receiver.next().await {
                if let Message::Text(text) = msg {
                    match serde_json::from_str::<InboundWebsocketText>(&text) {
                        Ok(InboundWebsocketText::Command(json_envelope)) => {
                            tracing::trace!(
                                "Parsed command envelope from websocket (module={})",
                                json_envelope.module
                            );
                            let _ = command_json_tx.send(json_envelope).await;
                        }
                        Ok(InboundWebsocketText::Update(json_envelope)) => {
                            tracing::trace!(
                                "Parsed update envelope from websocket (module={})",
                                json_envelope.module
                            );
                            let _ = update_json_tx.send(json_envelope).await;
                        }
                        Ok(InboundWebsocketText::Transport(TransportMessage::Heartbeat {
                            data,
                        })) => {
                            if let Some(message) = encode_transport_heartbeat_response(&data) {
                                tracing::trace!("Responding to transport websocket heartbeat");
                                let _ = tx_for_recv.send(message);
                            }
                        }
                        Err(_) => {
                            tracing::warn!("Failed to deserialize websocket text message");
                            tracing::debug!("Message that failed: {}", text);
                        }
                    }
                }
            }

            // Stop tracking this client, then drop the reference to the guard
            // Required to that this async fn is Send-compatible
            {
                let mut guard = clients.lock().unwrap();
                guard.retain(|c| !c.sender.same_channel(&tx_for_recv));
            }
        }
    });

    supervise_client_tasks(send_task, recv_task, cancellation_rx).await;

    let mut guard = clients.lock().unwrap();
    guard.retain(|c| !c.sender.same_channel(&tx));
}

/// Cancels both socket directions on revocation even when either task is blocked on I/O.
async fn supervise_client_tasks(
    mut send_task: tokio::task::JoinHandle<()>,
    mut recv_task: tokio::task::JoinHandle<()>,
    mut cancellation: tokio::sync::watch::Receiver<bool>,
) {
    tokio::select! {
        biased;
        _ = cancellation.changed() => {
            send_task.abort();
            recv_task.abort();
            let _ = tokio::join!(send_task, recv_task);
        }
        _ = &mut send_task => {
            recv_task.abort();
            let _ = recv_task.await;
        }
        _ = &mut recv_task => {
            send_task.abort();
            let _ = send_task.await;
        }
    }
}

/// Closes every active session when listener permissions change or the host exits.
fn close_connected_clients(clients: &Arc<Mutex<Vec<ConnectedClient>>>) {
    let mut guard = clients.lock().unwrap();
    let close_message = Message::Close(None);
    for client in guard.iter() {
        client.cancellation.send_replace(true);
        let _ = client.sender.send(close_message.clone());
    }
    guard.clear();
}

/// Revokes remote sessions while keeping the local operator connected during rebinding.
fn close_remote_clients(clients: &Arc<Mutex<Vec<ConnectedClient>>>, generation: &AtomicU64) -> u64 {
    let mut clients = clients.lock().unwrap();
    let next_generation = generation.fetch_add(1, Ordering::AcqRel) + 1;
    clients.retain(|client| {
        if !client.local {
            client.cancellation.send_replace(true);
            let _ = client.sender.send(Message::Close(None));
        }
        client.local
    });
    next_generation
}

/// Retries transient address conflicts while a previous listener is being released.
async fn bind_listener_with_retry(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let mut last_error = None;

    for attempt in 1..=20 {
        match TcpListener::bind(&addr).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == ErrorKind::AddrInUse && attempt < 20 => {
                last_error = Some(error);
                tracing::warn!(attempt, "WebSocket bind address {} in use; retrying", addr);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            ErrorKind::AddrInUse,
            format!("failed to bind websocket listener at {addr}"),
        )
    }))
}

/// Stops accepting connections and closes HTTP keep-alives before replacing listeners.
async fn stop_listeners(
    servers: &mut tokio::task::JoinSet<std::io::Result<()>>,
    shutdown: &tokio::sync::broadcast::Sender<()>,
) {
    let _ = shutdown.send(());
    if tokio::time::timeout(Duration::from_secs(2), async {
        while servers.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        servers.abort_all();
        while servers.join_next().await.is_some() {}
    }
}

/// Start the axum websocket server and broadcast task.
pub(crate) fn create_axum_task(
    config: crate::external_control::ListenerTaskConfig,
    mut shutdown_rx: BroadcastReceiver<()>,
    ws_broadcast_rx: ClientReceiver<Vec<u8>>,
    command_json_tx: ClientSender<CommandJsonEnvelope>,
    update_json_tx: ClientSender<UpdateJsonEnvelope>,
    plugin_routes: Router,
    stateful_plugin_routes: Router<AxumAppState>,
) -> tokio::task::JoinHandle<()> {
    let crate::external_control::ListenerTaskConfig {
        port,
        mut requests,
        status,
        settings_path,
    } = config;
    let clients: Arc<Mutex<Vec<ConnectedClient>>> = Default::default();
    let remote_generation = Arc::new(AtomicU64::new(0));
    let state = AxumAppState {
        command_json_tx,
        update_json_tx,
        clients: clients.clone(),
        remote_generation: remote_generation.clone(),
    };
    let axum_app = websocket_router(state, plugin_routes, stateful_plugin_routes);

    // Byte-oriented broadcast task for plugin-owned serialization
    let _broadcast_task = tokio::spawn({
        let clients = clients.clone();
        async move {
            while let Ok(encoded) = ws_broadcast_rx.recv().await {
                tracing::trace!(
                    "Sending plugin-serialized websocket message ({} KB)",
                    encoded.len() as f32 / 1024.0
                );
                let message = Message::Binary(encoded.into());
                let mut guard = clients.lock().unwrap();
                guard.retain(|client| client.sender.send(message.clone()).is_ok());
            }
        }
    });

    tokio::spawn(async move {
        let mut process_shutdown_rx = subscribe_process_shutdown();
        let mut servers = tokio::task::JoinSet::new();
        let (listener_shutdown, _) = tokio::sync::broadcast::channel::<()>(1);
        let mut persisted_settings = requests.borrow().settings.clone();
        let mut initial = true;
        loop {
            let request = requests.borrow_and_update().clone();
            let generation = close_remote_clients(&clients, &remote_generation);
            stop_listeners(&mut servers, &listener_shutdown).await;
            let mut errors: Vec<String> = request.error.clone().into_iter().collect();
            if initial {
                errors.extend(status.borrow().error.clone());
                initial = false;
            }
            if request.settings != persisted_settings {
                match crate::external_control::save_settings(
                    settings_path.as_deref(),
                    &request.settings,
                ) {
                    Ok(()) => persisted_settings = request.settings.clone(),
                    Err(error) => errors.push(format!(
                        "Could not save external control preferences: {error}"
                    )),
                }
            }
            let mut listeners = Vec::new();
            for address in &request.addresses {
                match bind_listener_with_retry(*address).await {
                    Ok(listener) => listeners.push(listener),
                    Err(error) => errors.push(format!("Could not listen on {address}: {error}")),
                }
            }
            // A failed wildcard bind must never leave the local UI without a listener.
            if !listeners.iter().any(|listener| {
                listener.local_addr().is_ok_and(|address| {
                    address.ip().is_unspecified() || address.ip().is_loopback()
                })
            }) {
                match bind_listener_with_retry(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await
                {
                    Ok(listener) => listeners.push(listener),
                    Err(error) => {
                        tracing::error!(%error, "Failed to bind local websocket server");
                        std::process::exit(1);
                    }
                }
            }
            let listening_addresses = listeners
                .iter()
                .filter_map(|listener| listener.local_addr().ok())
                .map(|address| address.to_string())
                .collect();
            status.send_replace(nightfall_io::ExternalControlState {
                available: true,
                settings: request.settings,
                listening_addresses,
                error: if errors.is_empty() {
                    None
                } else {
                    Some(errors.join(" "))
                },
            });
            for listener in listeners {
                let app = axum_app.clone().layer(Extension(generation));
                let mut shutdown = listener_shutdown.subscribe();
                servers.spawn(async move {
                    axum::serve(
                        listener,
                        app.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .with_graceful_shutdown(async move {
                        let _ = shutdown.recv().await;
                    })
                    .await
                });
            }
            if is_process_shutdown_requested() {
                break;
            }
            tokio::select! {
                changed = requests.changed() => { if changed.is_err() { break; } }
                _ = shutdown_rx.recv() => break,
                _ = process_shutdown_rx.recv() => break,
                result = servers.join_next() => {
                    tracing::error!(?result, "Websocket listener exited unexpectedly");
                    break;
                }
            }
        }
        close_connected_clients(&clients);
        stop_listeners(&mut servers, &listener_shutdown).await;
        _broadcast_task.abort();
    })
}

/// Combine core and plugin routes under one cross-origin policy for desktop and browser clients.
pub fn websocket_router(
    state: AxumAppState,
    plugin_routes: Router,
    stateful_plugin_routes: Router<AxumAppState>,
) -> Router {
    // Core routes that require the shared websocket state
    let core_routes = Router::new()
        .route("/ws", get(handle_socket))
        .merge(stateful_plugin_routes)
        .with_state(state);

    // Merge core routes with plugin-registered stateless routes
    core_routes.merge(plugin_routes).layer(
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::HEAD, Method::POST, Method::OPTIONS])
            .allow_headers([header::CONTENT_TYPE, header::RANGE])
            .expose_headers([
                header::ACCEPT_RANGES,
                header::CONTENT_LENGTH,
                header::CONTENT_RANGE,
                axum::http::HeaderName::from_static("x-showfile-export-warnings"),
                axum::http::HeaderName::from_static("x-diagnostic-export-warnings"),
            ]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises live wildcard/local rebinding and fallback after a selected address fails.
    #[tokio::test]
    async fn listener_rebinds_and_recovers_local_access() {
        use nightfall_io::{ExternalControlSettings, ExternalControlState};

        use crate::external_control::ListenerRequest;
        let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let local = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut request = ListenerRequest {
            settings: ExternalControlSettings::default(),
            addresses: vec![local],
            error: None,
        };
        let (requests, request_rx) = tokio::sync::watch::channel(request.clone());
        let (status_tx, mut status) = tokio::sync::watch::channel(ExternalControlState::default());
        let (shutdown, shutdown_rx) = tokio::sync::broadcast::channel(1);
        let (_broadcast_tx, broadcast_rx) = async_channel::unbounded();
        let (command_tx, _command_rx) = async_channel::unbounded();
        let (update_tx, _update_rx) = async_channel::unbounded();
        let directory = tempfile::tempdir().unwrap();
        let task = create_axum_task(
            crate::external_control::ListenerTaskConfig {
                port,
                requests: request_rx,
                status: status_tx,
                settings_path: Some(directory.path().join("control.json")),
            },
            shutdown_rx,
            broadcast_rx,
            command_tx,
            update_tx,
            Router::new(),
            Router::new(),
        );
        tokio::time::timeout(Duration::from_secs(5), status.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.borrow().listening_addresses, vec![local.to_string()]);
        let (mut local_client, _) = tokio_tungstenite::connect_async(format!("ws://{local}/ws"))
            .await
            .unwrap();
        let _version = local_client.next().await.unwrap().unwrap();
        request.settings.enabled = true;
        request.addresses = vec![SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))];
        requests.send_replace(request.clone());
        tokio::time::timeout(Duration::from_secs(5), status.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            status.borrow().listening_addresses,
            vec![format!("0.0.0.0:{port}")]
        );
        assert!(tokio::net::TcpStream::connect(local).await.is_ok());
        local_client
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"WebSocketHeartbeat","data":{"id":7}}"#.into(),
            ))
            .await
            .unwrap();
        let heartbeat = tokio::time::timeout(Duration::from_secs(5), local_client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            heartbeat.is_binary(),
            "local session must survive rebinding"
        );
        request.settings.interface = Some("missing".into());
        request.addresses = vec![SocketAddr::from((Ipv4Addr::new(192, 0, 2, 99), port))];
        requests.send_replace(request.clone());
        tokio::time::timeout(Duration::from_secs(5), status.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.borrow().listening_addresses, vec![local.to_string()]);
        assert!(
            status
                .borrow()
                .error
                .as_ref()
                .unwrap()
                .contains("Could not listen")
        );
        request.settings.enabled = false;
        request.addresses = vec![local];
        requests.send_replace(request);
        tokio::time::timeout(Duration::from_secs(5), status.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(status.borrow().error.is_none());
        assert!(tokio::net::TcpStream::connect(local).await.is_ok());
        shutdown.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }

    /// Verifies direct native encoding matches the transport-neutral bridge bytes.
    #[test]
    fn native_wire_encoding_matches_client_bridge_encoding() {
        let payload = EngineClientMessage::ResyncComplete;
        let native = non_droppable_binary_message(&payload)
            .expect("native adapter should encode the client message");
        let bridge = EncodedClientMessage::new(DISCRIMINATOR_NON_DROPPABLE, &payload)
            .expect("client bridge should encode the client message")
            .to_bytes();

        let Message::Binary(native) = native else {
            panic!("native client event should be binary");
        };
        assert_eq!(native.as_ref(), bridge.as_slice());
    }

    /// Ensures permission changes revoke remote sessions while preserving loopback sessions.
    #[test]
    fn permission_changes_close_only_remote_clients() {
        let (local_tx, mut local_rx) = tokio::sync::mpsc::unbounded_channel();
        let (remote_tx, mut remote_rx) = tokio::sync::mpsc::unbounded_channel();
        let (local_cancel, local_cancellation) = tokio::sync::watch::channel(false);
        let (remote_cancel, remote_cancellation) = tokio::sync::watch::channel(false);
        let clients = Arc::new(Mutex::new(vec![
            ConnectedClient {
                sender: local_tx,
                cancellation: local_cancel,
                local: true,
            },
            ConnectedClient {
                sender: remote_tx,
                cancellation: remote_cancel,
                local: false,
            },
        ]));
        close_remote_clients(&clients, &AtomicU64::new(0));
        assert_eq!(remote_rx.try_recv().unwrap(), Message::Close(None));
        assert!(local_rx.try_recv().is_err());
        assert!(!*local_cancellation.borrow());
        assert!(*remote_cancellation.borrow());
        assert_eq!(clients.lock().unwrap().len(), 1);
    }

    /// Revokes incoming command processing while a full outbound buffer prevents sending Close.
    #[tokio::test]
    async fn remote_revocation_cancels_both_directions_under_backpressure() {
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel(1);
        outbound_tx.send("buffered frame").await.unwrap();
        let (send_started, started_rx) = tokio::sync::oneshot::channel();
        let send_task = tokio::spawn(async move {
            let _ = send_started.send(());
            // A peer that does not read leaves this send permanently backpressured.
            outbound_tx.send("blocked frame").await.unwrap();
        });
        started_rx.await.unwrap();
        assert!(!send_task.is_finished());

        let (incoming_tx, mut incoming_rx) = tokio::sync::mpsc::unbounded_channel();
        let (commands_tx, mut commands_rx) = tokio::sync::mpsc::unbounded_channel();
        let recv_task = tokio::spawn(async move {
            while let Some(command) = incoming_rx.recv().await {
                commands_tx.send(command).unwrap();
            }
        });
        incoming_tx.send("before revocation").unwrap();
        assert_eq!(commands_rx.recv().await, Some("before revocation"));
        let (cancellation, cancellation_rx) = tokio::sync::watch::channel(false);
        let (message_tx, _unread_messages) = tokio::sync::mpsc::unbounded_channel();
        let clients = Arc::new(Mutex::new(vec![ConnectedClient {
            sender: message_tx,
            cancellation,
            local: false,
        }]));
        let supervisor = tokio::spawn(supervise_client_tasks(
            send_task,
            recv_task,
            cancellation_rx,
        ));

        close_remote_clients(&clients, &AtomicU64::new(0));
        tokio::time::timeout(Duration::from_secs(1), supervisor)
            .await
            .unwrap()
            .unwrap();
        assert!(incoming_tx.send("after revocation").is_err());
        assert_eq!(commands_rx.recv().await, None);
        assert_eq!(outbound_rx.recv().await, Some("buffered frame"));
        assert_eq!(outbound_rx.recv().await, None);
        assert!(clients.lock().unwrap().is_empty());
    }

    /// Verifies shutdown fanout sends a close frame and removes all registered clients.
    #[test]
    fn close_connected_clients_sends_close_and_clears_registry() {
        let (client_tx, mut client_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
        let (cancellation, cancellation_rx) = tokio::sync::watch::channel(false);
        let clients = Arc::new(Mutex::new(vec![ConnectedClient {
            sender: client_tx,
            cancellation,
            local: true,
        }]));

        close_connected_clients(&clients);

        let close_message = client_rx
            .try_recv()
            .expect("client should receive close frame");
        assert_eq!(close_message, Message::Close(None));
        assert!(clients.lock().unwrap().is_empty());
        assert!(*cancellation_rx.borrow());
    }

    /// Verifies transport heartbeats are encoded as direct non-droppable CBOR responses.
    #[test]
    fn transport_heartbeat_response_encodes_echoed_id() {
        let message = encode_transport_heartbeat_response(&TransportHeartbeatData { id: 42 })
            .expect("heartbeat should encode a direct response");

        let Message::Binary(bytes) = message else {
            panic!("heartbeat response should be binary");
        };
        assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);

        let decoded: serde_json::Value =
            minicbor_serde::from_slice(&bytes[1..]).expect("response should decode as CBOR");
        assert_eq!(decoded["type"], TRANSPORT_HEARTBEAT_RESPONSE_TYPE);
        assert_eq!(decoded["data"]["id"], 42);
    }

    /// Verifies command envelopes and unrelated JSON are not treated as transport heartbeats.
    #[test]
    fn transport_heartbeat_response_ignores_non_heartbeat_messages() {
        let inbound = serde_json::from_str::<InboundWebsocketText>(
            r#"{"command_id":"00000000-0000-0000-0000-000000000001","module":"EngineCommand","command":{"type":"ResyncState"}}"#,
        )
        .expect("command envelope should parse as inbound websocket text");
        assert!(matches!(inbound, InboundWebsocketText::Command(_)));

        let inbound = serde_json::from_str::<InboundWebsocketText>(
            r#"{"module":"ControlUpdate","update":{"type":"SetConsoleValue","data":{"control_id":1,"value":0.5}}}"#,
        )
        .expect("update envelope should parse as inbound websocket text");
        assert!(matches!(inbound, InboundWebsocketText::Update(_)));

        assert!(
            serde_json::from_str::<InboundWebsocketText>(
                r#"{"type":"OtherTransportMessage","data":{"id":42}}"#,
            )
            .is_err()
        );
    }
}
