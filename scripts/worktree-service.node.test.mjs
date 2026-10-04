// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCliArgs } from "../worktree-dashboard/worktree-service.mjs";

const execFileAsync = promisify(execFile);
const servicePath = fileURLToPath(
  new URL("../worktree-dashboard/worktree-service.mjs", import.meta.url),
);

/**
 * Runs the service CLI against a dashboard address nothing listens on and
 * returns its exit code and output.
 */
async function runWithoutDashboard(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [servicePath, ...args],
      {
        env: {
          ...process.env,
          NIGHTFALL_WORKTREE_DASHBOARD_URL: "http://127.0.0.1:1",
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Verifies restart defaults to the backend of the given worktree. */
test("restart targets the backend by default", () => {
  assert.deepEqual(parseCliArgs(["--worktree=/w/a", "restart"]), {
    command: "restart",
    worktree: "/w/a",
    services: ["backend"],
    json: false,
  });
});

/** Verifies repeated and comma-separated services merge, and `all` expands. */
test("services accept repeats, commas, and all", () => {
  assert.deepEqual(
    parseCliArgs([
      "--worktree=/w/a",
      "start",
      "-s",
      "backend,ui",
      "--service",
      "ui",
    ]).services,
    ["backend", "ui"],
  );
  assert.deepEqual(
    parseCliArgs(["--worktree=/w/a", "stop", "-s", "all"]).services,
    ["backend", "ui", "wasm", "artnet-sender", "sacn-sender"],
  );
});

/** Verifies bad commands, services, stray arguments, and a missing worktree are rejected. */
test("invalid arguments are rejected", () => {
  const wt = "--worktree=/w/a";
  assert.throws(() => parseCliArgs([wt, "reboot"]), /Unknown command/);
  assert.throws(() => parseCliArgs([wt, "toString"]), /Unknown command/);
  assert.throws(
    () => parseCliArgs([wt, "start", "-s", "db"]),
    /Unknown service/,
  );
  assert.throws(() => parseCliArgs([wt, "start", "-s", ","]), /at least one/);
  assert.throws(
    () => parseCliArgs([wt, "list", "extra"]),
    /Unexpected argument/,
  );
  assert.throws(() => parseCliArgs(["restart"]), /--worktree/);
  assert.equal(parseCliArgs(["list"]).command, "list");
  assert.equal(parseCliArgs([wt]).command, "help");
});

/** Verifies worktree removal proceeds when the dashboard is not running. */
test("stop succeeds when the dashboard is unreachable", async () => {
  const result = await runWithoutDashboard([
    `--worktree=${process.cwd()}`,
    "stop",
    "-s",
    "all",
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no managed services to stop/u);
});

/** Verifies commands other than stop report an unreachable dashboard as a failure. */
test("restart fails when the dashboard is unreachable", async () => {
  const result = await runWithoutDashboard([
    `--worktree=${process.cwd()}`,
    "restart",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unable to reach worktree dashboard/u);
});
