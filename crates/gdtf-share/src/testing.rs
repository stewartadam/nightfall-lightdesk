// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! A local stand-in for the GDTF Share API, so tests never contact the real site.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode, header::SET_COOKIE},
    response::IntoResponse,
    routing::post,
};
use serde_json::{Value, json};

use crate::client::ShareClient;
use crate::credentials::Credentials;

/// Username the mock API accepts.
pub(crate) const USER: &str = "lighting@example.com";
/// Password the mock API accepts.
pub(crate) const PASSWORD: &str = "correct horse";
/// Session cookie the mock API sets on a successful login.
pub(crate) const COOKIE: &str = "PHPSESSID=mock-session";

/// Returns the credentials the mock API accepts.
pub(crate) fn valid_credentials() -> Credentials {
    Credentials {
        user: USER.into(),
        password: PASSWORD.into(),
    }
}

/// A running mock API and how many logins it has answered.
pub(crate) struct MockShare {
    /// Base URL to give [`ShareClient::new`].
    pub(crate) base_url: String,
    /// Login requests received so far.
    pub(crate) logins: Arc<AtomicUsize>,
}

impl MockShare {
    /// Starts a mock API on a free loopback port for the rest of the test.
    ///
    /// Login accepts only [`valid_credentials`], answering like GDTF Share: HTTP 200 with
    /// `result: false` and an error message for anything else.
    pub(crate) async fn start() -> Self {
        let logins = Arc::new(AtomicUsize::new(0));
        let counter = logins.clone();
        let router = Router::new().route(
            "/login.php",
            post(move |Json(body): Json<Value>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    if body["user"] == USER && body["password"] == PASSWORD {
                        let mut headers = HeaderMap::new();
                        headers.insert(SET_COOKIE, format!("{COOKIE}; path=/").parse().unwrap());
                        (
                            StatusCode::OK,
                            headers,
                            Json(json!({ "result": true, "notice": "Logged in." })),
                        )
                            .into_response()
                    } else {
                        Json(json!({ "result": false, "error": "Wrong username or password." }))
                            .into_response()
                    }
                }
            }),
        );
        Self::serve(router, logins).await
    }

    /// Serves `router` on a free loopback port.
    pub(crate) async fn serve(router: Router, logins: Arc<AtomicUsize>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            base_url: format!("http://{address}"),
            logins,
        }
    }

    /// Returns a client pointed at this mock API.
    pub(crate) fn client(&self) -> ShareClient {
        ShareClient::new(self.base_url.clone()).unwrap()
    }

    /// Returns how many login requests the mock API has answered.
    pub(crate) fn login_count(&self) -> usize {
        self.logins.load(Ordering::SeqCst)
    }
}
