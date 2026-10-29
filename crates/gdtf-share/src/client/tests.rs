// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use axum::{Router, http::StatusCode, routing::post};

use super::*;
use crate::testing::{COOKIE, MockShare, gdtf_archive, list_entry, valid_credentials};

/// A successful login returns the session cookie without its attributes.
#[tokio::test]
async fn login_returns_the_session_cookie() {
    let share = MockShare::start().await;
    let session = share.client().login(&valid_credentials()).await.unwrap();
    assert_eq!(session.cookie(), format!("{COOKIE}-1"));
    assert!(!format!("{session:?}").contains("mock-session"));
}

/// A refused login carries GDTF Share's own error message.
#[tokio::test]
async fn refused_login_keeps_the_share_message() {
    let share = MockShare::start().await;
    let wrong = Credentials {
        password: "wrong".into(),
        ..valid_credentials()
    };
    let error = share.client().login(&wrong).await.unwrap_err();
    assert!(
        matches!(&error, ShareError::Rejected(message) if message == "Wrong username or password."),
        "{error:?}"
    );
}

/// A reply that is not the API's JSON envelope is a protocol error, not a refusal.
#[tokio::test]
async fn non_json_reply_is_a_protocol_error() {
    let router = Router::new().route(
        "/login.php",
        post(|| async { (StatusCode::SERVICE_UNAVAILABLE, "<html>maintenance</html>") }),
    );
    let share = MockShare::serve(router).await;
    let error = share
        .client()
        .login(&valid_credentials())
        .await
        .unwrap_err();
    assert!(matches!(error, ShareError::Protocol(_)), "{error:?}");
}

/// A successful login that sets no cookie cannot authenticate later requests.
#[tokio::test]
async fn login_without_cookie_is_a_protocol_error() {
    let router = Router::new().route(
        "/login.php",
        post(|| async { axum::Json(serde_json::json!({ "result": true })) }),
    );
    let share = MockShare::serve(router).await;
    let error = share
        .client()
        .login(&valid_credentials())
        .await
        .unwrap_err();
    assert!(matches!(error, ShareError::Protocol(_)), "{error:?}");
}

/// An unreachable server is a network error.
#[tokio::test]
async fn unreachable_server_is_a_network_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let client = ShareClient::new(format!("http://{address}")).unwrap();
    let error = client.login(&valid_credentials()).await.unwrap_err();
    assert!(matches!(error, ShareError::Network(_)), "{error:?}");
}

/// Every `Set-Cookie` header contributes its `name=value` pair to the session cookie.
#[test]
fn session_cookie_joins_every_cookie_pair() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.append(
        SET_COOKIE,
        "PHPSESSID=one; path=/; HttpOnly".parse().unwrap(),
    );
    headers.append(SET_COOKIE, "lang=en".parse().unwrap());
    assert_eq!(
        session_cookie(&headers).as_deref(),
        Some("PHPSESSID=one; lang=en")
    );
    assert_eq!(session_cookie(&reqwest::header::HeaderMap::new()), None);
}

/// A session that is not the mock API's own, as left behind by an expired login.
fn stale_session() -> Session {
    Session {
        cookie: format!("{COOKIE}-stale"),
    }
}

/// The list is read from the reply envelope, skipping entries the engine cannot read.
#[tokio::test]
async fn list_skips_unreadable_entries() {
    let share = MockShare::start().await;
    share.set_list(serde_json::json!([
        list_entry(1, "id", "Acme", "Spot", "1.0", &[("Basic", 8)]),
        { "fixture": "no revision id" },
    ]));
    let client = share.client();
    let session = client.login(&valid_credentials()).await.unwrap();
    let entries = client.list(&session).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].modes[0].dmxfootprint, 8);
}

/// GDTF Share's `Unauthorized.` envelope is an expired session; other envelopes keep
/// their message.
#[tokio::test]
async fn error_envelopes_are_told_apart() {
    let share = MockShare::start().await;
    let client = share.client();
    let error = client.list(&stale_session()).await.unwrap_err();
    assert!(matches!(error, ShareError::SessionExpired), "{error:?}");

    let session = client.login(&valid_credentials()).await.unwrap();
    let error = client.download(&session, 5, &|_, _| {}).await.unwrap_err();
    assert!(
        matches!(&error, ShareError::Refused(message) if message == "File not found."),
        "{error:?}"
    );
}

/// A download returns the archive bytes unchanged, reporting progress up to the
/// announced length.
#[tokio::test]
async fn download_returns_the_archive() {
    let share = MockShare::start().await;
    share.add_file(3, gdtf_archive("Spot"));
    let client = share.client();
    let session = client.login(&valid_credentials()).await.unwrap();
    let reports = std::sync::Mutex::new(Vec::new());
    let bytes = client
        .download(&session, 3, &|received, length| {
            reports.lock().unwrap().push((received, length));
        })
        .await
        .unwrap();
    assert_eq!(bytes, gdtf_archive("Spot"));
    let size = bytes.len() as u64;
    assert_eq!(
        reports.into_inner().unwrap().last(),
        Some(&(size, Some(size)))
    );
}
