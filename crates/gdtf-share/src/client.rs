// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Minimal client for the GDTF Share public API.
//!
//! The API keeps a login in a session cookie that later requests replay. Cookies are
//! handled by hand rather than through a cookie store, since the API only ever sets the
//! one session cookie.

use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, SET_COOKIE};
use serde::Deserialize;

use crate::credentials::Credentials;

/// Base URL of the GDTF Share public API.
pub const API_BASE_URL: &str = "https://gdtf-share.com/apis/public";

/// Why a GDTF Share request failed.
#[derive(Debug, thiserror::Error)]
pub enum ShareError {
    /// GDTF Share refused the username and password.
    #[error("GDTF Share did not accept the username and password: {0}")]
    Rejected(String),
    /// The request never got an answer from GDTF Share.
    #[error("Could not reach GDTF Share: {0}")]
    Network(String),
    /// GDTF Share answered with something the client does not understand.
    #[error("GDTF Share sent an unexpected response: {0}")]
    Protocol(String),
}

/// A signed-in GDTF Share session, carried by its session cookie.
#[derive(Clone)]
pub struct Session {
    cookie: String,
}

impl Session {
    /// Returns the `Cookie` header value that authenticates later requests.
    pub fn cookie(&self) -> &str {
        &self.cookie
    }
}

impl std::fmt::Debug for Session {
    /// Hides the cookie, which grants account access until the session expires.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Session").finish_non_exhaustive()
    }
}

/// The `{ result, error }` envelope every GDTF Share API reply uses.
#[derive(Deserialize)]
struct ApiReply {
    result: bool,
    #[serde(default)]
    error: Option<String>,
}

/// Sends GDTF Share API requests to one base URL.
#[derive(Clone)]
pub struct ShareClient {
    http: reqwest::Client,
    base_url: String,
}

impl ShareClient {
    /// Builds a client for the API at `base_url`, which tests point at a local server.
    pub fn new(base_url: impl Into<String>) -> Result<Self, ShareError> {
        let base_url = base_url.into();
        let http = reqwest::Client::builder()
            .https_only(base_url.starts_with("https:"))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| ShareError::Network(error.to_string()))?;
        Ok(Self { http, base_url })
    }

    /// Logs in with `credentials` and returns the session GDTF Share opened.
    ///
    /// A refusal from GDTF Share is [`ShareError::Rejected`] with its own message, so the
    /// user can tell a wrong password from a network problem.
    pub async fn login(&self, credentials: &Credentials) -> Result<Session, ShareError> {
        let body = serde_json::json!({
            "user": credentials.user,
            "password": credentials.password,
        });
        let response = self
            .http
            .post(format!("{}/login.php", self.base_url))
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|error| ShareError::Network(error.to_string()))?;
        let status = response.status();
        let cookie = session_cookie(response.headers());
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ShareError::Network(error.to_string()))?;
        let reply: ApiReply = serde_json::from_slice(&bytes)
            .map_err(|_| ShareError::Protocol(format!("login answered HTTP {status}")))?;
        if !reply.result {
            return Err(ShareError::Rejected(
                reply
                    .error
                    .unwrap_or_else(|| format!("login answered HTTP {status}")),
            ));
        }
        if !status.is_success() {
            return Err(ShareError::Protocol(format!(
                "login answered HTTP {status}"
            )));
        }
        cookie
            .map(|cookie| Session { cookie })
            .ok_or_else(|| ShareError::Protocol("login set no session cookie".into()))
    }
}

/// Joins the `name=value` part of every `Set-Cookie` header into one `Cookie` value.
fn session_cookie(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let cookies: Vec<&str> = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(str::trim)
        .filter(|pair| !pair.is_empty())
        .collect();
    (!cookies.is_empty()).then(|| cookies.join("; "))
}

#[cfg(test)]
mod tests;
