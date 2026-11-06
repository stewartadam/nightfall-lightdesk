// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/** Opens the demo workspace at a size where every default panel is docked. */
async function openDemoWorkspace(
  page: Parameters<typeof waitForDockviewApp>[0],
) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
}

/**
 * Opening a timeline whose editor is parked in a collapsed edge goes through the app's real click
 * path, which must expand the edge rather than leave the focused editor hidden.
 */
test("opening a timeline already docked in a collapsed edge reveals it", async ({
  page,
}, testInfo) => {
  await openDemoWorkspace(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.timelines.get()).length,
      ),
    )
    .toBeGreaterThan(0);
  const uid = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timelineUid = Object.keys(stores.timelines.get())[0];
    const api = stores.dockApi.get();
    api.getPanel(`panel-Timeline-${timelineUid}`)?.api.close();
    api.addPanel({
      id: `panel-Timeline-${timelineUid}`,
      component: "Timeline",
      title: "Parked timeline",
      params: { initialTimelineUid: timelineUid },
      position: {
        referenceGroup: api.getEdgeGroup("bottom").id,
        direction: "within",
      },
    });
    api.getEdgeGroup("bottom").collapse();
    api.getPanel("panel-Timelines")?.focus();
    return timelineUid;
  });
  /** Reads whether the parked editor's edge group is collapsed. */
  const edgeCollapsed = () =>
    page.evaluate(
      (panelId) =>
        (window as any).appStores.dockApi
          .get()
          .getPanel(panelId)
          .group.api.isCollapsed(),
      `panel-Timeline-${uid}`,
    );
  await expect.poll(edgeCollapsed).toBe(true);

  await page
    .locator(
      `[data-workspace-active="true"] [data-crud-select-id="${uid}"]:visible`,
    )
    .click();

  await expect.poll(edgeCollapsed).toBe(false);
  await expect(
    page.locator("[data-timeline-toolbar]:visible").first(),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("revealed-timeline.png") });
});

/**
 * A panel added without a position joins the active group, so opening a new editor while a
 * collapsed edge is active must expand that edge rather than leave the editor hidden.
 */
test("opening a new editor while a collapsed edge is active reveals it", async ({
  page,
}, testInfo) => {
  await openDemoWorkspace(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const consolePanel = api.getPanel("panel-CommandLine");
    consolePanel.group.api.expand();
    consolePanel.api.setActive();
    consolePanel.group.api.collapse();
  });
  await page.keyboard.press("ControlOrMeta+P");
  const objects = page.getByRole("region", { name: "Showfile objects" });
  await expect(objects).toBeVisible();
  await page.keyboard.type("Sequence");
  await page.keyboard.press("Enter");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const panel = (window as any).appStores.dockApi.get().activePanel;
        return {
          isEditor: /editor/.test(panel?.id ?? ""),
          collapsed: panel?.group.api.isCollapsed?.() ?? false,
          visibility: getComputedStyle(panel.view.content.element).visibility,
        };
      }),
    )
    .toEqual({ isEditor: true, collapsed: false, visibility: "visible" });
  await page.screenshot({ path: testInfo.outputPath("revealed-editor.png") });
});

/** Opening Console from the palette expands its collapsed edge and lets the user type at once. */
test("opening Console from the command palette focuses the command line", async ({
  page,
}, testInfo) => {
  await openDemoWorkspace(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByPlaceholder("Type a command or search...");
  await palette.fill("Console");
  await palette.press("Enter");

  const input = page.locator('[data-workspace-active="true"] #cmdline');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("focused-console.png") });
});
