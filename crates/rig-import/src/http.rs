// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The HTTP route that receives an MVR file and reads it for import.
//!
//! MVR files that include venue models can be hundreds of megabytes, too large for a
//! websocket command, so the client uploads the file here and gets back a session ID to
//! preview and import with.

use std::io::Write;

use axum::{
    Json,
    body::Body,
    extract::{DefaultBodyLimit, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use nightfall_websocket::prelude::HttpRouteRegistry;

use crate::preview::RigUploadResponse;
use crate::rig::read_rig_file;
use crate::sessions::RigImportSessions;

/// Path of the upload route.
pub const UPLOAD_PATH: &str = "/api/rig-import/mvr";

/// Largest MVR file accepted, in bytes.
pub const UPLOAD_LIMIT_BYTES: usize = 1024 * 1024 * 1024;

/// Query string of an upload: the file's name, shown in the preview.
#[derive(serde::Deserialize)]
struct UploadQuery {
    /// Name of the uploaded file.
    name: Option<String>,
}

/// Registers the upload route, which stores rigs in `sessions`.
pub fn register_rig_import_routes(registry: &mut HttpRouteRegistry, sessions: RigImportSessions) {
    registry.register(
        UPLOAD_PATH,
        post(move |query: Query<UploadQuery>, body: Body| {
            upload_rig(query, body, sessions.clone())
        })
        .layer(DefaultBodyLimit::disable()),
    );
}

/// Streams the request body to a temporary file, reads it as an MVR file off the async
/// runtime, and keeps the result under a new session.
async fn upload_rig(
    Query(query): Query<UploadQuery>,
    body: Body,
    sessions: RigImportSessions,
) -> Response {
    let file_name = query
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "rig.mvr".to_string());
    let temp = match receive_body(body).await {
        Ok(temp) => temp,
        Err((status, message)) => return error_response(status, message),
    };
    let read = tokio::task::spawn_blocking(move || read_rig_file(temp.path(), &file_name)).await;
    match read {
        Ok(Ok(rig)) => {
            let session = sessions.insert(rig);
            Json(RigUploadResponse { session }).into_response()
        }
        Ok(Err(error)) => error_response(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
        Err(error) => {
            tracing::warn!(%error, "Reading an uploaded rig failed");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "Reading the file failed")
        }
    }
}

/// Writes a request body to a temporary file as it arrives, refusing bodies over
/// [`UPLOAD_LIMIT_BYTES`]. Fails with the status and message to answer with.
async fn receive_body(body: Body) -> Result<tempfile::NamedTempFile, (StatusCode, String)> {
    let server_error =
        |error: std::io::Error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    let mut temp = tempfile::Builder::new()
        .prefix("nightfall-rig-upload-")
        .suffix(".mvr")
        .tempfile()
        .map_err(server_error)?;
    let mut stream = body.into_data_stream();
    let mut received = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                format!("The upload was interrupted: {error}"),
            )
        })?;
        received += chunk.len();
        if received > UPLOAD_LIMIT_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "The file is larger than 1 GiB".to_string(),
            ));
        }
        temp.write_all(&chunk).map_err(server_error)?;
    }
    if received == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "The uploaded file is empty".to_string(),
        ));
    }
    Ok(temp)
}

/// Builds a plain-text error response.
fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, message.into()).into_response()
}
