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
import { readChangedPaths } from "./ci-scope.mjs";

/** The actual acquisition command includes deleted and renamed packaging inputs. */
test("workflow diff captures both sides of renames and removed files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nightfall-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  /** Run Git inside the isolated repository used to exercise the workflow diff. */
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });
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
      new URL("../.github/workflows/ci-precommit.yml", import.meta.url),
      "utf8",
    ),
  );
  const command = workflow.jobs.scope.steps.find(
    (step) => step.name === "Capture changed paths as data",
  ).run;
  execFileSync("bash", ["-c", command], {
    cwd: directory,
    env: { ...process.env, EVENT_NAME: "pull_request" },
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
      new URL("../.github/workflows/ci-precommit.yml", import.meta.url),
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
    "needs.selection.outputs.browser_package == 'true'",
  );
  assert.deepEqual(jobs.selection.permissions ?? {}, {});
});
