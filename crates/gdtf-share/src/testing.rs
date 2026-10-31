// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! A local stand-in for the GDTF Share API, so tests never contact the real site.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header::COOKIE as COOKIE_HEADER, header::SET_COOKIE},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::ShareClient;
use crate::credentials::Credentials;

/// Username the mock API accepts.
pub(crate) const USER: &str = "lighting@example.com";
/// Password the mock API accepts.
pub(crate) const PASSWORD: &str = "correct horse";
/// Session cookie name and value prefix; each login appends its own number.
pub(crate) const COOKIE: &str = "PHPSESSID=mock-session";

/// Returns the credentials the mock API accepts.
pub(crate) fn valid_credentials() -> Credentials {
    Credentials {
        user: USER.into(),
        password: PASSWORD.into(),
    }
}

/// Builds a minimal GDTF archive: a zip holding only a `description.xml`.
pub(crate) fn gdtf_archive(fixture: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    archive
        .start_file(
            "description.xml",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
    write!(
        archive,
        r#"<GDTF DataVersion="1.2"><FixtureType Name="{fixture}"/></GDTF>"#
    )
    .unwrap();
    archive.finish().unwrap().into_inner()
}

/// Requests the mock API has answered, and what it serves.
#[derive(Default)]
struct MockState {
    logins: AtomicUsize,
    lists: AtomicUsize,
    downloads: AtomicUsize,
    sessions: Mutex<HashSet<String>>,
    list: Mutex<Value>,
    files: Mutex<HashMap<u32, Vec<u8>>>,
}

/// A running mock API.
pub(crate) struct MockShare {
    /// Base URL to give [`ShareClient::new`].
    pub(crate) base_url: String,
    state: Arc<MockState>,
}

/// The `rid` query parameter of a download.
#[derive(Deserialize)]
struct DownloadQuery {
    rid: u32,
}

/// The reply GDTF Share gives a request without a valid session: HTTP 200 and `result: false`.
fn unauthorized() -> Response {
    Json(json!({ "result": false, "error": "Unauthorized." })).into_response()
}

impl MockState {
    /// Whether `headers` carry a session cookie from an earlier login that has not expired.
    fn signed_in(&self, headers: &HeaderMap) -> bool {
        headers
            .get(COOKIE_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|cookie| self.sessions.lock().unwrap().contains(cookie))
    }
}

/// Answers a login like GDTF Share: a fresh numbered session cookie for the accepted
/// credentials, HTTP 200 with `result: false` and an error message for anything else.
async fn login(State(state): State<Arc<MockState>>, Json(body): Json<Value>) -> Response {
    let count = state.logins.fetch_add(1, Ordering::SeqCst) + 1;
    if body["user"] != USER || body["password"] != PASSWORD {
        return Json(json!({ "result": false, "error": "Wrong username or password." }))
            .into_response();
    }
    let cookie = format!("{COOKIE}-{count}");
    state.sessions.lock().unwrap().insert(cookie.clone());
    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, format!("{cookie}; path=/").parse().unwrap());
    (
        StatusCode::OK,
        headers,
        Json(json!({ "result": true, "notice": "Logged in." })),
    )
        .into_response()
}

/// Serves the configured fixture list to signed-in requests.
async fn list(State(state): State<Arc<MockState>>, headers: HeaderMap) -> Response {
    state.lists.fetch_add(1, Ordering::SeqCst);
    if !state.signed_in(&headers) {
        return unauthorized();
    }
    let list = state.list.lock().unwrap().clone();
    Json(json!({ "result": true, "timestamp": 1_761_000_000, "list": list })).into_response()
}

/// Serves a configured archive to signed-in requests, or GDTF Share's error envelope.
async fn download(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    Query(query): Query<DownloadQuery>,
) -> Response {
    state.downloads.fetch_add(1, Ordering::SeqCst);
    if !state.signed_in(&headers) {
        return unauthorized();
    }
    match state.files.lock().unwrap().get(&query.rid) {
        Some(bytes) => bytes.clone().into_response(),
        None => Json(json!({ "result": false, "error": "File not found." })).into_response(),
    }
}

impl MockShare {
    /// Starts a mock API on a free loopback port for the rest of the test.
    ///
    /// Login accepts only [`valid_credentials`]. The list starts with one fixture and no
    /// archives are served until a test adds them.
    pub(crate) async fn start() -> Self {
        let state = Arc::new(MockState {
            list: Mutex::new(json!([list_entry(
                1,
                "mock-type",
                "Acme",
                "Spot",
                "1.0",
                &[]
            )])),
            ..MockState::default()
        });
        let router = Router::new()
            .route("/login.php", post(login))
            .route("/getList.php", get(list))
            .route("/downloadFile.php", get(download))
            .with_state(state.clone());
        Self::listen(router, state).await
    }

    /// Serves `router` on a free loopback port, for tests that need replies the mock
    /// API never gives.
    pub(crate) async fn serve(router: Router) -> Self {
        Self::listen(router, Arc::default()).await
    }

    /// Serves `router` on a free loopback port, recording requests in `state`.
    async fn listen(router: Router, state: Arc<MockState>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            base_url: format!("http://{address}"),
            state,
        }
    }

    /// Returns a client pointed at this mock API.
    pub(crate) fn client(&self) -> ShareClient {
        ShareClient::new(self.base_url.clone()).unwrap()
    }

    /// Returns how many login requests the mock API has answered.
    pub(crate) fn login_count(&self) -> usize {
        self.state.logins.load(Ordering::SeqCst)
    }

    /// Returns how many list requests the mock API has answered.
    pub(crate) fn list_count(&self) -> usize {
        self.state.lists.load(Ordering::SeqCst)
    }

    /// Returns how many download requests the mock API has answered.
    pub(crate) fn download_count(&self) -> usize {
        self.state.downloads.load(Ordering::SeqCst)
    }

    /// Replaces the fixture list entries the API serves.
    pub(crate) fn set_list(&self, entries: Value) {
        *self.state.list.lock().unwrap() = entries;
    }

    /// Serves `bytes` as the archive of revision `rid`.
    pub(crate) fn add_file(&self, rid: u32, bytes: Vec<u8>) {
        self.state.files.lock().unwrap().insert(rid, bytes);
    }

    /// Ends every open session, as GDTF Share does after two idle hours.
    pub(crate) fn expire_sessions(&self) {
        self.state.sessions.lock().unwrap().clear();
    }
}

/// One fixture list entry shaped like GDTF Share's, with the fields the engine reads.
pub(crate) fn list_entry(
    rid: u32,
    uuid: &str,
    manufacturer: &str,
    fixture: &str,
    revision: &str,
    modes: &[(&str, u32)],
) -> Value {
    json!({
        "rid": rid,
        "fixture": fixture,
        "manufacturer": manufacturer,
        "revision": revision,
        "creationDate": 1_700_000_000u64,
        "lastModified": 1_700_000_000u64 + u64::from(rid),
        "uploader": "User",
        "rating": "N/A",
        "version": "1.1",
        "creator": "Someone",
        "uuid": uuid,
        "filesize": 1024,
        "modes": modes
            .iter()
            .map(|(name, footprint)| json!({ "name": name, "dmxfootprint": footprint }))
            .collect::<Vec<_>>(),
    })
}
