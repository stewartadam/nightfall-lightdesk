// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * API URL helpers for backend HTTP endpoints.
 */

import { isTauriRuntime } from "./tauri";

const DEFAULT_BACKEND_PORT = 3030;

declare global {
  interface Window {
    /** Backend port injected by the desktop shell before application scripts run. */
    __NIGHTFALL_BACKEND_PORT__?: number;
  }
}

// Use a narrowed Location shape here so tests can pass plain objects instead of DOM Location instances.
type RuntimeLocation = {
  host?: string;
  hostname?: string;
  origin?: string;
  protocol?: string;
};

type BackendUrlOptions = {
  backendPort: number;
  isDev: boolean;
  runtimeLocation?: RuntimeLocation;
  tauriRuntime: boolean;
};

type WebSocketUrlOptions = BackendUrlOptions & {
  viteProxyEnabled: boolean;
};

/**
 * Returns the backend port expected by the UI runtime.
 *
 * The desktop shell injects the port of the backend it launched. A production
 * bundle opened in a browser was served by the backend itself, so the page's
 * own port is the backend port. Vite dev reads `NIGHTFALL_PORT`.
 */
export function resolveBackendPort(
  isDev: boolean,
  envPort?: string,
  desktopPort?: number,
  pagePort?: string,
): number {
  if (desktopPort !== undefined) return desktopPort;
  if (!isDev) {
    const served = pagePort ? Number.parseInt(pagePort, 10) : Number.NaN;
    return Number.isFinite(served) ? served : DEFAULT_BACKEND_PORT;
  }

  if (!envPort) {
    return DEFAULT_BACKEND_PORT;
  }

  const parsed = Number.parseInt(envPort, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_BACKEND_PORT;
}

/** Returns the backend port expected by the UI runtime. */
export function getBackendPort(): number {
  const env = import.meta.env ?? {};
  return resolveBackendPort(
    Boolean(env.DEV),
    env.NIGHTFALL_PORT,
    isTauriRuntime() ? window.__NIGHTFALL_BACKEND_PORT__ : undefined,
    globalThis.location?.port,
  );
}

/**
 * Returns the host that runs the backend when the UI connects to it directly.
 * The web server that served the UI runs beside the backend, so a browser
 * reaches the backend through the page's own hostname and a phone on the LAN
 * targets that machine rather than itself. The desktop shell keeps the
 * loopback backend it launched.
 */
function directBackendHost({
  runtimeLocation,
  tauriRuntime,
}: Pick<BackendUrlOptions, "runtimeLocation" | "tauriRuntime">): string {
  if (!tauriRuntime && runtimeLocation?.hostname) {
    return runtimeLocation.hostname;
  }
  return "localhost";
}

/** Resolves the base backend HTTP URL from runtime state. */
export function resolveBackendUrl({
  backendPort,
  isDev,
  runtimeLocation,
  tauriRuntime,
}: BackendUrlOptions): string {
  if (isDev && runtimeLocation?.origin && !tauriRuntime) {
    return runtimeLocation.origin;
  }

  return `http://${directBackendHost({ runtimeLocation, tauriRuntime })}:${backendPort}`;
}

/** Returns the base backend HTTP URL. */
export function getBackendUrl(): string {
  const env = import.meta.env ?? {};
  return resolveBackendUrl({
    backendPort: getBackendPort(),
    isDev: Boolean(env.DEV),
    runtimeLocation: globalThis.location,
    tauriRuntime: isTauriRuntime(),
  });
}

/** Resolves the backend WebSocket URL from runtime state. */
export function resolveWebSocketUrl({
  backendPort,
  isDev,
  runtimeLocation,
  tauriRuntime,
  viteProxyEnabled,
}: WebSocketUrlOptions): string {
  if (isDev && runtimeLocation?.host && viteProxyEnabled && !tauriRuntime) {
    const wsProtocol = runtimeLocation.protocol === "https:" ? "wss" : "ws";
    return `${wsProtocol}://${runtimeLocation.host}/ws`;
  }

  return `ws://${directBackendHost({ runtimeLocation, tauriRuntime })}:${backendPort}/ws`;
}

/** Returns the backend WebSocket URL. */
export function getWebSocketUrl(): string {
  const env = import.meta.env ?? {};
  return resolveWebSocketUrl({
    backendPort: getBackendPort(),
    isDev: Boolean(env.DEV),
    runtimeLocation: globalThis.location,
    tauriRuntime: isTauriRuntime(),
    viteProxyEnabled: env.NIGHTFALL_VITE_PROXY === "1",
  });
}
