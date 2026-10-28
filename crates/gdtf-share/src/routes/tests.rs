// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use axum::{
    body::{Body, to_bytes},
    http::{Method, Request},
};
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::account::VaultOpener;
use crate::credentials::CredentialVault;
use crate::testing::{MockShare, PASSWORD, USER, gdtf_archive, list_entry};

/// The engine computer's own browser.
const LOCAL: &str = "127.0.0.1:5000";
/// A phone on the LAN talking to the engine directly.
const PHONE: &str = "192.168.1.20:5000";

/// Builds the routes around an account on the mock API, an in-memory keychain and a
/// temporary data folder, which lives as long as the returned guard.
fn router(share: &MockShare) -> (axum::Router, tempfile::TempDir) {
    let store = keyring_core::mock::Store::new().unwrap();
    let keychain: VaultOpener = Arc::new(move || CredentialVault::with_store(store.clone()));
    let data = tempfile::tempdir().unwrap();
    let router = test_router(GdtfShare::new(
        GdtfShareAccount::with_parts(share.client(), keychain, None),
        GdtfShareFolders {
            catalog_file: data.path().join("catalog.json"),
            library_dir: data.path().join("fixtures"),
        },
    ));
    (router, data)
}

/// Builds the routes and signs in from the computer running Nightfall.
async fn signed_in_router(share: &MockShare) -> (axum::Router, tempfile::TempDir) {
    let (router, data) = router(share);
    let (status, body) = Call::new(Method::POST, ACCOUNT_PATH, LOCAL)
        .body(credentials_body())
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (router, data)
}

/// One request to the account routes.
struct Call<'a> {
    method: Method,
    path: &'a str,
    peer: &'a str,
    forwarded_host: Option<&'a str>,
    body: Option<Value>,
}

impl<'a> Call<'a> {
    /// A request from `peer` with no body and no proxy headers.
    fn new(method: Method, path: &'a str, peer: &'a str) -> Self {
        Self {
            method,
            path,
            peer,
            forwarded_host: None,
            body: None,
        }
    }

    /// Adds a JSON body.
    fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    /// Marks the request as relayed by a local proxy for the browser that addressed `host`.
    fn forwarded_for(mut self, host: &'a str) -> Self {
        self.forwarded_host = Some(host);
        self
    }

    /// Sends the request, returning the status and body text.
    async fn send(self, router: &axum::Router) -> (StatusCode, String) {
        let mut builder = Request::builder()
            .method(self.method)
            .uri(self.path)
            .header("content-type", "application/json");
        if let Some(host) = self.forwarded_host {
            builder = builder.header("x-forwarded-host", host);
        }
        let mut request = builder
            .body(
                self.body
                    .map_or_else(Body::empty, |body| Body::from(body.to_string())),
            )
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(self.peer.parse::<SocketAddr>().unwrap()));
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }
}

/// Returns valid credentials as a request body, with padding the route trims.
fn credentials_body() -> Value {
    json!({ "user": format!("  {USER} "), "password": PASSWORD })
}

/// Signing in locally, reading the status from another device and signing out round-trip.
#[tokio::test]
async fn local_sign_in_status_and_sign_out() {
    let share = MockShare::start().await;
    let (router, _data) = router(&share);

    let (status, body) = Call::new(Method::POST, ACCOUNT_PATH, LOCAL)
        .body(credentials_body())
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let signed_in: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(signed_in["user"], USER);
    assert_eq!(signed_in["source"], "keychain");
    assert_eq!(signed_in["keychain_available"], true);

    let (status, body) = Call::new(Method::GET, ACCOUNT_PATH, PHONE)
        .send(&router)
        .await;
    assert_eq!(
        (status, serde_json::from_str::<Value>(&body).unwrap()),
        (StatusCode::OK, signed_in)
    );

    let (status, body) = Call::new(Method::POST, SIGN_OUT_PATH, LOCAL)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["user"],
        Value::Null
    );
}

/// Other devices cannot change the account, whether direct or relayed by a local proxy.
#[tokio::test]
async fn remote_changes_are_forbidden() {
    let share = MockShare::start().await;
    let (router, _data) = router(&share);
    let direct = Call::new(Method::POST, ACCOUNT_PATH, PHONE).body(credentials_body());
    assert_eq!(direct.send(&router).await.0, StatusCode::FORBIDDEN);
    let proxied = Call::new(Method::POST, ACCOUNT_PATH, LOCAL)
        .forwarded_for("192.168.1.10:5173")
        .body(credentials_body());
    assert_eq!(proxied.send(&router).await.0, StatusCode::FORBIDDEN);
    let sign_out = Call::new(Method::POST, SIGN_OUT_PATH, PHONE);
    assert_eq!(sign_out.send(&router).await.0, StatusCode::FORBIDDEN);
    assert_eq!(share.login_count(), 0);
}

/// Wrong or missing credentials answer 422 with a message the UI can show.
#[tokio::test]
async fn rejected_credentials_answer_unprocessable() {
    let share = MockShare::start().await;
    let (router, _data) = router(&share);
    let (status, body) = Call::new(Method::POST, ACCOUNT_PATH, LOCAL)
        .body(json!({ "user": USER, "password": "wrong" }))
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.contains("Wrong username or password."), "{body}");

    let (status, _) = Call::new(Method::POST, ACCOUNT_PATH, LOCAL)
        .body(json!({ "user": " ", "password": PASSWORD }))
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(share.login_count(), 1);
}

/// Serves two fixture types on the mock API, one with an older and a newer revision.
fn list_fixtures(share: &MockShare) {
    share.set_list(json!([
        list_entry(10, TYPE_A, "Robe", "Spiider", "Old", &[("Mode 1", 30)]),
        list_entry(11, TYPE_A, "Robe", "Spiider", "New", &[("Mode 1", 30)]),
        list_entry(20, TYPE_B, "Martin", "MAC Aura", "1.0", &[("Standard", 14)]),
    ]));
}

/// Fixture type id of the listed Spiider, in capitals to check ids are normalized.
const TYPE_A: &str = "4A3B1E36-0000-4000-8000-000000000001";
/// Fixture type id of the listed MAC Aura.
const TYPE_B: &str = "4a3b1e36-0000-4000-8000-000000000002";

/// Searching needs a signed-in account and never contacts GDTF Share without one.
#[tokio::test]
async fn search_needs_a_signed_in_account() {
    let share = MockShare::start().await;
    let (router, _data) = router(&share);
    let (status, body) = Call::new(Method::GET, FIXTURES_PATH, PHONE)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
    assert!(body.contains("Sign in to GDTF Share"), "{body}");
    assert_eq!(share.list_count(), 0);
}

/// The first search fetches the list with the sign-in's session; later searches, from any
/// device, reuse the saved list.
#[tokio::test]
async fn search_fetches_the_list_once_and_returns_every_match() {
    let share = MockShare::start().await;
    list_fixtures(&share);
    let (router, _data) = signed_in_router(&share).await;

    let (status, body) = Call::new(Method::GET, "/api/gdtf-share/fixtures?query=spi", PHONE)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let results: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(results["total"], 1);
    assert_eq!(results["fixtures"][0]["rid"], 11);
    assert_eq!(
        results["fixtures"][0]["fixture_type_id"],
        TYPE_A.to_ascii_lowercase()
    );
    assert_eq!(results["fixtures"][0]["modes"][0]["footprint"], 30);

    let (_, body) = Call::new(Method::GET, FIXTURES_PATH, PHONE)
        .send(&router)
        .await;
    let all: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(all["total"], 2);
    assert_eq!(all["fixtures"].as_array().unwrap().len(), 2);
    assert_eq!(all["fixtures"][1]["manufacturer"], "Robe");
    assert_eq!((share.login_count(), share.list_count()), (1, 1));
}

/// Refreshing fetches the list again even when the saved one is fresh, and an empty
/// reply keeps the saved list instead of replacing it with nothing.
#[tokio::test]
async fn refresh_fetches_the_list_again() {
    let share = MockShare::start().await;
    list_fixtures(&share);
    let (router, _data) = signed_in_router(&share).await;
    Call::new(Method::GET, FIXTURES_PATH, LOCAL)
        .send(&router)
        .await;
    share.set_list(json!([list_entry(
        30,
        TYPE_B,
        "Martin",
        "MAC Aura",
        "2.0",
        &[]
    )]));
    let (status, body) = Call::new(Method::POST, REFRESH_PATH, LOCAL)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["total"], 1);

    share.set_list(json!([]));
    let (status, _) = Call::new(Method::POST, REFRESH_PATH, LOCAL)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let (_, body) = Call::new(Method::GET, FIXTURES_PATH, LOCAL)
        .send(&router)
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["fixtures"][0]["rid"],
        30
    );
    assert_eq!(share.list_count(), 3);
}

/// Parses an install reply's newline-delimited events.
fn install_events(body: &str) -> Vec<Value> {
    body.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// Installing streams the download's progress, saves the archive in the library folder
/// under GDTF Share's file name, and logs in again once when the session has expired.
#[tokio::test]
async fn install_saves_the_archive_after_logging_in_again() {
    let share = MockShare::start().await;
    list_fixtures(&share);
    share.add_file(20, gdtf_archive("MAC Aura"));
    let (router, data) = signed_in_router(&share).await;
    Call::new(Method::GET, FIXTURES_PATH, LOCAL)
        .send(&router)
        .await;
    share.expire_sessions();

    let (status, body) = Call::new(Method::POST, "/api/gdtf-share/fixtures/20/install", PHONE)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let events = install_events(&body);
    let (last, progress) = events.split_last().unwrap();
    assert_eq!(last["type"], "Installed", "{body}");
    assert_eq!(last["data"]["file_name"], "Martin@MAC_Aura@1.0@20.gdtf");
    let size = gdtf_archive("MAC Aura").len();
    assert_eq!(progress.last().unwrap()["type"], "Progress");
    assert_eq!(progress.last().unwrap()["data"]["received"], size);
    assert_eq!(progress.last().unwrap()["data"]["total"], size);
    let saved = std::fs::read(data.path().join("fixtures/Martin@MAC_Aura@1.0@20.gdtf")).unwrap();
    assert_eq!(saved, gdtf_archive("MAC Aura"));
    assert_eq!((share.login_count(), share.download_count()), (2, 2));
}

/// A revision missing from the saved list cannot be installed, and nothing is downloaded.
#[tokio::test]
async fn install_of_an_unlisted_revision_is_not_found() {
    let share = MockShare::start().await;
    list_fixtures(&share);
    let (router, _data) = signed_in_router(&share).await;
    Call::new(Method::GET, FIXTURES_PATH, LOCAL)
        .send(&router)
        .await;
    let (status, _) = Call::new(Method::POST, "/api/gdtf-share/fixtures/99/install", LOCAL)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(share.download_count(), 0);
}

/// A download GDTF Share refuses ends the stream with a failure line, and nothing is saved.
#[tokio::test]
async fn install_failure_ends_the_stream() {
    let share = MockShare::start().await;
    list_fixtures(&share);
    let (router, data) = signed_in_router(&share).await;
    Call::new(Method::GET, FIXTURES_PATH, LOCAL)
        .send(&router)
        .await;
    let (status, body) = Call::new(Method::POST, "/api/gdtf-share/fixtures/20/install", LOCAL)
        .send(&router)
        .await;
    assert_eq!(status, StatusCode::OK);
    let last = install_events(&body).pop().unwrap();
    assert_eq!(last["type"], "Failed", "{body}");
    assert_eq!(last["data"]["signed_out"], false);
    assert!(
        !data
            .path()
            .join("fixtures/Martin@MAC_Aura@1.0@20.gdtf")
            .exists()
    );
}
