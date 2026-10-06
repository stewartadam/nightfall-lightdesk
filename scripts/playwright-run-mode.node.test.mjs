// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolvePlaywrightRunMode,
  resolvePlaywrightViteMode,
} from "./playwright-run-mode.mjs";

/** Verify native runs serve an e2e build and embedded-demo runs the dev server by default. */
test("defaults the Vite mode by target", () => {
  assert.equal(
    resolvePlaywrightViteMode({ targetsEmbeddedDemo: false }),
    "e2e",
  );
  assert.equal(resolvePlaywrightViteMode({ targetsEmbeddedDemo: true }), "dev");
});

/** Verify the command-line option outranks the environment, which outranks the default. */
test("prefers the requested Vite mode over the environment", () => {
  assert.equal(
    resolvePlaywrightViteMode({
      requested: "dev",
      environment: "preview",
      targetsEmbeddedDemo: false,
    }),
    "dev",
  );
  assert.equal(
    resolvePlaywrightViteMode({
      environment: "preview",
      targetsEmbeddedDemo: true,
    }),
    "preview",
  );
});

/** Verify a mistyped environment mode fails instead of silently falling back. */
test("rejects an unknown Vite mode from the environment", () => {
  assert.throws(
    () =>
      resolvePlaywrightViteMode({
        environment: "build",
        targetsEmbeddedDemo: false,
      }),
    /Unknown Playwright Vite mode build/,
  );
});

/** Verify ordinary Playwright tests retain native backend preparation. */
test("ordinary test runs prepare the native backend", () => {
  assert.deepEqual(resolvePlaywrightRunMode(["test"]), {
    isTestRun: true,
    needsBackend: true,
    targetsEmbeddedDemo: false,
  });
});

/** Verify embedded-demo targets keep test ownership without backend setup. */
test("embedded-demo tests skip native backend preparation", () => {
  assert.deepEqual(
    resolvePlaywrightRunMode(["test", "browser-demo.spec.ts"], "embedded-demo"),
    {
      isTestRun: true,
      needsBackend: false,
      targetsEmbeddedDemo: true,
    },
  );
});

/** Verify non-test Playwright commands never prepare a native backend. */
test("non-test commands skip native backend preparation", () => {
  assert.deepEqual(
    resolvePlaywrightRunMode(["install", "chromium"], "embedded-demo"),
    {
      isTestRun: false,
      needsBackend: false,
      targetsEmbeddedDemo: true,
    },
  );
});
