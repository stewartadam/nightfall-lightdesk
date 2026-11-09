// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { nightfallTestDataDir } from "./nightfall-test-data-dir.mjs";
import { buildEnvLines, resolvePort } from "./setup-env.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
/** setup-env.mjs and the local modules it imports. */
const SETUP_ENV_FILES = [
  "setup-env.mjs",
  "nightfall-test-data-dir.mjs",
  "playwright-path.mjs",
  "showfile-storage.mjs",
  "worktree-data-dir.mjs",
];

/**
 * Converts dotenv lines into a key-value map for assertions.
 */
function envMapFromLines(lines) {
  return parseEnv(lines.join("\n"));
}

/** Verifies inherited settings survive while generated worktree values win. */
test("secondary worktree inherits dotenv text before applying overrides", () => {
  const seed =
    '# Local settings\nMY_SETTING=kept\nCUSTOM="hello # world"\nNIGHTFALL_PORT=3030\nPLAYWRIGHT_BROWSERS_PATH=/old\nNIGHTFALL_DATA_DIR=/main/data\nNIGHTFALL_OUTPUT_SACN_ENABLED=true\nNIGHTFALL_OUTPUT_ARTNET=true\nNIGHTFALL_INPUT_SACN_ENABLED=true\nNIGHTFALL_INPUT_ARTNET=true\n';
  const projectRoot = "/repo/branch";
  const lines = buildEnvLines({
    port: 3674,
    projectRoot,
    mainWorktree: "/repo/main",
    seed,
  });
  const env = envMapFromLines(lines);
  assert.deepEqual(lines.slice(0, 3), seed.split("\n").slice(0, 3));
  assert.equal(env.MY_SETTING, "kept");
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
      seed: "MY_SETTING=kept\nNIGHTFALL_OUTPUT_ARTNET=true\n",
    }),
  );
  assert.equal(env.MY_SETTING, "kept");
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

/**
 * Verifies an explicit --port wins, a checkout otherwise keeps its own port or
 * falls back to 3030, and malformed --port values are rejected rather than
 * silently replaced.
 */
test("port comes from --port, then the checkout's own .env, then 3030", () => {
  assert.equal(resolvePort(["--port=3640"], "5172"), 3640);
  assert.equal(resolvePort([], "5172"), 5172);
  assert.equal(resolvePort([], undefined), 3030);
  assert.equal(resolvePort([], "not-a-port"), 3030);
  for (const bad of ["--port=", "--port=abc", "--port=0", "--port=70000"]) {
    assert.throws(() => resolvePort([bad], "5172"), /--port/, bad);
  }
});

/**
 * Verifies a secondary worktree without --port is refused instead of falling
 * back to the default port another checkout may already use.
 */
test("secondary worktree requires --port", () => {
  assert.throws(
    () => resolvePort([], undefined, { secondary: true }),
    /wt hook pre-start setup-env/,
  );
  assert.equal(resolvePort(["--port=3640"], "3030", { secondary: true }), 3640);
});

/**
 * Runs setup-env in a throwaway repository with another checkout's port
 * exported, and verifies the generated .env uses the --port value (or the
 * default for a fresh primary checkout), never the inherited variable.
 */
test("inherited NIGHTFALL_PORT never reaches the generated .env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nightfall-setup-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "main");
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", main]);
  for (const file of SETUP_ENV_FILES) {
    await cp(join(scriptsDir, file), join(main, "scripts", file));
  }
  execFileSync("git", ["-C", main, "add", "scripts"]);
  execFileSync("git", [
    "-C",
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  execFileSync("git", ["-C", main, "worktree", "add", "-q", worktree]);
  const env = {
    ...process.env,
    NIGHTFALL_PORT: "5172",
    NIGHTFALL_DATA_DIR: join(root, "data"),
  };

  /** Runs one checkout's copy of setup-env and returns the port it wrote. */
  const runSetup = async (checkout, args) => {
    execFileSync(
      process.execPath,
      [join(checkout, "scripts", "setup-env.mjs"), ...args],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return parseEnv(await readFile(join(checkout, ".env"), "utf8"))
      .NIGHTFALL_PORT;
  };

  assert.equal(await runSetup(main, []), "3030");
  assert.equal(await runSetup(worktree, ["--port=3640"]), "3640");
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [join(worktree, "scripts", "setup-env.mjs")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
});
