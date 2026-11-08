// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Loads each show a backup copies from its primary, and reports this host's own live show
//! revision to any backup following it.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use bevy::prelude::*;
use nightfall_backup::prelude::{MirroredShowfileReady, ShowfileRevision};
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

/// Registers the route a backup polls to learn when this host's live show changed.
pub(crate) fn register_backup_http_routes(registry: &mut HttpRouteRegistry) {
    registry.register(
        nightfall_backup::SHOWFILE_REVISION_PATH,
        get(current_showfile_revision),
    );
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
