// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the live Clips group geometry and constraints after asynchronous docking changes. */
async function clipGroup(page: Page) {
  return page.evaluate(() => {
    const group = (window as any).appStores.dockApi
      .get()
      .getPanel("panel-ClipList").api.group;
    return {
      width: group.api.width,
      height: group.api.height,
      minWidth: group.minimumWidth,
      minHeight: group.minimumHeight,
    };
  });
}

/** Verifies group minimums aggregate inactive tabs and update after moves and restoration. */
test("panel definitions constrain grid and edge groups", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.screenshot({ path: testInfo.outputPath("dockview-gutters.png") });
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const clips = api.getPanel("panel-ClipList");
    clips.api.moveTo({
      group: api.getPanel("panel-FixtureGrid").api.group,
      position: "right",
    });
    api.getPanel("panel-SequenceList").api.moveTo({
      group: clips.api.group,
      position: "bottom",
    });
    api
      .getPanel("panel-CommandLine")
      .api.moveTo({ group: clips.api.group, position: "center" });
    clips.api.setActive();
  });
  await expect
    .poll(async () => {
      const group = await clipGroup(page);
      return [group.minWidth, group.minHeight];
    })
    .toEqual([531, 416]);
  await page.evaluate(() => {
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-ClipList")
      .api.setSize({ width: 80, height: 80 });
  });
  const before = await clipGroup(page);
  expect(before.width).toBeGreaterThanOrEqual(515);
  expect(before.height).toBeGreaterThanOrEqual(400);
  await page.getByRole("tab", { name: "Console", exact: true }).click();
  expect(await clipGroup(page)).toEqual(before);
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  expect(await clipGroup(page)).toEqual(before);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CommandLine").api.moveTo({
      group: api.getPanel("panel-FixtureGrid").api.group,
      position: "bottom",
    });
  });
  await expect.poll(async () => (await clipGroup(page)).minWidth).toBe(531);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const right = api.getPanel("panel-PropertiesInspector").api.group;
    api
      .getPanel("panel-ClipList")
      .api.moveTo({ group: right, position: "center" });
    api.getPanel("panel-PropertiesInspector").api.moveTo({
      group: api.getPanel("panel-FixtureGrid").api.group,
      position: "center",
    });
    api.getEdgeGroup("right").expand();
  });
  await expect
    .poll(async () => (await clipGroup(page)).width)
    .toBeGreaterThanOrEqual(514.5);

  const edge = page.getByTestId("dv-edge-group-edge-Properties");
  const sash = page.locator(".dv-sash").filter({ visible: true });
  const edgeBox = await edge.boundingBox();
  const sashBoxes = await sash.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  const handle = sashBoxes.find(
    (box) =>
      box.height > 300 && Math.abs(box.x + box.width / 2 - edgeBox!.x) < 16,
  );
  expect(handle).toBeDefined();
  await page.mouse.move(
    handle!.x + handle!.width / 2,
    handle!.y + handle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(edgeBox!.x + 180, handle!.y + handle!.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await clipGroup(page)).width)
    .toBeGreaterThanOrEqual(514.5);
  expect((await clipGroup(page)).width).toBeLessThan(525);
  await edge.screenshot({
    path: testInfo.outputPath("clips-edge-minimum.png"),
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(
          localStorage.getItem("nightfall-ui-layouts") ?? "null",
        );
        const right = state?.sessionLayout?.layout?.edgeGroups?.right;
        return (
          right?.visible &&
          JSON.stringify(right.group).includes("panel-ClipList")
        );
      }),
    )
    .toBe(true);
  const saved = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("nightfall-ui-layouts")!);
    state.sessionLayout.layout.edgeGroups.right.size = 80;
    return state;
  });
  await page.addInitScript((state) => {
    localStorage.setItem("nightfall-ui-layouts", JSON.stringify(state));
  }, saved);
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(async () => (await clipGroup(page)).width)
    .toBeGreaterThanOrEqual(514.5);
  await expect.poll(async () => (await clipGroup(page)).minWidth).toBe(531);
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().getEdgeGroup("right").collapse(),
  );
  await expect.poll(async () => (await clipGroup(page)).width).toBeLessThan(50);
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().getEdgeGroup("right").expand(),
  );
  await expect
    .poll(async () => (await clipGroup(page)).width)
    .toBeGreaterThanOrEqual(514.5);

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const bottom = api.groups.find(
      (group: any) => group.id === api.getEdgeGroup("bottom").id,
    );
    api
      .getPanel("panel-ClipList")
      .api.moveTo({ group: bottom, position: "center" });
    api.setEdgeGroupVisible("bottom", true);
    api.getEdgeGroup("bottom").expand();
  });
  await expect
    .poll(async () => (await clipGroup(page)).height)
    .toBeGreaterThanOrEqual(399.5);
  const bottomEdge = page.getByTestId("dv-edge-group-edge-Console");
  const bottomBox = await bottomEdge.boundingBox();
  const bottomHandles = await sash.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  const bottomHandle = bottomHandles.find(
    (box) =>
      box.width > 1000 && Math.abs(box.y + box.height / 2 - bottomBox!.y) < 16,
  );
  expect(bottomHandle).toBeDefined();
  await page.mouse.move(
    bottomHandle!.x + bottomHandle!.width / 2,
    bottomHandle!.y + bottomHandle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bottomHandle!.x + bottomHandle!.width / 2,
    bottomBox!.y + 300,
    { steps: 10 },
  );
  await page.mouse.up();
  expect((await clipGroup(page)).height).toBeGreaterThanOrEqual(399.5);
  expect((await clipGroup(page)).height).toBeLessThan(410);
  await bottomEdge.screenshot({
    path: testInfo.outputPath("clips-bottom-minimum.png"),
  });
});
