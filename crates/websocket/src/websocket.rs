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
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use async_channel::{Receiver as ClientReceiver, Sender as ClientSender};
use axum::{
    Extension, Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, Method, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
};
use futures_util::SinkExt;
use futures_util::StreamExt;
use minicbor_serde;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::{net::TcpListener, sync::broadcast::Receiver as BroadcastReceiver};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::outbox::{ClientOutbox, Enqueued, OUTBOX_BYTE_LIMIT, Publication};

/// How long a client dropped for lagging has to receive its close frame before its socket is
/// torn down without one.
const LAGGING_CLIENT_CLOSE_GRACE: Duration = Duration::from_secs(5);

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
    /// Identity the engine uses to address replies to this session.
    pub id: ClientId,
    /// Bounded outbound queue for this session.
    pub(crate) outbox: Arc<ClientOutbox>,
    /// Cancels both I/O tasks without depending on the peer reading an outgoing frame.
    pub cancellation: tokio::sync::watch::Sender<bool>,
    /// Whether the session is local and survives external permission changes.
    pub local: bool,
}

#[derive(Clone)]
/// State shared for the axum app
pub struct AxumAppState {
    /// Channel for sending JSON command envelopes from Axum
    pub command_json_tx: CommandSender,
    /// Channel for sending untracked JSON update envelopes from Axum.
    pub update_json_tx: ClientSender<UpdateJsonEnvelope>,
    /// Tells the engine when the last session closes so it can protect unsaved work.
    pub client_presence: ClientPresenceSender,
    /// Maintains references the message channels of connected client
    pub clients: Arc<Mutex<Vec<ConnectedClient>>>,
    /// Source of unique identities for sessions, never reused while the server runs.
    pub next_client_id: Arc<AtomicU64>,
    /// Admission generation used to reject remote upgrades from retired listeners.
    pub remote_generation: Arc<AtomicU64>,
    /// Session PIN and tokens that devices on the network need to connect.
    pub pairing: Arc<crate::pairing::RemotePairing>,
}

/// Handle an incoming HTTP websocket request
async fn handle_socket(
    ws: WebSocketUpgrade,
    State(state): State<AxumAppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(generation): Extension<u64>,
    uri: Uri,
    headers: HeaderMap,
) -> impl IntoResponse {
    let local = crate::origin::is_local_client(Some(peer), &headers, &uri);
    let token = state.pairing.token_from(&headers);
    ws.on_upgrade(move |socket| client_ws(socket, state, local, generation, token))
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
///
/// A remote session registers only while its listener generation is current and its pairing
/// token is still valid. Both are checked under the client registry lock, so a session can
/// never slip in after a PIN regeneration has closed the remote clients.
async fn client_ws(
    mut socket: WebSocket,
    state: AxumAppState,
    local: bool,
    generation: u64,
    pairing_token: Option<String>,
) {
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
    let outbox = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
    let (cancellation, cancellation_rx) = tokio::sync::watch::channel(false);
    let clients = state.clients.clone();
    let command_json_tx = state.command_json_tx.clone();
    let update_json_tx = state.update_json_tx.clone();
    let client_id = ClientId(state.next_client_id.fetch_add(1, Ordering::Relaxed));

    // Register client and then drop reference to the guard
    // Required to that this async fn is Send-compatible
    {
        let mut guard = clients.lock().unwrap();
        if !local
            && (state.remote_generation.load(Ordering::Acquire) != generation
                || !state.pairing.token_valid(pairing_token.as_deref()))
        {
            return;
        }
        guard.push(ConnectedClient {
            id: client_id,
            outbox: outbox.clone(),
            cancellation: cancellation.clone(),
            local,
        });
    }

    // Task: forward backend → client
    let send_task = tokio::spawn({
        let outbox = outbox.clone();
        async move {
            while let Some(msg) = outbox.next().await {
                let should_close = matches!(msg, Message::Close(_));
                if ws_sender.send(msg).await.is_err() {
                    break;
                }
                if should_close {
                    break;
                }
            }
        }
    });

    // Task: client → backend
    let recv_task = tokio::spawn({
        let outbox = outbox.clone();
        let cancellation = cancellation.clone();
        async move {
            while let Some(Ok(msg)) = ws_receiver.next().await {
                if let Message::Text(text) = msg {
                    match serde_json::from_str::<InboundWebsocketText>(&text) {
                        Ok(InboundWebsocketText::Command(mut json_envelope)) => {
                            tracing::trace!(
                                %client_id,
                                "Parsed command envelope from websocket (module={})",
                                json_envelope.module
                            );
                            json_envelope.reply_target = ReplyTarget::Client(client_id);
                            let _ = command_json_tx.send(json_envelope).await;
                        }
                        Ok(InboundWebsocketText::Update(mut json_envelope)) => {
                            tracing::trace!(
                                %client_id,
                                "Parsed update envelope from websocket (module={})",
                                json_envelope.module
                            );
                            json_envelope.sender = Audience::Client(client_id);
                            let _ = update_json_tx.send(json_envelope).await;
                        }
                        Ok(InboundWebsocketText::Transport(TransportMessage::Heartbeat {
                            data,
                        })) => {
                            if let Some(message) = encode_transport_heartbeat_response(&data) {
                                tracing::trace!("Responding to transport websocket heartbeat");
                                if outbox.push(message) == Enqueued::Overflowed {
                                    cancel_after_lag_grace(cancellation.clone());
                                }
                            }
                        }
                        Err(_) => {
                            tracing::warn!("Failed to deserialize websocket text message");
                            tracing::debug!("Message that failed: {}", text);
                        }
                    }
                }
            }
        }
    });

    supervise_client_tasks(send_task, recv_task, cancellation_rx).await;

    tracing::debug!(
        coalesced = outbox.coalesced_count(),
        "WebSocket client disconnected"
    );
    let last = forget_client(&clients, &outbox);
    if last {
        tracing::info!(%client_id, "Last websocket client disconnected");
    }
    state.client_presence.client_disconnected(client_id, last);
}

/// Removes a closed session from the registry and returns whether no session remains.
///
/// Every registered session passes through here exactly once when it ends, whichever path
/// closed it first, so the session that leaves the registry empty is the one that reports it.
fn forget_client(clients: &Mutex<Vec<ConnectedClient>>, outbox: &Arc<ClientOutbox>) -> bool {
    let mut guard = clients.lock().unwrap();
    guard.retain(|c| !Arc::ptr_eq(&c.outbox, outbox));
    guard.is_empty()
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
    for client in guard.iter() {
        client.cancellation.send_replace(true);
        client.outbox.close();
    }
    guard.clear();
}

/// Revokes remote sessions while keeping the local operator connected during rebinding.
fn close_remote_clients(clients: &Arc<Mutex<Vec<ConnectedClient>>>, generation: &AtomicU64) -> u64 {
    let mut clients = clients.lock().unwrap();
    let next_generation = generation.fetch_add(1, Ordering::AcqRel) + 1;
    close_remote_entries(&mut clients);
    next_generation
}

/// Closes every remote session on the current listeners, leaving local ones connected.
///
/// Unlike [`close_remote_clients`], the listeners stay current, so devices that still hold
/// valid credentials may connect again straight away.
pub(crate) fn disconnect_remote_clients(clients: &Arc<Mutex<Vec<ConnectedClient>>>) {
    close_remote_entries(&mut clients.lock().unwrap());
}

/// Cancels and removes the remote entries of a locked client registry.
fn close_remote_entries(clients: &mut Vec<ConnectedClient>) {
    clients.retain(|client| {
        if !client.local {
            client.cancellation.send_replace(true);
            client.outbox.close();
        }
        client.local
    });
}

/// Tears down a lagging client's socket tasks if its close frame has not gone out within
/// [`LAGGING_CLIENT_CLOSE_GRACE`].
///
/// A client that stopped reading entirely never accepts the close frame, which would otherwise
/// leave its send task blocked until the TCP connection times out.
fn cancel_after_lag_grace(cancellation: tokio::sync::watch::Sender<bool>) {
    tokio::spawn(async move {
        tokio::time::sleep(LAGGING_CLIENT_CLOSE_GRACE).await;
        cancellation.send_replace(true);
    });
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

/// Queues one engine frame on every session in its audience.
///
/// Each session's outbox bounds what a slow reader can accumulate and drops the session once
/// it falls too far behind. A frame addressed to a session that already disconnected reaches
/// no one.
fn deliver_frame(clients: &Mutex<Vec<ConnectedClient>>, frame: OutboundFrame) {
    tracing::trace!(
        audience = ?frame.audience,
        "Sending plugin-serialized websocket message ({} KB)",
        frame.bytes.len() as f32 / 1024.0
    );
    let audience = frame.audience;
    let publication = Publication::from_encoded(frame.bytes);
    let mut guard = clients.lock().unwrap();
    guard.retain(|client| {
        if !audience.includes(client.id) {
            return true;
        }
        let outcome = client.outbox.publish(&publication);
        if outcome == Enqueued::Overflowed {
            cancel_after_lag_grace(client.cancellation.clone());
        }
        outcome.keeps_client()
    });
}

/// Start the axum websocket server and broadcast task.
pub(crate) fn create_axum_task(
    config: crate::external_control::ListenerTaskConfig,
    mut shutdown_rx: BroadcastReceiver<()>,
    ws_broadcast_rx: ClientReceiver<OutboundFrame>,
    command_json_tx: CommandSender,
    update_json_tx: ClientSender<UpdateJsonEnvelope>,
    client_presence: ClientPresenceSender,
    plugin_routes: Router,
    stateful_plugin_routes: Router<AxumAppState>,
    web_ui: Option<crate::SharedWebUiAssets>,
) -> (tokio::task::JoinHandle<()>, SwappableRoutes) {
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
        client_presence,
        clients: clients.clone(),
        next_client_id: Default::default(),
        remote_generation: remote_generation.clone(),
        pairing: Arc::new(crate::pairing::RemotePairing::new(port)),
    };
    let routes = SwappableRoutes::new(state.clone(), web_ui, plugin_routes, stateful_plugin_routes);
    let axum_app = websocket_router(state, routes.clone());

    // Byte-oriented fan-out task for plugin-owned serialization
    let _broadcast_task = tokio::spawn({
        let clients = clients.clone();
        async move {
            while let Ok(frame) = ws_broadcast_rx.recv().await {
                deliver_frame(&clients, frame);
            }
        }
    });

    let task = tokio::spawn(async move {
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
                // Command results and other small frames follow larger state frames closely;
                // Nagle's algorithm would hold them until the client acknowledges earlier data.
                let listener = listener.tap_io(|stream| {
                    if let Err(error) = stream.set_nodelay(true) {
                        tracing::warn!(%error, "websocket_tcp_nodelay_failed");
                    }
                });
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
    });
    (task, routes)
}

/// Plugin-registered HTTP routes of the active world, replaceable while the server runs.
///
/// Plugin routes capture world-owned state (fixture archives, showfile storage),
/// so each world installs its own routes when it attaches to a running server.
///
/// The built web UI, when the host supplies it, answers whatever the plugin routes do not,
/// so it stays reachable across world replacement.
#[derive(Clone)]
pub struct SwappableRoutes {
    state: AxumAppState,
    web_ui: Option<crate::SharedWebUiAssets>,
    current: Arc<RwLock<Router>>,
}

impl SwappableRoutes {
    /// Build the route set for one world, binding stateful routes to the server state.
    fn new(
        state: AxumAppState,
        web_ui: Option<crate::SharedWebUiAssets>,
        plugin_routes: Router,
        stateful_plugin_routes: Router<AxumAppState>,
    ) -> Self {
        let current = Arc::new(RwLock::new(Self::combine(
            &state,
            web_ui.as_ref(),
            plugin_routes,
            stateful_plugin_routes,
        )));
        Self {
            state,
            web_ui,
            current,
        }
    }

    /// Merge stateless and stateful plugin routes into one servable router, falling back to
    /// the web UI files when they are available.
    fn combine(
        state: &AxumAppState,
        web_ui: Option<&crate::SharedWebUiAssets>,
        plugin_routes: Router,
        stateful_plugin_routes: Router<AxumAppState>,
    ) -> Router {
        let routes = stateful_plugin_routes
            .with_state(state.clone())
            .merge(plugin_routes);
        match web_ui {
            Some(assets) => {
                let assets = assets.clone();
                routes.fallback(move |request: Request| {
                    crate::web_ui::serve_web_ui(assets.clone(), request)
                })
            }
            None => routes,
        }
    }

    /// Replace the served plugin routes with those registered by a newly active world.
    pub fn replace(&self, plugin_routes: Router, stateful_plugin_routes: Router<AxumAppState>) {
        let routes = Self::combine(
            &self.state,
            self.web_ui.as_ref(),
            plugin_routes,
            stateful_plugin_routes,
        );
        *self
            .current
            .write()
            .expect("plugin route lock should not be poisoned") = routes;
    }

    /// Dispatch one request to the currently installed plugin routes.
    async fn call(self, request: Request) -> Response {
        let mut router = self
            .current
            .read()
            .expect("plugin route lock should not be poisoned")
            .clone();
        match tower_service::Service::call(&mut router, request).await {
            Ok(response) => response,
            Err(never) => match never {},
        }
    }
}

/// Combine core and plugin routes under one cross-origin policy for desktop and browser clients.
///
/// Foreign origins are turned away before CORS runs, so the CORS layer only ever echoes an
/// origin that already passed [`crate::origin::reject_foreign_origins`]. Remote devices
/// that have not paired are turned away inside CORS, so the browser can read the refusal.
fn websocket_router(state: AxumAppState, routes: SwappableRoutes) -> Router {
    use crate::pairing::{
        PAIRING_PATH, PAIRING_PIN_PATH, pairing_status, regenerate_pairing_pin, require_pairing,
        show_pairing_pin, submit_pairing_pin,
    };

    // Core routes own the socket and pairing; plugin routes resolve against the active world.
    let core_routes = Router::new()
        .route("/ws", get(handle_socket))
        .route(PAIRING_PATH, get(pairing_status).post(submit_pairing_pin))
        .route(
            PAIRING_PIN_PATH,
            get(show_pairing_pin).post(regenerate_pairing_pin),
        )
        .with_state(state.clone())
        .fallback(move |request: Request| routes.clone().call(request));

    core_routes
        .layer(axum::middleware::from_fn_with_state(state, require_pairing))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::mirror_request())
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
        .layer(axum::middleware::from_fn(
            crate::origin::reject_foreign_origins,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::TryNextError;

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
        let (task, _routes) = create_axum_task(
            crate::external_control::ListenerTaskConfig {
                port,
                requests: request_rx,
                status: status_tx,
                settings_path: Some(directory.path().join("control.json")),
            },
            shutdown_rx,
            broadcast_rx,
            CommandSender::new(command_tx, FrameWaker::default()),
            update_tx,
            ClientPresenceSender::new(async_channel::unbounded().0, FrameWaker::default()),
            Router::new(),
            Router::new(),
            None,
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

    /// Verifies the engine hears about every closed session, and that only the final one is
    /// marked last, so a tab closing while another stays open does not trigger last-client work.
    #[tokio::test]
    async fn disconnects_report_the_session_and_whether_it_was_last() {
        let (command_tx, _command_rx) = async_channel::unbounded();
        let (update_json_tx, _update_rx) = async_channel::unbounded();
        let (presence_tx, presence_rx) = async_channel::unbounded();
        let state = AxumAppState {
            command_json_tx: CommandSender::new(command_tx, FrameWaker::default()),
            update_json_tx,
            client_presence: ClientPresenceSender::new(presence_tx, FrameWaker::default()),
            clients: Default::default(),
            next_client_id: Default::default(),
            remote_generation: Default::default(),
            pairing: Arc::new(crate::pairing::RemotePairing::new(0)),
        };
        let clients = state.clients.clone();
        let routes = SwappableRoutes::new(state.clone(), None, Router::new(), Router::new());
        let app = websocket_router(state, routes).layer(Extension(0_u64));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        let registered = |count: usize| {
            let clients = clients.clone();
            async move {
                while clients.lock().unwrap().len() != count {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        };

        let (mut first, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let (mut second, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), registered(2))
            .await
            .unwrap();

        first.close(None).await.unwrap();
        let report = tokio::time::timeout(Duration::from_secs(5), presence_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            report,
            ClientDisconnectReport {
                client: ClientId(0),
                last: false
            }
        );

        second.close(None).await.unwrap();
        let report = tokio::time::timeout(Duration::from_secs(5), presence_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            report,
            ClientDisconnectReport {
                client: ClientId(1),
                last: true
            }
        );
        assert!(presence_rx.try_recv().is_err());
        server.abort();
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
        let local_outbox = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
        let remote_outbox = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
        let (local_cancel, local_cancellation) = tokio::sync::watch::channel(false);
        let (remote_cancel, remote_cancellation) = tokio::sync::watch::channel(false);
        let clients = Arc::new(Mutex::new(vec![
            ConnectedClient {
                id: ClientId(0),
                outbox: local_outbox.clone(),
                cancellation: local_cancel,
                local: true,
            },
            ConnectedClient {
                id: ClientId(1),
                outbox: remote_outbox.clone(),
                cancellation: remote_cancel,
                local: false,
            },
        ]));
        close_remote_clients(&clients, &AtomicU64::new(0));
        assert_eq!(remote_outbox.try_next(), Ok(Message::Close(None)));
        assert_eq!(local_outbox.try_next(), Err(TryNextError::Empty));
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
        let clients = Arc::new(Mutex::new(vec![ConnectedClient {
            id: ClientId(0),
            outbox: Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT)),
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

    /// Verifies addressed frames reach only their client, broadcast frames reach every client,
    /// and both keep their relative order on each session.
    #[test]
    fn deliver_frame_honours_audience() {
        let first = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
        let second = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
        let clients = Mutex::new(vec![
            ConnectedClient {
                id: ClientId(1),
                outbox: first.clone(),
                cancellation: tokio::sync::watch::channel(false).0,
                local: true,
            },
            ConnectedClient {
                id: ClientId(2),
                outbox: second.clone(),
                cancellation: tokio::sync::watch::channel(false).0,
                local: false,
            },
        ]);
        let frame = |audience, byte| OutboundFrame {
            audience,
            bytes: vec![byte],
        };

        deliver_frame(&clients, frame(Audience::All, 1));
        deliver_frame(&clients, frame(Audience::Client(ClientId(2)), 2));
        deliver_frame(&clients, frame(Audience::Client(ClientId(9)), 3));
        deliver_frame(&clients, frame(Audience::All, 4));

        let drain = |outbox: &ClientOutbox| {
            std::iter::from_fn(|| outbox.try_next().ok())
                .map(|message| match message {
                    Message::Binary(bytes) => bytes[0],
                    other => panic!("unexpected message {other:?}"),
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(drain(&first), vec![1, 4]);
        assert_eq!(drain(&second), vec![1, 2, 4]);
        assert_eq!(clients.lock().unwrap().len(), 2);
    }

    /// Verifies shutdown fanout sends a close frame and removes all registered clients.
    #[test]
    fn close_connected_clients_sends_close_and_clears_registry() {
        let outbox = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
        let (cancellation, cancellation_rx) = tokio::sync::watch::channel(false);
        let clients = Arc::new(Mutex::new(vec![ConnectedClient {
            id: ClientId(0),
            outbox: outbox.clone(),
            cancellation,
            local: true,
        }]));

        close_connected_clients(&clients);

        assert_eq!(outbox.try_next(), Ok(Message::Close(None)));
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

    /// Serves the real router and checks that websocket upgrades and CORS preflights from a
    /// foreign site are refused while the UI's own origin and non-browser clients connect.
    #[tokio::test]
    async fn router_refuses_foreign_browser_origins() {
        use tokio_tungstenite::tungstenite::{
            Error as WsError, client::IntoClientRequest, http::StatusCode as WsStatus,
        };

        let (command_tx, _command_rx) = async_channel::unbounded();
        let (update_json_tx, _update_rx) = async_channel::unbounded();
        let state = AxumAppState {
            command_json_tx: CommandSender::new(command_tx, FrameWaker::default()),
            update_json_tx,
            client_presence: ClientPresenceSender::new(
                async_channel::unbounded().0,
                FrameWaker::default(),
            ),
            clients: Default::default(),
            next_client_id: Default::default(),
            remote_generation: Default::default(),
            pairing: Arc::new(crate::pairing::RemotePairing::new(0)),
        };
        let routes = SwappableRoutes::new(state.clone(), None, Router::new(), Router::new());
        let app = websocket_router(state, routes).layer(Extension(0_u64));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });

        let upgrade = |origin: Option<&'static str>| async move {
            let mut request = format!("ws://localhost:{port}/ws")
                .into_client_request()
                .unwrap();
            if let Some(origin) = origin {
                request
                    .headers_mut()
                    .insert(header::ORIGIN, origin.parse().unwrap());
            }
            tokio_tungstenite::connect_async(request).await
        };
        for origin in [
            None,
            Some("http://localhost:3031"),
            Some("tauri://localhost"),
        ] {
            let (mut client, _) = upgrade(origin).await.unwrap();
            assert!(
                client.next().await.unwrap().unwrap().is_binary(),
                "{origin:?}"
            );
        }
        match upgrade(Some("https://evil.example")).await {
            Err(WsError::Http(response)) => assert_eq!(response.status(), WsStatus::FORBIDDEN),
            other => panic!("foreign origin upgraded: {:?}", other.map(|_| ())),
        }

        let preflight = |origin: &str| {
            format!(
                "OPTIONS /api/showfile HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: {origin}\r\n\
                 Access-Control-Request-Method: POST\r\nConnection: close\r\n\r\n"
            )
        };
        let requests = [
            (
                preflight("http://localhost:3031"),
                "HTTP/1.1 200",
                Some("access-control-allow-origin: http://localhost:3031"),
            ),
            (preflight("https://evil.example"), "HTTP/1.1 403", None),
            // A same-origin GET from a rebound public domain carries no Origin at all.
            (
                format!(
                    "GET /api/showfiles HTTP/1.1\r\nHost: rebind.evil.example:{port}\r\n\
                     Connection: close\r\n\r\n"
                ),
                "HTTP/1.1 403",
                None,
            ),
        ];
        for (request, status, header_line) in requests {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            assert!(response.starts_with(status), "{request}: {response}");
            if let Some(header_line) = header_line {
                assert!(
                    response.to_ascii_lowercase().contains(header_line),
                    "{request}: {response}"
                );
            }
        }
        server.abort();
    }

    /// A device on the network loads the UI and the pairing endpoint freely, needs the PIN's
    /// cookie for backend routes, and cannot read or regenerate the PIN itself.
    #[tokio::test]
    async fn remote_devices_pair_before_reaching_backend_routes() {
        use axum::{
            body::{Body, to_bytes},
            http::StatusCode,
        };
        use tower_service::Service;

        let (command_tx, _command_rx) = async_channel::unbounded();
        let (update_json_tx, _update_rx) = async_channel::unbounded();
        let state = AxumAppState {
            command_json_tx: CommandSender::new(command_tx, FrameWaker::default()),
            update_json_tx,
            client_presence: ClientPresenceSender::new(
                async_channel::unbounded().0,
                FrameWaker::default(),
            ),
            clients: Default::default(),
            next_client_id: Default::default(),
            remote_generation: Default::default(),
            pairing: Arc::new(crate::pairing::RemotePairing::new(3030)),
        };
        let pin = state.pairing.pin();
        let routes = SwappableRoutes::new(
            state.clone(),
            None,
            Router::new().route("/api/marker", get(|| async { "marker" })),
            Router::new(),
        );
        let mut app = websocket_router(state, routes);
        let mut send = |peer: [u8; 4],
                        method: Method,
                        path: &'static str,
                        cookie: Option<String>,
                        body: Option<String>| {
            let mut request = Request::builder().method(method).uri(path).header(
                header::HOST,
                if peer == [127, 0, 0, 1] {
                    "localhost:3030"
                } else {
                    "192.168.1.20:3030"
                },
            );
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie);
            }
            if body.is_some() {
                request = request.header(header::CONTENT_TYPE, "application/json");
            }
            let mut request = request
                .body(body.map_or_else(Body::empty, Body::from))
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from((peer, 50000))));
            let call = app.call(request);
            async move {
                let response = call.await.unwrap();
                let status = response.status();
                let set_cookie = response
                    .headers()
                    .get(header::SET_COOKIE)
                    .map(|value| value.to_str().unwrap().to_string());
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                (
                    status,
                    set_cookie,
                    String::from_utf8(body.to_vec()).unwrap(),
                )
            }
        };
        let phone = [192, 168, 1, 50];
        let local = [127, 0, 0, 1];

        assert_eq!(
            send(phone, Method::GET, "/api/marker", None, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(local, Method::GET, "/api/marker", None, None).await.0,
            StatusCode::OK
        );
        let (_, _, body) = send(phone, Method::GET, "/api/pairing", None, None).await;
        assert_eq!(body, r#"{"required":true,"paired":false}"#);
        for method in [Method::GET, Method::POST] {
            assert_eq!(
                send(phone, method, "/api/pairing/pin", None, None).await.0,
                StatusCode::UNAUTHORIZED
            );
        }

        let attempt = |pin: &str| Some(format!(r#"{{"pin":"{pin}"}}"#));
        let (status, set_cookie, _) =
            send(phone, Method::POST, "/api/pairing", None, attempt(&pin)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let cookie = set_cookie.unwrap().split(';').next().unwrap().to_string();
        assert_eq!(
            send(
                phone,
                Method::GET,
                "/api/marker",
                Some(cookie.clone()),
                None
            )
            .await
            .2,
            "marker"
        );
        let (_, _, body) = send(
            phone,
            Method::GET,
            "/api/pairing",
            Some(cookie.clone()),
            None,
        )
        .await;
        assert_eq!(body, r#"{"required":true,"paired":true}"#);
        assert_eq!(
            send(
                phone,
                Method::POST,
                "/api/pairing/pin",
                Some(cookie.clone()),
                None
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );

        let (status, _, body) = send(local, Method::POST, "/api/pairing/pin", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.starts_with(r#"{"pin":""#), "{body}");
        assert_eq!(
            send(phone, Method::GET, "/api/marker", Some(cookie), None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }

    /// A phone relayed by the dev proxy counts as remote: its socket needs the pairing
    /// cookie, and regenerating the PIN closes it while the local operator stays connected.
    #[tokio::test]
    async fn regenerating_the_pin_closes_proxied_remote_sockets() {
        use tokio_tungstenite::tungstenite::{
            Error as WsError, Message as WsMessage, client::IntoClientRequest,
            http::StatusCode as WsStatus,
        };

        let (command_tx, _command_rx) = async_channel::unbounded();
        let (update_json_tx, _update_rx) = async_channel::unbounded();
        let state = AxumAppState {
            command_json_tx: CommandSender::new(command_tx, FrameWaker::default()),
            update_json_tx,
            client_presence: ClientPresenceSender::new(
                async_channel::unbounded().0,
                FrameWaker::default(),
            ),
            clients: Default::default(),
            next_client_id: Default::default(),
            remote_generation: Default::default(),
            pairing: Arc::new(crate::pairing::RemotePairing::new(3030)),
        };
        let pairing = state.pairing.clone();
        let routes = SwappableRoutes::new(state.clone(), None, Router::new(), Router::new());
        let app = websocket_router(state, routes).layer(Extension(0_u64));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        let connect = |cookie: Option<String>| async move {
            let mut request = format!("ws://localhost:{port}/ws")
                .into_client_request()
                .unwrap();
            let headers = request.headers_mut();
            headers.insert("x-forwarded-host", "192.168.1.20:3031".parse().unwrap());
            headers.insert(header::ORIGIN, "http://192.168.1.20:3031".parse().unwrap());
            if let Some(cookie) = cookie {
                headers.insert(header::COOKIE, cookie.parse().unwrap());
            }
            tokio_tungstenite::connect_async(request).await
        };

        match connect(None).await {
            Err(WsError::Http(response)) => {
                assert_eq!(response.status(), WsStatus::UNAUTHORIZED)
            }
            other => panic!("unpaired phone upgraded: {:?}", other.map(|_| ())),
        }
        let crate::pairing::PairingOutcome::Paired(token) = pairing.attempt(
            Ipv4Addr::LOCALHOST.into(),
            &pairing.pin(),
            std::time::Instant::now(),
        ) else {
            panic!("correct PIN refused");
        };
        let (mut phone, _) = connect(Some(format!("nightfall_pairing_3030={token}")))
            .await
            .unwrap();
        assert!(phone.next().await.unwrap().unwrap().is_binary());
        let (mut local, _) = tokio_tungstenite::connect_async(format!("ws://localhost:{port}/ws"))
            .await
            .unwrap();
        assert!(local.next().await.unwrap().unwrap().is_binary());

        let response = raw_loopback_post(port, "/api/pairing/pin").await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match phone.next().await {
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "remote socket stayed open after regeneration"
        );
        local
            .send(WsMessage::Text(
                r#"{"type":"WebSocketHeartbeat","data":{"id":1}}"#.into(),
            ))
            .await
            .unwrap();
        assert!(local.next().await.unwrap().unwrap().is_binary());
        server.abort();
    }

    /// Sends a bodiless `POST` over a raw socket from loopback and returns the raw response.
    async fn raw_loopback_post(port: u16, path: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        stream
            .write_all(
                format!(
                    "POST {path} HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Length: 0\r\n\
                     Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    /// Plugin routes win over the web UI fallback, and the UI keeps serving after a world
    /// replaces the plugin routes.
    #[tokio::test]
    async fn web_ui_answers_only_unclaimed_paths_across_route_swaps() {
        use std::borrow::Cow;

        use axum::body::{Body, to_bytes};

        /// Build output holding only an entry document.
        struct IndexOnly;

        impl crate::WebUiAssets for IndexOnly {
            /// Returns the entry document for its exact path only.
            fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
                (path == "index.html").then_some(Cow::Borrowed(b"ui".as_slice()))
            }
        }

        let (command_tx, _command_rx) = async_channel::unbounded();
        let (update_json_tx, _update_rx) = async_channel::unbounded();
        let state = AxumAppState {
            command_json_tx: CommandSender::new(command_tx, FrameWaker::default()),
            update_json_tx,
            client_presence: ClientPresenceSender::new(
                async_channel::unbounded().0,
                FrameWaker::default(),
            ),
            clients: Default::default(),
            next_client_id: Default::default(),
            remote_generation: Default::default(),
            pairing: Arc::new(crate::pairing::RemotePairing::new(0)),
        };
        let plugin_route = |marker: &'static str| {
            Router::new().route("/api/marker", get(move || async move { marker }))
        };
        let routes = SwappableRoutes::new(
            state,
            Some(Arc::new(IndexOnly)),
            plugin_route("first"),
            Router::new(),
        );
        let body_of = |path: &'static str| {
            let routes = routes.clone();
            async move {
                let request = Request::builder().uri(path).body(Body::empty()).unwrap();
                let response = routes.call(request).await;
                let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                String::from_utf8(bytes.to_vec()).unwrap()
            }
        };

        assert_eq!(body_of("/api/marker").await, "first");
        assert_eq!(body_of("/").await, "ui");
        routes.replace(plugin_route("second"), Router::new());
        assert_eq!(body_of("/api/marker").await, "second");
        assert_eq!(body_of("/cues").await, "ui");
    }
}
