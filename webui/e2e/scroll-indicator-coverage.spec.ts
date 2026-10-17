// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/** Loads the embedded demo at a given viewport size with the default panel layout. */
async function openDemo(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
}

/** Returns the edge strip of a scroll indicator overlay. */
function edge(overlay: Locator, side: string): Locator {
  return overlay.locator(`.nf-scroll-edge[data-edge="${side}"]`);
}

/**
 * Checks the Controls strip marks the controls hidden off its right edge, and that clicking that
 * edge scrolls sideways so the left edge appears.
 */
test("controls strip shows horizontal scroll edges", async ({
  page,
}, testInfo) => {
  await openDemo(page, 900, 900);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByPlaceholder("Type a command or search...").fill("Open Clips");
  await page.keyboard.press("Enter");
  const controls = page.locator(".controls");
  await expect(controls).toBeVisible();
  const overlay = controls.locator(".nf-scroll-indicators");
  await expect(edge(overlay, "right")).toHaveAttribute("data-visible", "true");
  await expect(edge(overlay, "left")).toHaveAttribute("data-visible", "false");
  await controls.screenshot({
    path: testInfo.outputPath("controls-start.png"),
  });

  await edge(overlay, "right").click();
  await expect(edge(overlay, "left")).toHaveAttribute("data-visible", "true");
  await controls.screenshot({
    path: testInfo.outputPath("controls-scrolled.png"),
  });
});

/**
 * Checks the command palette uses the shared edges in place of its own carets, and that moving
 * the keyboard selection to the end keeps the selected row clear of the top edge.
 */
test("command palette list shows shared scroll edges", async ({
  page,
}, testInfo) => {
  await openDemo(page, 1200, 800);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator('[data-dialog-kind="command-palette"]');
  await expect(palette.getByRole("textbox")).toBeVisible();
  await expect(palette.locator("[data-scroll-overflow]")).toHaveCount(0);
  const overlay = palette.locator(".nf-scroll-indicators");
  await expect(edge(overlay, "bottom")).toHaveAttribute("data-visible", "true");
  await page.screenshot({
    path: testInfo.outputPath("command-palette-top.png"),
  });

  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageDown");
  await expect(edge(overlay, "top")).toHaveAttribute("data-visible", "true");
  await page.screenshot({
    path: testInfo.outputPath("command-palette-end.png"),
  });

  // Walk to the first command of a later category, whose short heading would
  // otherwise leave the selected row partly under the top edge.
  const target = await palette.evaluate((root) => {
    const lists = [...root.querySelectorAll("[data-command-category-title]")]
      .map((title) => title.nextElementSibling)
      .slice(2);
    const first = lists
      .map((list) => list?.querySelector<HTMLElement>("[data-command-index]"))
      .find(Boolean);
    return Number(first?.dataset.commandIndex);
  });
  await page.keyboard.press("PageUp");
  await page.keyboard.press("PageUp");
  await page.keyboard.press("PageUp");
  for (let step = 0; step < target; step++)
    await page.keyboard.press("ArrowDown");
  const selected = palette.locator(`[data-command-index="${target}"]`);
  await expect(selected).toHaveAttribute("data-selected", "true");
  await expect(edge(overlay, "top")).toHaveAttribute("data-visible", "true");
  await expect
    .poll(async () => {
      const row = await selected.boundingBox();
      const cover = await edge(overlay, "top").boundingBox();
      return row && cover ? row.y - (cover.y + cover.height) : -1;
    })
    .toBeGreaterThanOrEqual(-1);
  await page.keyboard.press("Escape");
});

/**
 * Checks the object palette reveals keyboard-selected rows below its bottom edge rather than
 * underneath it, where the blurred edge would intercept clicks.
 */
test("object palette keeps keyboard selection clear of the edges", async ({
  page,
}, testInfo) => {
  await openDemo(page, 1200, 700);
  await page.keyboard.press("ControlOrMeta+P");
  const viewport = page.getByRole("region", { name: "Showfile objects" });
  await expect(viewport).toBeVisible();
  const overlay = viewport.locator("xpath=following-sibling::*[1]");
  await expect(edge(overlay, "bottom")).toHaveAttribute("data-visible", "true");

  const bottomEdge = edge(overlay, "bottom");
  for (let step = 0; step < 12; step++) await page.keyboard.press("ArrowDown");
  const selected = viewport.locator('[data-selected="true"]');
  const selectedBox = await selected.boundingBox();
  const edgeBox = await bottomEdge.boundingBox();
  expect(selectedBox && edgeBox).toBeTruthy();
  if (selectedBox && edgeBox) {
    expect(selectedBox.y + selectedBox.height).toBeLessThanOrEqual(
      edgeBox.y + 1,
    );
  }
  await page.screenshot({ path: testInfo.outputPath("object-palette.png") });
  await page.keyboard.press("Escape");
});

/**
 * Checks a dropdown menu taller than the space beside its trigger marks the hidden items, and
 * that pressing the edge scrolls the menu without closing it.
 */
test("dropdown menu shows scroll edges when it is cut short", async ({
  page,
}, testInfo) => {
  await openDemo(page, 1200, 260);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const menu = page.locator('[data-component="DropdownMenuContent"]');
  await expect(menu).toBeVisible();
  const overlay = page.locator(".nf-scroll-indicators.nf-menu-scroll");
  await expect(edge(overlay, "bottom")).toHaveAttribute("data-visible", "true");
  await page.screenshot({ path: testInfo.outputPath("dropdown-menu.png") });

  await edge(overlay, "bottom").click();
  await expect(menu).toBeVisible();
  await expect(edge(overlay, "top")).toHaveAttribute("data-visible", "true");
  await page.screenshot({
    path: testInfo.outputPath("dropdown-menu-scrolled.png"),
  });
});

/**
 * Checks a panel whose content is taller than its Dockview group gets edges from the shared
 * panel frame, without the panel adding a scroll area of its own.
 */
test("dockview panel frame shows edges for overflowing panels", async ({
  page,
}, testInfo) => {
  await openDemo(page, 1000, 700);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "panel-frame-check",
      component: "OscInput",
      title: "OSC",
      params: { initialPanelId: "panel-frame-check" },
      floating: { width: 300, height: 220 },
    });
  });
  const frame = page.locator(
    '.nf-scroll-area:has(> .nf-scroll-viewport [data-panel-id="panel-frame-check"])',
  );
  const overlay = frame.locator(":scope > .contents > .nf-scroll-indicators");
  await expect(edge(overlay, "bottom")).toHaveAttribute("data-visible", "true");
  await expect(edge(overlay, "top")).toHaveAttribute("data-visible", "false");
  await page.screenshot({ path: testInfo.outputPath("panel-frame.png") });

  await edge(overlay, "bottom").click();
  await expect(edge(overlay, "top")).toHaveAttribute("data-visible", "true");
  await page.screenshot({
    path: testInfo.outputPath("panel-frame-scrolled.png"),
  });
});

/**
 * Checks the DMX universe channel grid marks channels hidden below it and keeps marking them
 * while channel values update live.
 */
test("DMX channel grid shows scroll edges", async ({ page }, testInfo) => {
  await openDemo(page, 1200, 800);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "dmx-grid-check",
      component: "DmxUniverse",
      title: "DMX",
      params: { initialPanelId: "dmx-grid-check" },
      position: {
        referencePanel: api.panels.find(
          (panel: any) => panel.view.contentComponent === "Visualizer",
        )?.id,
        direction: "within",
      },
    });
  });
  const panel = page.locator('[data-panel-id="dmx-grid-check"]');
  const overlay = panel
    .locator('[role="tabpanel"] .nf-scroll-indicators')
    .last();
  await expect(edge(overlay, "bottom")).toHaveAttribute("data-visible", "true");
  await page.screenshot({ path: testInfo.outputPath("dmx-grid.png") });

  await edge(overlay, "bottom").click();
  await expect(edge(overlay, "top")).toHaveAttribute("data-visible", "true");
  await page.screenshot({ path: testInfo.outputPath("dmx-grid-scrolled.png") });
});
