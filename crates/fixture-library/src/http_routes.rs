// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for fixture library endpoints.
//!
//! This module provides HTTP handlers for serving fixture library resources
//! via the websocket crate's route registry. Every route authorizes its archive
//! path against [`LibraryArchives`] before touching the filesystem, and runs
//! archive I/O on the blocking pool.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::Response,
};

use crate::library_archives::LibraryArchives;
use crate::mesh::{MeshExtractionError, decode_gdtf_path, extract_mesh_from_gdtf};
use crate::wheel_media::{WheelMediaError, extract_wheel_media};

/// Builds a response with a status and a short diagnostic body.
fn status_response(status: StatusCode, body: &'static str) -> Response {
    Response::builder()
        .status(status)
        .body(Body::from(body))
        .unwrap()
}

/// Reason a client-supplied archive path was refused before any archive I/O.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveRejection {
    /// The path parameter was not valid base64url UTF-8.
    Malformed,
    /// The path does not name an archive indexed by the fixture library.
    OutsideLibrary,
}

impl ArchiveRejection {
    /// Maps a rejection to its response; unknown and out-of-library paths share one 404 so
    /// the route cannot be used to probe for files outside the library.
    fn into_response(self) -> Response {
        match self {
            Self::Malformed => status_response(StatusCode::BAD_REQUEST, "Invalid archive path"),
            Self::OutsideLibrary => {
                status_response(StatusCode::NOT_FOUND, "Fixture archive not found")
            }
        }
    }
}

/// Decodes a base64url archive path and authorizes it against the indexed library archives.
///
/// Returns the canonical archive path. Canonicalization touches the filesystem, so callers
/// run this on the blocking pool alongside the archive read.
fn authorize_archive(
    archives: &LibraryArchives,
    encoded: &str,
) -> Result<std::path::PathBuf, ArchiveRejection> {
    let requested = decode_gdtf_path(encoded).map_err(|_| ArchiveRejection::Malformed)?;
    archives
        .resolve(std::path::Path::new(&requested))
        .ok_or_else(|| {
            tracing::debug!(path = requested, "Rejected archive outside fixture library");
            ArchiveRejection::OutsideLibrary
        })
}

/// Serves a source gobo PNG from an indexed GDTF archive.
///
/// Status codes separate a missing archive or entry (404), a corrupt archive or
/// invalid image (422), and disk failures (500).
pub async fn serve_wheel_media(
    State(archives): State<LibraryArchives>,
    Path((encoded, name)): Path<(String, String)>,
) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let path = authorize_archive(&archives, &encoded)?;
        Ok::<_, ArchiveRejection>(extract_wheel_media(&path, &name))
    })
    .await;
    match result {
        Ok(Err(rejection)) => rejection.into_response(),
        Ok(Ok(Ok(data))) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "private, max-age=3600")
            .body(Body::from(data))
            .unwrap(),
        Ok(Ok(Err(WheelMediaError::ArchiveNotFound | WheelMediaError::NotFound))) => {
            status_response(StatusCode::NOT_FOUND, "Wheel image not found")
        }
        Ok(Ok(Err(
            error @ (WheelMediaError::CorruptArchive(_) | WheelMediaError::InvalidImage),
        ))) => {
            tracing::warn!(%error, "Rejected wheel image");
            status_response(StatusCode::UNPROCESSABLE_ENTITY, "Invalid wheel image")
        }
        Ok(Ok(Err(error @ WheelMediaError::Io(_)))) => {
            tracing::warn!(%error, "Failed to read wheel image");
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to read wheel image",
            )
        }
        Err(error) => {
            tracing::error!(%error, "Wheel image task failed");
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to read wheel image",
            )
        }
    }
}

/// Serves a mesh file from an indexed GDTF archive.
///
/// The GDTF path is base64url-encoded in the URL to handle special characters.
pub async fn serve_mesh(
    State(archives): State<LibraryArchives>,
    Path((gdtf_path_encoded, model_name)): Path<(String, String)>,
) -> Response {
    let requested_model = model_name.clone();
    let result = tokio::task::spawn_blocking(move || {
        let path = authorize_archive(&archives, &gdtf_path_encoded)?;
        tracing::debug!(
            "Serving mesh '{}' from GDTF: {}",
            model_name,
            path.display()
        );
        Ok::<_, ArchiveRejection>(extract_mesh_from_gdtf(&path, &model_name))
    })
    .await;

    match result {
        Ok(Err(rejection)) => rejection.into_response(),
        Ok(Ok(Ok(mesh))) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mesh.format.content_type())
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Body::from(mesh.data))
            .unwrap(),
        Ok(Ok(Err(MeshExtractionError::FileNotFound(path)))) => {
            tracing::warn!("GDTF file not found: {}", path);
            status_response(StatusCode::NOT_FOUND, "GDTF file not found")
        }
        Ok(Ok(Err(MeshExtractionError::ParseError(msg)))) => {
            tracing::warn!("Failed to parse GDTF file: {}", msg);
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse GDTF file",
            )
        }
        Ok(Ok(Err(MeshExtractionError::MeshNotFound(_)))) => {
            tracing::warn!(model = requested_model, "Mesh not found in GDTF file");
            status_response(StatusCode::NOT_FOUND, "Mesh not found in GDTF archive")
        }
        Ok(Ok(Err(MeshExtractionError::IoError(e)))) => {
            tracing::warn!("IO error extracting mesh: {}", e);
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO error extracting mesh",
            )
        }
        Err(error) => {
            tracing::error!(%error, "Mesh extraction task failed");
            status_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO error extracting mesh",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    use super::*;
    use crate::manager::FixtureLibraryManager;

    /// Creates a library holding one indexed archive plus an identical archive outside it.
    fn library_with_stray_archive() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        LibraryArchives,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let library = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let indexed = library.path().join("optic.gdtf");
        let stray = outside.path().join("stray.gdtf");
        crate::library_archives::tests::write_indexed_gdtf(&indexed);
        crate::library_archives::tests::write_indexed_gdtf(&stray);
        let manager =
            FixtureLibraryManager::read_from_directories(library.path().to_path_buf(), None)
                .unwrap();
        let archives = LibraryArchives::default();
        archives.sync(&manager);
        (library, outside, archives, indexed, stray)
    }

    /// Encodes a filesystem path the way the web UI does for route parameters.
    fn encode(path: &std::path::Path) -> String {
        URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes())
    }

    /// Serves wheel media from indexed archives but rejects valid archives outside the library.
    #[tokio::test]
    async fn wheel_media_route_rejects_archives_outside_library() {
        let (_library, _outside, archives, indexed, stray) = library_with_stray_archive();
        let served = serve_wheel_media(
            State(archives.clone()),
            Path((encode(&indexed), "pattern".to_owned())),
        )
        .await;
        assert_eq!(served.status(), StatusCode::OK);
        let rejected = serve_wheel_media(
            State(archives.clone()),
            Path((encode(&stray), "pattern".to_owned())),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::NOT_FOUND);
        let host_file = serve_wheel_media(
            State(archives),
            Path((
                encode(std::path::Path::new("/etc/hosts")),
                "pattern".to_owned(),
            )),
        )
        .await;
        assert_eq!(host_file.status(), StatusCode::NOT_FOUND);
    }

    /// Rejects mesh requests for archives outside the library and malformed path encodings.
    #[tokio::test]
    async fn mesh_route_rejects_archives_outside_library() {
        let (_library, _outside, archives, _indexed, stray) = library_with_stray_archive();
        let rejected = serve_mesh(
            State(archives.clone()),
            Path((encode(&stray), "Body".to_owned())),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::NOT_FOUND);
        let malformed = serve_mesh(
            State(archives),
            Path(("not base64!".to_owned(), "Body".to_owned())),
        )
        .await;
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    }
}
