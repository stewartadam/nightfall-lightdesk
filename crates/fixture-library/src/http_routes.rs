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

use axum::{
    body::Body,
    extract::Path,
    http::{StatusCode, header},
    response::Response,
};

use crate::mesh::{MeshExtractionError, decode_gdtf_path, extract_mesh_from_gdtf};

/// Serves a source gobo PNG while archive parsing runs on the blocking I/O pool.
pub async fn serve_wheel_media(Path((encoded, name)): Path<(String, String)>) -> Response {
    use crate::wheel_media::{WheelMediaError, extract_wheel_media};
    let path = match decode_gdtf_path(&encoded) {
        Ok(path) => path,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::empty())
                .unwrap();
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        extract_wheel_media(std::path::Path::new(&path), &name)
    })
    .await;
    match result {
        Ok(Ok(data)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "private, max-age=3600")
            .body(Body::from(data))
            .unwrap(),
        Ok(Err(WheelMediaError::ArchiveUnavailable | WheelMediaError::NotFound)) => {
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap()
        }
        _ => Response::builder()
            .status(StatusCode::UNPROCESSABLE_ENTITY)
            .body(Body::empty())
            .unwrap(),
    }
}

/// Serve a mesh file from a GDTF archive.
///
/// The GDTF path is base64url-encoded in the URL to handle special characters.
pub async fn serve_mesh(Path((gdtf_path_encoded, model_name)): Path<(String, String)>) -> Response {
    use std::path::Path as StdPath;

    // Decode the base64url-encoded GDTF path
    let gdtf_path = match decode_gdtf_path(&gdtf_path_encoded) {
        Ok(path) => path,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("{}", e)))
                .unwrap();
        }
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
