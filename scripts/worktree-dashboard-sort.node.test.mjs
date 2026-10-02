// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dashboardUrl = new URL(
  "../worktree-dashboard/worktree-dashboard.mjs",
  import.meta.url,
).href;

/**
 * Imports the dashboard in a child process (importing starts its HTTP server)
 * and returns the JSON value printed by `body`, which has the module's exports
 * in scope as `dashboard`.
 */
async function evalInDashboard(t, body) {
  const cwd = await mkdtemp(join(tmpdir(), "nightfall-dashboard-sort-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = `const dashboard = await import(${JSON.stringify(dashboardUrl)}); process.stdout.write(JSON.stringify(${body})); process.exit(0);`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, env: { ...process.env, NIGHTFALL_WORKTREE_DASHBOARD_PORT: "0" } },
  );
  return JSON.parse(stdout);
}

/** Verifies the remote default branch leads the primary list and duplicates collapse. */
test("primary branches put the detected default branch first", async (t) => {
  const result = await evalInDashboard(
    t,
    `[
      dashboard.primaryBranchesFrom("origin/main\\n"),
      dashboard.primaryBranchesFrom("upstream/trunk"),
      dashboard.primaryBranchesFrom(null),
    ]`,
  );
  assert.deepEqual(result, [
    ["main", "develop"],
    ["trunk", "develop", "main"],
    ["develop", "main"],
  ]);
});

/** Verifies primary branches sort ahead of feature worktrees regardless of `.env` presence. */
test("worktrees sort primary branches to the top", async (t) => {
  const result = await evalInDashboard(
    t,
    `dashboard.sortWorktrees([
      { branch: "alpha", path: "/w/alpha", envExists: true },
      { branch: "main", path: "/w/main", envExists: false },
      { branch: null, path: "/w/detached", envExists: true },
      { branch: "beta", path: "/w/beta", envExists: false },
      { branch: "develop", path: "/w/develop", envExists: true },
    ], ["develop", "main"]).map((w) => w.path)`,
  );
  assert.deepEqual(result, [
    "/w/develop",
    "/w/main",
    "/w/alpha",
    "/w/detached",
    "/w/beta",
  ]);
});
