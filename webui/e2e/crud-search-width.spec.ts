// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks Clips keeps its minimum width and toolbar search presents only the grouped clear action. */
test("Clips minimum width and grouped search clear", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "clip-width-check",
      component: "ClipList",
      title: "Clips width check",
      params: { initialPanelId: "clip-width-check" },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
    api.getPanel("clip-width-check").focus();
    api.getPanel("clip-width-check").group.api.setSize({ width: 200 });
  });
  const panel = page.locator(
    '[data-component="ClipList"][data-panel-id="clip-width-check"]',
  );
  await expect
    .poll(async () => (await panel.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(515);
  await panel
    .getByRole("button", { name: "Search clips", exact: true })
    .click();
  const search = panel.getByRole("searchbox");
  await search.fill("afa");
  const group = panel.getByRole("search");
  await expect(group.getByRole("button", { name: "Clear search" })).toHaveCount(
    1,
  );
  await group.screenshot({
    path: testInfo.outputPath("single-clear-button.png"),
  });
  await group.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toBeHidden();
  await panel
    .getByRole("button", { name: "Search clips", exact: true })
    .click();
  await expect(panel.getByRole("searchbox")).toHaveValue("");
});

/** Checks each searchable CRUD panel enforces its own minimum in a separate dock group. */
test("searchable CRUD panels enforce 515px minimum width", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  for (const component of [
    "ClipList",
    "SequenceList",
    "TimelinesPanel",
    "GroupsPanel",
    "CueList",
    "FxList",
    "BlueprintsPanel",
    "FlowList",
    "SceneObjects",
  ]) {
    await page.evaluate((component) => {
      const api = (window as any).appStores.dockApi.get();
      api.addPanel({
        id: "crud-width-check",
        component,
        title: "CRUD width check",
        params: { initialPanelId: "crud-width-check" },
        position: { referencePanel: "panel-FixtureGrid", direction: "right" },
      });
      api.getPanel("crud-width-check").group.api.setSize({ width: 200 });
    }, component);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as any).appStores.dockApi
                .get()
                .getPanel("crud-width-check").group.api.width,
          ),
        { message: `${component} minimum width` },
      )
      .toBeGreaterThanOrEqual(515);
    if (component === "SceneObjects")
      await page.screenshot({
        path: testInfo.outputPath("crud-panel-minimum-width.png"),
      });
    await page.evaluate(() =>
      (window as any).appStores.dockApi
        .get()
        .getPanel("crud-width-check")
        .api.close(),
    );
  }
});
