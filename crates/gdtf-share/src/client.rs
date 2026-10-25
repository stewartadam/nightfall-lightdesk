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

use reqwest::StatusCode;
use reqwest::header::{CONTENT_TYPE, COOKIE, SET_COOKIE};
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
    /// GDTF Share no longer accepts the session, which it ends after two idle hours.
    #[error("The GDTF Share session expired")]
    SessionExpired,
    /// GDTF Share refused a signed-in request, with its own message.
    #[error("GDTF Share refused the request: {0}")]
    Refused(String),
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

    /// Fetches every revision GDTF Share lists, skipping entries the engine cannot read.
    ///
    /// A list with no readable entry is a protocol error rather than an empty library.
    pub async fn list(&self, session: &Session) -> Result<Vec<ShareEntry>, ShareError> {
        /// `getList.php` wraps the entries in the reply envelope; older replies were bare.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum ListReply {
            Wrapped { list: Vec<serde_json::Value> },
            Bare(Vec<serde_json::Value>),
        }

        let bytes = self.get(session, "getList.php").await?;
        let entries = match serde_json::from_slice(&bytes) {
            Ok(ListReply::Wrapped { list } | ListReply::Bare(list)) => list,
            Err(error) => return Err(ShareError::Protocol(format!("unreadable list: {error}"))),
        };
        let total = entries.len();
        let entries: Vec<ShareEntry> = entries
            .into_iter()
            .filter_map(|entry| serde_json::from_value(entry).ok())
            .collect();
        // GDTF Share lists thousands of fixtures, so an empty list means its format changed
        // or it failed; keeping the previous list beats replacing it with nothing.
        if entries.is_empty() {
            return Err(ShareError::Protocol(format!(
                "none of the {total} listed fixtures could be read"
            )));
        }
        if entries.len() < total {
            tracing::warn!(
                skipped = total - entries.len(),
                total,
                "Skipped unreadable GDTF Share list entries"
            );
        }
        Ok(entries)
    }

    /// Downloads the archive of one revision.
    pub async fn download(&self, session: &Session, rid: u32) -> Result<Vec<u8>, ShareError> {
        self.get(session, &format!("downloadFile.php?rid={rid}"))
            .await
    }

    /// Sends a signed-in `GET` for `path` and returns the reply body.
    ///
    /// GDTF Share reports failures as a small `{ result: false, error }` envelope, often
    /// with HTTP 200, so short JSON replies are checked for one before the body is used.
    async fn get(&self, session: &Session, path: &str) -> Result<Vec<u8>, ShareError> {
        let response = self
            .http
            .get(format!("{}/{path}", self.base_url))
            .header(COOKIE, session.cookie())
            .send()
            .await
            .map_err(|error| ShareError::Network(error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ShareError::Network(error.to_string()))?;
        if status == StatusCode::UNAUTHORIZED {
            return Err(ShareError::SessionExpired);
        }
        if bytes.len() <= MAX_ERROR_REPLY
            && bytes.first() == Some(&b'{')
            && let Ok(ApiReply {
                result: false,
                error,
            }) = serde_json::from_slice(&bytes)
        {
            let message = error.unwrap_or_else(|| format!("HTTP {status}"));
            // GDTF Share answers `Unauthorized.` to requests whose session it ended.
            let expired = message
                .trim()
                .trim_end_matches('.')
                .eq_ignore_ascii_case("unauthorized");
            return Err(if expired {
                ShareError::SessionExpired
            } else {
                ShareError::Refused(message)
            });
        }
        if !status.is_success() {
            return Err(ShareError::Protocol(format!(
                "{path} answered HTTP {status}"
            )));
        }
        Ok(bytes.to_vec())
    }
}

/// Longest reply checked for an error envelope; real errors are a few dozen bytes.
const MAX_ERROR_REPLY: usize = 4096;

/// One revision as `getList.php` lists it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareEntry {
    /// Revision id, which downloads name.
    pub rid: u32,
    /// GDTF fixture type id, shared by every revision of a fixture type.
    #[serde(default)]
    pub uuid: Option<String>,
    /// Manufacturer name.
    #[serde(default)]
    pub manufacturer: String,
    /// Fixture name.
    #[serde(default)]
    pub fixture: String,
    /// Revision text the uploader gave.
    #[serde(default)]
    pub revision: String,
    /// When the revision was last changed, in Unix seconds.
    #[serde(default)]
    pub last_modified: u64,
    /// `Manuf.` for manufacturer uploads, `User` for everyone else.
    #[serde(default)]
    pub uploader: String,
    /// Average rating out of 5 as text, or `N/A`.
    #[serde(default)]
    pub rating: serde_json::Value,
    /// Archive size in bytes.
    #[serde(default)]
    pub filesize: u64,
    /// DMX modes.
    #[serde(default)]
    pub modes: Vec<ShareMode>,
}

/// One DMX mode of a listed revision.
#[derive(Debug, Clone, Deserialize)]
pub struct ShareMode {
    /// Mode name.
    pub name: String,
    /// DMX channels the mode uses.
    #[serde(default)]
    pub dmxfootprint: u32,
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
