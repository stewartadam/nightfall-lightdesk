// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getNightfallDataDirectoryPath,
  isTauriRuntime,
  openDataDirectory,
  resolveNightfallDataDirectoryPath,
} from "./tauri";

/** Verifies browser-only Tauri detection stays false when no window exists. */
test("isTauriRuntime returns false when window is unavailable", () => {
  assert.equal(isTauriRuntime(), false);
});

/** Verifies Tauri detection recognizes the runtime marker injected on window. */
test("isTauriRuntime detects mocked tauri internals", () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: unknown;
  };
  const previousWindow = globalWithWindow.window;

  Object.defineProperty(globalWithWindow, "window", {
    value: { __TAURI_INTERNALS__: {} },
    configurable: true,
  });

  try {
    assert.equal(isTauriRuntime(), true);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalWithWindow, "window");
    } else {
      Object.defineProperty(globalWithWindow, "window", {
        value: previousWindow,
        configurable: true,
      });
    }
  }
});

/** Verifies shell-only data directory opening is unavailable in browser/node contexts. */
test("openDataDirectory rejects outside tauri runtime", async () => {
  await assert.rejects(
    openDataDirectory(),
    /only available in the desktop app/u,
  );
});

/** Verifies platform defaults remain available when no env override is configured. */
test("getNightfallDataDirectoryPath detects macOS browser platform", () => {
  const globalWithNavigator = globalThis as typeof globalThis & {
    navigator?: unknown;
  };
  const previousNavigator = globalWithNavigator.navigator;

  Object.defineProperty(globalWithNavigator, "navigator", {
    value: { platform: "MacIntel" },
    configurable: true,
  });

  try {
    assert.equal(
      getNightfallDataDirectoryPath(),
      "~/Library/Application Support/com.nightfall.nightfall",
    );
  } finally {
    if (previousNavigator === undefined) {
      Reflect.deleteProperty(globalWithNavigator, "navigator");
    } else {
      Object.defineProperty(globalWithNavigator, "navigator", {
        value: previousNavigator,
        configurable: true,
      });
    }
  }
});

/** Verifies an explicit data directory override takes precedence over platform defaults. */
test("resolveNightfallDataDirectoryPath prefers env override", () => {
  assert.equal(
    resolveNightfallDataDirectoryPath("MacIntel", "/tmp/nightfall-dev"),
    "/tmp/nightfall-dev",
  );
});

/** Verifies blank data directory overrides are ignored in favor of platform defaults. */
test("resolveNightfallDataDirectoryPath ignores blank env override", () => {
  assert.equal(
    resolveNightfallDataDirectoryPath("linux", "  "),
    "~/.local/share/nightfall",
  );
});
