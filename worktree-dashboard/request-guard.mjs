// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Hostnames, as `URL` normalizes them, that always name this machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Splits a comma-separated list of origins into normalized entries, trimming
 * whitespace and trailing slashes and dropping blanks.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseAllowedOrigins(value) {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
}

/**
 * Returns the lowercase hostname a `Host` header names, or null when the
 * header does not parse as a host with an optional port.
 * @param {string} host
 * @returns {string | null}
 */
function hostnameFromHostHeader(host) {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns the lowercase hostname of an origin, or null for the opaque `null`
 * origin and anything else that does not parse as a URL.
 * @param {string} origin
 * @returns {string | null}
 */
function hostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Builds the check every dashboard request passes before it is routed. The API
 * creates and deletes worktrees and starts and kills local processes, so web
 * pages must not be able to reach it:
 *
 * - The `Host` header must name this machine (a loopback name, the address the
 *   dashboard listens on, or the hostname of an allowed origin), which stops
 *   DNS rebinding.
 * - An `Origin` header, which browsers send on cross-origin requests including
 *   simple POSTs a page can send without reading the response, must be a
 *   loopback origin or one listed in `allowedOrigins`.
 *
 * Non-browser clients such as the MCP server and the `wt service` alias send no
 * `Origin` and pass on the `Host` check alone. The web UI reaches the API through
 * the Vite dev server's `/worktree-api` proxy, which forwards the page's origin.
 *
 * @param {{ dashboardHost: string, allowedOrigins?: string[] }} options
 * @returns {(headers: { host?: string, origin?: string }) => { allowed: boolean, reason?: string }}
 */
export function createRequestGuard({ dashboardHost, allowedOrigins = [] }) {
  const origins = new Set(allowedOrigins);
  const hosts = new Set(LOOPBACK_HOSTNAMES);
  const listenHostname = hostnameFromHostHeader(dashboardHost);
  if (listenHostname) hosts.add(listenHostname);
  for (const origin of allowedOrigins) {
    const hostname = hostnameFromOrigin(origin);
    if (hostname) hosts.add(hostname);
  }

  /**
   * Decides whether a request with these headers may reach the API, with a
   * reason for the 403 response when it may not.
   */
  return function checkRequest({ host, origin }) {
    const hostname = host ? hostnameFromHostHeader(host) : null;
    if (!hostname || !hosts.has(hostname)) {
      return {
        allowed: false,
        reason: `Host not allowed: ${host ?? "(none)"}`,
      };
    }
    if (origin === undefined || origins.has(origin)) return { allowed: true };
    const originHostname = hostnameFromOrigin(origin);
    if (originHostname && LOOPBACK_HOSTNAMES.has(originHostname)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Origin not allowed: ${origin}. Add it to NIGHTFALL_WORKTREE_DASHBOARD_ALLOWED_ORIGINS to permit it.`,
    };
  };
}
