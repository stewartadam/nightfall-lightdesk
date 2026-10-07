// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Browser origin policy for the backend's HTTP and websocket endpoints.
//!
//! The backend has no cookies or tokens, so without this check any website open in a
//! browser on the engine machine could open `ws://localhost:<port>/ws` and drive the show
//! as a trusted local client. Browsers always attach `Origin` to websocket upgrades and
//! cross-origin requests, so a request carrying one is admitted only when it comes from
//! the desktop shell, or from a page served by the same host the browser used to reach
//! the backend. The port is ignored because the Vite dev server runs beside the backend
//! on its own port.
//!
//! Browsers omit `Origin` on same-origin `GET`s, so a site that rebinds its own public
//! domain to this machine could still read routes that way. Every request must therefore
//! address the backend by a local name; non-browser clients use an IP or local name anyway.

use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::{ConnectInfo, Request},
    http::{HeaderMap, HeaderName, StatusCode, Uri, header, uri::Authority},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// Origins the Tauri webview reports for bundled assets on macOS/Linux and on Windows.
const DESKTOP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// Header the Vite dev proxy uses to pass on the host the browser originally addressed.
const FORWARDED_HOST: HeaderName = HeaderName::from_static("x-forwarded-host");

/// Name suffixes that only resolve on the local network, never through public DNS.
const LOCAL_NAME_SUFFIXES: &[&str] = &[".local", ".localhost", ".lan", ".home.arpa", ".internal"];

/// Rejects requests from foreign browser pages or addressed through public names before
/// they reach a route.
///
/// Runs ahead of the CORS layer so preflights from foreign origins fail as well, and ahead
/// of the websocket upgrade so a foreign page never gets a session. Rejections log at debug
/// because a hostile page can trigger them in a loop.
pub(crate) async fn reject_foreign_origins(request: Request, next: Next) -> Response {
    let peer_is_loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(peer)| peer.ip().is_loopback());
    let host = request_host(request.headers(), request.uri(), peer_is_loopback);
    let origin = request.headers().get(header::ORIGIN);
    let allowed = match origin {
        Some(origin) => origin
            .to_str()
            .is_ok_and(|origin| origin_allowed(origin, host)),
        None => host.is_none_or(addresses_local_name),
    };
    if allowed {
        return next.run(request).await;
    }
    tracing::debug!(?origin, host, "websocket_foreign_origin_rejected");
    (StatusCode::FORBIDDEN, "Origin not allowed").into_response()
}

/// Returns whether a request comes from a browser or tool on the computer running Nightfall.
///
/// The peer must be loopback, and the browser must also have addressed this machine by a
/// loopback name. A local proxy such as the Vite dev server relays other devices from a
/// loopback address but reports the LAN address they used in `X-Forwarded-Host`, so a phone
/// browsing through it still counts as remote. A request without peer information counts as
/// remote, so a missing extension never grants local trust.
pub(crate) fn is_local_client(peer: Option<SocketAddr>, headers: &HeaderMap, uri: &Uri) -> bool {
    peer.is_some_and(|peer| peer.ip().is_loopback())
        && request_host(headers, uri, true).is_none_or(|host| {
            host.parse::<Authority>()
                .is_ok_and(|authority| is_loopback_name(authority.host()))
        })
}

/// Returns whether an addressed `host[:port]` names this machine or its local network.
fn addresses_local_name(host: &str) -> bool {
    host.parse::<Authority>().is_ok_and(|authority| {
        is_local_name(authority.host()) || is_loopback_name(authority.host())
    })
}

/// Returns the host (with optional port) the browser addressed to reach the backend.
///
/// Requests relayed by a proxy on this machine report the browser's host in
/// `X-Forwarded-Host`, since the proxy rewrites `Host` to its loopback target. The header
/// is only honored from loopback peers; browsers cannot set it on websocket upgrades, and
/// setting it on a fetch forces a preflight that this policy already rejects.
fn request_host<'a>(
    headers: &'a HeaderMap,
    uri: &'a Uri,
    peer_is_loopback: bool,
) -> Option<&'a str> {
    let forwarded = peer_is_loopback
        .then(|| headers.get(FORWARDED_HOST))
        .flatten()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    forwarded
        .or_else(|| {
            headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
        })
        .or_else(|| uri.authority().map(Authority::as_str))
}

/// Decides whether a browser page at `origin` may talk to a backend reached through `request_host`.
///
/// The page must be the desktop shell, or an `http(s)` page whose hostname matches the
/// addressed host. That host must also be a local name: a site that rebinds its own public
/// domain to this machine would otherwise match itself. Loopback names count as one host,
/// so a page opened at `127.0.0.1` may still reach the backend through `localhost`.
fn origin_allowed(origin: &str, request_host: Option<&str>) -> bool {
    if DESKTOP_ORIGINS.contains(&origin) {
        return true;
    }
    let Ok(origin) = origin.parse::<Uri>() else {
        return false;
    };
    if !matches!(origin.scheme_str(), Some("http" | "https")) {
        return false;
    }
    let Some(origin_host) = origin.host() else {
        return false;
    };
    let Some(request_host) = request_host.and_then(|host| host.parse::<Authority>().ok()) else {
        return false;
    };
    let request_host = request_host.host();
    (origin_host.eq_ignore_ascii_case(request_host) && is_local_name(request_host))
        || (is_loopback_name(origin_host) && is_loopback_name(request_host))
}

/// Returns whether `host` always resolves to this machine: `localhost`, a name under
/// `.localhost`, or a loopback IP address.
fn is_loopback_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || unbracketed
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// Returns whether `host` can only name a machine on this network: an IP address, a
/// single-label name, or a name under a reserved local suffix. A fully qualified single
/// label such as `foo.` is a top-level domain apex, so it does not count.
fn is_local_name(host: &str) -> bool {
    let fully_qualified = host.ends_with('.');
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    unbracketed.parse::<IpAddr>().is_ok()
        || (!fully_qualified && !host.contains('.'))
        || LOCAL_NAME_SUFFIXES
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Accepts the desktop shell and pages served by the host the browser used, on any port.
    #[test]
    fn accepts_desktop_and_same_host_pages() {
        for origin in DESKTOP_ORIGINS {
            assert!(origin_allowed(origin, Some("localhost:3030")), "{origin}");
        }
        let same_host = [
            ("http://localhost:3031", "localhost:3030"),
            ("http://127.0.0.1:3031", "127.0.0.1:3030"),
            ("http://192.168.1.20:3031", "192.168.1.20:3030"),
            ("https://[::1]:3031", "[::1]:3030"),
            ("http://Lightdesk.local:3031", "lightdesk.local:3030"),
            ("http://lightdesk:3031", "lightdesk:3030"),
            ("http://localhost", "localhost"),
            ("http://127.0.0.1:3031", "localhost:3030"),
            ("http://localhost:3031", "[::1]:3030"),
        ];
        for (origin, host) in same_host {
            assert!(origin_allowed(origin, Some(host)), "{origin} via {host}");
        }
    }

    /// Rejects other sites, opaque origins, and public names that could be rebound to this machine.
    #[test]
    fn rejects_foreign_pages() {
        let foreign = [
            ("https://evil.example", Some("localhost:3030")),
            ("http://localhost.evil.example:3031", Some("localhost:3030")),
            ("http://192.168.1.21:3031", Some("192.168.1.20:3030")),
            ("http://192.168.1.21:3031", Some("localhost:3030")),
            ("http://localhost:3031", Some("192.168.1.20:3030")),
            ("null", Some("localhost:3030")),
            ("file://", Some("localhost:3030")),
            ("tauri://evil", Some("localhost:3030")),
            ("http://localhost:3031", None),
            (
                "http://rebind.evil.example",
                Some("rebind.evil.example:3030"),
            ),
            (
                "http://rebind.evil.example.",
                Some("rebind.evil.example.:3030"),
            ),
            ("http://evil.", Some("evil.:3030")),
        ];
        for (origin, host) in foreign {
            assert!(!origin_allowed(origin, host), "{origin} via {host:?}");
        }
    }

    /// Requests without `Origin` must still address the backend by a local name, so a rebound
    /// public domain cannot read routes through same-origin `GET`s.
    #[test]
    fn addressed_host_must_be_local() {
        for host in [
            "localhost:3030",
            "127.0.0.1:3030",
            "[::1]:3030",
            "192.168.1.20:3030",
            "lightdesk.local",
            "lightdesk",
            "localhost.",
        ] {
            assert!(addresses_local_name(host), "{host}");
        }
        for host in ["rebind.evil.example:3030", "evil.:3030", "not a host"] {
            assert!(!addresses_local_name(host), "{host}");
        }
    }

    /// Only loopback peers that addressed a loopback name are local; devices relayed by a
    /// local proxy, network peers and requests without peer info are not.
    #[test]
    fn local_clients_are_loopback_peers_addressing_loopback() {
        let loopback = Some(SocketAddr::from(([127, 0, 0, 1], 50000)));
        let phone = Some(SocketAddr::from(([192, 168, 1, 50], 50000)));
        let headers = |pairs: &[(&'static str, &'static str)]| {
            let mut headers = HeaderMap::new();
            for (name, value) in pairs {
                headers.insert(*name, value.parse().unwrap());
            }
            headers
        };
        let uri = Uri::from_static("/ws");
        let direct = headers(&[("host", "localhost:3030")]);
        let proxied_local = headers(&[
            ("host", "localhost:3030"),
            ("x-forwarded-host", "127.0.0.1:3031"),
        ]);
        let proxied_phone = headers(&[
            ("host", "localhost:3030"),
            ("x-forwarded-host", "192.168.1.20:3031"),
        ]);
        assert!(is_local_client(loopback, &direct, &uri));
        assert!(is_local_client(loopback, &proxied_local, &uri));
        assert!(is_local_client(loopback, &HeaderMap::new(), &uri));
        assert!(!is_local_client(loopback, &proxied_phone, &uri));
        assert!(!is_local_client(phone, &direct, &uri));
        assert!(!is_local_client(None, &direct, &uri));
    }

    /// Prefers the proxy's forwarded host only when the proxy connects over loopback.
    #[test]
    fn forwarded_host_requires_loopback_peer() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:3030".parse().unwrap());
        headers.insert(FORWARDED_HOST, "192.168.1.20:3031".parse().unwrap());
        let uri = Uri::from_static("/ws");
        assert_eq!(
            request_host(&headers, &uri, true),
            Some("192.168.1.20:3031")
        );
        assert_eq!(request_host(&headers, &uri, false), Some("localhost:3030"));
    }
}
