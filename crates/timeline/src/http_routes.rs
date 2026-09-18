// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::fs;

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path as AxumPath},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use uuid::Uuid;

use crate::storage::{resolve_timeline_audio_path, timeline_audio_relative_path};

const TIMELINE_AUDIO_UPLOAD_LIMIT_BYTES: usize = 512 * 1024 * 1024;

/// HTTP response returned after storing an uploaded timeline audio file.
#[derive(Serialize)]
struct TimelineAudioUploadResponse {
    audio_path: String,
}

/// Build a timeline upload error response with the requested status and message.
fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    Response::builder()
        .status(status)
        .body(Body::from(message.into()))
        .unwrap()
}

/// Parse a timeline identifier supplied as an HTTP path segment.
fn parse_timeline_uid(raw_timeline_uid: &str) -> Result<Uuid, String> {
    Uuid::parse_str(raw_timeline_uid)
        .map_err(|error| format!("invalid timeline uid '{}': {}", raw_timeline_uid, error))
}

/// Limit multipart requests to the largest supported timeline audio upload.
pub(crate) fn timeline_audio_upload_limit() -> axum::extract::DefaultBodyLimit {
    axum::extract::DefaultBodyLimit::max(TIMELINE_AUDIO_UPLOAD_LIMIT_BYTES)
}

/// Store uploaded audio beneath the owning timeline in the active showfile.
pub async fn upload_timeline_audio(
    AxumPath(raw_timeline_uid): AxumPath<String>,
    mut multipart: Multipart,
) -> Response {
    let timeline_uid = match parse_timeline_uid(&raw_timeline_uid) {
        Ok(timeline_uid) => timeline_uid,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, message),
    };

    let Some(field) = (match multipart.next_field().await {
        Ok(field) => field,
        Err(error) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!("failed to read multipart body: {}", error),
            );
        }
    }) else {
        return error_response(StatusCode::BAD_REQUEST, "missing audio file upload");
    };

    let filename = field
        .file_name()
        .map(str::to_string)
        .unwrap_or_else(|| "track".to_string());
    let audio_bytes = match field.bytes().await {
        Ok(bytes) if !bytes.is_empty() => bytes,
        Ok(_) => {
            return error_response(StatusCode::BAD_REQUEST, "uploaded audio file is empty");
        }
        Err(error) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!("failed to read uploaded audio file: {}", error),
            );
        }
    };

    let relative_audio_path = match timeline_audio_relative_path(timeline_uid, &filename) {
        Ok(path) => path,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    let absolute_audio_path = match resolve_timeline_audio_path(&relative_audio_path) {
        Ok(path) => path,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let Some(audio_directory) = absolute_audio_path.parent() else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "failed to resolve timeline audio directory for {}",
                relative_audio_path
            ),
        );
    };

    if audio_directory.exists() {
        if let Err(error) = fs::remove_dir_all(audio_directory) {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "failed to clear existing timeline audio directory {}: {}",
                    audio_directory.display(),
                    error
                ),
            );
        }
    }

    if let Err(error) = fs::create_dir_all(audio_directory) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "failed to create timeline audio directory {}: {}",
                audio_directory.display(),
                error
            ),
        );
    }

    if let Err(error) = fs::write(&absolute_audio_path, &audio_bytes) {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "failed to write uploaded audio file {}: {}",
                absolute_audio_path.display(),
                error
            ),
        );
    }

    (
        StatusCode::OK,
        Json(TimelineAudioUploadResponse {
            audio_path: relative_audio_path,
        }),
    )
        .into_response()
}
