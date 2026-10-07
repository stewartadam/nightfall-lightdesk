// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Pairing PIN that devices on the network must enter before they may control the backend.
//!
//! The engine picks a six-digit PIN at startup and keeps it for the whole app session, so a
//! phone that drops off Wi-Fi reconnects without being asked again. A correct PIN earns the
//! browser a random session token in an `HttpOnly` cookie, which it then sends with every
//! request and websocket upgrade on its own. Tokens live only in memory: restarting the app
//! or regenerating the PIN signs every device out.
//!
//! Browsers on the operator's own computer never need the PIN; devices relayed by a local
//! dev proxy still do (see [`crate::origin::is_local_client`]). Static web UI
//! files stay public so a new device can load the page that asks for it; `/ws` and every
//! `/api` route except the pairing endpoint require a token. Plain HTTP exposes the PIN and
//! token to anyone watching the network, so this guards a trusted LAN against casual use,
//! not a hostile one.

use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use nightfall_io::{RemotePairingAttempt, RemotePairingPin, RemotePairingStatus};

use crate::{origin::is_local_client, websocket::AxumAppState};

/// Endpoint a device uses to learn whether it must pair and to submit the PIN.
pub(crate) const PAIRING_PATH: &str = "/api/pairing";

/// Loopback-only endpoint that shows or regenerates the PIN for the operator.
pub(crate) const PAIRING_PIN_PATH: &str = "/api/pairing/pin";

/// Misses allowed from one address before it has to wait between attempts.
const FREE_ATTEMPTS: u32 = 5;

/// Longest wait imposed on an address that keeps entering wrong PINs.
const MAX_LOCKOUT: Duration = Duration::from_secs(300);

/// Addresses with recorded misses kept before expired entries are pruned.
const MAX_TRACKED_PEERS: usize = 1024;

/// Cookie lifetime; tokens die with the app session long before this.
const COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 365;

/// Wrong-PIN history of one network address.
#[derive(Debug, Default)]
struct Misses {
    count: u32,
    retry_at: Option<Instant>,
}

/// Mutable pairing state guarded by one lock.
#[derive(Debug)]
struct PairingState {
    pin: String,
    tokens: HashSet<String>,
    misses: HashMap<IpAddr, Misses>,
}

/// Outcome of a PIN submission.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PairingOutcome {
    /// The PIN matched; the device keeps this token for the rest of the app session.
    Paired(String),
    /// The PIN did not match.
    Incorrect,
    /// The address missed too often and must wait this long before trying again.
    RateLimited(Duration),
}

/// Session PIN, issued tokens and per-address miss counters.
#[derive(Debug)]
pub struct RemotePairing {
    cookie_name: String,
    state: Mutex<PairingState>,
}

impl RemotePairing {
    /// Creates pairing state with a fresh PIN for the backend listening on `port`.
    ///
    /// Browsers share cookies across ports of one host, so the cookie name carries the port
    /// to keep two Nightfall instances on one computer from overwriting each other's tokens.
    pub(crate) fn new(port: u16) -> Self {
        Self {
            cookie_name: format!("nightfall_pairing_{port}"),
            state: Mutex::new(PairingState {
                pin: random_pin(),
                tokens: HashSet::new(),
                misses: HashMap::new(),
            }),
        }
    }

    /// Returns the PIN devices must enter during this app session.
    pub(crate) fn pin(&self) -> String {
        self.state.lock().unwrap().pin.clone()
    }

    /// Replaces the PIN and forgets every issued token.
    ///
    /// Miss counters survive, so an address already throttled for guessing does not earn
    /// fresh attempts each time the operator replaces the PIN. Callers must close remote
    /// sessions afterwards; a websocket that registers after this returns re-checks its
    /// token and is refused.
    pub(crate) fn regenerate(&self) -> String {
        let mut state = self.state.lock().unwrap();
        state.pin = random_pin();
        state.tokens.clear();
        state.pin.clone()
    }

    /// Checks a PIN from `peer`, issuing a token on success and throttling repeated misses.
    pub(crate) fn attempt(&self, peer: IpAddr, pin: &str, now: Instant) -> PairingOutcome {
        let mut state = self.state.lock().unwrap();
        if let Some(retry_at) = state.misses.get(&peer).and_then(|misses| misses.retry_at)
            && retry_at > now
        {
            return PairingOutcome::RateLimited(retry_at - now);
        }
        if pin.trim() == state.pin {
            state.misses.remove(&peer);
            let token = uuid::Uuid::new_v4().simple().to_string();
            state.tokens.insert(token.clone());
            return PairingOutcome::Paired(token);
        }
        if state.misses.len() >= MAX_TRACKED_PEERS {
            state
                .misses
                .retain(|_, misses| misses.retry_at.is_some_and(|retry_at| retry_at > now));
        }
        let misses = state.misses.entry(peer).or_default();
        misses.count += 1;
        misses.retry_at = lockout(misses.count).map(|wait| now + wait);
        PairingOutcome::Incorrect
    }

    /// Returns whether `token` was issued during this app session and is still valid.
    pub(crate) fn token_valid(&self, token: Option<&str>) -> bool {
        token.is_some_and(|token| self.state.lock().unwrap().tokens.contains(token))
    }

    /// Extracts this backend's pairing token from the request's `Cookie` headers.
    pub(crate) fn token_from(&self, headers: &HeaderMap) -> Option<String> {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(name, _)| *name == self.cookie_name)
            .map(|(_, token)| token.to_string())
    }

    /// Builds the `Set-Cookie` value that stores `token` in the browser.
    ///
    /// `HttpOnly` keeps page scripts from reading it and `SameSite=Strict` keeps other sites
    /// from sending it. `Secure` is omitted because the LAN UI is served over plain HTTP.
    fn cookie(&self, token: &str) -> HeaderValue {
        HeaderValue::from_str(&format!(
            "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={COOKIE_MAX_AGE_SECS}",
            self.cookie_name
        ))
        .expect("pairing cookie is plain ASCII")
    }
}

/// Picks a uniformly distributed six-digit PIN from the operating system's random source.
fn random_pin() -> String {
    format!("{:06}", uuid::Uuid::new_v4().as_u128() % 1_000_000)
}

/// Returns how long an address must wait after its `count`th consecutive miss.
///
/// The first few misses are free so a typo costs nothing; after that the wait doubles with
/// every miss, from one second up to [`MAX_LOCKOUT`].
fn lockout(count: u32) -> Option<Duration> {
    let excess = count.checked_sub(FREE_ATTEMPTS)?;
    Some(Duration::from_secs(1_u64 << excess.min(16)).min(MAX_LOCKOUT))
}

/// Returns whether a path controls the backend and so needs a paired device.
///
/// The pairing endpoint itself stays open so a new device can submit the PIN, and the
/// web UI files stay open so it can load the page that asks for it.
fn requires_pairing(path: &str) -> bool {
    let controls_backend =
        path == "/ws" || path.starts_with("/ws/") || path == "/api" || path.starts_with("/api/");
    controls_backend && path != PAIRING_PATH
}

/// Refuses remote requests to backend routes until the device has paired.
pub(crate) async fn require_pairing(
    State(state): State<AxumAppState>,
    request: Request,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(peer)| *peer);
    if is_local_client(peer, request.headers(), request.uri())
        || !requires_pairing(request.uri().path())
        || state
            .pairing
            .token_valid(state.pairing.token_from(request.headers()).as_deref())
    {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        "Enter the pairing PIN shown in Nightfall to control it from this device.",
    )
        .into_response()
}

/// Reports whether the requesting device must enter the PIN before connecting.
pub(crate) async fn pairing_status(
    State(state): State<AxumAppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
) -> Json<RemotePairingStatus> {
    let required = !is_local_client(Some(peer), &headers, &uri);
    let paired = !required
        || state
            .pairing
            .token_valid(state.pairing.token_from(&headers).as_deref());
    Json(RemotePairingStatus { required, paired })
}

/// Checks a submitted PIN and, when it matches, stores a session token in the browser.
pub(crate) async fn submit_pairing_pin(
    State(state): State<AxumAppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(attempt): Json<RemotePairingAttempt>,
) -> Response {
    match state
        .pairing
        .attempt(peer.ip(), &attempt.pin, Instant::now())
    {
        PairingOutcome::Paired(token) => {
            tracing::info!(%peer, "Remote device paired");
            (
                StatusCode::NO_CONTENT,
                [(header::SET_COOKIE, state.pairing.cookie(&token))],
            )
                .into_response()
        }
        PairingOutcome::Incorrect => {
            tracing::debug!(%peer, "Remote pairing PIN rejected");
            (StatusCode::UNAUTHORIZED, "Incorrect PIN.").into_response()
        }
        PairingOutcome::RateLimited(wait) => {
            let seconds = wait.as_secs_f64().ceil() as u64;
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, HeaderValue::from(seconds))],
                format!("Too many incorrect PINs. Try again in {seconds} s."),
            )
                .into_response()
        }
    }
}

/// Shows the PIN to the operator; other devices are refused.
pub(crate) async fn show_pairing_pin(
    State(state): State<AxumAppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if !is_local_client(Some(peer), &headers, &uri) {
        return operator_only();
    }
    Json(RemotePairingPin {
        pin: state.pairing.pin(),
    })
    .into_response()
}

/// Replaces the PIN and disconnects every paired device; other devices are refused.
pub(crate) async fn regenerate_pairing_pin(
    State(state): State<AxumAppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if !is_local_client(Some(peer), &headers, &uri) {
        return operator_only();
    }
    let pin = state.pairing.regenerate();
    crate::websocket::disconnect_remote_clients(&state.clients);
    tracing::info!("Remote pairing PIN regenerated; paired devices signed out");
    Json(RemotePairingPin { pin }).into_response()
}

/// Response for PIN management attempted from another device.
fn operator_only() -> Response {
    (
        StatusCode::FORBIDDEN,
        "The pairing PIN can only be managed on the computer running Nightfall.",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    /// Address of a phone on the LAN used across tests.
    const PHONE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));

    /// A correct PIN issues a token that the cookie round-trips and validates.
    #[test]
    fn correct_pin_issues_a_cookie_token() {
        let pairing = RemotePairing::new(3030);
        let pin = pairing.pin();
        assert_eq!(pin.len(), 6);
        assert!(pin.chars().all(|digit| digit.is_ascii_digit()));
        let PairingOutcome::Paired(token) = pairing.attempt(PHONE, &pin, Instant::now()) else {
            panic!("correct PIN refused");
        };
        let cookie = pairing.cookie(&token);
        let cookie = cookie.to_str().unwrap();
        assert!(cookie.starts_with(&format!("nightfall_pairing_3030={token};")));
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));

        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("theme=dark; nightfall_pairing_3030={token}")
                .parse()
                .unwrap(),
        );
        assert_eq!(
            pairing.token_from(&headers).as_deref(),
            Some(token.as_str())
        );
        assert!(pairing.token_valid(Some(&token)));
        assert!(!pairing.token_valid(Some("forged")));
        assert!(!pairing.token_valid(None));
    }

    /// A cookie issued by another Nightfall instance on the same host is ignored.
    #[test]
    fn cookie_name_is_scoped_to_the_port() {
        let pairing = RemotePairing::new(3030);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "nightfall_pairing_3040=abc".parse().unwrap(),
        );
        assert_eq!(pairing.token_from(&headers), None);
    }

    /// Typos are free at first, then each miss doubles the wait, and a correct PIN after
    /// the wait clears the history.
    #[test]
    fn repeated_misses_are_throttled() {
        let pairing = RemotePairing::new(3030);
        let pin = pairing.pin();
        let wrong = if pin == "000000" { "000001" } else { "000000" };
        let start = Instant::now();
        for _ in 1..FREE_ATTEMPTS {
            assert_eq!(
                pairing.attempt(PHONE, wrong, start),
                PairingOutcome::Incorrect
            );
        }
        assert_eq!(
            pairing.attempt(PHONE, wrong, start),
            PairingOutcome::Incorrect
        );
        assert_eq!(
            pairing.attempt(PHONE, &pin, start),
            PairingOutcome::RateLimited(Duration::from_secs(1))
        );
        let other = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 51));
        assert!(matches!(
            pairing.attempt(other, &pin, start),
            PairingOutcome::Paired(_)
        ));
        let later = start + Duration::from_secs(1);
        assert_eq!(
            pairing.attempt(PHONE, wrong, later),
            PairingOutcome::Incorrect
        );
        assert_eq!(
            pairing.attempt(PHONE, &pin, later),
            PairingOutcome::RateLimited(Duration::from_secs(2))
        );
        let after_wait = later + Duration::from_secs(2);
        assert!(matches!(
            pairing.attempt(PHONE, &pin, after_wait),
            PairingOutcome::Paired(_)
        ));
        assert_eq!(
            pairing.attempt(PHONE, wrong, after_wait),
            PairingOutcome::Incorrect
        );
    }

    /// The wait grows exponentially and stops at the cap.
    #[test]
    fn lockout_is_capped() {
        assert_eq!(lockout(FREE_ATTEMPTS - 1), None);
        assert_eq!(lockout(FREE_ATTEMPTS), Some(Duration::from_secs(1)));
        assert_eq!(lockout(FREE_ATTEMPTS + 3), Some(Duration::from_secs(8)));
        assert_eq!(lockout(FREE_ATTEMPTS + 40), Some(MAX_LOCKOUT));
    }

    /// Regenerating the PIN signs out every paired device.
    #[test]
    fn regenerating_revokes_tokens() {
        let pairing = RemotePairing::new(3030);
        let PairingOutcome::Paired(token) = pairing.attempt(PHONE, &pairing.pin(), Instant::now())
        else {
            panic!("correct PIN refused");
        };
        let old_pin = pairing.pin();
        let new_pin = pairing.regenerate();
        assert_eq!(pairing.pin(), new_pin);
        assert!(!pairing.token_valid(Some(&token)));
        if new_pin != old_pin {
            assert_eq!(
                pairing.attempt(PHONE, &old_pin, Instant::now()),
                PairingOutcome::Incorrect
            );
        }
    }

    /// Only backend routes other than the pairing endpoint are gated.
    #[test]
    fn gate_covers_backend_routes_only() {
        for path in ["/ws", "/api/showfiles", "/api", PAIRING_PIN_PATH] {
            assert!(requires_pairing(path), "{path}");
        }
        for path in [
            "/",
            "/index.html",
            "/assets/index-abc.js",
            "/cues",
            PAIRING_PATH,
        ] {
            assert!(!requires_pairing(path), "{path}");
        }
    }
}
