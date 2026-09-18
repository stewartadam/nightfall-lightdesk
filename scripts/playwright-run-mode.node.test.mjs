// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePlaywrightRunMode } from "./playwright-run-mode.mjs";

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
