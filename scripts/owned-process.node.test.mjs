// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import fkill from "fkill";

const harnessFixture = fileURLToPath(
  new URL("./test-fixtures/owned-process-harness.mjs", import.meta.url),
);
const childFixture = fileURLToPath(
  new URL("./test-fixtures/owned-process-child.mjs", import.meta.url),
);

/** Waits until a predicate succeeds or its deadline expires. */
async function waitFor(predicate, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Returns whether a process exists without changing its state. */
function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

/** Waits for a child process and returns its exit code and signal. */
function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** Reads the process identifiers written by a ready fixture descendant. */
function readMarker(markerPath) {
  return JSON.parse(readFileSync(markerPath, "utf8"));
}

/** Force-kills a test-owned process tree when a failed test leaves it behind. */
async function forceKillTestProcessGroup(processGroupId) {
  if (!processGroupId) return;
  if (process.platform === "win32") {
    await fkill(processGroupId, {
      force: true,
      silent: true,
      tree: true,
      waitForExit: 2_000,
    });
    return;
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ESRCH") {
      throw error;
    }
  }
}

/** Starts one lifecycle harness with an isolated marker and cleanup directory. */
function startScenario(root, mode) {
  const markerPath = join(root, `${mode}-marker.json`);
  const cleanupPath = join(root, `${mode}-cleanup`);
  mkdirSync(cleanupPath);
  const harness = spawn(
    process.execPath,
    [harnessFixture, mode, markerPath, cleanupPath],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  return { cleanupPath, harness, markerPath };
}

/** Waits for a fixture descendant and returns its recorded ownership metadata. */
async function waitForMarker(markerPath) {
  await waitFor(() => existsSync(markerPath), "fixture readiness");
  return readMarker(markerPath);
}

/** Verifies normal completion removes stubborn descendants and temporary data. */
test("owned commands clean up descendants after normal exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-owned-process-test-"));
  const scenario = startScenario(root, "exit-zero");
  let marker;
  try {
    marker = await waitForMarker(scenario.markerPath);
    const outcome = await waitForExit(scenario.harness);
    assert.deepEqual(outcome, { code: 0, signal: null });
    await waitFor(() => !processExists(marker.pid), "descendant exit");
    assert.equal(existsSync(scenario.cleanupPath), false);
  } finally {
    scenario.harness.kill("SIGKILL");
    await forceKillTestProcessGroup(marker?.processGroupId);
    rmSync(root, { force: true, recursive: true });
  }
});

/** Verifies failure status survives cleanup of descendants and temporary data. */
test("owned commands preserve failure exit status after cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-owned-process-test-"));
  const scenario = startScenario(root, "exit-failure");
  let marker;
  try {
    marker = await waitForMarker(scenario.markerPath);
    const outcome = await waitForExit(scenario.harness);
    assert.deepEqual(outcome, { code: 7, signal: null });
    await waitFor(() => !processExists(marker.pid), "descendant exit");
    assert.equal(existsSync(scenario.cleanupPath), false);
  } finally {
    scenario.harness.kill("SIGKILL");
    await forceKillTestProcessGroup(marker?.processGroupId);
    rmSync(root, { force: true, recursive: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  /** Verifies interrupted runners force-kill descendants and preserve signals. */
  test(`owned commands clean up descendants after ${signal}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "nightfall-owned-process-test-"));
    const scenario = startScenario(root, "stay-running");
    let marker;
    try {
      marker = await waitForMarker(scenario.markerPath);
      scenario.harness.kill(signal);
      const outcome = await waitForExit(scenario.harness);
      assert.deepEqual(outcome, { code: null, signal });
      await waitFor(() => !processExists(marker.pid), "descendant exit");
      assert.equal(existsSync(scenario.cleanupPath), false);
    } finally {
      scenario.harness.kill("SIGKILL");
      await forceKillTestProcessGroup(marker?.processGroupId);
      rmSync(root, { force: true, recursive: true });
    }
  });
}

/** Verifies cleanup remains scoped away from an unrelated process group. */
test("owned command cleanup leaves unrelated process groups running", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-owned-process-test-"));
  const unrelatedMarkerPath = join(root, "unrelated-marker.json");
  const unrelated = spawn(
    process.execPath,
    [childFixture, unrelatedMarkerPath, "0"],
    { detached: process.platform !== "win32", stdio: "ignore" },
  );
  unrelated.unref();
  const scenario = startScenario(root, "exit-zero");
  let marker;
  try {
    await waitForMarker(unrelatedMarkerPath);
    marker = await waitForMarker(scenario.markerPath);
    const outcome = await waitForExit(scenario.harness);
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.equal(processExists(unrelated.pid), true);
  } finally {
    scenario.harness.kill("SIGKILL");
    await forceKillTestProcessGroup(marker?.processGroupId);
    await forceKillTestProcessGroup(unrelated.pid);
    rmSync(root, { force: true, recursive: true });
  }
});
