// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { playwrightSandboxError } from "./playwright-sandbox.mjs";

/** Covers browser entry points, including UI mode taking precedence over listing. */
test("macOS seatbelt browser commands receive an actionable rejection", () => {
  for (const args of [
    ["test"],
    ["test", "--headed"],
    ["test", "--debug"],
    ["test", "--list", "--ui"],
    ["test", "--list", "--ui-port=0"],
    ["test", "--list", "--ui-host", "localhost"],
    ["test", "--", "--help"],
    ["test", "--grep", "--help"],
    ["test", "--grep", "--list"],
    ["open"],
    ["codegen"],
    ["screenshot", "about:blank", "test.png"],
    ["pdf", "about:blank", "test.pdf"],
    ["show-trace"],
    ["show-report"],
  ]) {
    const error = playwrightSandboxError(
      args,
      { CODEX_SANDBOX: "seatbelt" },
      "darwin",
    );
    assert.match(error, /approved escalated execution/, args.join(" "));
    assert.match(error, /Terminal/);
    assert.match(error, /Do not retry/);
  }
});

/** Keeps informational and installation commands available without a browser. */
test("macOS seatbelt permits non-launch commands", () => {
  for (const args of [
    [],
    ["--help"],
    ["--version"],
    ["-V"],
    ["help", "test"],
    ["test", "--help"],
    ["test", "-h"],
    ["test", "--list"],
    ["install", "chromium"],
    ["install-deps"],
    ["uninstall"],
    ["clear-cache"],
  ]) {
    assert.equal(
      playwrightSandboxError(args, { CODEX_SANDBOX: "seatbelt" }, "darwin"),
      undefined,
      args.join(" "),
    );
  }
});

/** Ensures ordinary Terminal, approved execution, and other operating systems pass. */
test("the guard only rejects the known macOS seatbelt environment", () => {
  for (const [platform, environment] of [
    ["darwin", {}],
    ["darwin", { CODEX_SANDBOX: "" }],
    ["darwin", { CODEX_SANDBOX_NETWORK_DISABLED: "1" }],
    ["linux", { CODEX_SANDBOX: "seatbelt" }],
    ["win32", { CODEX_SANDBOX: "seatbelt" }],
  ]) {
    assert.equal(
      playwrightSandboxError(["test"], environment, platform),
      undefined,
    );
  }
});

/** Exercises the real wrapper in an empty project so any premature setup fails. */
test("the wrapper rejects before setup and forwards help and listing without setup", {
  skip: process.platform !== "darwin",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-sandbox-guard-"));
  const wrapper = fileURLToPath(
    new URL("./run-playwright.mjs", import.meta.url),
  );
  try {
    const cliDirectory = join(root, "node_modules", "@playwright", "test");
    mkdirSync(cliDirectory, { recursive: true });
    writeFileSync(
      join(cliDirectory, "cli.js"),
      "process.stdout.write('CLI reached\\n');\n",
    );
    for (const args of [
      ["test"],
      ["test", "--headed"],
      ["test", "--browser", "firefox"],
      ["test", "--target", "embedded-demo"],
    ]) {
      const result = spawnSync(process.execPath, [wrapper, ...args], {
        cwd: root,
        env: { ...process.env, CODEX_SANDBOX: "seatbelt" },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /^Playwright browser launch blocked:/);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|cargo/);
    }
    for (const args of [
      ["test", "--help"],
      ["test", "--list"],
      ["test", "--list", "--target", "embedded-demo"],
    ]) {
      const result = spawnSync(process.execPath, [wrapper, ...args], {
        cwd: root,
        env: { ...process.env, CODEX_SANDBOX: "seatbelt" },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "CLI reached\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
