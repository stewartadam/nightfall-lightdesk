// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { selectWorktree } from "../worktree-dashboard/dashboard-client.mjs";
import { parseCliArgs } from "../worktree-dashboard/worktree-cli.mjs";

const root = join("/nonexistent", "nightfall-worktrees");
const worktrees = [
  { id: "a1", name: "nightfall", branch: "develop", path: root },
  {
    id: "b2",
    name: "nightfall.feature",
    branch: "feature",
    path: join(root, ".worktrees", "feature"),
  },
  { id: "c3", name: "other", branch: "feature", path: join("/elsewhere") },
];

/** Verifies restart defaults to the backend of the current worktree. */
test("restart targets the backend by default", () => {
  assert.deepEqual(parseCliArgs(["restart"]), {
    command: "restart",
    selector: null,
    services: ["backend"],
    json: false,
  });
});

/** Verifies repeated and comma-separated services merge, and `all` expands. */
test("services accept repeats, commas, and all", () => {
  assert.deepEqual(
    parseCliArgs(["start", "feature", "-s", "backend,ui", "--service", "ui"])
      .services,
    ["backend", "ui"],
  );
  assert.deepEqual(parseCliArgs(["stop", "-s", "all"]).services, [
    "backend",
    "ui",
    "wasm",
    "artnet-sender",
    "sacn-sender",
  ]);
});

/** Verifies bad commands, services, and stray arguments are rejected. */
test("invalid arguments are rejected", () => {
  assert.throws(() => parseCliArgs(["reboot"]), /Unknown command/);
  assert.throws(() => parseCliArgs(["toString"]), /Unknown command/);
  assert.throws(() => parseCliArgs(["start", "-s", "db"]), /Unknown service/);
  assert.throws(() => parseCliArgs(["start", "-s", ","]), /at least one/);
  assert.throws(() => parseCliArgs(["list", "extra"]), /Unexpected argument/);
  assert.equal(parseCliArgs([]).command, "help");
});

/** Verifies the deepest worktree containing the cwd wins when none is named. */
test("no selector picks the worktree containing the cwd", () => {
  assert.equal(
    selectWorktree(worktrees, null, join(root, ".worktrees", "feature", "src"))
      .id,
    "b2",
  );
  assert.equal(selectWorktree(worktrees, null, join(root, "webui")).id, "a1");
  assert.throws(
    () => selectWorktree(worktrees, null, join("/tmp")),
    /not inside a worktree/,
  );
});

/** Verifies selectors match by path, id, or name and reject ambiguous branches. */
test("selectors match path, id, name, or a unique branch", () => {
  assert.equal(selectWorktree(worktrees, root, "/").id, "a1");
  assert.equal(selectWorktree(worktrees, "c3", "/").id, "c3");
  assert.equal(selectWorktree(worktrees, "nightfall.feature", "/").id, "b2");
  assert.equal(selectWorktree(worktrees, "develop", "/").id, "a1");
  assert.throws(() => selectWorktree(worktrees, "feature", "/"), /several/);
  assert.throws(() => selectWorktree(worktrees, "nope", "/"), /No worktree/);
});
