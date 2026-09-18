// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for showfile discovery, revision restore, and draft persistence.

use std::path::{Component, Path, PathBuf};

use axum::{
    Json,
    body::Body,
    extract::{Path as AxumPath, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use nightfall_desk::prelude::ShowfileSaveOptions;
use nightfall_engine::prelude::{CommandId, CommandJsonEnvelope};
use nightfall_websocket::prelude::{AxumAppState, HttpRouteRegistry};
use tower_http::services::ServeFile;

use super::{
    listing::{
        AvailableShowfileDraftResponse, AvailableShowfilesResponse,
        available_showfile_draft_for_name_in_root, list_available_showfiles_in_root,
    },
    paths::{show_data_dir_path, showfile_root_dir_path},
};

/// Register showfile-owned HTTP endpoints with the shared route registry.
pub(crate) fn register_showfile_http_routes(registry: &mut HttpRouteRegistry) {
    registry.register("/api/showfiles", get(list_available_showfiles));
    registry.register(
        "/api/showfiles/current/export",
        post(export_current_showfile),
    );
    registry.register(
        "/api/showfiles/current/{*resource_path}",
        get(serve_current_showfile_resource),
    );
    registry.register(
        "/api/showfiles/{showfile_name}/draft",
        get(get_available_showfile_draft),
    );
    registry.register_stateful(
        "/api/showfiles/current/draft",
        post(save_current_showfile_draft),
    );
}

/// Requests a named live showfile copy without saving or changing the current show.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowfileExportRequest {
    name: String,
    policy: super::export::ShowfileExportPolicy,
    #[serde(default)]
    save_options: ShowfileSaveOptions,
}

/// Captures live engine state and streams a finalized ZIP with a separately loadable show directory.
async fn export_current_showfile(Json(options): Json<ShowfileExportRequest>) -> Response {
    if let Err(error) = super::paths::showfile_folder_name(Some(&options.name)) {
        return showfile_resource_error(StatusCode::BAD_REQUEST, error);
    }
    let mut capture = match crate::diagnostic_showfile::capture_showfile().await {
        Ok(capture) => capture,
        Err(error) => return showfile_resource_error(StatusCode::SERVICE_UNAVAILABLE, error),
    };
    if let Some(layout) = options.save_options.active_panel_layout {
        capture.snapshot.settings.active_panel_layout = Some(layout);
    }
    let Some(app_data) = nightfall::nightfall_data_dir() else {
        return showfile_resource_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Application data directory unavailable",
        );
    };
    let result = tokio::task::spawn_blocking(move || {
        let mut prepared = super::export::prepare_showfile_export(
            capture.snapshot,
            &capture.asset_root,
            &app_data,
            options.policy,
        )?;
        if capture.source != "current engine state" {
            prepared.warnings.push(
                "The engine did not respond; the latest stored showfile was exported.".to_string(),
            );
        }
        let file = prepared.write_zip(&options.name)?;
        Ok::<_, String>((file, prepared.warnings.len()))
    })
    .await;
    match result {
        Ok(Ok((file, warnings))) => {
            let file = tokio::fs::File::from_std(file.into_file());
            let stream = tokio_util::io::ReaderStream::new(file);
            without_showfile_resource_cache(
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/zip")
                    .header(
                        header::CONTENT_DISPOSITION,
                        "attachment; filename=\"showfile.zip\"",
                    )
                    .header("x-showfile-export-warnings", warnings.to_string())
                    .body(Body::from_stream(stream))
                    .expect("showfile export response should be valid"),
            )
        }
        Ok(Err(error)) => showfile_resource_error(StatusCode::INTERNAL_SERVER_ERROR, error),
        Err(error) => {
            tracing::warn!(%error, "Showfile export task failed");
            showfile_resource_error(StatusCode::INTERNAL_SERVER_ERROR, "Showfile export failed")
        }
    }
}

/// Prevent clients from caching resources from the currently mounted showfile.
fn without_showfile_resource_cache(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Build a showfile-resource error response without exposing filesystem paths.
fn showfile_resource_error(status: StatusCode, message: impl Into<String>) -> Response {
    without_showfile_resource_cache(
        Response::builder()
            .status(status)
            .body(Body::from(message.into()))
            .expect("showfile resource error response should be valid"),
    )
}

/// Resolve a URL resource path beneath an explicit showfile directory.
fn resolve_showfile_resource_path_from(
    show_data_dir: &Path,
    resource_path: &str,
) -> Result<PathBuf, String> {
    if resource_path.trim().is_empty() || resource_path.contains('\\') {
        return Err("invalid showfile resource path".to_string());
    }

    let relative_path = Path::new(resource_path);
    if relative_path.is_absolute()
        || !relative_path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err("invalid showfile resource path".to_string());
    }

    Ok(show_data_dir.join(relative_path))
}

/// Resolve and serve a file from the currently mounted showfile directory.
async fn serve_current_showfile_resource(
    AxumPath(resource_path): AxumPath<String>,
    request: Request,
) -> Response {
    let show_data_dir = match show_data_dir_path() {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(%error, "Failed to resolve the active showfile directory");
            return showfile_resource_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "no showfile is currently mounted",
            );
        }
    };
    let resource_path = match resolve_showfile_resource_path_from(&show_data_dir, &resource_path) {
        Ok(path) => path,
        Err(error) => return showfile_resource_error(StatusCode::BAD_REQUEST, error),
    };

    let canonical_show_data_dir = match tokio::fs::canonicalize(&show_data_dir).await {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(
                path = %show_data_dir.display(),
                %error,
                "Failed to canonicalize the active showfile directory"
            );
            return showfile_resource_error(StatusCode::NOT_FOUND, "showfile resource not found");
        }
    };
    let canonical_resource_path = match tokio::fs::canonicalize(&resource_path).await {
        Ok(path) if path.starts_with(&canonical_show_data_dir) => path,
        Ok(path) => {
            tracing::warn!(
                path = %path.display(),
                "Rejected a showfile resource outside the active directory"
            );
            return showfile_resource_error(
                StatusCode::BAD_REQUEST,
                "invalid showfile resource path",
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return showfile_resource_error(StatusCode::NOT_FOUND, "showfile resource not found");
        }
        Err(error) => {
            tracing::warn!(
                path = %resource_path.display(),
                %error,
                "Failed to resolve a showfile resource"
            );
            return showfile_resource_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve showfile resource",
            );
        }
    };

    let mut service = ServeFile::new(canonical_resource_path);
    match service.try_call(request).await {
        Ok(response) => without_showfile_resource_cache(response.map(Body::new)),
        Err(error) => {
            tracing::warn!(%error, "Failed to serve a showfile resource");
            showfile_resource_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to serve showfile resource",
            )
        }
    }
}

/// Return the showfiles available from the app data showfile root.
async fn list_available_showfiles() -> Response {
    match tokio::task::spawn_blocking(|| {
        showfile_root_dir_path().and_then(|root| list_available_showfiles_in_root(&root))
    })
    .await
    {
        Ok(Ok(showfiles)) => Json(AvailableShowfilesResponse { showfiles }).into_response(),
        Ok(Err(error)) => {
            tracing::warn!("Failed to list available showfiles: {}", error);
            (StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
        Err(error) => {
            tracing::warn!("Showfile listing task failed: {}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "showfile listing task failed",
            )
                .into_response()
        }
    }
}

/// Return lightweight available-draft metadata for one requested showfile.
async fn get_available_showfile_draft(AxumPath(showfile_name): AxumPath<String>) -> Response {
    match tokio::task::spawn_blocking(move || {
        showfile_root_dir_path()
            .and_then(|root| available_showfile_draft_for_name_in_root(&root, &showfile_name))
    })
    .await
    {
        Ok(Ok(draft)) => Json(AvailableShowfileDraftResponse { draft }).into_response(),
        Ok(Err(error)) => {
            tracing::warn!("Failed to discover available showfile draft: {}", error);
            (StatusCode::BAD_REQUEST, error).into_response()
        }
        Err(error) => {
            tracing::warn!("Available showfile draft task failed: {}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "available showfile draft task failed",
            )
                .into_response()
        }
    }
}

/// Enqueue a backend-owned draft check from browser lifecycle-safe close handling.
///
/// This RPC intentionally exists as an HTTP endpoint instead of a websocket
/// command because browser unload handling can start `sendBeacon` or
/// `fetch(..., { keepalive: true })` HTTP requests, but cannot reliably keep the
/// document alive long enough for a websocket command/response round trip. The
/// endpoint gives tab-close handling a browser lifecycle-compatible way to ask
/// the backend to hash the current showfile state, save a draft when it differs
/// from the saved baseline, or skip writing when the mounted draft is already
/// clean. Clean drafts remain mounted because the backend can outlive the
/// browser tab that triggered this endpoint.
async fn save_current_showfile_draft(
    State(state): State<AxumAppState>,
    options: Option<Json<ShowfileSaveOptions>>,
) -> Response {
    let save_options = options.map(|Json(options)| options).unwrap_or_default();
    let command_id = CommandId::new();
    let envelope = CommandJsonEnvelope {
        command_id,
        undo_id: Some(command_id.into()),
        module: "DeskCommand".to_string(),
        command: serde_json::json!({
            "type": "SaveDraftShowfile",
            "data": save_options,
        }),
    };

    match state.command_json_tx.send(envelope).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => {
            tracing::warn!("Failed to enqueue draft showfile save: {}", error);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "failed to enqueue draft showfile save",
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resource paths remain relative to the mounted showfile directory.
    #[test]
    fn showfile_resource_paths_resolve_beneath_mount() {
        let resolved = resolve_showfile_resource_path_from(
            Path::new("/show-data"),
            "timeline-audio/abc123/track.wav",
        )
        .expect("resource path should resolve");

        assert_eq!(
            resolved,
            Path::new("/show-data/timeline-audio/abc123/track.wav")
        );
    }

    /// Parent components cannot escape the mounted showfile directory.
    #[test]
    fn showfile_resource_paths_reject_parent_components() {
        let error = resolve_showfile_resource_path_from(
            Path::new("/show-data"),
            "timeline-audio/../outside.wav",
        )
        .expect_err("parent path should be rejected");

        assert_eq!(error, "invalid showfile resource path");
    }

    /// Backslash separators cannot bypass URL-path validation on any host platform.
    #[test]
    fn showfile_resource_paths_reject_backslashes() {
        let error = resolve_showfile_resource_path_from(
            Path::new("/show-data"),
            "timeline-audio\\..\\outside.wav",
        )
        .expect_err("backslash path should be rejected");

        assert_eq!(error, "invalid showfile resource path");
    }
}
