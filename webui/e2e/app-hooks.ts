// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Node-side helpers for the app's test hooks (`window.__nightfallTest`) and
 * the frontend mode a Playwright run serves.
 */

import type { Page } from "@playwright/test";
import type { HarnessName } from "./harness/registry";

/**
 * Returns the blank harness page's URL. Naming a fixture mounts it into the
 * page's `#root` as soon as the page loads.
 */
export function harnessPageUrl(fixture?: HarnessName): string {
  const page = "/e2e/fixtures/harness.html";
  return fixture ? `${page}?fixture=${fixture}` : page;
}

/**
 * Whether this run serves the e2e production build through `vite preview`
 * rather than the Vite dev server. Only dev servers offer HMR.
 */
export const servesE2eBuild =
  process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "e2e";

/** Skip reason for specs that exercise Vite's hot module replacement. */
export const REQUIRES_DEV_SERVER =
  "Exercises hot module replacement, which only the Vite dev server offers; run with --vite-mode dev";

/** Waits until the current document has published its test hooks. */
export async function waitForTestHooks(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForFunction(() => window.__nightfallTest !== undefined, {
    timeout: timeoutMs,
  });
}

/**
 * Stops the engine connection so a store-seeded spec owns every store, and
 * waits until the runtime reports it disconnected.
 */
export async function disconnectEngine(page: Page): Promise<void> {
  await waitForTestHooks(page);
  await page.evaluate(() => window.__nightfallTest.runtime.disconnect());
}

/**
 * Serves every script as an empty module so the page shows only its static
 * bootstrap document. Matches the dev server's `main.tsx` and the build's
 * hashed entry chunk alike.
 */
export async function blockAppScripts(page: Page): Promise<void> {
  await page.route("**/*", (route) =>
    route.request().resourceType() === "script"
      ? route.fulfill({ contentType: "application/javascript", body: "" })
      : route.fallback(),
  );
}
