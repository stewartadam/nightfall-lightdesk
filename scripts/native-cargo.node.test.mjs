// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { nativeCargoArgs } from "./run-native-cargo.mjs";

/** Keeps every native entry point on runtime workspace defaults so their Cargo graphs match. */
test("native selection uses runtime workspace default features", () => {
  for (const command of ["build", "clippy", "test"]) {
    const args = nativeCargoArgs(command, ["--bin", "nightfall-headless"]);
    assert.equal(args[0], command);
    assert.ok(args.includes("--workspace"));
    assert.equal(args[args.indexOf("--exclude") + 1], "app-tauri");
    assert.ok(!args.includes("--no-default-features"));
    assert.ok(!args.includes("--features"));
    assert.deepEqual(args.slice(-2), ["--bin", "nightfall-headless"]);
  }
  assert.ok(nativeCargoArgs("build").includes("--tests"));
  assert.ok(!nativeCargoArgs("test").includes("--tests"));
});

/** Runtime-only builds must not pull a WebView or Tauri build script into native validation. */
test("the default runtime dependency graph excludes Tauri", () => {
  const graph = execFileSync(
    "cargo",
    ["tree", "-p", "app-runtime", "--prefix", "none", "--format", "{p}"],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(graph, /^(?:app-tauri|tauri(?:-[\w-]+)?) v/m);
});

/** Guard artifact reuse between the Playwright backend build and the nextest run. */
test("nextest selects the same targets and features as the backend build", () => {
  const nextestArgs = nativeCargoArgs("nextest");
  const buildArgs = nativeCargoArgs("build");
  assert.deepEqual(nextestArgs.slice(0, 2), ["nextest", "run"]);
  assert.deepEqual(nextestArgs.slice(2), buildArgs.slice(1));
});
