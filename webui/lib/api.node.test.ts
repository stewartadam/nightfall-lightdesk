// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getBackendUrl,
  getWebSocketUrl,
  resolveBackendPort,
  resolveBackendUrl,
  resolveWebSocketUrl,
} from "./api";

/** Built frontend HTTP and worker websocket settings share the desktop-injected port. */
test("desktop runtime port reaches public URL helpers without Vite env", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: {}, __NIGHTFALL_BACKEND_PORT__: 3891 },
  });
  try {
    assert.equal(getBackendUrl(), "http://localhost:3891");
    assert.equal(getWebSocketUrl(), "ws://localhost:3891/ws");
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

/** Desktop startup configuration overrides both bundled defaults and Vite environment values. */
test("resolveBackendPort uses the launched desktop backend port", () => {
  assert.equal(resolveBackendPort(false, "5172", 3891), 3891);
  assert.equal(resolveBackendPort(true, "5172", 3891), 3891);
});

test("resolveBackendPort ignores baked NIGHTFALL_PORT outside dev", () => {
  assert.equal(resolveBackendPort(false, "5172"), 3030);
});

test("resolveBackendUrl uses same-origin backend in browser Vite dev", () => {
  assert.equal(
    resolveBackendUrl({
      backendPort: 3030,
      isDev: true,
      runtimeLocation: { origin: "http://localhost:3031" },
      tauriRuntime: false,
    }),
    "http://localhost:3031",
  );
});

test("resolveBackendUrl bypasses same-origin backend in Tauri dev", () => {
  assert.equal(
    resolveBackendUrl({
      backendPort: 3030,
      isDev: true,
      runtimeLocation: { origin: "http://localhost:3031" },
      tauriRuntime: true,
    }),
    "http://localhost:3030",
  );
});

test("resolveWebSocketUrl uses same-origin proxy in browser Vite dev when enabled", () => {
  assert.equal(
    resolveWebSocketUrl({
      backendPort: 3030,
      isDev: true,
      runtimeLocation: { protocol: "https:", host: "localhost:3031" },
      tauriRuntime: false,
      viteProxyEnabled: true,
    }),
    "wss://localhost:3031/ws",
  );
});

test("resolveWebSocketUrl bypasses same-origin proxy in Tauri dev", () => {
  assert.equal(
    resolveWebSocketUrl({
      backendPort: 3030,
      isDev: true,
      runtimeLocation: { protocol: "https:", host: "localhost:3031" },
      tauriRuntime: true,
      viteProxyEnabled: true,
    }),
    "ws://localhost:3030/ws",
  );
});
