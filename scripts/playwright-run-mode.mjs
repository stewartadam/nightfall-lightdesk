// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PLAYWRIGHT_VITE_MODES } from "./playwright-cli-options.mjs";
import { mayLaunchPlaywrightBrowser } from "./playwright-sandbox.mjs";

/**
 * Classifies one wrapper invocation so embedded-demo tests can avoid native
 * application setup while retaining their owned frontend lifecycle.
 */
export function resolvePlaywrightRunMode(playwrightArgs, target = "native") {
  const isTestRun =
    playwrightArgs[0] === "test" && mayLaunchPlaywrightBrowser(playwrightArgs);
  const targetsEmbeddedDemo = target === "embedded-demo";
  return {
    isTestRun,
    needsBackend: isTestRun && !targetsEmbeddedDemo,
    targetsEmbeddedDemo,
  };
}

/**
 * Chooses how the run serves the web UI: the `--vite-mode` option, then
 * `NIGHTFALL_PLAYWRIGHT_VITE_MODE`, then an e2e build for native runs and
 * the dev server for embedded-demo runs, whose artifact tests opt into
 * `preview` explicitly.
 */
export function resolvePlaywrightViteMode({
  requested,
  environment,
  targetsEmbeddedDemo,
}) {
  const configured = requested ?? environment?.trim();
  if (configured) {
    if (!PLAYWRIGHT_VITE_MODES.includes(configured)) {
      throw new Error(
        `Unknown Playwright Vite mode ${configured}; use one of ${PLAYWRIGHT_VITE_MODES.join(", ")}`,
      );
    }
    return configured;
  }
  return targetsEmbeddedDemo ? "dev" : "e2e";
}
