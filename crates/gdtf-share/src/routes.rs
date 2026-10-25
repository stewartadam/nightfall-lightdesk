// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for the GDTF Share account.
//!
//! `GET /api/gdtf-share/account` reads the status, `POST` to it signs in with a JSON
//! `{ user, password }` body, and `POST /api/gdtf-share/account/sign-out` signs out. Both
//! changes use `POST` so they pass the backend's CORS method list from the desktop shell.
//! Changes are limited to the computer running Nightfall: the password never crosses the
//! network to the engine, and another device cannot remove an account it cannot restore.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode, Uri},
    routing::{get, post},
};
use nightfall_websocket::prelude::{HttpRouteRegistry, is_local_client};

use crate::account::{AccountError, GdtfShareAccount, GdtfShareAccountStatus};
use crate::client::ShareError;
use crate::credentials::Credentials;

/// Path of the account resource; `GET` reads it and `POST` signs in.
const ACCOUNT_PATH: &str = "/api/gdtf-share/account";
/// Path that signs the account out.
const SIGN_OUT_PATH: &str = "/api/gdtf-share/account/sign-out";

/// A failed request: its status code and a message the UI shows as is.
type RouteError = (StatusCode, String);

/// Registers the GDTF Share account routes against the real GDTF Share API.
pub fn register_routes(registry: &mut HttpRouteRegistry) {
    match GdtfShareAccount::new() {
        Ok(account) => {
            let account = Arc::new(account);
            registry.register(ACCOUNT_PATH, account_routes(account.clone()));
            registry.register(SIGN_OUT_PATH, sign_out_routes(account));
        }
        Err(error) => tracing::error!(%error, "GDTF Share is unavailable"),
    }
}

/// Builds the status and sign-in routes around `account`.
fn account_routes(account: Arc<GdtfShareAccount>) -> axum::routing::MethodRouter {
    get(status).post(sign_in).with_state(account)
}

/// Builds the sign-out route around `account`.
fn sign_out_routes(account: Arc<GdtfShareAccount>) -> axum::routing::MethodRouter {
    post(sign_out).with_state(account)
}

/// Maps an account failure to the status code and message clients receive.
fn route_error(error: AccountError) -> RouteError {
    let status = match &error {
        AccountError::Share(ShareError::Rejected(_)) => StatusCode::UNPROCESSABLE_ENTITY,
        AccountError::Share(_) => StatusCode::BAD_GATEWAY,
        AccountError::ManagedByEnvironment => StatusCode::CONFLICT,
        AccountError::Keychain(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}

/// Refuses account changes from other devices, including ones relayed by a local proxy.
fn require_local(peer: SocketAddr, headers: &HeaderMap, uri: &Uri) -> Result<(), RouteError> {
    if is_local_client(Some(peer), headers, uri) {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        "Change the GDTF Share account on the computer running Nightfall.".to_string(),
    ))
}

/// Returns the account status without contacting GDTF Share.
async fn status(State(account): State<Arc<GdtfShareAccount>>) -> Json<GdtfShareAccountStatus> {
    Json(account.status().await)
}

/// Signs in with the posted credentials, for requests from the computer running Nightfall.
async fn sign_in(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    State(account): State<Arc<GdtfShareAccount>>,
    Json(credentials): Json<Credentials>,
) -> Result<Json<GdtfShareAccountStatus>, RouteError> {
    require_local(peer, &headers, &uri)?;
    let credentials = Credentials {
        user: credentials.user.trim().to_string(),
        password: credentials.password,
    };
    if credentials.user.is_empty() || credentials.password.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "Enter your GDTF Share username and password.".to_string(),
        ));
    }
    account
        .sign_in(credentials)
        .await
        .map(Json)
        .map_err(route_error)
}

/// Signs out and forgets the saved account, for requests from the computer running Nightfall.
async fn sign_out(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    State(account): State<Arc<GdtfShareAccount>>,
) -> Result<Json<GdtfShareAccountStatus>, RouteError> {
    require_local(peer, &headers, &uri)?;
    account.sign_out().await.map(Json).map_err(route_error)
}

/// Wraps the account routes in a router, for tests that call them directly.
#[cfg(test)]
pub(crate) fn test_router(account: Arc<GdtfShareAccount>) -> axum::Router {
    axum::Router::new()
        .route(ACCOUNT_PATH, account_routes(account.clone()))
        .route(SIGN_OUT_PATH, sign_out_routes(account))
}

#[cfg(test)]
mod tests;
