// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/**
 * Checks that an overflowing panel tab strip scrolls by wheel without showing
 * a scrollbar, and that its hidden-tab count button keeps one width while the
 * single-digit count changes.
 */
test("panel tab strips scroll without a scrollbar and keep a steady overflow count", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);

  const overflow = page.locator(".dv-tabs-overflow-dropdown-default").first();
  await expect(overflow).toBeVisible();
  const header = page
    .locator(".dv-tabs-and-actions-container")
    .filter({ has: overflow })
    .first();
  const strip = header.locator(".dv-scrollable").first();
  const tabs = strip.locator(".dv-tabs-container");

  await strip.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => tabs.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(strip.locator(".dv-scrollbar")).toBeHidden();
  await header.screenshot({ path: testInfo.outputPath("tab-strip.png") });

  const count = overflow.locator("span");
  const widths = new Map<string, number>();
  for (const digit of ["1", "4", "7"]) {
    await count.evaluate((element, text) => {
      element.textContent = text;
    }, digit);
    const box = await overflow.boundingBox();
    widths.set(digit, box?.width ?? 0);
  }
  expect(new Set(widths.values()).size).toBe(1);
});
