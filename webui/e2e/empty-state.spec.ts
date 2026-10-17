// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import {
  dockFixturesInMainGrid,
  resetToDefaultLayout,
  waitForDockviewApp,
} from "./showfile-startup";

const SCREENSHOT_DIR = process.env.NIGHTFALL_EMPTY_STATE_SCREENSHOT_DIR;

/** Saves a screenshot to the test output and, when configured, to the shared review folder. */
async function capture(
  target: Page | Locator,
  testInfo: { outputPath: (name: string) => string },
  name: string,
) {
  await target.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  if (SCREENSHOT_DIR) {
    await target.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
  }
}

/** Adds a panel to the main dock group and focuses it, reusing an existing panel with the same id. */
async function openPanel(
  page: Page,
  component: string,
  id: string,
  params: Record<string, unknown> = {},
) {
  await page.evaluate(
    ({ component, id, params }) => {
      const api = (window as any).appStores.dockApi.get();
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        existing.focus();
        return;
      }
      const panel = api.addPanel({
        id,
        component,
        title: component,
        params: { initialPanelId: id, ...params },
        position: { referencePanel: "panel-FixtureGrid", direction: "within" },
      });
      panel.api.setActive();
      panel.focus();
    },
    { component, id, params },
  );
  return page.locator(`[data-panel-id="${id}"]:visible`).first();
}

/** Walks the migrated empty states in the browser demo and checks their shared variant markup. */
test("panels, lists, inspectors and placeholders render the shared empty state", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await dockFixturesInMainGrid(page);

  const fxEditor = await openPanel(page, "FxEditor", "panel-FxEditor-empty");
  const noFx = fxEditor.locator('[data-empty-state="panel"]');
  await expect(noFx).toHaveText("No FX selected");
  await capture(fxEditor, testInfo, "fx-editor-no-fx-selected");

  const fxList = await openPanel(page, "FxList", "panel-FxList-empty");
  await fxList.getByRole("button", { name: /^Search/ }).click();
  await fxList.getByRole("searchbox").fill("zzz-no-such-effect");
  await expect(
    fxList.locator('[data-empty-state="panel"]', { hasText: "No matching FX" }),
  ).toBeVisible();
  await capture(fxList, testInfo, "fx-list-filtered-empty");

  const cueUid = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const cues = stores.cues.get();
    const [uid, cue] = Object.entries(cues)[0] as [string, any];
    stores.cues.set({ ...cues, [uid]: { ...cue, instructions: [] } });
    return cue.identifiers.uid as string;
  });
  const cueEditor = await openPanel(
    page,
    "CueEditor",
    "panel-CueEditor-empty",
    {
      initialCueUid: cueUid,
    },
  );
  await expect(
    cueEditor.locator("[data-empty-state]", {
      hasText: /No fixture values in cue p0/,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await capture(cueEditor, testInfo, "cue-editor-no-values");

  const history = await openPanel(page, "UndoStack", "panel-UndoStack-empty");
  await expect(
    history.locator('[data-empty-state="dashed"]', {
      hasText: "Redo stack is empty",
    }),
  ).toBeVisible();
  await capture(history, testInfo, "history-empty");

  const selection = await openPanel(
    page,
    "SelectionVisualizer",
    "panel-SelectionVisualizer-empty",
  );
  await expect(
    selection.locator('[data-empty-state="dashed"]').first(),
  ).toBeVisible();
  await capture(selection, testInfo, "selection-visualizer-empty");

  await openPanel(page, "ClipList", "panel-ClipList-empty");
  await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const clips = api.getPanel("panel-ClipList-empty");
    clips?.api.setActive();
    clips?.focus();
  });
  const inspector = page
    .locator('[data-panel-id="panel-PropertiesInspector"]:visible')
    .first();
  await expect(inspector.locator('[data-empty-state="inline"]')).toBeVisible();
  await capture(inspector, testInfo, "inspector-clip-empty");
});

/** Shows every variant on the design lab's Empty states panel, including the loading toggle. */
test("design lab demonstrates empty state variants", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Empty states/ })
    .click();
  const panel = page.getByRole("region", { name: "Empty state examples" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("status").first()).toHaveText(
    "Loading showfiles...",
  );
  await capture(panel, testInfo, "design-lab-empty-states");
  await panel.getByRole("button", { name: "Finish loading" }).click();
  await expect(panel.getByText("No showfiles found.")).toBeVisible();
  await capture(panel, testInfo, "design-lab-empty-states-loaded");
});
