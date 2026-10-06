// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Serves the built web UI from the backend port so other devices can load it.
//!
//! The desktop window loads the UI through the webview's own protocol, so nothing else
//! needs HTTP access to it there. A phone or tablet on the LAN has no such protocol: when
//! the host supplies the built files, this fallback answers every request that no backend
//! route claims, and the page then reaches the backend on the same origin.

use std::{borrow::Cow, sync::Arc};

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};

/// Host-provided source of the built web UI files.
///
/// Paths are relative to the build output root without a leading slash, for example
/// `index.html` or `assets/index-abc123.js`. Implementations return a file only when that
/// exact path exists, so the server can tell a missing asset from a client-side route.
pub trait WebUiAssets: Send + Sync + 'static {
    /// Returns the contents of the file at `path`, or `None` when the build has no such file.
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>>;
}

/// Shared handle to the web UI files served by the backend.
pub type SharedWebUiAssets = Arc<dyn WebUiAssets>;

/// Build output path of the single-page application's entry document.
const INDEX_PATH: &str = "index.html";

/// Directory Vite emits content-hashed build output into.
const HASHED_ASSETS_PREFIX: &str = "assets/";

/// Cache policy for content-hashed files, whose names change whenever their contents do.
const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";

/// Cache policy for files whose names stay fixed across builds, such as the entry document.
const REVALIDATE_CACHE: &str = "no-cache";

/// Answers a request that no backend route matched with a file from the built web UI.
///
/// Files are looked up by their exact path. Paths without a file extension are client-side
/// routes and receive the entry document; a missing path with an extension is a 404 rather
/// than HTML, so a stale or mistyped script reference fails visibly instead of being parsed
/// as markup. Only `GET` and `HEAD` are served.
pub(crate) async fn serve_web_ui(assets: SharedWebUiAssets, request: Request) -> Response {
    let method = request.method();
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(path) = asset_path(request.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (path, contents) = match assets.get(&path) {
        Some(contents) => (path, contents),
        None if is_client_route(&path) => match assets.get(INDEX_PATH) {
            Some(contents) => (INDEX_PATH.to_string(), contents),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(contents.into_owned())
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    let content_type = mime_guess::from_path(&path).first_or_octet_stream();
    if let Ok(value) = HeaderValue::from_str(content_type.as_ref()) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if path.starts_with(HASHED_ASSETS_PREFIX) {
            IMMUTABLE_CACHE
        } else {
            REVALIDATE_CACHE
        }),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// Converts a request path into a build output path, rejecting traversal and odd segments.
///
/// The root maps to the entry document. Segments are percent-decoded so encoded file names
/// resolve, and any empty, `.` or `..` segment, or one containing a backslash, is refused
/// rather than normalized.
fn asset_path(request_path: &str) -> Option<String> {
    let trimmed = request_path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(INDEX_PATH.to_string());
    }
    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .ok()?;
        if decoded.is_empty() || decoded == "." || decoded == ".." || decoded.contains('\\') {
            return None;
        }
        segments.push(decoded);
    }
    Some(segments.join("/"))
}

/// Reports whether a path names a client-side route rather than a build file.
///
/// Build files always carry an extension in their last segment; application routes do not.
fn is_client_route(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_none_or(|name| !name.contains('.'))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::body::to_bytes;

    use super::*;

    /// In-memory build output used to exercise lookup and fallback rules.
    struct FakeBuild(HashMap<&'static str, &'static [u8]>);

    impl WebUiAssets for FakeBuild {
        /// Returns a file only on an exact path match, as real hosts must.
        fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
            self.0.get(path).map(|bytes| Cow::Borrowed(*bytes))
        }
    }

    /// Builds a shared asset source holding an entry document and one hashed script.
    fn build() -> SharedWebUiAssets {
        Arc::new(FakeBuild(HashMap::from([
            ("index.html", b"<!doctype html>".as_slice()),
            ("assets/index-abc.js", b"console.log(1)".as_slice()),
            ("notices/third party.txt", b"notices".as_slice()),
        ])))
    }

    /// Sends one request through the handler and returns status, selected headers and body.
    async fn fetch(
        method: Method,
        path: &str,
    ) -> (StatusCode, Option<String>, Option<String>, Vec<u8>) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap();
        let response = serve_web_ui(build(), request).await;
        let status = response.status();
        let header = |name| {
            response
                .headers()
                .get(name)
                .map(|value: &HeaderValue| value.to_str().unwrap().to_string())
        };
        let content_type = header(header::CONTENT_TYPE);
        let cache = header(header::CACHE_CONTROL);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, content_type, cache, body.to_vec())
    }

    /// The root serves the entry document as HTML that browsers must revalidate.
    #[tokio::test]
    async fn root_serves_index_without_long_caching() {
        let (status, content_type, cache, body) = fetch(Method::GET, "/").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/html"));
        assert_eq!(cache.as_deref(), Some(REVALIDATE_CACHE));
        assert_eq!(body, b"<!doctype html>");
    }

    /// Hashed build output is served with its own type and cached indefinitely.
    #[tokio::test]
    async fn hashed_assets_are_immutable() {
        let (status, content_type, cache, body) = fetch(Method::GET, "/assets/index-abc.js").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/javascript"));
        assert_eq!(cache.as_deref(), Some(IMMUTABLE_CACHE));
        assert_eq!(body, b"console.log(1)");
    }

    /// Extensionless paths are client routes and load the application.
    #[tokio::test]
    async fn client_routes_fall_back_to_index() {
        let (status, content_type, _, body) = fetch(Method::GET, "/settings/network").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/html"));
        assert_eq!(body, b"<!doctype html>");
    }

    /// A missing file with an extension is a 404, never the entry document.
    #[tokio::test]
    async fn missing_files_are_not_found() {
        let (status, _, _, _) = fetch(Method::GET, "/assets/stale-123.js").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Encoded names resolve, while traversal and non-read methods are refused.
    #[tokio::test]
    async fn decodes_names_and_refuses_traversal_and_writes() {
        let (status, _, _, body) = fetch(Method::GET, "/notices/third%20party.txt").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"notices");
        for path in [
            "/assets/../index.html",
            "/assets/%2e%2e/index.html",
            "/a//b",
            "/a\\b",
        ] {
            assert_eq!(
                fetch(Method::GET, path).await.0,
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        assert_eq!(fetch(Method::POST, "/").await.0, StatusCode::NOT_FOUND);
    }

    /// HEAD reports headers without sending the file.
    #[tokio::test]
    async fn head_omits_body() {
        let (status, content_type, _, body) = fetch(Method::HEAD, "/").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/html"));
        assert!(body.is_empty());
    }
}
