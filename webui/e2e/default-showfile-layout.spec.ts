// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 2048, height: 1056 } });

/** Checks a new show's arrangement, visible geometry, and serialized edge state. */
test("new showfiles use the performance workspace", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
  });
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /New Showfile/ }).click();
  const createDialog = page.getByRole("dialog", { name: "New Showfile" });
  await createDialog.getByLabel("Show name").fill(`layout-${Date.now()}`);
  await createDialog
    .getByRole("checkbox", { name: "Include sample data" })
    .check();
  await createDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(createDialog).not.toBeVisible();
  await waitForDockviewApp(page);

  for (const title of ["Clips", "Groups", "Timelines", "3D Visualizer"]) {
    await expect(
      page.getByRole("tab", { name: title, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Add group", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Collapse controls", exact: true }),
  ).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();
        return {
          left: api
            .getPanel("panel-ClipList")
            .api.group.panels.map((panel: any) => panel.title),
          bottom: api
            .getPanel("panel-CommandLine")
            .api.group.panels.map((panel: any) => panel.title),
          right: api
            .getPanel("panel-PropertiesInspector")
            .api.group.panels.map((panel: any) => panel.title),
          collapsed: ["left", "bottom", "right"].map((edge) =>
            api.getEdgeGroup(edge).isCollapsed(),
          ),
          objects: api
            .getPanel("panel-Groups")
            .api.group.panels.map((panel: any) => panel.title),
          activeObjects:
            api.getPanel("panel-Groups").api.group.activePanel.title,
        };
      }),
    )
    .toEqual({
      left: ["Clips"],
      bottom: ["Console", "Programmer", "Selection Inspector", "Tap Pattern"],
      right: [
        "Properties",
        "Status Display",
        "Fixtures",
        "Patch",
        "Instrumentation",
      ],
      collapsed: [false, true, true],
      objects: ["Groups", "Sequences", "FX List"],
      activeObjects: "Groups",
    });

  const bounds = await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    return [
      "panel-ClipList",
      "panel-Groups",
      "panel-TimelinesPanel",
      "panel-Visualizer",
    ].map((id) => {
      const rect = api.getPanel(id).api.group.element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    });
  });
  const [clips, groups, timelines, visualizer] = bounds;
  expect(clips.right).toBeLessThanOrEqual(groups.x);
  expect(groups.bottom).toBeLessThanOrEqual(timelines.y);
  expect(groups.x).toBeCloseTo(timelines.x, 0);
  expect(groups.width).toBeCloseTo(timelines.width, 0);
  expect(timelines.right).toBeLessThanOrEqual(visualizer.x);
  expect(visualizer.y).toBeCloseTo(groups.y, 0);
  expect(visualizer.bottom).toBeCloseTo(timelines.bottom, 0);
  expect(groups.height / timelines.height).toBeGreaterThan(0.9);
  expect(groups.height / timelines.height).toBeLessThan(1.1);
  await expect(
    page.locator('[data-panel-id="panel-Visualizer"]:visible canvas').first(),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-panel-id="panel-Visualizer"]:visible')
      .getByText(/^\d+ FPS$/),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("new-showfile-layout.png"),
  });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.fromJSON(api.toJSON());
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();
        return ["left", "bottom", "right"].map((edge) =>
          api.getEdgeGroup(edge).isCollapsed(),
        );
      }),
    )
    .toEqual([false, true, true]);

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.keyboard.press("Meta+Shift+P");
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Reset Layout");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi
          .get()
          .getEdgeGroup("left")
          .isCollapsed(),
      ),
    )
    .toBe(true);
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi
          .get()
          .getEdgeGroup("right")
          .isCollapsed(),
      ),
    )
    .toBe(false);
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(
    page
      .locator('[data-panel-id="panel-Visualizer"]:visible')
      .getByText(/^\d+ FPS$/),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("compact-showfile-layout.png"),
  });
});
