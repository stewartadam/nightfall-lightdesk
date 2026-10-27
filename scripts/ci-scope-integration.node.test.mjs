// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  appIndependent,
  dashboardSources,
  readChangedPaths,
} from "./ci-scope.mjs";

const repositoryRoot = new URL("..", import.meta.url);

/**
 * Listing a script as app-independent is only safe while nothing the app validation jobs run can
 * reach it. Collect what those jobs execute: their workflows and composite actions, the package
 * scripts those invoke (expanded recursively), the build and test configuration, and every
 * non-test app source under scripts/, webui/, playwright/ and worktree-dashboard/. None of it may
 * name an app-independent script.
 */
test("app-independent scripts are never run by app validation", () => {
  /** Whether a path skips app validation under the scope policy. */
  const independent = (path) =>
    appIndependent.some((pattern) => pattern.test(path));
  /** Read a repository file as text. */
  const read = (path) => readFileSync(new URL(path, repositoryRoot), "utf8");
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const sources = new Map(
    [
      ".github/workflows/ci.yml",
      ".github/workflows/native-validation.yml",
      ".github/workflows/wasm.yml",
      ".github/workflows/browser-demo.yml",
      "vite.config.ts",
      "playwright.config.ts",
      ...tracked.filter(
        (path) =>
          path.startsWith(".github/actions/") ||
          /^tsconfig[^/]*\.json$/.test(path) ||
          (/^(scripts|webui|playwright|worktree-dashboard)\//.test(path) &&
            /\.(c?m?[jt]sx?|d\.mts|json|sh|html)$/.test(path) &&
            !path.endsWith(".node.test.mjs") &&
            !independent(path)),
      ),
    ].map((path) => [path, read(path)]),
  );
  const packageScripts = JSON.parse(read("package.json")).scripts;
  const pending = [...sources.values()];
  const expanded = new Set();
  while (pending.length) {
    for (const [, name] of pending
      .pop()
      .matchAll(/\bpnpm (?:run )?([\w:-]+)/g)) {
      if (packageScripts[name] && !expanded.has(name)) {
        expanded.add(name);
        sources.set(`package.json#${name}`, packageScripts[name]);
        pending.push(packageScripts[name]);
      }
    }
  }
  const scripts = tracked.filter(
    (path) =>
      path.startsWith("scripts/") &&
      !path.endsWith(".node.test.mjs") &&
      independent(path),
  );
  assert.ok(scripts.includes("scripts/update-deps.sh"));
  for (const script of scripts) {
    const name = script.slice("scripts/".length);
    for (const [source, contents] of sources) {
      assert.ok(!contents.includes(name), `${source} runs ${script}`);
    }
  }
});

/**
 * Dashboard-only PRs skip the native backend and Chromium product flows, which is only safe while
 * no app source outside the dashboard loads it. The e2e build in vite.config.ts lists the page as
 * an entry, and the WebUI typecheck that still runs for dashboard changes covers what it bundles.
 */
test("dashboard sources are never loaded by other app sources", () => {
  /** Whether a path is part of the dashboard or skips app validation entirely. */
  const exempt = (path) =>
    [...appIndependent, ...dashboardSources].some((pattern) =>
      pattern.test(path),
    );
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  assert.ok(tracked.some((path) => dashboardSources[0].test(path)));
  for (const path of tracked.filter(
    (path) =>
      (path.startsWith(".github/") ||
        /^(scripts|webui|playwright|crates)\//.test(path) ||
        /^[^/]+\.(c?m?[jt]s|json|ya?ml)$/.test(path)) &&
      /\.(c?m?[jt]sx?|json|ya?ml|html|rs)$/.test(path) &&
      !path.includes(".node.test.") &&
      !["package.json", "vite.config.ts", "scripts/ci-scope.mjs"].includes(
        path,
      ) &&
      !exempt(path),
  )) {
    const contents = readFileSync(new URL(path, repositoryRoot), "utf8");
    assert.ok(!contents.includes("worktree-dashboard"), `${path} loads it`);
  }
});

/** The actual acquisition command includes deleted and renamed packaging inputs. */
test("workflow diff captures both sides of renames and removed files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nightfall-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  /** Run Git inside the isolated repository used to exercise the workflow diff. */
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      env: environment,
      encoding: "utf8",
    });
  git("init", "--quiet");
  git("config", "user.name", "CI scope test");
  git("config", "user.email", "ci@example.invalid");
  writeFileSync(join(directory, "old.txt"), "resource");
  writeFileSync(join(directory, "deleted.txt"), "removed");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  git("mv", "old.txt", "new.txt");
  git("rm", "deleted.txt");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "change");
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const command = workflow.jobs.scope.steps.find(
    (step) => step.name === "Capture changed paths as data",
  ).run;
  execFileSync("bash", ["-c", command], {
    cwd: directory,
    env: { ...environment, EVENT_NAME: "pull_request" },
  });
  assert.deepEqual(
    readChangedPaths(
      readFileSync(join(directory, ".ci-changed-files"), "utf8"),
    ).sort(),
    ["deleted.txt", "new.txt", "old.txt"],
  );
});

/** Selection stays permissionless and both consumers use their own output. */
test("workflow connects independent validation outputs", () => {
  const { jobs } = parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    jobs.desktop.if,
    "needs.selection.outputs.desktop_package == 'true'",
  );
  assert.equal(
    jobs["desktop-check"].if,
    "needs.selection.outputs.desktop_check == 'true'",
  );
  assert.equal(
    jobs["browser-demo"].if,
    "needs.selection.outputs.browser_package == 'true' || needs.selection.outputs.browser_preview == 'true'",
  );
  assert.match(
    jobs["browser-demo"].with["product-flows"],
    /^\$\{\{ needs\.selection\.outputs\.browser_package == 'true' \}\}$/,
  );
  for (const job of ["native", "browser-smoke"]) {
    assert.match(
      jobs[job].if,
      /needs\.selection\.outputs\.native == 'true'/,
      job,
    );
  }
  assert.match(jobs.webui.if, /needs\.selection\.outputs\.app == 'true'/);
  assert.deepEqual(jobs.selection.permissions ?? {}, {});
});
