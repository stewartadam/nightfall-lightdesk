// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** iPhone 15-sized portrait viewport. */
const PHONE = { width: 393, height: 852 };
const DEMO_PATH =
  process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
    ? "/demo/app/?startup:draftRecovery=false&e2e=1"
    : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1";

test.describe.configure({ timeout: 120_000 });
test.use({
  viewport: PHONE,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
});

/** Reads the docked session layout the compact shell must leave untouched. */
async function readSavedSession(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("nightfall-ui-layouts");
    return raw ? (JSON.parse(raw).sessionLayout ?? null) : null;
  });
}

/** Reads how the compact workspace arranged its Dockview groups. */
async function readDockStructure(page: Page) {
  return page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    return {
      groups: api.groups.length,
      edges: ["left", "right", "bottom"].filter((position) =>
        Boolean(api.getEdgeGroup(position)),
      ),
      panels: api.panels.length,
      active: api.activePanel?.id as string | undefined,
    };
  });
}

/** Dispatches a one-finger horizontal flick, since Playwright has no swipe gesture. */
async function flick(target: Locator, dx: number): Promise<void> {
  await target.evaluate((element, distance) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    /** Builds a touch list for one finger at the given x position. */
    const touchAt = (clientX: number) =>
      new Touch({ identifier: 1, target: element, clientX, clientY: y });
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        touches: [touchAt(x)],
        changedTouches: [touchAt(x)],
      }),
    );
    element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [touchAt(x + distance)],
      }),
    );
  }, dx);
}

/** Verifies the phone layout shows one full-width panel with tab, swipe and sheet navigation. */
test("compact shell navigates one panel at a time on a phone", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(DEMO_PATH);
  await waitForDockviewApp(page);
  const savedBefore = await readSavedSession(page);

  const nav = page.getByRole("navigation", { name: "Panels" });
  await expect(nav).toBeVisible();
  await expect.poll(async () => (await readDockStructure(page)).groups).toBe(1);
  const structure = await readDockStructure(page);
  expect(structure.edges).toEqual([]);
  const tabs = nav.getByRole("tab");
  await expect(tabs).toHaveCount(structure.panels);

  // The shown panel spans the screen instead of its docked minimum width.
  const content = page.locator(".dv-content-container").first();
  const box = await content.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("01-compact-start.png") });

  await nav.getByRole("tab", { name: "Clips" }).click();
  await expect(nav.getByRole("tab", { name: "Clips" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("02-clips.png") });

  const before = (await readDockStructure(page)).active;
  const surface = page.locator(".dv-content-container").first();
  await flick(surface, -160);
  await expect
    .poll(async () => (await readDockStructure(page)).active)
    .not.toBe(before);
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath("03-after-swipe.png") });
  await flick(surface, 160);
  await expect
    .poll(async () => (await readDockStructure(page)).active)
    .toBe(before);

  await nav.getByRole("button", { name: "Panels" }).click();
  const sheet = page.getByRole("dialog", { name: "Panels" });
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("04-panel-sheet.png") });
  await sheet.getByRole("button", { name: "Cues", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(nav.getByRole("tab", { name: "Cues" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Panels opened by features fold into the single group as well.
  expect((await readDockStructure(page)).groups).toBe(1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("05-opened-cues.png") });

  expect(await readSavedSession(page)).toEqual(savedBefore);
  expect(pageErrors).toEqual([]);

  // Widening the window returns to the saved docked arrangement.
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(nav).toHaveCount(0);
  await expect
    .poll(async () => (await readDockStructure(page)).edges.length)
    .toBeGreaterThan(0);
});

/** Verifies a docked arrangement survives a trip through the compact shell unchanged. */
test("compact shell keeps the docked arrangement for when the window widens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(DEMO_PATH);
  await waitForDockviewApp(page);
  await expect
    .poll(async () => (await readDockStructure(page)).edges.length)
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-Visualizer")
      ?.api.close(),
  );
  await expect
    .poll(async () => JSON.stringify(await readSavedSession(page)))
    .not.toContain("panel-Visualizer");
  const docked = await readSavedSession(page);

  await page.setViewportSize(PHONE);
  const nav = page.getByRole("navigation", { name: "Panels" });
  await expect(nav).toBeVisible();
  await expect.poll(async () => (await readDockStructure(page)).groups).toBe(1);
  await expect(nav.getByRole("tab", { name: "3D Visualizer" })).toHaveCount(0);
  await nav.getByRole("tab", { name: "Clips" }).click();
  await nav.getByRole("tab", { name: "Programmer" }).click();
  expect(await readSavedSession(page)).toEqual(docked);

  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(nav).toHaveCount(0);
  await expect
    .poll(async () => (await readDockStructure(page)).edges.length)
    .toBeGreaterThan(0);
  expect((await readDockStructure(page)).groups).toBeGreaterThan(1);
  expect(
    await page.evaluate(() =>
      Boolean(
        (window as any).appStores.dockApi.get().getPanel("panel-Visualizer"),
      ),
    ),
  ).toBe(false);
});
