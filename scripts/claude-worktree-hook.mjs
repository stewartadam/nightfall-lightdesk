// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Runs Git in the main checkout and returns trimmed stdout, or null when Git fails. */
function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Runs Worktrunk without a terminal so approval prompts cannot block Claude Code.
 * Worktrunk's progress and project hook output go to stderr, which Claude Code shows
 * on failure; stdout is captured because Claude Code reads it as the hook result.
 */
function wt(args) {
  const result = spawnSync("wt", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wt ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout;
}

/**
 * Creates the worktree Claude Code asked for through `wt switch`, so Worktrunk's
 * project hooks (`.env`, dependencies, build seeding) run exactly as they do for a
 * manually created worktree. Worktrunk picks the path from its own template, so the
 * path Claude Code proposed is ignored and the real one is printed for Claude Code.
 * New branches start from origin's default branch, matching Claude Code's own default.
 */
function create({ base_path: basePath, branch_name: branch }) {
  const exists =
    git(basePath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]) !== null;
  const args = [
    "-C",
    basePath,
    "switch",
    "--yes",
    "--no-cd",
    "--format",
    "json",
  ];
  if (!exists) {
    args.push("--create");
    const remoteHead = git(basePath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead) args.push("--base", remoteHead);
  }
  const { path } = JSON.parse(wt([...args, branch]));
  process.stdout.write(`${path}\n`);
}

/**
 * Removes a Claude Code worktree through `wt remove` so the pre-remove hook stops its
 * services. Worktrunk refuses dirty worktrees and keeps unmerged branches, so session
 * cleanup never discards work; Claude Code then reports the worktree as kept.
 */
function remove({ base_path: basePath, worktree_path: worktreePath }) {
  wt(["-C", basePath, "remove", "--yes", "--foreground", worktreePath]);
}

/** Dispatches a Claude Code WorktreeCreate or WorktreeRemove hook payload from stdin. */
function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  switch (input.hook_event_name) {
    case "WorktreeCreate":
      create(input);
      break;
    case "WorktreeRemove":
      remove(input);
      break;
    default:
      throw new Error(`unsupported hook event ${input.hook_event_name}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`claude-worktree-hook: ${error.message}\n`);
  process.exit(1);
}
