// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Keeps sticky search usable above portaled hints while filtering and committing multiple selections. */
test("searchable selects keep overflow hints below search", async ({
  page,
}, testInfo) => {
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Selects/ })
    .click();
  const trigger = page.getByRole("button", {
    name: "Fixture zones",
    exact: true,
  });
  await trigger.click();
  const menu = page.locator("[data-hs-select-dropdown].opened");
  await menu.evaluate((element) => {
    element.style.maxHeight = "150px";
  });
  await menu.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const top = page.locator(
    '.nf-scroll-indicators[style*="position: fixed"] [data-edge="top"][data-visible="true"]',
  );
  await expect(top).toBeVisible();
  const search = menu.getByPlaceholder("Search options");
  const searchBox = await search.boundingBox();
  const hintBox = await top.boundingBox();
  expect(hintBox!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height);
  await search.click();
  await search.fill("Overhead");
  await expect(menu.locator('[data-value="overhead"]')).toBeVisible();
  await menu.locator('[data-value="overhead"]').click();
  await page.screenshot({
    path: testInfo.outputPath("advanced-select-search.png"),
  });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator('select[aria-label="Fixture zones"]')).toHaveValues(
    ["left", "right", "overhead"],
  );
  await expect(
    page.locator(
      '.nf-scroll-indicators[style*="position: fixed"] [data-visible="true"]',
    ),
  ).toHaveCount(0);
});

/** Keeps every cue-trigger option reachable when a narrow lab panel places its toggle near the viewport edge. */
test("advanced selects flip into available viewport space", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  const form = page.getByRole("region", { name: "Input form examples" });
  const trigger = form.getByRole("button", {
    name: "Cue trigger",
    exact: true,
  });
  await trigger.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await trigger.click();
  const menu = page.locator("[data-hs-select-dropdown].opened");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-placement", /^top/);
  await expect
    .poll(async () => {
      const bounds = await menu.boundingBox();
      return Boolean(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 900 &&
          bounds.y + bounds.height <= 700,
      );
    })
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 700 });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect
    .poll(async () => {
      const bounds = await menu.boundingBox();
      return Boolean(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 390 &&
          bounds.y + bounds.height <= 700,
      );
    })
    .toBe(true);
  await expect(menu.locator('[data-value="timecode"]')).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("advanced-select-bottom-edge.png"),
  });
  await menu.locator('[data-value="timecode"]').click();
  await expect(trigger).toContainText("Timecode");
  await expect(menu).toBeHidden();

  await trigger.evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-placement", /^bottom/);
  // Constrain the plugin-owned viewport to exercise overflow without replacing its options.
  const previousMaxHeight = await menu.evaluate((element) => {
    const previous = element.style.maxHeight;
    element.style.maxHeight = "80px";
    return previous;
  });
  const hints = page.locator('.nf-scroll-indicators[style*="position: fixed"]');
  await expect(hints.locator('[data-edge="bottom"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await menu.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(hints.locator('[data-edge="top"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await expect(hints.locator('[data-edge="bottom"]')).toHaveAttribute(
    "data-visible",
    "false",
  );
  await page.screenshot({
    path: testInfo.outputPath("advanced-select-scrolled.png"),
  });
  await menu.evaluate((element, maxHeight) => {
    element.style.maxHeight = maxHeight;
    element.scrollTop = 0;
  }, previousMaxHeight);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});
