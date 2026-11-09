// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Loads each show a backup copies from its primary, and reports this host's own live show
//! revision to any backup following it.

use std::{
    net::SocketAddr,
    sync::{Mutex, OnceLock, mpsc},
};

use axum::{
    Json,
    extract::{ConnectInfo, Query},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use bevy::prelude::*;
use nightfall_backup::{
    forwarding::{ForwardCursor, forward_journal},
    prelude::{MirroredShowfileReady, ShowfileRevision},
};
use nightfall_engine::prelude::*;
use nightfall_websocket::prelude::HttpRouteRegistry;

use crate::swap_orchestrator::PendingWorldSwapRequest;

/// Origin recorded for show loads the backup link starts.
const BACKUP_LINK_ORIGIN: &str = "Backup link";

/// Replaces the world with the newest show copied from the primary.
///
/// Only the newest copy in a frame is loaded, since each one replaces the whole show. The load
/// is tracked as a detached command so the world swap can complete it like any other load.
pub(crate) fn load_mirrored_showfiles(
    mut mirrored: MessageReader<MirroredShowfileReady>,
    pending: Option<ResMut<PendingWorldSwapRequest>>,
    mut tracker: ResMut<CommandTracker>,
) {
    let Some(show) = mirrored.read().last() else {
        return;
    };
    let Some(mut pending) = pending else {
        tracing::warn!("Backup copied a show, but this runtime cannot swap worlds");
        return;
    };
    let command_id = CommandId::new();
    if let Err(error) = tracker.register_context(
        command_id,
        command_id.into(),
        CommandOrigin::Remote(BACKUP_LINK_ORIGIN.to_string()),
        ReplyTarget::Detached,
    ) {
        tracing::error!(%command_id, %error, "backup_show_load_registration_failed");
        return;
    }
    tracing::info!(showfile = ?show.showfile_name, "Loading the show copied from the primary");
    pending.request_load_showfile(
        command_id.into(),
        show.showfile_name.as_deref(),
        show.directory.clone(),
    );
}

/// Registers the routes a backup polls: the revision of this host's live show, checkpoints of
/// its live state, the commands it forwards, and the public status a backup sends heartbeats to.
pub(crate) fn register_backup_http_routes(registry: &mut HttpRouteRegistry) {
    registry.register(
        nightfall_backup::failover::HOST_STATUS_PATH,
        get(|| async { Json(nightfall_backup::failover::host_status()) }),
    );
    registry.register(
        nightfall_backup::SHOWFILE_REVISION_PATH,
        get(current_showfile_revision),
    );
    registry.register(nightfall_backup::LIVE_STATE_PATH, get(current_live_state));
    registry.register(
        nightfall_backup::FORWARDED_COMMANDS_PATH,
        get(forwarded_commands),
    );
}

/// Answers with the commands forwarded after the backup's cursor, holding the request open for
/// a while when there are none yet. Without a cursor it answers at once with where to start.
async fn forwarded_commands(Query(query): Query<ForwardedQuery>) -> Response {
    let cursor = query
        .session
        .zip(query.after)
        .map(|(session, after)| ForwardCursor { session, after });
    Json(
        forward_journal()
            .wait_after(cursor, nightfall_backup::FORWARDED_WAIT)
            .await,
    )
    .into_response()
}

/// A backup's cursor in the forwarded command journal, absent on its first request.
#[derive(serde::Deserialize)]
struct ForwardedQuery {
    session: Option<u64>,
    after: Option<u64>,
}

/// Reply channel for one live state checkpoint request.
type LiveStateReply = tokio::sync::oneshot::Sender<LiveStateSnapshot>;

/// Sender half of the live state request channel, shared by every world of the session.
static LIVE_STATE_REQUESTS: OnceLock<Mutex<Option<mpsc::SyncSender<LiveStateReply>>>> =
    OnceLock::new();

/// Requests that may wait for the same frame's checkpoint.
const PENDING_LIVE_STATE_REQUESTS: usize = 4;

/// Longest a checkpoint request waits for the engine thread.
const LIVE_STATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Registers the bounded live state request channel for the session, surviving its world swaps.
pub(crate) fn register_live_state_requests() -> mpsc::Receiver<LiveStateReply> {
    let (sender, receiver) = mpsc::sync_channel(PENDING_LIVE_STATE_REQUESTS);
    *LIVE_STATE_REQUESTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sender);
    receiver
}

/// Answers every waiting checkpoint request from one capture of the world, between frames.
pub(crate) fn respond_to_live_state_requests(
    receiver: &mpsc::Receiver<LiveStateReply>,
    world: &mut World,
) {
    let replies: Vec<LiveStateReply> = receiver
        .try_iter()
        .filter(|reply| !reply.is_closed())
        .collect();
    if replies.is_empty() {
        return;
    }
    let snapshot = capture_live_state(world);
    for reply in replies {
        let _ = reply.send(snapshot.clone());
    }
}

/// Answers with a checkpoint of this host's live state, and remembers the backup asking for it.
///
/// Pairing already admitted the request, so the backup it names can be trusted to take over.
async fn current_live_state(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // A backup asking for checkpoints will read forwarded commands next, so start recording.
    forward_journal().note_reader();
    nightfall_backup::failover::note_backup_peer(peer.ip(), &headers);
    let sender = LIVE_STATE_REQUESTS
        .get()
        .and_then(|lock| lock.lock().ok()?.clone());
    let Some(sender) = sender else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The engine is not running yet.",
        )
            .into_response();
    };
    let requested_at = std::time::Instant::now();
    let (reply, response) = tokio::sync::oneshot::channel();
    if sender.try_send(reply).is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The engine is busy; try again shortly.",
        )
            .into_response();
    }
    match tokio::time::timeout(LIVE_STATE_TIMEOUT, response).await {
        Ok(Ok(snapshot)) => {
            nightfall_backup::failover::note_checkpoint_served(peer.ip(), &headers);
            (
                [(
                    nightfall_backup::LIVE_STATE_WAIT_HEADER,
                    requested_at.elapsed().as_millis().to_string(),
                )],
                Json(snapshot),
            )
                .into_response()
        }
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "The engine did not answer in time.",
        )
            .into_response(),
    }
}

/// Answers with the open showfile's name and a hash of its live contents.
///
/// Only a capture of the running engine counts: during startup or a stall the stored copy may
/// be older than what is on stage, so the backup is told to ask again instead.
async fn current_showfile_revision() -> Response {
    let capture = match crate::diagnostic_showfile::capture_showfile().await {
        Ok(capture) if capture.source == crate::diagnostic_showfile::LIVE_SOURCE => capture,
        Ok(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "The engine is busy; try again shortly.",
            )
                .into_response();
        }
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    let showfile_name = capture.showfile_name;
    let revision = tokio::task::spawn_blocking(move || {
        crate::systems::showfile_events::live_showfile_revision(capture.snapshot)
    })
    .await;
    match revision {
        Ok(Ok(revision)) => Json(ShowfileRevision {
            showfile_name,
            revision: format!("{revision:016x}"),
        })
        .into_response(),
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}
