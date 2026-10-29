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
use crate::testing::{MockShare, PASSWORD, USER};

/// The engine computer's own browser.
const LOCAL: &str = "127.0.0.1:5000";
/// A phone on the LAN talking to the engine directly.
const PHONE: &str = "192.168.1.20:5000";

/// Builds the routes around an account on the mock API and an in-memory keychain.
fn router(share: &MockShare) -> axum::Router {
    let store = keyring_core::mock::Store::new().unwrap();
    let keychain: VaultOpener = Arc::new(move || CredentialVault::with_store(store.clone()));
    test_router(Arc::new(GdtfShareAccount::with_parts(
        share.client(),
        keychain,
        None,
    )))
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
    let router = router(&share);

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
    let router = router(&share);
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
    let router = router(&share);
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
