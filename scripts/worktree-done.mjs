// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

/** Runs a read or fetch without shell interpolation and preserves failure details. */
function output(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Overrides Worktrunk's comparison target for this process tree only. */
function targetEnvironment(target) {
  const env = { ...process.env };
  const index = Number(env.GIT_CONFIG_COUNT ?? 0);
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = "worktrunk.default-branch";
  env[`GIT_CONFIG_VALUE_${index}`] = target;
  return env;
}

/** Checks merged PR targets before letting Worktrunk perform its normal safe removal. */
function main() {
  const { values, positionals } = parseArgs({
    options: {
      foreground: { type: "boolean" },
      reap: { type: "boolean" },
      "no-delete-branch": { type: "boolean" },
      "no-hooks": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(
      "Usage: wt done [branch ...] [--foreground] [--reap] [--no-delete-branch] [--no-hooks] [-y]\n" +
        "Requires a merged same-repository GitHub PR for each branch. Defaults to the current branch.\n" +
        "Fetches each PR target from origin and keeps Worktrunk's merge and dirty-worktree checks.\n" +
        "For branches without merged PRs, paths, or forced cleanup, use wt remove directly.\n",
    );
    return;
  }

  const branches = positionals.length
    ? positionals
    : [output("git", ["symbolic-ref", "--quiet", "--short", "HEAD"])];
  const repository = output("git", ["remote", "get-url", "origin"]);
  const plans = [...new Set(branches)].map((branch) => {
    output("git", ["show-ref", "--verify", `refs/heads/${branch}`]);
    const pr = JSON.parse(
      output("gh", [
        "pr",
        "view",
        branch,
        "--repo",
        repository,
        "--json",
        "state,baseRefName,headRefName,isCrossRepository,url",
      ]),
    );
    if (
      pr.state !== "MERGED" ||
      pr.isCrossRepository ||
      pr.headRefName !== branch
    ) {
      throw new Error(
        `${branch}: expected a merged same-repository PR; nothing removed. Use wt remove for manual cleanup.`,
      );
    }
    output("git", ["check-ref-format", `refs/heads/${pr.baseRefName}`]);
    return { branch, target: pr.baseRefName, url: pr.url };
  });

  // Finish lookups and fetches before removing any requested worktree.
  for (const target of new Set(plans.map((plan) => plan.target))) {
    output("git", [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${target}:refs/remotes/origin/${target}`,
    ]);
  }
  const flags = Object.keys(values)
    .filter((key) => values[key])
    .map((key) => `--${key}`);
  // Remove the invoking worktree last so subsequent commands retain their cwd.
  const current = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf8" },
  ).stdout?.trim();
  plans.sort(
    (a, b) => Number(a.branch === current) - Number(b.branch === current),
  );
  for (const { branch, target, url } of plans) {
    process.stderr.write(
      `Checking ${branch} against origin/${target} (${url})\n`,
    );
    const result = spawnSync("wt", ["remove", ...flags, "--", branch], {
      stdio: "inherit",
      env: targetEnvironment(`origin/${target}`),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`wt done: ${error.message}\n`);
  process.exitCode = 1;
}
