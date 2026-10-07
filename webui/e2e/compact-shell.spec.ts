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
  // Only the first four panels are pinned as tabs; the bar never scrolls.
  const tabs = nav.getByRole("tab");
  await expect(tabs).toHaveCount(Math.min(4, structure.panels));
  const tabStrip = nav.getByRole("tablist");
  expect(
    await tabStrip.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);

  // The shown panel spans the screen instead of its docked minimum width.
  const content = page.locator(".dv-content-container").first();
  const box = await content.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  // One slim header replaces the two-row header and the status bar.
  await expect(
    page.getByRole("region", { name: "Application status bar" }),
  ).toHaveCount(0);
  const headerBox = await page.locator(".nf-app-header").boundingBox();
  expect(headerBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48);
  // The panel runs edge to edge without a frame, and its toolbars keep to one row.
  const group = page.locator(".dv-groupview").first();
  await expect(group).toHaveCSS("border-top-width", "0px");
  for (const toolbar of await page.locator(".nf-panel-toolbar").all()) {
    if (!(await toolbar.isVisible())) continue;
    expect((await toolbar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(50);
  }
  // The 3D Visualizer toolbar overflows, so its right edge shows a scroll cue
  // sitting over the toolbar it belongs to.
  const rightCue = page
    .locator(
      '.nf-panel-toolbar-scroll [data-edge="right"][data-visible="true"]',
    )
    .first();
  await expect(rightCue).toBeVisible();
  const cueBox = await rightCue.boundingBox();
  const toolbarBoxes = [];
  for (const toolbar of await page.locator(".nf-panel-toolbar").all()) {
    if (await toolbar.isVisible())
      toolbarBoxes.push(await toolbar.boundingBox());
  }
  expect(
    toolbarBoxes.some(
      (bar) =>
        bar &&
        cueBox &&
        cueBox.y >= bar.y - 1 &&
        cueBox.y + cueBox.height <= bar.y + bar.height + 1 &&
        Math.abs(cueBox.x + cueBox.width - (bar.x + bar.width)) <= 2,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("01-compact-start.png") });

  const secondTab = tabs.nth(1);
  await secondTab.click();
  await expect(secondTab).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("02-second-tab.png") });

  // Only the tab bar takes the panel-switching flick, never the panel content.
  const before = (await readDockStructure(page)).active;
  const surface = page.locator(".dv-content-container").first();
  await flick(surface, -160);
  await page.waitForTimeout(300);
  expect((await readDockStructure(page)).active).toBe(before);
  await flick(nav, -160);
  await expect
    .poll(async () => (await readDockStructure(page)).active)
    .not.toBe(before);
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath("03-after-swipe.png") });
  await flick(nav, 160);
  await expect
    .poll(async () => (await readDockStructure(page)).active)
    .toBe(before);

  await nav.getByRole("button", { name: "Panels" }).click();
  const sheet = page.getByRole("dialog", { name: "Panels" });
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("04-panel-sheet.png") });
  await sheet.getByRole("button", { name: "Cues", exact: true }).click();
  await expect(sheet).toBeHidden();
  // An unpinned panel borrows the last tab slot; the Panels button stays put.
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(3)).toContainText("Cues");
  await expect(tabs.nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(nav.getByRole("button", { name: "Panels" })).toHaveText(
    "Panels",
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
  await nav.getByRole("tab").nth(1).click();
  await nav.getByRole("tab").nth(2).click();
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

/** Verifies the Panels sheet pins, unpins and reorders tabs, and that the order survives a reload. */
test("compact shell pins and reorders tabs from the Panels sheet", async ({
  page,
}, testInfo) => {
  await page.goto(DEMO_PATH);
  await waitForDockviewApp(page);
  const nav = page.getByRole("navigation", { name: "Panels" });
  const tabs = nav.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  // Show a pinned panel so the last slot holds a pin, not a visiting panel.
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  const lastPinned = (await tabs.nth(3).innerText()).trim();

  await nav.getByRole("button", { name: "Panels" }).click();
  const sheet = page.getByRole("dialog", { name: "Panels" });
  const pinClips = sheet.getByRole("button", { name: "Pin Clips" });
  await pinClips.click();
  // Pinning a fifth panel takes the last tab slot and unpins its previous owner.
  await expect(tabs.nth(3)).toContainText("Clips");
  await expect(pinClips).toHaveAttribute("aria-pressed", "true");
  await expect(
    sheet.getByRole("button", { name: `Pin ${lastPinned}` }),
  ).toHaveAttribute("aria-pressed", "false");

  // Dragging a row's handle to the top makes it the first tab.
  const handle = sheet.getByRole("button", { name: "Reorder Clips" });
  const firstRow = sheet.locator("[data-compact-row-id]").first();
  const from = await handle.boundingBox();
  const to = await firstRow.boundingBox();
  if (!from || !to) throw new Error("sheet rows are not laid out");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 8 });
  await page.screenshot({ path: testInfo.outputPath("06-dragging.png") });
  await page.mouse.up();
  await expect(tabs.first()).toContainText("Clips");
  await page.screenshot({ path: testInfo.outputPath("07-reordered.png") });

  // The arrow keys reorder too, and focus stays on the handle between presses.
  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(tabs.nth(2)).toContainText("Clips");
  await expect(handle).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(tabs.first()).toContainText("Clips");

  await pinClips.click();
  await expect(tabs.first()).not.toContainText("Clips");
  await expect(pinClips).toHaveAttribute("aria-pressed", "false");
  await pinClips.click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.reload();
  await waitForDockviewApp(page);
  await tabs.first().click();
  await expect(tabs.nth(3)).toContainText("Clips");
});

/** Verifies the slim header keeps the status bar's controls one tap away. */
test("compact header carries the status bar controls", async ({
  page,
}, testInfo) => {
  await page.goto(DEMO_PATH);
  await waitForDockviewApp(page);
  const header = page.getByRole("navigation", { name: "Global" });
  await expect(header.getByRole("status")).toHaveAccessibleName("Connected");
  await expect(
    header.getByRole("button", { name: /^(Undo:|Nothing to undo)/ }),
  ).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Open command palette" }),
  ).toBeVisible();

  // The logo opens the main menu, which names the showfile.
  const mainMenu = header.getByRole("button", { name: "Main menu" });
  await mainMenu.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByTestId("compact-showfile-name")).toHaveText(
    "nightfall-demo",
  );
  for (const item of ["Object Palette", "Reset Demo", "Settings"]) {
    await expect(
      menu.getByRole("button", { name: new RegExp(`^${item}`) }),
    ).toBeVisible();
  }
  // The menu opens downward and stays on screen.
  const menuBox = await menu.boundingBox();
  expect(menuBox?.y ?? -1).toBeGreaterThan(0);
  expect((menuBox?.x ?? -1) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(
    PHONE.width,
  );
  await page.screenshot({ path: testInfo.outputPath("08-more-menu.png") });

  // On a phone in landscape the long menu scrolls instead of running off the bottom.
  await page.setViewportSize({ width: PHONE.height, height: PHONE.width });
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return (box?.y ?? 0) + (box?.height ?? Number.POSITIVE_INFINITY);
    })
    .toBeLessThanOrEqual(PHONE.width);
  await page.setViewportSize(PHONE);

  // Picking an item added for the phone closes the menu like any other item.
  await menu.getByRole("button", { name: "Object Palette" }).click();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await mainMenu.click();
  await menu.getByRole("button", { name: /^Settings/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

/** Verifies a tap does not leave a hover tooltip open, since touch has no hover to end it. */
test("compact shell taps show tooltips only on triggers with no action", async ({
  page,
}, testInfo) => {
  await page.goto(DEMO_PATH);
  await waitForDockviewApp(page);
  const header = page.getByRole("navigation", { name: "Global" });
  const dot = header.getByRole("status");
  const undo = header.getByRole("button", {
    name: /^(Undo:|Nothing to undo)/,
  });
  // The connection dot sits beside the logo, left of the undo controls.
  expect((await dot.boundingBox())?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(
    (await undo.boundingBox())?.x ?? 0,
  );

  // Tapping the dot shows its status; the next tap elsewhere hides it.
  await dot.tap();
  await expect(page.getByRole("tooltip")).toHaveText("Connected");
  await page.screenshot({ path: testInfo.outputPath("09-status-tooltip.png") });
  await page.getByRole("navigation", { name: "Panels" }).tap();
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // A button keeps its own action, and its hover tooltip stays closed.
  await page
    .locator('.nf-panel-toolbar [data-component="Tooltip"] button:enabled')
    .filter({ visible: true })
    .first()
    .tap();
  await page.waitForTimeout(900);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
