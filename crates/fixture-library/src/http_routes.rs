// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Indexed, bounded HTTP access to fixture mesh resources.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::Response,
};
use bevy_ecs::prelude::Resource;
use tokio::sync::Semaphore;

use crate::manager::{FixtureLibraryManager, FixtureSource};
use crate::mesh::{MeshExtractionError, decode_gdtf_path, extract_mesh_from_revision};

/// Shared current library index and admission limit for expensive mesh extraction requests.
#[derive(Clone, Resource)]
pub struct MeshAccess {
    paths: Arc<RwLock<HashSet<PathBuf>>>,
    slots: Arc<Semaphore>,
}

impl MeshAccess {
    /// Bind HTTP access to the same installed/package profile index used by fixture creation.
    pub fn new(library: &FixtureLibraryManager) -> Self {
        let access = Self {
            paths: Arc::default(),
            slots: Arc::new(Semaphore::new(2)),
        };
        access.refresh(library);
        access
    }

    /// Atomically replace allowed paths so removed profiles and previous show assets cannot remain authorized.
    pub fn refresh(&self, library: &FixtureLibraryManager) {
        let paths = library
            .list_fixtures()
            .into_iter()
            .filter_map(|profile| match &profile.source {
                FixtureSource::Gdtf(metadata) => Some(metadata.file_path.clone()),
                _ => None,
            })
            .collect();
        if let Ok(mut current) = self.paths.write() {
            *current = paths;
        }
    }

    /// Check exact indexed paths before opening any file; aliases supplied by requests gain no extra access.
    fn allows(&self, path: &std::path::Path) -> bool {
        self.paths.read().is_ok_and(|paths| paths.contains(path))
    }
}

/// Serve only indexed GDTF resources with bounded extraction away from async executor threads.
pub async fn serve_mesh(
    State(access): State<MeshAccess>,
    Path((encoded_path, archive_sha256, model_name)): Path<(String, String, String)>,
) -> Response {
    if archive_sha256.len() != 64
        || !archive_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return error_response(StatusCode::BAD_REQUEST, "Invalid archive revision");
    }
    let path = match decode_gdtf_path(&encoded_path) {
        Ok(path) => PathBuf::from(path),
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid archive identifier"),
    };
    if !access.allows(&path) {
        return error_response(
            StatusCode::NOT_FOUND,
            "Archive is not in the current fixture library",
        );
    }
    let Ok(slot) = Arc::clone(&access.slots).acquire_owned().await else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Mesh loading is unavailable",
        );
    };
    if !access.allows(&path) {
        return error_response(
            StatusCode::NOT_FOUND,
            "Archive is no longer in the fixture library",
        );
    }
    let etag = format!("\"{archive_sha256}\"");
    let result = tokio::task::spawn_blocking(move || {
        // Keep admission ownership inside the worker even if its HTTP request is cancelled.
        let _slot = slot;
        extract_mesh_from_revision(&path, &archive_sha256, &model_name)
    })
    .await;
    match result {
        Ok(Ok(mesh)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mesh.format.content_type())
            .header(
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            )
            .header(header::ETAG, etag)
            .body(Body::from(mesh.data))
            .expect("valid mesh response"),
        Ok(Err(error)) => {
            tracing::warn!(%error, "Fixture mesh extraction failed");
            let (status, message) = match error {
                MeshExtractionError::RevisionUnavailable => (
                    StatusCode::CONFLICT,
                    "Requested archive revision is unavailable",
                ),
                MeshExtractionError::InvalidModelName => {
                    (StatusCode::BAD_REQUEST, "Invalid model resource name")
                }
                MeshExtractionError::MeshNotFound(_) => {
                    (StatusCode::NOT_FOUND, "Mesh resource is unavailable")
                }
                MeshExtractionError::ArchiveError(error) if error.code.ends_with("_limit") => (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Fixture archive exceeds resource limits",
                ),
                MeshExtractionError::ArchiveError(error) if error.code == "archive_io" => {
                    (StatusCode::NOT_FOUND, "Fixture archive is unavailable")
                }
                _ => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Fixture resource could not be decoded",
                ),
            };
            error_response(status, message)
        }
        Err(error) => {
            tracing::error!(%error, "Fixture mesh worker failed");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "Mesh worker failed")
        }
    }
}

/// Keep transient resource failures out of browser caches.
fn error_response(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(message.to_owned()))
        .expect("valid mesh error response")
}
