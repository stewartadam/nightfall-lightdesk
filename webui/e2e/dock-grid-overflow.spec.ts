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
 * Docking a wide Timeline editor next to the Visualizer while the Clips edge
 * is open asks for more width than a 1440px window has; the grid panels must
 * shrink to fit the dock instead of pushing the Visualizer off screen, and
 * grow back to their minimums once the edge collapses.
 */
test("grid panels shrink to fit when their minimums exceed the dock", async ({
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
  const squeezed = await gridOverflow(page);
  expect(squeezed.clipsExpanded).toBe(true);
  expect(squeezed.editorWidth).toBeLessThan(640);
  await waitForVisualizerRedraw(page);
  await page.screenshot({ path: testInfo.outputPath("grid-fits-dock.png") });

  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().getEdgeGroup("left").collapse(),
  );
  await expect
    .poll(async () => (await gridOverflow(page)).editorWidth)
    .toBeGreaterThanOrEqual(640);
  expect((await gridOverflow(page)).overflow).toBe(0);
  await waitForVisualizerRedraw(page);
  await page.screenshot({
    path: testInfo.outputPath("grid-after-collapse.png"),
  });
});
