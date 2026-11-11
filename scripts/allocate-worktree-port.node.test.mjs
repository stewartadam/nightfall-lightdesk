// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  allocatePort,
  PORT_BLOCK_SIZE,
  pickPortBlock,
} from "./allocate-worktree-port.mjs";

const scriptPath = fileURLToPath(
  new URL("./allocate-worktree-port.mjs", import.meta.url),
);

/** Asserts that the block starting at `base` overlaps none of `takenPorts`. */
function assertClear(base, takenPorts) {
  for (const taken of takenPorts) {
    assert.ok(
      base + PORT_BLOCK_SIZE <= taken || taken + PORT_BLOCK_SIZE <= base,
      `${base} overlaps ${taken}`,
    );
  }
}

/**
 * Verifies new worktrees get an aligned port block that stays clear of every
 * port block other worktrees own, including unaligned ports.
 */
test("port blocks are aligned and avoid other worktrees", () => {
  assert.equal(
    pickPortBlock([], () => 0),
    3000,
  );
  assert.equal(
    pickPortBlock([], () => 0.999),
    3990,
  );
  assert.equal(
    pickPortBlock([3000], () => 0),
    3010,
  );
  // An unaligned 3005 owns 3005-3014, so both 3000 and 3010 are taken.
  assert.equal(
    pickPortBlock([3005], () => 0),
    3020,
  );
  for (let i = 0; i < 200; i += 1) {
    const base = pickPortBlock([3030, 3517, 3988]);
    assert.equal(base % PORT_BLOCK_SIZE, 0);
    assertClear(base, [3030, 3517, 3988]);
  }
  const everyBlock = Array.from({ length: 100 }, (_, i) => 3000 + i * 10);
  assert.throws(() => pickPortBlock(everyBlock), /NIGHTFALL_PORT/);
});

/**
 * Verifies a worktree keeps its current port while nothing overlaps it, and
 * moves to a free block when another worktree has claimed that range.
 */
test("a worktree keeps its port unless another worktree overlaps it", () => {
  assert.equal(allocatePort({ currentPort: 3640, takenPorts: [3000] }), 3640);
  assert.equal(
    allocatePort({ currentPort: Number.NaN, takenPorts: [], random: () => 0 }),
    3000,
  );
  const moved = allocatePort({
    currentPort: 3640,
    takenPorts: [3645],
    random: () => 0,
  });
  assert.equal(moved, 3000);
});

/**
 * Verifies the CLI reads ports from real Git worktrees: a new worktree avoids
 * both the primary checkout's unaligned port and a sibling's block, and an
 * inherited NIGHTFALL_PORT has no effect on the result.
 */
test("CLI avoids every other worktree's ports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nightfall-allocate-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "main");
  // Git hooks export repository selectors such as GIT_DIR; inheriting them would point Git at
  // the invoking checkout, and `git init` would then turn that repository bare.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  /** Runs a quiet Git command in `cwd`, isolated from the invoking repository. */
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", main], { env });
  git(
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  const sibling = join(root, "sibling");
  const fresh = join(root, "fresh");
  git(main, "worktree", "add", "-q", "-b", "sibling", sibling);
  git(main, "worktree", "add", "-q", "-b", "fresh", fresh);
  await writeFile(join(main, ".env"), "NIGHTFALL_PORT=3995\n");
  await writeFile(join(sibling, ".env"), "NIGHTFALL_PORT=3000\n");

  for (let i = 0; i < 10; i += 1) {
    const port = Number(
      execFileSync(process.execPath, [scriptPath, fresh], {
        env: { ...env, NIGHTFALL_PORT: "3000" },
      }).toString(),
    );
    assert.equal(port % PORT_BLOCK_SIZE, 0);
    assertClear(port, [3995, 3000]);
  }

  await writeFile(join(fresh, ".env"), "NIGHTFALL_PORT=3500\n");
  const kept = execFileSync(process.execPath, [scriptPath, fresh], {
    env,
  }).toString();
  assert.equal(kept.trim(), "3500");
});
