// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/**
 * Ensures the docked app shell consumes the viewport without creating body scroll.
 */
test("app shell keeps vertical overflow inside panels", async ({ page }) => {
  await page.setViewportSize({ width: 1519, height: 1283 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(2_000);

  const metrics = await page.evaluate(() => {
    const app = document.querySelector("main#app");
    const statusBar = document.querySelector(
      '[role="region"][aria-label="Application status bar"]',
    );
    return {
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      appBottom: app?.getBoundingClientRect().bottom ?? 0,
      statusBarBottom: statusBar?.getBoundingClientRect().bottom ?? 0,
    };
  });

  expect(
    Math.max(metrics.bodyScrollHeight, metrics.documentScrollHeight),
  ).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.appBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.statusBarBottom).toBeLessThanOrEqual(
    metrics.viewportHeight + 1,
  );
});
