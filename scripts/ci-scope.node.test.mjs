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
  browser_preview: false,
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
    ["desktop/app-tauri/src/desktop_shell.rs", check],
    ["crates/app-runtime/src/lib.rs", check],
    ["crates/app-runtime/src/session.rs", check],
    ["crates/app-runtime/src/shutdown.rs", check],
    ["crates/app-runtime/src/diagnostic_logs.rs", check],
    ["crates/config/src/lib.rs", check],
    ["desktop/app-tauri/tauri.conf.json", desktopWithCheck],
    ["desktop/app-tauri/capabilities/default.json", desktopWithCheck],
    ["desktop/app-tauri/icons/icon.ico", desktopWithCheck],
    ["desktop/app-tauri/build.rs", desktopWithCheck],
    ["desktop/app-tauri/Cargo.toml", desktopWithCheck],
    ["crates/app-runtime/Cargo.toml", desktopWithCheck],
    [".github/workflows/desktop-check.yml", desktopWithCheck],
    ["crates/browser-runtime/src/lib.rs", browser],
    ["scripts/browser-demo-audio.mjs", browser],
    [".github/workflows/browser-demo.yml", browser],
    ["webui/e2e/browser-demo.spec.ts", browser],
    ["webui/e2e/distribution-notices.spec.ts", browser],
    ["webui/e2e/browser-demo-soak.spec.ts", none],
    [".github/workflows/desktop-artifacts.yml", desktop],
    [".github/workflows/release-notes.yml", none],
    ["scripts/release-notes.mjs", none],
    ["Cargo.lock", both],
    ["Cargo.toml", both],
    ["pnpm-lock.yaml", both],
    ["pnpm-workspace.yaml", both],
    ["crates/app-runtime/assets/sample-audio/lofi.mp3", both],
    [".github/workflows/ci.yml", both],
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
    select(["desktop/app-tauri/src/main.rs", "desktop/app-tauri/build.rs"]),
    desktopWithCheck,
  );
  assert.deepEqual(select(["desktop/app-tauri/src/main.rs", "Cargo.lock"]), {
    ...both,
    desktop_check: true,
  });
  assert.deepEqual(select(["Cargo.lock"]), both);
  assert.deepEqual(
    select([
      "desktop/app-tauri/src/main.rs",
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

/** Previews build only for configured same-repository PRs, independently of packaging. */
test("browser previews require a configured target and a same-repository PR", () => {
  /** Select a UI-only PR with the given preview conditions. */
  const select = (options) =>
    selectScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["webui/components/example.tsx"],
      ...options,
    });
  assert.deepEqual(select({ previewTarget: true, sameRepository: true }), {
    ...none,
    browser_preview: true,
  });
  assert.deepEqual(
    select({ previewTarget: true, sameRepository: false }),
    none,
  );
  assert.deepEqual(
    select({ previewTarget: false, sameRepository: true }),
    none,
  );
  assert.deepEqual(
    selectScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["crates/browser-runtime/src/lib.rs"],
      previewTarget: true,
      sameRepository: true,
    }),
    { ...browser, browser_preview: true },
  );
  for (const [event, ref] of [
    ["push", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/develop"],
  ]) {
    assert.equal(
      selectScope({ event, ref, previewTarget: true, sameRepository: true })
        .browser_preview,
      false,
      event,
    );
  }
});

/** NUL-delimited paths preserve unusual names without interpreting them as script or shell input. */
test("changed paths preserve whitespace and newlines", () => {
  assert.deepEqual(readChangedPaths("a b\0line\nbreak\0"), [
    "a b",
    "line\nbreak",
  ]);
  assert.deepEqual(readChangedPaths(""), []);
});
