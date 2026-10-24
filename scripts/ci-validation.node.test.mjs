// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const { jobs } = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

/** Cheap validation and browser feedback must not acquire unrelated build barriers. */
test("validation jobs wait only for their preparation prerequisites", () => {
  assert.equal(jobs["source-checks"].needs, "scope");
  assert.deepEqual(jobs.native.needs, ["scope", "selection"]);
  assert.equal(
    jobs.native.with["rust-tests"],
    `\${{ needs.selection.outputs.rust == 'true' }}`,
  );
  assert.deepEqual(jobs.webui.needs, [
    "scope",
    "selection",
    "wasm-bridge",
    "browser-runtime",
  ]);
  assert.deepEqual(jobs["browser-smoke"].needs, [
    "scope",
    "selection",
    "native",
    "wasm-bridge",
  ]);
  assert.equal(
    jobs["source-checks"].if,
    `\${{ !startsWith(github.ref, 'refs/tags/') && !inputs.preview && !github.event.pull_request.draft }}`,
  );
  // Selection leaves app validation off for drafts and preview-only runs.
  for (const id of ["native", "webui", "browser-smoke"]) {
    assert.equal(
      jobs[id].if,
      `\${{ !startsWith(github.ref, 'refs/tags/') && needs.selection.outputs.app == 'true' }}`,
    );
  }
  for (const id of ["wasm-bridge", "browser-runtime"]) {
    assert.deepEqual(jobs[id].needs, ["scope", "selection"]);
    for (const output of ["app", "browser_package", "browser_preview"]) {
      assert.match(
        jobs[id].if,
        new RegExp(`needs\\.selection\\.outputs\\.${output} == 'true'`),
        `${id} builds for ${output}`,
      );
    }
  }
  assert.match(
    jobs["wasm-bridge"].if,
    /needs\.selection\.outputs\.desktop_package == 'true'/,
  );
  assert.deepEqual(jobs.docs.needs, ["scope", "selection"]);
  for (const id of [
    "source-checks",
    "native",
    "webui",
    "browser-smoke",
    "docs",
  ]) {
    assert.ok(
      jobs.gate.needs.includes(id),
      `${id} must contribute to the required check`,
    );
  }
});

/** Execute the production aggregate guard against failed, cancelled, and skipped prerequisites. */
test("the required check accepts only successful prerequisite results", () => {
  assert.equal(jobs.gate.name, "CI gate");
  assert.match(jobs.gate.if, /!cancelled\(\)/);
  assert.match(jobs.gate.if, /needs.scope.result != 'skipped'/);
  const [draftGuard, guard] = jobs.gate.steps;
  assert.equal(
    draftGuard.if,
    "inputs.preview || github.event.pull_request.draft",
  );
  assert.equal(
    guard.if,
    `\${{ !inputs.preview && !github.event.pull_request.draft }}`,
  );
  assert.equal(guard.env.JOB_RESULTS, `\${{ toJSON(needs) }}`);
  const results = Object.fromEntries(
    jobs.gate.needs.map((id) => [id, { result: "success" }]),
  );
  /** Run the workflow shell against a controlled collection of dependency outcomes. */
  function runGuard(outcomes, docs = "true", app = "true") {
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", guard.run],
      {
        env: {
          ...process.env,
          JOB_RESULTS: JSON.stringify(outcomes),
          DOCS: docs,
          APP: app,
        },
        encoding: "utf8",
      },
    );
    assert.ifError(result.error);
    return result.status;
  }
  assert.equal(runGuard(results), 0);
  for (const id of jobs.gate.needs) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.notEqual(
        runGuard({ ...results, [id]: { result } }),
        0,
        `${id}: ${result}`,
      );
    }
  }
  assert.equal(guard.env.DOCS, `\${{ needs.selection.outputs.docs }}`);
  const noDocs = { ...results, docs: { result: "skipped" } };
  assert.equal(runGuard(noDocs, "false"), 0, "unselected docs skip");
  assert.notEqual(
    runGuard(noDocs, ""),
    0,
    "missing docs selection stays strict",
  );
  assert.notEqual(
    runGuard({ ...noDocs, native: { result: "failure" } }, "false"),
    0,
    "skipped docs still require other jobs",
  );
  assert.equal(guard.env.APP, `\${{ needs.selection.outputs.app }}`);
  const appJobs = [
    "wasm-bridge",
    "browser-runtime",
    "native",
    "webui",
    "browser-smoke",
  ];
  const noApp = {
    ...noDocs,
    ...Object.fromEntries(appJobs.map((id) => [id, { result: "skipped" }])),
  };
  assert.equal(runGuard(noApp, "false", "false"), 0, "unselected app skips");
  assert.equal(
    runGuard(
      { ...noApp, "wasm-bridge": { result: "failure" } },
      "false",
      "false",
    ),
    0,
    "a preview-only WASM build does not decide the check",
  );
  assert.notEqual(
    runGuard(noApp, "false", ""),
    0,
    "missing app selection stays strict",
  );
  assert.notEqual(
    runGuard(noApp, "false", "true"),
    0,
    "selected app requires its jobs",
  );
  for (const id of ["scope", "selection", "source-checks"]) {
    assert.notEqual(
      runGuard({ ...noApp, [id]: { result: "failure" } }, "false", "false"),
      0,
      `skipped app still requires ${id}`,
    );
  }
});

/** Drafts acquire source only when opened, so later draft pushes skip every job and the gate. */
test("draft PRs skip the workflow after opening", () => {
  assert.match(
    jobs.scope.if,
    /^\(github\.event\.pull_request\.draft != true \|\| github\.event\.action == 'opened'\) && \(/,
  );
  for (const [id, job] of Object.entries(jobs)) {
    if (id !== "scope") {
      assert.ok(
        [job.needs ?? []].flat().length > 0,
        `${id} must depend on source acquisition`,
      );
    }
  }
});

/**
 * A manual preview run reports the required check on the PR head, so it must pass only while
 * the PR is a draft and fail once the PR is ready, when the full run decides the check.
 */
test("preview runs pass the gate only for draft PRs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nightfall-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "gh"), '#!/bin/sh\necho "$PR_DRAFT"\n', {
    mode: 0o755,
  });
  const draftGuard = jobs.gate.steps.find(
    (step) => step.if === "inputs.preview || github.event.pull_request.draft",
  );
  /** Run the draft guard against a stubbed GitHub CLI reporting the given draft state. */
  const run = (draft) =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", draftGuard.run], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        PR_DRAFT: draft,
        PR_NUMBER: "7",
        GH_REPO: "owner/repo",
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
      },
      encoding: "utf8",
    }).status;
  assert.equal(run("true"), 0);
  assert.notEqual(run("false"), 0);
  assert.notEqual(run(""), 0);
});
