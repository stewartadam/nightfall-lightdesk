// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    "wasm-bridge",
    "browser-runtime",
  ]);
  assert.deepEqual(jobs["browser-smoke"].needs, [
    "scope",
    "selection",
    "native",
    "wasm-bridge",
  ]);
  for (const id of ["source-checks", "native", "webui", "browser-smoke"]) {
    assert.equal(
      jobs[id].if,
      `\${{ !startsWith(github.ref, 'refs/tags/') && !inputs.preview }}`,
    );
  }
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
  assert.equal(
    jobs.gate.name,
    `\${{ inputs.preview && 'Preview gate' || 'CI gate' }}`,
  );
  assert.match(jobs.gate.if, /!cancelled\(\)/);
  assert.match(jobs.gate.if, /needs.scope.result != 'skipped'/);
  assert.match(jobs.gate.if, /!inputs.preview/);
  const guard = jobs.gate.steps[0];
  assert.equal(guard.env.JOB_RESULTS, `\${{ toJSON(needs) }}`);
  const results = Object.fromEntries(
    jobs.gate.needs.map((id) => [id, { result: "success" }]),
  );
  /** Run the workflow shell against a controlled collection of dependency outcomes. */
  function runGuard(outcomes, docs = "true") {
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", guard.run],
      {
        env: {
          ...process.env,
          JOB_RESULTS: JSON.stringify(outcomes),
          DOCS: docs,
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
});

/** Drafts acquire no source, so every job and the gate skip until the PR is ready for review. */
test("draft PRs skip the whole workflow", () => {
  assert.match(
    jobs.scope.if,
    /^github\.event\.pull_request\.draft != true && \(/,
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
