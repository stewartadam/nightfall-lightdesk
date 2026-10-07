// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Browser diagnostics downloads using the same archive writer as the desktop shell.

use std::net::SocketAddr;

use axum::{
    Json,
    body::Body,
    extract::ConnectInfo,
    http::{StatusCode, header},
    response::Response,
    routing::post,
};
use nightfall_websocket::prelude::HttpRouteRegistry;

use crate::diagnostic_bundle::{BundleOptions, ShowfileMode, build_bundle};

/// Registers the browser download endpoint before the shared HTTP server starts.
pub(crate) fn register_routes(registry: &mut HttpRouteRegistry) {
    registry.register("/api/diagnostics/export", post(export_diagnostics));
}

/// Browser collection includes system information and optional show content; native logs are desktop-only.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserBundleOptions {
    system_info: String,
    showfile_mode: ShowfileMode,
}

/// Captures selected show content and streams a finalized temporary archive that is removed after download.
///
/// The archive holds logs, local paths and optionally the show, so only clients on the
/// engine machine itself may request it; devices reaching the backend over the network
/// are refused.
async fn export_diagnostics(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(options): Json<BrowserBundleOptions>,
) -> Result<Response, (StatusCode, String)> {
    if !peer.ip().is_loopback() {
        return Err((
            StatusCode::FORBIDDEN,
            "Diagnostics can only be collected on the computer running Nightfall.".to_string(),
        ));
    }
    let app_data = nightfall::nightfall_data_dir().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Application data directory unavailable".to_string(),
        )
    })?;
    let showfile = if options.showfile_mode == ShowfileMode::None {
        None
    } else {
        Some(
            crate::diagnostic_showfile::capture_showfile()
                .await
                .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?,
        )
    };
    let (file, warnings) = tokio::task::spawn_blocking(move || {
        build_bundle(
            &std::env::temp_dir(),
            &app_data,
            BundleOptions {
                system_info: options.system_info,
                showfile_mode: options.showfile_mode,
                log_mode: None,
                log_length: None,
            },
            showfile,
        )
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file.into_file()));
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"nightfall-diagnostics.zip\"",
        )
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-diagnostic-export-warnings", warnings.len().to_string())
        .body(Body::from_stream(stream))
        .expect("diagnostic export response should be valid"))
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use axum::{Json, extract::ConnectInfo, http::StatusCode};

    use super::{BrowserBundleOptions, export_diagnostics};
    use crate::diagnostic_bundle::ShowfileMode;

    /// Devices reaching the backend over the network cannot pull logs or the show.
    #[tokio::test]
    async fn refuses_network_peers() {
        let peer = SocketAddr::from((Ipv4Addr::new(192, 168, 1, 20), 50_000));
        let options = BrowserBundleOptions {
            system_info: String::new(),
            showfile_mode: ShowfileMode::None,
        };
        let Err((status, _)) = export_diagnostics(ConnectInfo(peer), Json(options)).await else {
            panic!("a network peer exported diagnostics");
        };
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
