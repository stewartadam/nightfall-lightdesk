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
    routing::{get, post},
};
use bevy::prelude::*;
use nightfall_backup::{
    forwarding::{ForwardCursor, forward_journal},
    prelude::{BackupState, MirroredShowfileReady, ShowfileRevision},
};
use nightfall_engine::prelude::*;
use nightfall_showfile::ShowfileCommand;
use nightfall_websocket::prelude::HttpRouteRegistry;

use crate::swap_orchestrator::PendingWorldSwapRequest;

/// Origin recorded for show loads the backup link starts.
const BACKUP_LINK_ORIGIN: &str = "Backup link";

/// Showfile commands that open or create a show, which a backup accepts and which end its role.
pub(crate) const SHOW_LOAD_COMMANDS: &[&str] = &[
    "NewShowfile",
    "NewNamedShowfile",
    "LoadShowfile",
    "LoadNamedShowfile",
    "LoadDraftShowfile",
    "LoadShowfileRevision",
];

/// Returns whether `command` opens or creates a show, replacing whatever show is open. Matches
/// the same commands as [`SHOW_LOAD_COMMANDS`], which a test keeps in step.
fn opens_a_show(command: &ShowfileCommand) -> bool {
    matches!(
        command,
        ShowfileCommand::NewShowfile
            | ShowfileCommand::NewNamedShowfile(_)
            | ShowfileCommand::LoadShowfile
            | ShowfileCommand::LoadNamedShowfile(_)
            | ShowfileCommand::LoadDraftShowfile(_)
            | ShowfileCommand::LoadShowfileRevision(_)
    )
}

/// Stops following the primary when a client opens or creates a show, before the show load
/// runs, so the world it loads starts as a normal desk.
pub(crate) fn leave_backup_role_for_show_loads(
    mut commands: MessageReader<CommandEnvelope<ShowfileCommand>>,
    state: Option<ResMut<BackupState>>,
    mut notifications: MessageWriter<UiNotification>,
) {
    let Some(mut state) = state else {
        return;
    };
    if !commands
        .read()
        .any(|envelope| opens_a_show(&envelope.command))
    {
        return;
    }
    let was_backup = state.is_backup();
    let primary = state.primary_address.clone().unwrap_or_default();
    let save_error = nightfall_backup::leave_backup_role_for_show_load(&mut state);
    if !was_backup {
        return;
    }
    let message = match save_error {
        None => format!("Opening a show stopped following {primary}."),
        Some(error) => format!(
            "Opening a show stopped following {primary}, but this will not survive a restart: \
             {error}"
        ),
    };
    notifications.write(UiNotification::toast(ToastLevel::Info, message));
}

/// Records whether the open show is the failover pair's show kept in the failover folder, so
/// continuing as the primary after a restart opens it again. Opening one of this computer's own
/// showfiles, or saving the pair's show under a new name, clears the record. Only a change is
/// stored.
pub(crate) fn remember_failover_show(
    mut remembered: Local<Option<(Option<String>, bool)>>,
    current_showfile: Res<crate::systems::showfile_events::CurrentShowfile>,
    state: Option<ResMut<BackupState>>,
) {
    let in_failover_folder = nightfall::show_storage_is_failover();
    let open = (
        current_showfile.name().map(str::to_string),
        in_failover_folder,
    );
    if remembered.as_ref() == Some(&open) {
        return;
    }
    *remembered = Some(open);
    nightfall_backup::remember_open_show(current_showfile.name(), in_failover_folder);
    if let Some(mut state) = state {
        let failover_show = in_failover_folder.then(|| nightfall_backup::FailoverShow {
            name: current_showfile.name().map(str::to_string),
        });
        if state.failover_show != failover_show {
            state.failover_show = failover_show;
        }
    }
}

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
    registry.register(nightfall_backup::failover::STEP_DOWN_PATH, post(step_down));
    registry.register(
        nightfall_backup::failover::PAIR_KEY_PATH,
        post(issue_pair_key),
    );
    registry.register(
        nightfall_backup::FORWARDED_COMMANDS_PATH,
        get(forwarded_commands),
    );
}

/// Issues the key this host will share with the backup that just paired with it. Pairing guards
/// the route, so only a paired device or this computer can ask; a backup answers 409.
async fn issue_pair_key() -> Response {
    match nightfall_backup::failover::issue_pair_key() {
        Ok(key) => key.into_response(),
        Err(message) => (StatusCode::CONFLICT, message).into_response(),
    }
}

/// Steps down to follow the host that sent the request, when it carries the key the two share and
/// took over with a newer epoch than this host's. Answers 409 when this host keeps its role.
async fn step_down(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<nightfall_backup::failover::StepDownRequest>,
) -> StatusCode {
    if nightfall_backup::failover::request_step_down(peer.ip(), &request) {
        StatusCode::ACCEPTED
    } else {
        StatusCode::CONFLICT
    }
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
    match nightfall_backup::failover::check_backup_request(&headers) {
        Ok(()) => {}
        Err(nightfall_backup::failover::BackupRefusal::LeftPair) => {
            return (StatusCode::GONE, "This computer left the failover pair.").into_response();
        }
        Err(nightfall_backup::failover::BackupRefusal::NotPaired) => {
            return (
                StatusCode::UNAUTHORIZED,
                "This computer is not paired with this backup. Pair again with its PIN.",
            )
                .into_response();
        }
    }
    // The world waiting at startup for a show is empty, and its checkpoint would wipe the
    // backup's playback.
    if !nightfall_backup::failover::host_status().show_open {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The primary has no show open yet.",
        )
            .into_response();
    }
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
    // The world waiting at startup for a show is empty, and copying it would wipe the backup.
    if !nightfall_backup::failover::host_status().show_open {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The primary has no show open yet.",
        )
            .into_response();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command that opens or creates a show is a show load, and its `type` tag is in
    /// [`SHOW_LOAD_COMMANDS`], which a backup accepts while read-only; saving is neither.
    #[test]
    fn show_loads_match_the_read_only_allow_list() {
        use nightfall_showfile::{NewShowfileOptions, ShowfileRevisionSelection};

        let tag = |command: &ShowfileCommand| {
            serde_json::to_value(command).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let loads = [
            ShowfileCommand::NewShowfile,
            ShowfileCommand::NewNamedShowfile(NewShowfileOptions {
                name: "Show".into(),
                include_sample_data: false,
            }),
            ShowfileCommand::LoadShowfile,
            ShowfileCommand::LoadNamedShowfile("Show".into()),
            ShowfileCommand::LoadDraftShowfile("Show".into()),
            ShowfileCommand::LoadShowfileRevision(ShowfileRevisionSelection {
                showfile_name: "Show".into(),
                revision_name: "rev".into(),
            }),
        ];
        let tags: Vec<String> = loads.iter().map(tag).collect();
        assert_eq!(tags, SHOW_LOAD_COMMANDS);
        assert!(loads.iter().all(opens_a_show));
        assert!(!opens_a_show(&ShowfileCommand::SaveShowfile));
    }
}
