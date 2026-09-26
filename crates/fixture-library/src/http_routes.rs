// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for fixture library endpoints.
//!
//! This module provides HTTP handlers for serving fixture library resources
//! via the websocket crate's route registry.

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

use crate::mesh::{
    MeshExtractionError, decode_gdtf_path, extract_mesh_from_gdtf, extract_wheel_media_from_gdtf,
};

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

/// Decodes a URL-encoded archive path and checks it is indexed, or returns the error response.
#[allow(clippy::result_large_err)]
fn indexed_archive_path(encoded: &str, archives: &IndexedArchives) -> Result<String, Response> {
    let path = decode_gdtf_path(encoded).map_err(|error| {
        Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from(error.to_string()))
            .unwrap()
    })?;
    if !archives.contains(&path) {
        tracing::warn!(
            path,
            "Refusing to serve a resource from an unindexed archive"
        );
        return Err(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("GDTF file not found"))
            .unwrap());
    }
    Ok(path)
}

/// Serve a mesh file from an indexed GDTF archive.
///
/// The GDTF path is base64url-encoded in the URL to handle special characters.
pub async fn serve_mesh(
    Path((gdtf_path_encoded, model_name)): Path<(String, String)>,
    archives: IndexedArchives,
) -> Response {
    use std::path::Path as StdPath;

    let gdtf_path = match indexed_archive_path(&gdtf_path_encoded, &archives) {
        Ok(path) => path,
        Err(response) => return response,
    };

    tracing::debug!("Serving mesh '{}' from GDTF: {}", model_name, gdtf_path);

    // Extract the mesh using fixture-library
    match extract_mesh_from_gdtf(StdPath::new(&gdtf_path), &model_name) {
        Ok(mesh) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mesh.format.content_type())
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Body::from(mesh.data))
            .unwrap(),
        Err(MeshExtractionError::FileNotFound(_)) => {
            tracing::warn!("GDTF file not found: {}", gdtf_path);
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("GDTF file not found"))
                .unwrap()
        }
        Err(MeshExtractionError::ParseError(msg)) => {
            tracing::warn!("Failed to parse GDTF file {}: {}", gdtf_path, msg);
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("Failed to parse GDTF file"))
                .unwrap()
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

            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Mesh not found in GDTF archive"))
                .unwrap()
        }
        Err(MeshExtractionError::IoError(e)) => {
            tracing::warn!("IO error extracting mesh: {}", e);
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("IO error extracting mesh"))
                .unwrap()
        }
    }
}

/// Serve a wheel slot image (gobo, animation wheel) from a GDTF archive as PNG.
///
/// The GDTF path is base64url-encoded in the URL to handle special characters.
pub async fn serve_wheel_media(
    Path((gdtf_path_encoded, media_name)): Path<(String, String)>,
    archives: IndexedArchives,
) -> Response {
    let gdtf_path = match indexed_archive_path(&gdtf_path_encoded, &archives) {
        Ok(path) => path,
        Err(response) => return response,
    };

    match extract_wheel_media_from_gdtf(std::path::Path::new(&gdtf_path), &media_name) {
        Ok(data) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Body::from(data))
            .unwrap(),
        Err(error) => {
            tracing::warn!(media = media_name, %error, "Wheel media not served");
            let status = match error {
                MeshExtractionError::FileNotFound(_) | MeshExtractionError::MeshNotFound(_) => {
                    StatusCode::NOT_FOUND
                }
                MeshExtractionError::ParseError(_) | MeshExtractionError::IoError(_) => {
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            };
            Response::builder()
                .status(status)
                .body(Body::from("Wheel media not available"))
                .unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;
    use crate::testing::{GdtfBuilder, GeometrySpec};

    /// Writes an archive with one wheel image and returns its path and URL-encoded path.
    fn archive(dir: &std::path::Path, name: &str) -> (PathBuf, String) {
        let path = dir.join(name);
        GdtfBuilder::new("Test", name)
            .geometry(GeometrySpec::generic("Base"))
            .file("wheels/stars.png", b"png")
            .write_to(&path);
        let encoded = URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes());
        (path, encoded)
    }

    /// Verifies wheel images are served only from indexed archives.
    #[tokio::test]
    async fn wheel_media_requires_an_indexed_archive() {
        let dir = tempfile::tempdir().unwrap();
        let (indexed, indexed_encoded) = archive(dir.path(), "indexed.gdtf");
        let (_, other_encoded) = archive(dir.path(), "other.gdtf");
        let archives = IndexedArchives::default();
        archives.replace([indexed]);

        let served = serve_wheel_media(
            Path((indexed_encoded, "stars".to_string())),
            archives.clone(),
        )
        .await;
        assert_eq!(served.status(), StatusCode::OK);

        let refused =
            serve_wheel_media(Path((other_encoded, "stars".to_string())), archives.clone()).await;
        assert_eq!(refused.status(), StatusCode::NOT_FOUND);
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
