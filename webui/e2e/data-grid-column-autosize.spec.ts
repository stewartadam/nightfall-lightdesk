// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  frontendOnlyTest as test,
} from "./playwright-fixtures";

/** Reads the rendered width to verify header/body layout after resizing. */
async function width(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

/** Verifies auto-size reads offscreen live data, respects bounds, and keeps drag resizing. */
test("column edge double-click fits current content without changing selection or neighbors", async ({
  page,
}, testInfo) => {
  await page.route("**/grid-column-autosize", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div><script type="module" src="/e2e/fixtures/data-grid-column-autosize.tsx"></script></body></html>',
    }),
  );
  await page.goto("/grid-column-autosize");
  const grid = page.getByRole("grid");
  const fixed = grid.locator('[data-grid-header-id="tanstack-header-fixed"]');
  const content = grid.locator(
    '[data-grid-header-id="tanstack-header-content"]',
  );
  const bounded = grid.locator(
    '[data-grid-header-id="tanstack-header-bounded"]',
  );
  const minimum = grid.locator(
    '[data-grid-header-id="tanstack-header-minimum"]',
  );
  const handle = fixed.locator("[data-grid-resize-handle]");
  await expect(fixed).toBeVisible();
  await grid.locator("#tanstack-cell-1-0").click();
  const selection = await grid.getAttribute("data-selection-range");
  const contentWidth = await width(content);
  await expect(grid.locator("#tanstack-cell-0-99")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle long content" }).click();

  await handle.dblclick();
  await expect.poll(() => width(fixed)).toBeGreaterThan(240);
  const fittedWidth = await width(fixed);
  expect(await width(grid.locator("#tanstack-cell-0-0"))).toBe(fittedWidth);
  expect(await width(content)).toBe(contentWidth);
  await expect(grid).toHaveAttribute("data-selection-range", selection!);
  await expect(fixed).toHaveAttribute("data-selected", "false");
  await expect(page.getByTestId("last-resize")).toHaveText(
    `fixed:${fittedWidth}`,
  );

  await content.locator("[data-grid-resize-handle]").dblclick();
  await expect.poll(() => width(content)).toBeGreaterThan(contentWidth + 100);
  await bounded.locator("[data-grid-resize-handle]").dblclick();
  await expect.poll(() => width(bounded)).toBe(140);
  await minimum.locator("[data-grid-resize-handle]").dblclick();
  await expect.poll(() => width(minimum)).toBe(100);
  await grid.screenshot({ path: testInfo.outputPath("autosized-columns.png") });

  await page.getByRole("button", { name: "Toggle long content" }).click();
  await handle.dblclick();
  await expect.poll(() => width(fixed)).toBeLessThan(90);
  const shortWidth = await width(fixed);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect.poll(() => width(fixed)).toBe(shortWidth + 60);
  await handle.dblclick();
  await expect.poll(() => width(fixed)).toBe(shortWidth);

  await handle.focus();
  await handle.press("ArrowRight");
  await expect.poll(() => width(fixed)).toBe(shortWidth + 10);
  await handle.press("Shift+ArrowLeft");
  await expect.poll(() => width(fixed)).toBe(shortWidth + 9);
  await handle.press("Home");
  await expect.poll(() => width(fixed)).toBe(90);
  await handle.dblclick();
  await expect.poll(() => width(fixed)).toBe(shortWidth);
  await expect(handle).toHaveAttribute("aria-valuenow", String(shortWidth));
  await expect(grid).toHaveAttribute("data-selection-range", selection!);
});
