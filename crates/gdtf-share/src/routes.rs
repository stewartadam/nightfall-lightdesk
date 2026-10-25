// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP routes for the GDTF Share account, fixture search and installs.
//!
//! `GET /api/gdtf-share/account` reads the status, `POST` to it signs in with a JSON
//! `{ user, password }` body, and `POST /api/gdtf-share/account/sign-out` signs out. Both
//! changes use `POST` so they pass the backend's CORS method list from the desktop shell.
//! Account changes are limited to the computer running Nightfall: the password never
//! crosses the network to the engine, and another device cannot remove an account it
//! cannot restore.
//!
//! `GET /api/gdtf-share/fixtures?query=&offset=&limit=` searches the saved fixture list,
//! `POST /api/gdtf-share/fixtures/refresh` fetches it again, and
//! `POST /api/gdtf-share/fixtures/{rid}/install` downloads a revision into the fixture
//! library. Any paired device may search and install, as it may upload fixtures.

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode, Uri},
    routing::{get, post},
};
use nightfall_websocket::prelude::{HttpRouteRegistry, is_local_client};
use serde::Deserialize;

use crate::account::{AccountError, GdtfShareAccount, GdtfShareAccountStatus};
use crate::catalog::{GdtfShareCatalog, GdtfShareSearchResults};
use crate::client::ShareError;
use crate::credentials::Credentials;
use crate::install::{GdtfShareInstall, install};

/// Path of the account resource; `GET` reads it and `POST` signs in.
const ACCOUNT_PATH: &str = "/api/gdtf-share/account";
/// Path that signs the account out.
const SIGN_OUT_PATH: &str = "/api/gdtf-share/account/sign-out";
/// Path that searches the fixture list.
const FIXTURES_PATH: &str = "/api/gdtf-share/fixtures";
/// Path that fetches the fixture list again.
const REFRESH_PATH: &str = "/api/gdtf-share/fixtures/refresh";
/// Path that installs one revision into the fixture library.
const INSTALL_PATH: &str = "/api/gdtf-share/fixtures/{rid}/install";

/// Results per page when a search names no limit.
const DEFAULT_PAGE: usize = 50;

/// A failed request: its status code and a message the UI shows as is.
type RouteError = (StatusCode, String);

/// Where GDTF Share data lives on the computer running Nightfall.
pub struct GdtfShareFolders {
    /// The saved fixture list.
    pub catalog_file: PathBuf,
    /// The fixture library folder installs are saved in.
    pub library_dir: PathBuf,
}

/// Everything the routes share.
#[derive(Clone)]
pub(crate) struct GdtfShare {
    pub(crate) account: Arc<GdtfShareAccount>,
    pub(crate) catalog: Arc<GdtfShareCatalog>,
    pub(crate) library_dir: Arc<PathBuf>,
}

impl GdtfShare {
    /// Assembles the route state around `account` and the folders in `folders`.
    pub(crate) fn new(account: GdtfShareAccount, folders: GdtfShareFolders) -> Self {
        Self {
            account: Arc::new(account),
            catalog: Arc::new(GdtfShareCatalog::new(folders.catalog_file)),
            library_dir: Arc::new(folders.library_dir),
        }
    }
}

/// Registers the GDTF Share routes against the real GDTF Share API.
pub fn register_routes(registry: &mut HttpRouteRegistry, folders: GdtfShareFolders) {
    match GdtfShareAccount::new() {
        Ok(account) => {
            for (path, routes) in routes(GdtfShare::new(account, folders)) {
                registry.register(path, routes);
            }
        }
        Err(error) => tracing::error!(%error, "GDTF Share is unavailable"),
    }
}

/// Builds every route around `share`, keyed by path.
fn routes(share: GdtfShare) -> [(&'static str, axum::routing::MethodRouter); 5] {
    [
        (
            ACCOUNT_PATH,
            get(status).post(sign_in).with_state(share.clone()),
        ),
        (SIGN_OUT_PATH, post(sign_out).with_state(share.clone())),
        (FIXTURES_PATH, get(search).with_state(share.clone())),
        (REFRESH_PATH, post(refresh).with_state(share.clone())),
        (INSTALL_PATH, post(install_fixture).with_state(share)),
    ]
}

/// Maps an account failure to the status code and message clients receive.
fn route_error(error: AccountError) -> RouteError {
    let status = match &error {
        AccountError::Share(ShareError::Rejected(_)) => StatusCode::UNPROCESSABLE_ENTITY,
        AccountError::Share(_) => StatusCode::BAD_GATEWAY,
        AccountError::ManagedByEnvironment => StatusCode::CONFLICT,
        AccountError::SignedOut => StatusCode::PRECONDITION_REQUIRED,
        AccountError::Keychain(_) | AccountError::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
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
async fn status(State(share): State<GdtfShare>) -> Json<GdtfShareAccountStatus> {
    Json(share.account.status().await)
}

/// Signs in with the posted credentials, for requests from the computer running Nightfall.
async fn sign_in(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    State(share): State<GdtfShare>,
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
    share
        .account
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
    State(share): State<GdtfShare>,
) -> Result<Json<GdtfShareAccountStatus>, RouteError> {
    require_local(peer, &headers, &uri)?;
    share
        .account
        .sign_out()
        .await
        .map(Json)
        .map_err(route_error)
}

/// Query parameters of a search.
#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    query: String,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

/// Searches the saved fixture list, fetching it first when there is none.
///
/// A list older than a day is searched as is while a newer one is fetched in the
/// background. Searching needs a signed-in account even when a list is saved.
async fn search(
    State(share): State<GdtfShare>,
    Query(params): Query<SearchParams>,
) -> Result<Json<GdtfShareSearchResults>, RouteError> {
    if !share.account.is_signed_in().await {
        return Err(route_error(AccountError::SignedOut));
    }
    let (catalog, stale) = share
        .catalog
        .for_search(&share.account)
        .await
        .map_err(route_error)?;
    if stale {
        share
            .catalog
            .refresh_in_background(share.account.clone(), catalog.fetched_at());
    }
    let limit = params.limit.unwrap_or(DEFAULT_PAGE);
    let results =
        tokio::task::spawn_blocking(move || catalog.search(&params.query, params.offset, limit))
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(results))
}

/// Fetches the fixture list again now, and returns its size and fetch time.
async fn refresh(
    State(share): State<GdtfShare>,
) -> Result<Json<GdtfShareSearchResults>, RouteError> {
    let older_than = share
        .catalog
        .current()
        .await
        .map_or(0, |catalog| catalog.fetched_at());
    let catalog = share
        .catalog
        .fetch(&share.account, Some(older_than))
        .await
        .map_err(route_error)?;
    Ok(Json(catalog.summary()))
}

/// Downloads revision `rid` into the fixture library.
async fn install_fixture(
    State(share): State<GdtfShare>,
    Path(rid): Path<u32>,
) -> Result<Json<GdtfShareInstall>, RouteError> {
    let fixture = share
        .catalog
        .current()
        .await
        .and_then(|catalog| catalog.revision(rid).cloned())
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "This fixture is not in the GDTF Share list; search again to refresh it."
                    .to_string(),
            )
        })?;
    install(&share.account, &share.library_dir, &fixture)
        .await
        .map(Json)
        .map_err(route_error)
}

/// Wraps every route in a router, for tests that call them directly.
#[cfg(test)]
pub(crate) fn test_router(share: GdtfShare) -> axum::Router {
    routes(share)
        .into_iter()
        .fold(axum::Router::new(), |router, (path, routes)| {
            router.route(path, routes)
        })
}

#[cfg(test)]
mod tests;
