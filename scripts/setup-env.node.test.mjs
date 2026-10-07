// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { nightfallTestDataDir } from "./nightfall-test-data-dir.mjs";
import { buildEnvLines } from "./setup-env.mjs";

/**
 * Converts dotenv lines into a key-value map for assertions.
 */
function envMapFromLines(lines) {
  return parseEnv(lines.join("\n"));
}

/** Verifies inherited settings survive while generated worktree values win. */
test("secondary worktree inherits dotenv text before applying overrides", () => {
  const seed =
    '# Local settings\nNIGHTFALL_CARGO_COMMAND=mbx\nCUSTOM="hello # world"\nNIGHTFALL_PORT=3030\nPLAYWRIGHT_BROWSERS_PATH=/old\nNIGHTFALL_DATA_DIR=/main/data\nNIGHTFALL_OUTPUT_SACN_ENABLED=true\nNIGHTFALL_OUTPUT_ARTNET=true\nNIGHTFALL_INPUT_SACN_ENABLED=true\nNIGHTFALL_INPUT_ARTNET=true\n';
  const projectRoot = "/repo/branch";
  const lines = buildEnvLines({
    port: 3674,
    projectRoot,
    mainWorktree: "/repo/main",
    seed,
  });
  const env = envMapFromLines(lines);
  assert.deepEqual(lines.slice(0, 3), seed.split("\n").slice(0, 3));
  assert.equal(env.NIGHTFALL_CARGO_COMMAND, "mbx");
  assert.equal(env.CUSTOM, "hello # world");
  assert.equal(env.NIGHTFALL_PORT, "3674");
  assert.notEqual(env.PLAYWRIGHT_BROWSERS_PATH, "/old");
  assert.equal(env.NIGHTFALL_DATA_DIR, nightfallTestDataDir(projectRoot));
  for (const key of [
    "NIGHTFALL_OUTPUT_SACN_ENABLED",
    "NIGHTFALL_OUTPUT_ARTNET",
    "NIGHTFALL_INPUT_SACN_ENABLED",
    "NIGHTFALL_INPUT_ARTNET",
  ]) {
    assert.equal(env[key], "false");
  }
});

/** Verifies setup in the primary worktree preserves its custom settings. */
test("main worktree preserves existing custom settings", () => {
  const env = envMapFromLines(
    buildEnvLines({
      port: 3030,
      projectRoot: "/repo/main",
      mainWorktree: "/repo/main",
      seed: "NIGHTFALL_CARGO_COMMAND=mbx\nNIGHTFALL_OUTPUT_ARTNET=true\n",
    }),
  );
  assert.equal(env.NIGHTFALL_CARGO_COMMAND, "mbx");
  assert.equal(env.NIGHTFALL_OUTPUT_ARTNET, "true");
});

/**
 * Verifies the main worktree keeps network transport startup defaults open.
 */
test("main worktree env does not seed network transport overrides", () => {
  const projectRoot = "/repo/nightfall";
  const env = envMapFromLines(
    buildEnvLines({
      port: 3030,
      projectRoot,
      mainWorktree: projectRoot,
    }),
  );

  assert.equal(env.NIGHTFALL_PORT, "3030");
  assert.equal(env.NIGHTFALL_DATA_DIR, undefined);
  assert.equal(env.NIGHTFALL_OUTPUT_SACN_ENABLED, undefined);
  assert.equal(env.NIGHTFALL_OUTPUT_ARTNET, undefined);
  assert.equal(env.NIGHTFALL_INPUT_SACN_ENABLED, undefined);
  assert.equal(env.NIGHTFALL_INPUT_ARTNET, undefined);
});

/**
 * Verifies secondary worktrees start with network input and output disabled.
 */
test("secondary worktree env disables network transport startup", () => {
  const projectRoot = "/repo/nightfall-worktrees/branch-a";
  const env = envMapFromLines(
    buildEnvLines({
      port: 3674,
      projectRoot,
      mainWorktree: "/repo/nightfall",
    }),
  );

  assert.equal(env.NIGHTFALL_PORT, "3674");
  assert.equal(env.NIGHTFALL_DATA_DIR, nightfallTestDataDir(projectRoot));
  assert.equal(env.NIGHTFALL_OUTPUT_SACN_ENABLED, "false");
  assert.equal(env.NIGHTFALL_OUTPUT_ARTNET, "false");
  assert.equal(env.NIGHTFALL_INPUT_SACN_ENABLED, "false");
  assert.equal(env.NIGHTFALL_INPUT_ARTNET, "false");
});

/**
 * Verifies overridden keys are replaced in place rather than appended, so a
 * seed that already carries generated values (or duplicates from earlier runs)
 * yields exactly one assignment per key.
 */
test("overridden keys are replaced instead of duplicated", () => {
  const projectRoot = "/repo/nightfall-worktrees/branch-a";
  const seed =
    "NIGHTFALL_PORT=5172\nPLAYWRIGHT_BROWSERS_PATH=/old\nKEEP=1\nexport NIGHTFALL_PORT=3646\nPLAYWRIGHT_BROWSERS_PATH=/old\nNIGHTFALL_OUTPUT_ARTNET=true\n";
  const lines = buildEnvLines({
    port: 3674,
    projectRoot,
    mainWorktree: "/repo/nightfall",
    seed,
  });
  const keys = lines.map((line) => line.split("=")[0]);

  assert.equal(new Set(keys).size, keys.length);
  assert.equal(lines[0], "NIGHTFALL_PORT=3674");
  assert.equal(lines[2], "KEEP=1");
  assert.equal(lines[3], "NIGHTFALL_OUTPUT_ARTNET=false");
  assert.equal(envMapFromLines(lines).NIGHTFALL_PORT, "3674");
});
