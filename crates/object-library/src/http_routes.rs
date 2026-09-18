// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for object library endpoints.
//!
//! This module provides HTTP handlers for serving object library resources
//! via the websocket crate's route registry.

use axum::{
    body::Body,
    extract::Path,
    http::{StatusCode, header},
    response::Response,
};

use crate::manager::{
    ObjectLibraryManager, ObjectModelPathScope, decode_object_path, extract_model_from_bundle,
    showfile_object_snapshot_dir,
};

fn model_response(data: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "model/gltf-binary")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(data))
        .unwrap()
}

fn source_bundle_filename_from_snapshot_bundle_filename(bundle_filename: &str) -> Option<&str> {
    let (prefix, source_bundle_filename) = bundle_filename.split_once('-')?;
    let is_uuid_simple_prefix = prefix.len() == 32
        && prefix
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if !is_uuid_simple_prefix || source_bundle_filename.is_empty() {
        return None;
    }
    Some(source_bundle_filename)
}

/// Serve a GLB model file from an object bundle.
///
/// The object bundle token is base64url-encoded in the URL.
pub async fn serve_object_model(Path(object_path_encoded): Path<String>) -> Response {
    // Decode the base64url-encoded object bundle token.
    let object_model_path = match decode_object_path(&object_path_encoded) {
        Ok(path) => path,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("{}", e)))
                .unwrap();
        }
    };

    let (bundle_path, fallback_bundle_path) = match object_model_path.scope {
        ObjectModelPathScope::Library => {
            let library_path = match ObjectLibraryManager::get_library_path() {
                Ok(path) => path,
                Err(e) => {
                    tracing::warn!("Failed to resolve object library path: {}", e);
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Body::from("Failed to resolve object library path"))
                        .unwrap();
                }
            };
            (library_path.join(&object_model_path.bundle_filename), None)
        }
        ObjectModelPathScope::ShowfileData => {
            let showfile_snapshot_dir = match showfile_object_snapshot_dir() {
                Ok(path) => path,
                Err(e) => {
                    tracing::warn!("Failed to resolve showfile object snapshot dir: {}", e);
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Body::from("Failed to resolve showfile snapshot directory"))
                        .unwrap();
                }
            };

            let fallback_bundle_path = source_bundle_filename_from_snapshot_bundle_filename(
                &object_model_path.bundle_filename,
            )
            .and_then(|source_bundle_filename| {
                match ObjectLibraryManager::get_library_path() {
                    Ok(path) => Some(path.join(source_bundle_filename)),
                    Err(error) => {
                        tracing::warn!(
                            "Failed to resolve object library path for showfile fallback: {}",
                            error
                        );
                        None
                    }
                }
            });

            (
                showfile_snapshot_dir.join(&object_model_path.bundle_filename),
                fallback_bundle_path,
            )
        }
    };

    tracing::debug!(
        "Serving model from object bundle: {}",
        bundle_path.display()
    );

    let model_result = match extract_model_from_bundle(&bundle_path) {
        Ok(data) => Ok(data),
        Err(crate::ObjectLibraryError::NotFound { .. }) => {
            if let Some(fallback_bundle_path) = fallback_bundle_path.as_ref() {
                match extract_model_from_bundle(fallback_bundle_path) {
                    Ok(data) => {
                        tracing::warn!(
                            "Showfile object snapshot {} missing; falling back to library bundle {}",
                            bundle_path.display(),
                            fallback_bundle_path.display()
                        );
                        Ok(data)
                    }
                    Err(error) => Err(error),
                }
            } else {
                Err(crate::ObjectLibraryError::NotFound {
                    name: bundle_path.display().to_string(),
                })
            }
        }
        Err(error) => Err(error),
    };

    match model_result {
        Ok(data) => model_response(data),
        Err(crate::ObjectLibraryError::NotFound { .. }) => {
            tracing::warn!("Object bundle not found: {}", bundle_path.display());
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Object bundle not found"))
                .unwrap()
        }
        Err(crate::ObjectLibraryError::ModelNotFound(_)) => {
            tracing::warn!(
                "Model not found in object bundle: {}",
                bundle_path.display()
            );
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("Model not found in object bundle"))
                .unwrap()
        }
        Err(e) => {
            tracing::warn!(
                "Error extracting model from {}: {}",
                bundle_path.display(),
                e
            );
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("Failed to extract model"))
                .unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::source_bundle_filename_from_snapshot_bundle_filename;

    #[test]
    fn snapshot_filename_source_bundle_extracts_suffix() {
        let source = source_bundle_filename_from_snapshot_bundle_filename(
            "40f4d2e51f2e4f7d8eb8f7f89dcbce2f-road-case.robj",
        );
        assert_eq!(source, Some("road-case.robj"));
    }

    #[test]
    fn snapshot_filename_source_bundle_rejects_non_snapshot_names() {
        let source = source_bundle_filename_from_snapshot_bundle_filename("road-case.robj");
        assert_eq!(source, None);

        let source = source_bundle_filename_from_snapshot_bundle_filename(
            "not-a-uuid-prefix-road-case.robj",
        );
        assert_eq!(source, None);
    }
}
