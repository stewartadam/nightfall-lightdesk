// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for fixture library endpoints.
//!
//! This module provides HTTP handlers for serving fixture library resources
//! via the websocket crate's route registry. Every route checks its archive
//! path against [`IndexedArchives`] before reading the archive, and runs that
//! check and the archive read on the blocking pool.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    body::Body,
    extract::Path,
    http::{StatusCode, header},
    response::Response,
};
use bevy_ecs::prelude::Resource;

use crate::mesh::{MeshExtractionError, decode_gdtf_path, extract_mesh_from_gdtf};
use crate::wheel_media::{WheelMediaError, extract_wheel_media};

/// Archive files the fixture library currently indexes.
///
/// Resource routes decode a filesystem path from the URL; only paths in this
/// set are opened, so a request cannot make the server parse arbitrary files.
/// Shared with route handlers and refreshed whenever the library changes.
#[derive(Resource, Clone, Default)]
pub struct IndexedArchives(Arc<RwLock<HashSet<PathBuf>>>);

impl IndexedArchives {
    /// Replaces the indexed set with `paths`, canonicalizing each.
    pub fn replace(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let canonical = paths
            .into_iter()
            .filter_map(|path| path.canonicalize().ok())
            .collect();
        if let Ok(mut set) = self.0.write() {
            *set = canonical;
        }
    }

    /// Returns whether `path` resolves to an indexed archive.
    pub fn contains(&self, path: &str) -> bool {
        let Ok(canonical) = std::path::Path::new(path).canonicalize() else {
            return false;
        };
        self.0.read().is_ok_and(|set| set.contains(&canonical))
    }
}

/// Builds a response with a status and a short diagnostic body.
fn status_response(status: StatusCode, body: &'static str) -> Response {
    Response::builder()
        .status(status)
        .body(Body::from(body))
        .unwrap()
}

/// Decodes a URL-encoded archive path and checks it is indexed, or returns the error response.
///
/// Checking canonicalizes the path, which touches the filesystem, so callers
/// run this on the blocking pool alongside the archive read.
#[allow(clippy::result_large_err)]
fn indexed_archive_path(encoded: &str, archives: &IndexedArchives) -> Result<String, Response> {
    let path = decode_gdtf_path(encoded)
        .map_err(|_| status_response(StatusCode::BAD_REQUEST, "Invalid archive path"))?;
    if !archives.contains(&path) {
        tracing::warn!(
            path,
            "Refusing to serve a resource from an unindexed archive"
        );
        return Err(status_response(
            StatusCode::NOT_FOUND,
            "GDTF file not found",
        ));
    }
    Ok(path)
}

/// Runs a blocking archive request on the blocking pool, answering 500 if the task fails.
async fn run_blocking(
    what: &'static str,
    request: impl FnOnce() -> Response + Send + 'static,
) -> Response {
    tokio::task::spawn_blocking(request)
        .await
        .unwrap_or_else(|error| {
            tracing::error!(%error, what, "Archive request task failed");
            status_response(StatusCode::INTERNAL_SERVER_ERROR, "Archive request failed")
        })
}

/// Serve a mesh file from an indexed GDTF archive.
///
/// The GDTF path is base64url-encoded in the URL to handle special characters.
pub async fn serve_mesh(
    Path((gdtf_path_encoded, model_name)): Path<(String, String)>,
    archives: IndexedArchives,
) -> Response {
    run_blocking("mesh", move || {
        mesh_response(&gdtf_path_encoded, &model_name, &archives)
    })
    .await
}

/// Reads a mesh from an indexed archive and maps the outcome to a response.
fn mesh_response(encoded: &str, model_name: &str, archives: &IndexedArchives) -> Response {
    use std::path::Path as StdPath;

    let gdtf_path = match indexed_archive_path(encoded, archives) {
        Ok(path) => path,
        Err(response) => return response,
    };

    tracing::debug!("Serving mesh '{}' from GDTF: {}", model_name, gdtf_path);

    match extract_mesh_from_gdtf(StdPath::new(&gdtf_path), model_name) {
        Ok(mesh) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mesh.format.content_type())
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Body::from(mesh.data))
            .unwrap(),
        Err(MeshExtractionError::FileNotFound(_)) => {
            tracing::warn!("GDTF file not found: {}", gdtf_path);
            status_response(StatusCode::NOT_FOUND, "GDTF file not found")
        }
        Err(MeshExtractionError::ParseError(msg)) => {
            tracing::warn!("Failed to parse GDTF file {}: {}", gdtf_path, msg);
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse GDTF file",
            )
        }
        Err(MeshExtractionError::MeshNotFound(_)) => {
            let gdtf_filename = StdPath::new(&gdtf_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&gdtf_path);

            tracing::warn!(
                model = model_name,
                gdtf_file = gdtf_filename,
                "Mesh not found in GDTF file",
            );
            status_response(StatusCode::NOT_FOUND, "Mesh not found in GDTF archive")
        }
        Err(MeshExtractionError::IoError(e)) => {
            tracing::warn!("IO error extracting mesh: {}", e);
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO error extracting mesh",
            )
        }
    }
}

/// Serve a wheel slot image (gobo, animation wheel) from an indexed GDTF archive as PNG.
///
/// The GDTF path is base64url-encoded in the URL to handle special characters.
/// Status codes separate a missing archive or image (404), a corrupt archive or
/// invalid image (422), and disk failures (500).
pub async fn serve_wheel_media(
    Path((gdtf_path_encoded, media_name)): Path<(String, String)>,
    archives: IndexedArchives,
) -> Response {
    run_blocking("wheel media", move || {
        wheel_media_response(&gdtf_path_encoded, &media_name, &archives)
    })
    .await
}

/// Reads a wheel image from an indexed archive and maps the outcome to a response.
fn wheel_media_response(encoded: &str, media_name: &str, archives: &IndexedArchives) -> Response {
    let gdtf_path = match indexed_archive_path(encoded, archives) {
        Ok(path) => path,
        Err(response) => return response,
    };

    match extract_wheel_media(std::path::Path::new(&gdtf_path), media_name) {
        Ok(data) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Body::from(data))
            .unwrap(),
        Err(error @ (WheelMediaError::ArchiveNotFound | WheelMediaError::NotFound)) => {
            tracing::warn!(media = media_name, %error, "Wheel media not served");
            status_response(StatusCode::NOT_FOUND, "Wheel image not found")
        }
        Err(error @ (WheelMediaError::CorruptArchive(_) | WheelMediaError::InvalidImage)) => {
            tracing::warn!(media = media_name, %error, "Rejected wheel image");
            status_response(StatusCode::UNPROCESSABLE_ENTITY, "Invalid wheel image")
        }
        Err(error @ WheelMediaError::Io(_)) => {
            tracing::warn!(media = media_name, %error, "Failed to read wheel image");
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to read wheel image",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;
    use crate::testing::{GdtfBuilder, GeometrySpec};
    use crate::wheel_media::tests::PNG;

    /// Encodes a filesystem path the way the web UI does for route parameters.
    fn encode(path: &std::path::Path) -> String {
        URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes())
    }

    /// Writes an archive with a valid and an invalid wheel image and returns its path and URL-encoded path.
    fn archive(dir: &std::path::Path, name: &str) -> (PathBuf, String) {
        let path = dir.join(name);
        GdtfBuilder::new("Test", name)
            .geometry(GeometrySpec::generic("Base"))
            .file("wheels/stars.png", PNG)
            .file("wheels/broken.png", b"not a png")
            .write_to(&path);
        let encoded = encode(&path);
        (path, encoded)
    }

    /// Requests a wheel image and returns the response status.
    async fn wheel_status(encoded: &str, media: &str, archives: &IndexedArchives) -> StatusCode {
        serve_wheel_media(
            Path((encoded.to_string(), media.to_string())),
            archives.clone(),
        )
        .await
        .status()
    }

    /// Verifies wheel images are served only from indexed archives.
    #[tokio::test]
    async fn wheel_media_requires_an_indexed_archive() {
        let dir = tempfile::tempdir().unwrap();
        let (indexed, indexed_encoded) = archive(dir.path(), "indexed.gdtf");
        let (_, other_encoded) = archive(dir.path(), "other.gdtf");
        let archives = IndexedArchives::default();
        archives.replace([indexed]);

        assert_eq!(
            wheel_status(&indexed_encoded, "stars", &archives).await,
            StatusCode::OK
        );
        assert_eq!(
            wheel_status(&indexed_encoded, "stars.png", &archives).await,
            StatusCode::OK
        );
        assert_eq!(
            wheel_status(&other_encoded, "stars", &archives).await,
            StatusCode::NOT_FOUND
        );
        let host_file = encode(std::path::Path::new("/etc/hosts"));
        assert_eq!(
            wheel_status(&host_file, "stars", &archives).await,
            StatusCode::NOT_FOUND
        );
    }

    /// Verifies wheel image failures map to 404 for missing media and 422 for invalid images
    /// or archives.
    #[tokio::test]
    async fn wheel_media_maps_failures_to_statuses() {
        let dir = tempfile::tempdir().unwrap();
        let (indexed, encoded) = archive(dir.path(), "indexed.gdtf");
        let corrupt = dir.path().join("corrupt.gdtf");
        std::fs::write(&corrupt, b"definitely not a zip archive").unwrap();
        let archives = IndexedArchives::default();
        archives.replace([indexed, corrupt.clone()]);

        assert_eq!(
            wheel_status(&encoded, "missing", &archives).await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            wheel_status(&encoded, "broken", &archives).await,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            wheel_status(&encode(&corrupt), "stars", &archives).await,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    /// Verifies meshes are refused for unindexed paths and malformed encodings.
    #[tokio::test]
    async fn mesh_requests_reject_unindexed_paths() {
        let dir = tempfile::tempdir().unwrap();
        let (_, encoded) = archive(dir.path(), "loose.gdtf");
        let archives = IndexedArchives::default();
        let refused = serve_mesh(Path((encoded, "Body".to_string())), archives.clone()).await;
        assert_eq!(refused.status(), StatusCode::NOT_FOUND);
        let malformed = serve_mesh(Path(("%%%".to_string(), "Body".to_string())), archives).await;
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    }
}
