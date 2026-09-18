// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

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

import { mayLaunchPlaywrightBrowser } from "./playwright-sandbox.mjs";
