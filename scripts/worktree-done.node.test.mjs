// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./worktree-done.mjs", import.meta.url));
const hasWorktrunk = spawnSync("wt", ["--version"]).status === 0;

/** Builds an isolated origin, stale clone, linked worktree, and deterministic GitHub CLI. */
function fixture(t, target = "develop") {
  const root = mkdtempSync(join(tmpdir(), "nightfall-wt-done-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream");
  const repo = join(root, "repo");
  const worktree = join(root, "feature worktree");
  const bin = join(root, "bin");
  mkdirSync(upstream);
  mkdirSync(bin);
  writeFileSync(join(root, "wt.toml"), "");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    WORKTRUNK_CONFIG_PATH: join(root, "wt.toml"),
    WORKTRUNK_SYSTEM_CONFIG_PATH: join(root, "wt.toml"),
    WORKTRUNK_PROJECT_CONFIG_PATH: join(root, "wt.toml"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GH_TEST_TARGET: target,
    GH_TEST_STATE: "MERGED",
  };
  /** Runs real Git in a selected repository using the isolated test configuration. */
  function git(cwd, ...args) {
    return execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git(upstream, "init", "-b", "main");
  git(upstream, "config", "user.name", "Test");
  git(upstream, "config", "user.email", "test@example.test");
  git(upstream, "commit", "--allow-empty", "-m", "initial");
  if (target !== "main") git(upstream, "switch", "-c", target);
  git(root, "clone", upstream, repo);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "worktrunk.default-branch", "main");
  git(repo, "worktree", "add", "-b", "feature", worktree);
  writeFileSync(join(worktree, "feature.txt"), "merged feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "feature");
  // Origin learns the feature only after the clone's tracking ref was created.
  git(upstream, "fetch", repo, "feature");
  git(upstream, "merge", "--squash", "FETCH_HEAD");
  git(upstream, "commit", "-m", "squash feature");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
if (process.env.GH_TEST_FAIL) { process.stderr.write('GitHub unavailable'); process.exit(1); }
const args = process.argv.slice(2);
if (args[0] !== 'pr' || args[1] !== 'view' || args[3] !== '--repo') process.exit(2);
process.stdout.write(JSON.stringify({ state: process.env.GH_TEST_STATE, baseRefName: args[2] === 'other' ? 'main' : process.env.GH_TEST_TARGET, headRefName: args[2], isCrossRepository: !!process.env.GH_TEST_FORK, url: 'https://github.com/test/repo/pull/1' }));
`,
    { mode: 0o755 },
  );
  /** Executes the cleanup script, defaulting to synchronous cleanup of the named branch. */
  function done(args = ["feature", "--foreground", "--no-hooks"], cwd = repo) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  }
  /** Checks both the feature reference and worktree survive a rejected cleanup. */
  function assertRetained(result) {
    assert.notEqual(result.status, 0, result.stderr);
    assert.ok(existsSync(worktree));
    git(repo, "show-ref", "--verify", "refs/heads/feature");
  }
  return { root, upstream, repo, worktree, env, git, done, assertRetained };
}

for (const target of ["main", "develop"]) {
  /** Exercises real squash-merge detection against freshly fetched PR targets. */
  test(`removes a squash-merged branch targeting ${target}`, {
    skip: !hasWorktrunk,
  }, (t) => {
    const f = fixture(t, target);
    const result = f.done();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.worktree), false);
    assert.throws(() =>
      f.git(f.repo, "show-ref", "--verify", "refs/heads/feature"),
    );
    assert.equal(f.git(f.repo, "config", "worktrunk.default-branch"), "main");
    assert.equal(
      f.git(f.repo, "rev-parse", `origin/${target}`),
      f.git(f.upstream, "rev-parse", "HEAD"),
    );
  });
}

/** Ensures a merged PR does not authorize deleting commits added locally afterwards. */
test("retains a branch with additional unmerged local work", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, "later.txt"), "keep this work\n");
  f.git(f.worktree, "add", "later.txt");
  f.git(f.worktree, "commit", "-m", "later work");
  const result = f.done();
  assert.equal(result.status, 0, result.stderr);
  f.git(f.repo, "show-ref", "--verify", "refs/heads/feature");
  assert.match(
    result.stderr,
    /[Uu]nmerged|[Nn]ot merged|[Nn]ot integrated|[Kk]ept|[Rr]etain/,
  );
});

/** Verifies Worktrunk still rejects a dirty worktree instead of discarding edits. */
test("refuses dirty worktrees", { skip: !hasWorktrunk }, (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, "feature.txt"), "uncommitted edit\n");
  f.assertRetained(f.done());
});

/** Exercises current-worktree resolution and propagates the shell's directory directive. */
test("defaults to the current branch and preserves shell integration", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  f.env.WORKTRUNK_DIRECTIVE_CD_FILE = join(f.root, "cd-directive");
  const result = f.done(["--foreground", "--no-hooks"], f.worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  assert.ok(existsSync(f.env.WORKTRUNK_DIRECTIVE_CD_FILE));
});

/** Honors explicit branch retention while still removing the merged worktree. */
test("forwards --no-delete-branch", { skip: !hasWorktrunk }, (t) => {
  const f = fixture(t);
  const result = f.done([
    "feature",
    "--foreground",
    "--no-hooks",
    "--no-delete-branch",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  f.git(f.repo, "show-ref", "--verify", "refs/heads/feature");
});

for (const state of ["OPEN", "CLOSED"]) {
  /** Refuses PRs that have not been merged before invoking any removal operation. */
  test(`refuses ${state.toLowerCase()} PRs`, (t) => {
    const f = fixture(t);
    f.env.GH_TEST_STATE = state;
    f.assertRetained(f.done());
  });
}

/** Leaves worktrees and branches intact when GitHub cannot provide reliable metadata. */
test("refuses cleanup after a GitHub lookup failure", (t) => {
  const f = fixture(t);
  f.env.GH_TEST_FAIL = "1";
  f.assertRetained(f.done());
});

/** Avoids using a different repository's identically named PR branch as evidence. */
test("refuses fork PRs", (t) => {
  const f = fixture(t);
  f.env.GH_TEST_FORK = "1";
  f.assertRetained(f.done());
});

/** A missing target must not trigger cleanup against stale tracking references. */
test("refuses cleanup when fetching the target fails", (t) => {
  const f = fixture(t);
  f.env.GH_TEST_TARGET = "deleted-target";
  f.assertRetained(f.done());
});

/** Rejects force flags so a typo cannot bypass the alias's normal cleanup checks. */
test("does not accept forced deletion", (t) => {
  const f = fixture(t);
  f.assertRetained(f.done(["feature", "-D"]));
});

/** Validates every requested branch before starting a potentially partial cleanup. */
test("a missing later branch prevents any removal", (t) => {
  const f = fixture(t);
  f.assertRetained(
    f.done(["feature", "missing-branch", "--foreground", "--no-hooks"]),
  );
});

/** Uses each PR's own target and removes the invoking worktree last, even if listed first. */
test("cleans multiple branches with mixed targets from the current worktree", {
  skip: !hasWorktrunk,
}, (t) => {
  const f = fixture(t);
  const other = join(f.root, "other-worktree");
  f.git(f.repo, "worktree", "add", "-b", "other", other, "origin/main");
  writeFileSync(join(other, "other.txt"), "other change\n");
  f.git(other, "add", "other.txt");
  f.git(other, "commit", "-m", "other feature");
  f.git(f.upstream, "switch", "main");
  f.git(f.upstream, "fetch", f.repo, "other");
  f.git(f.upstream, "merge", "--squash", "FETCH_HEAD");
  f.git(f.upstream, "commit", "-m", "squash other");
  const result = f.done(
    ["feature", "other", "feature", "--foreground", "--no-hooks"],
    f.worktree,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(existsSync(other), false);
  for (const branch of ["feature", "other"]) {
    assert.throws(() =>
      f.git(f.repo, "show-ref", "--verify", `refs/heads/${branch}`),
    );
  }
  assert.equal(f.git(f.repo, "config", "worktrunk.default-branch"), "main");
});
