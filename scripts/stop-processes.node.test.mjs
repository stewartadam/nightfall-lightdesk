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

const execFileAsync = promisify(execFile);

/**
 * Verifies worktree cleanup proceeds when the dashboard backend is unreachable.
 */
test("kill-backend succeeds when the dashboard backend is unreachable", async () => {
  const { stderr } = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("./stop-processes.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        NIGHTFALL_WORKTREE_DASHBOARD_URL: "http://127.0.0.1:0",
        WORKTREE_TARGET: process.cwd(),
      },
    },
  );

  assert.match(stderr, /unable to reach worktree dashboard/u);
});
