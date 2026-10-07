// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/**
 * Plain cargo commands must select every runtime crate and only those, so hooks, CI and
 * partial builds share one graph while the desktop shell builds only when named.
 */
test("default workspace members are every member except the desktop shell", () => {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version=1", "--no-deps"], {
      encoding: "utf8",
    }),
  );
  const nameOf = (id) =>
    metadata.packages.find((pkg) => pkg.id === id)?.name ?? id;
  const members = metadata.workspace_members.map(nameOf);
  const defaults = new Set(metadata.workspace_default_members.map(nameOf));
  assert.deepEqual(
    members.filter((name) => !defaults.has(name)),
    ["app-tauri"],
  );
});

/** Runtime-only builds must not pull a WebView or Tauri build script into native validation. */
test("the default runtime dependency graph excludes Tauri", () => {
  const graph = execFileSync(
    "cargo",
    ["tree", "--prefix", "none", "--format", "{p}"],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(graph, /^(?:app-tauri|tauri(?:-[\w-]+)?) v/m);
});
