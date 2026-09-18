// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import {
  seedStartupShowfileName,
  waitForDockviewApp,
} from "./showfile-startup";

const BACKEND_TARGET_FPS = 44;
const MIN_EXPECTED_BACKEND_FPS = 40;

/** Submits a command through the header command line. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/** Waits until app stores and the backend metrics stream are available. */
async function waitForBackendMetrics(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return Boolean(stores?.dockApi?.get?.() && stores?.engineMetrics?.get);
      }),
    )
    .toBe(true);

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as any).appStores.engineMetrics.get()?.fps ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}

/** Reads the latest backend FPS value published to the instrumentation store. */
async function readBackendFps(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as any).appStores.engineMetrics.get()?.fps ?? 0,
  );
}

/** Verifies the backend FPS metric tracks an operator-requested frame target. */
test("backend fps metric tracks the configured frame target", async ({
  page,
}) => {
  await seedStartupShowfileName(page);
  await page.goto("/?e2e=1&scenario=backend-fps-metrics");
  await waitForDockviewApp(page, {
    createIfMissing: true,
    newShowfileName: "backend-fps-metrics",
  });
  await waitForBackendMetrics(page);

  await submitCommand(page, `fps ${BACKEND_TARGET_FPS}`);

  await expect
    .poll(() => readBackendFps(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(MIN_EXPECTED_BACKEND_FPS);
});
