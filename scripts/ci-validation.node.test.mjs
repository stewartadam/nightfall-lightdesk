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
  readFileSync(
    new URL("../.github/workflows/ci-precommit.yml", import.meta.url),
    "utf8",
  ),
);

/** Cheap validation and browser feedback must not acquire unrelated build barriers. */
test("validation jobs wait only for their preparation prerequisites", () => {
  assert.equal(jobs["source-checks"].needs, "scope");
  assert.equal(jobs.native.needs, "scope");
  assert.equal(jobs["native-tests"].needs, "scope");
  assert.deepEqual(jobs.webui.needs, [
    "scope",
    "wasm-bridge",
    "browser-runtime",
  ]);
  assert.deepEqual(jobs["browser-smoke"].needs, [
    "scope",
    "native-tests",
    "wasm-bridge",
    "browser-runtime",
  ]);
  for (const id of [
    "source-checks",
    "native",
    "native-tests",
    "webui",
    "browser-smoke",
  ]) {
    assert.equal(jobs[id].if, `\${{ !startsWith(github.ref, 'refs/tags/') }}`);
    assert.ok(
      jobs.precommit.needs.includes(id),
      `${id} must contribute to the required check`,
    );
  }
});

/** Execute the production aggregate guard against failed, cancelled, and skipped prerequisites. */
test("the required check accepts only successful prerequisite results", () => {
  assert.equal(jobs.precommit.name, "Run prek hooks");
  assert.match(jobs.precommit.if, /!cancelled\(\)/);
  assert.match(jobs.precommit.if, /needs.scope.result != 'skipped'/);
  const guard = jobs.precommit.steps[0];
  assert.equal(guard.env.JOB_RESULTS, `\${{ toJSON(needs) }}`);
  const results = Object.fromEntries(
    jobs.precommit.needs.map((id) => [id, { result: "success" }]),
  );
  /** Run the workflow shell against a controlled collection of dependency outcomes. */
  function runGuard(outcomes) {
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", guard.run],
      {
        env: { ...process.env, JOB_RESULTS: JSON.stringify(outcomes) },
        encoding: "utf8",
      },
    );
    assert.ifError(result.error);
    return result.status;
  }
  assert.equal(runGuard(results), 0);
  for (const id of jobs.precommit.needs) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.notEqual(
        runGuard({ ...results, [id]: { result } }),
        0,
        `${id}: ${result}`,
      );
    }
  }
});
