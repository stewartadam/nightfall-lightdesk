// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

for (const viewport of [
  { width: 1800, height: 900 },
  { width: 1000, height: 640 },
  { width: 390, height: 844 },
]) {
  /** Keeps catalog scrolling and its edge gestures from moving the full-height workspace at each breakpoint. */
  test(`catalog scroll is isolated and adornments align at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/design-lab.html");
    const sidebar = page.getByRole("complementary", {
      name: "Design controls",
    });
    const catalog = page.getByRole("navigation", { name: "Component index" });
    const workspace = page.getByRole("region", {
      name: "Interactive dock workspace",
    });
    await expect(workspace).toBeVisible();
    const bounds = (await workspace.boundingBox())!;
    const paddingBottom = await page
      .locator("main")
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom),
      );
    expect(bounds.y + bounds.height).toBeCloseTo(
      viewport.height - paddingBottom,
      0,
    );
    const rightEdges = await catalog
      .locator("h2 span, h3 span, button svg")
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().right),
      );
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1);
    await page.screenshot({
      path: testInfo.outputPath("catalog-alignment.png"),
      fullPage: true,
    });

    await sidebar.hover();
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => sidebar.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await catalog.getByRole("button").last().focus();
    await expect(catalog.getByRole("button").last()).toBeInViewport();
    await sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(150);
    expect(await workspace.boundingBox()).toEqual(bounds);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.locator("main").evaluate((element) => element.scrollTop),
    ).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBe(viewport.height);
    expect(
      await sidebar.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("catalog-scrolled.png"),
      fullPage: true,
    });
  });
}

/** Verifies overflowing demo contents remain scrollable inside their panel while the dock and page stay fixed. */
test("panel contents scroll inside the fixed Dockview", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Sliders/ })
    .click();
  const workspace = page.getByRole("region", {
    name: "Interactive dock workspace",
  });
  const panel = page.getByRole("region", { name: "Slider examples" });
  const bounds = (await workspace.boundingBox())!;
  await panel.hover();
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    panel.getByRole("switch", { name: "Disable sliders" }),
  ).toBeInViewport();
  expect(await workspace.boundingBox()).toEqual(bounds);
  expect(
    await page.locator("main").evaluate((element) => element.scrollTop),
  ).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("panel-scrolled.png"),
    fullPage: true,
  });
});
