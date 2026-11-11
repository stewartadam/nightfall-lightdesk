// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/**
 * Measures the furthest any docked grid group reaches past the space the dock
 * gives the grid on any side, along with the open Timeline editor's width and
 * applied minimum width and whether the Clips edge is open.
 */
async function gridOverflow(page: Page) {
  return page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const center = api.component.element.getBoundingClientRect();
    let overflow = 0;
    for (const group of api.groups) {
      if (group.api.location.type !== "grid") continue;
      const box = group.element.getBoundingClientRect();
      overflow = Math.max(
        overflow,
        center.left - box.left,
        center.top - box.top,
        box.right - center.right,
        box.bottom - center.bottom,
      );
    }
    const editor = api.panels.find(
      (panel: any) => panel.api.component === "Timeline",
    );
    return {
      overflow: Math.round(overflow),
      editorWidth: editor ? Math.round(editor.group.api.width) : 0,
      editorMinimum: editor ? editor.group.minimumWidth : 0,
      clipsExpanded: !api.getEdgeGroup("left").isCollapsed(),
    };
  });
}

/**
 * Gives the Visualizer time to redraw after a dock resize before a screenshot.
 * Its worker renderer owns the canvas, so the page cannot observe when the new
 * frame lands, and slow CI renderers show a blank panel until it does.
 */
async function waitForVisualizerRedraw(page: Page) {
  await page.waitForTimeout(2_000);
}

/**
 * Docking a Timeline editor beside the Visualizer while the Clips edge is
 * open at 1440px must fit the dock at the panels' declared minimums, which
 * the dock enforces. Toolbars too narrow for their controls keep one row and
 * fold the rest behind "More actions".
 */
test("Timeline editor and Visualizer fit beside the open Clips edge", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  // A layout reset re-collapses edge groups a frame later, so keep expanding
  // the Clips edge until it stays open.
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        (window as any).appStores.dockApi.get().getEdgeGroup("left").expand(),
      );
      return (await gridOverflow(page)).clipsExpanded;
    })
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.timelines.get()).length,
      ),
    )
    .toBeGreaterThan(0);
  const uid = await page.evaluate(
    () => Object.keys((window as any).appStores.timelines.get())[0],
  );

  await page
    .locator(
      `[data-workspace-active="true"] [data-crud-select-id="${uid}"]:visible`,
    )
    .click();
  await expect(
    page.locator("[data-timeline-toolbar]:visible").first(),
  ).toBeVisible();
  // Wait until the editor's declared minimum is applied, so the overflow
  // check below runs against the layout that used to spill off screen.
  await expect
    .poll(async () => (await gridOverflow(page)).editorMinimum)
    .toBeGreaterThan(116);
  await expect.poll(async () => (await gridOverflow(page)).overflow).toBe(0);
  const fitted = await gridOverflow(page);
  expect(fitted.clipsExpanded).toBe(true);
  expect(fitted.editorWidth).toBeGreaterThanOrEqual(480);

  const toolbar = page.locator("[data-timeline-toolbar]:visible").first();
  const frame = toolbar.locator("xpath=..");
  const more = frame.locator("> .nf-panel-toolbar-more button");
  await expect(more).toBeVisible();
  // One row of 32px controls plus the toolbar's padding and border.
  await expect
    .poll(() => frame.evaluate((element) => element.clientHeight))
    .toBeLessThanOrEqual(48);
  await waitForVisualizerRedraw(page);
  await page.screenshot({ path: testInfo.outputPath("toolbar-one-row.png") });

  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(toolbar.locator("[inert]")).toHaveCount(0);
  // The last unfolded control is the topmost element where it is drawn.
  expect(
    await toolbar.evaluate((element) => {
      const last = element.querySelector<HTMLElement>(
        ":scope > .nf-toolbar-group:last-child > :last-child",
      )!;
      const rect = last.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit !== null && last.contains(hit);
    }),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("toolbar-unfolded.png") });
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(toolbar.locator("[inert]").first()).toBeAttached();
});
