// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readChangedPaths, selectScope } from "./ci-scope.mjs";

const none = {
  desktop_check: false,
  desktop_package: false,
  browser_package: false,
};
const desktop = { ...none, desktop_package: true };
const browser = { ...none, browser_package: true };
const both = { ...desktop, browser_package: true };
const check = { ...none, desktop_check: true };
const desktopWithCheck = { ...desktop, desktop_check: true };

/** Preserve the intended separation between runtime, shell, and distribution validation. */
test("PR selection follows distribution ownership", () => {
  for (const [path, expected] of [
    ["crates/app-runtime/src/systems/showfile_events/save.rs", none],
    ["crates/app-runtime/src/tests.rs", none],
    ["crates/app-runtime/src/sample_data/fixtures.rs", none],
    ["webui/components/example.tsx", none],
    ["crates/app-tauri/src/desktop_shell.rs", check],
    ["crates/app-runtime/src/lib.rs", check],
    ["crates/app-runtime/src/session.rs", check],
    ["crates/app-runtime/src/shutdown.rs", check],
    ["crates/app-runtime/src/diagnostic_logs.rs", check],
    ["crates/config/src/lib.rs", check],
    ["crates/app-tauri/tauri.conf.json", desktopWithCheck],
    ["crates/app-tauri/capabilities/default.json", desktopWithCheck],
    ["crates/app-tauri/icons/icon.ico", desktopWithCheck],
    ["crates/app-tauri/build.rs", desktopWithCheck],
    ["crates/app-tauri/Cargo.toml", desktopWithCheck],
    ["crates/app-runtime/Cargo.toml", desktopWithCheck],
    [".github/workflows/desktop-check.yml", desktopWithCheck],
    ["crates/browser-runtime/src/lib.rs", browser],
    ["scripts/browser-demo-audio.mjs", browser],
    [".github/workflows/browser-demo.yml", browser],
    [".github/workflows/desktop-artifacts.yml", desktop],
    [".github/workflows/release-notes.yml", none],
    ["scripts/release-notes.mjs", none],
    ["Cargo.lock", both],
    ["Cargo.toml", both],
    ["package-lock.json", both],
    ["crates/app-runtime/assets/sample-audio/lofi.mp3", both],
    [".github/workflows/ci-precommit.yml", both],
    ["scripts/ci-scope.mjs", both],
    ["crates/wasm-bridge/src/lib.rs", both],
  ]) {
    assert.deepEqual(
      selectScope({
        event: "pull_request",
        ref: "refs/pull/1/merge",
        paths: [path],
      }),
      expected,
      path,
    );
  }
});

/** Packaging does not run desktop tests, so desktop code keeps the check beside packaging. */
test("combined changes run each required validation once", () => {
  /** Apply PR selection to a combined change set. */
  const select = (paths) =>
    selectScope({ event: "pull_request", ref: "refs/pull/1/merge", paths });
  assert.deepEqual(
    select(["crates/app-tauri/src/main.rs", "crates/app-tauri/build.rs"]),
    desktopWithCheck,
  );
  assert.deepEqual(select(["crates/app-tauri/src/main.rs", "Cargo.lock"]), {
    ...both,
    desktop_check: true,
  });
  assert.deepEqual(select(["Cargo.lock"]), both);
  assert.deepEqual(
    select([
      "crates/app-tauri/src/main.rs",
      "crates/browser-runtime/src/lib.rs",
    ]),
    { ...check, browser_package: true },
  );
});

/** Branch, release, and manual policies do not accidentally depend on a PR path filter. */
test("event policy retains main and release packaging with explicit manual choices", () => {
  assert.deepEqual(
    selectScope({ event: "push", ref: "refs/heads/main" }),
    both,
  );
  assert.deepEqual(
    selectScope({ event: "push", ref: "refs/heads/develop" }),
    none,
  );
  assert.deepEqual(
    selectScope({ event: "push", ref: "refs/tags/v0.1.0" }),
    desktop,
  );
  for (const [distribution, expected] of [
    ["all", both],
    ["desktop", desktop],
    ["browser", browser],
  ]) {
    assert.deepEqual(
      selectScope({
        event: "workflow_dispatch",
        ref: "refs/heads/develop",
        distribution,
      }),
      expected,
    );
  }
  assert.throws(() =>
    selectScope({ event: "workflow_dispatch", distribution: "invalid" }),
  );
  assert.throws(() => selectScope({ event: "unknown", ref: "" }));
});

/** NUL-delimited paths preserve unusual names without interpreting them as script or shell input. */
test("changed paths preserve whitespace and newlines", () => {
  assert.deepEqual(readChangedPaths("a b\0line\nbreak\0"), [
    "a b",
    "line\nbreak",
  ]);
  assert.deepEqual(readChangedPaths(""), []);
});
