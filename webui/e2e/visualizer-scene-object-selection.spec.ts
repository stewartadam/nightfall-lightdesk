// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const SCENE_OBJECT_LABEL = "Selectable Truss";

/** Replaces each scenario backend and proves fixture/scene state is blank. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedSceneStoreCounts(page))
    .toEqual({
      fixtureGeometries: 0,
      fixtures: 0,
      programmerSelection: 0,
      sceneObjects: 0,
      sceneObjectSelection: 0,
    });
});

/** Reads backend definitions and visualizer selections owned by this suite. */
async function ownedSceneStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      fixtureGeometries: Object.keys(stores.fixtureGeometries.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      programmerSelection: stores.programmerSelection.get().length,
      sceneObjects: Object.keys(stores.sceneObjects.get()).length,
      sceneObjectSelection: stores.visualizerSceneObjectSelection.get().length,
    };
  });
}

/**
 * Opens the app with the main-thread visualizer so pointer picking is deterministic.
 */
async function openVisualizerApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false&e2e=scene-object-selection",
  );
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.fixtureGeometries?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.programmerSelection?.get) &&
      Boolean((window as any).appStores?.sceneObjects?.get) &&
      Boolean((window as any).appStores?.visualizerSceneObjectSelection?.get),
  );
  await expect
    .poll(() => ownedSceneStoreCounts(page))
    .toEqual({
      fixtureGeometries: 0,
      fixtures: 0,
      programmerSelection: 0,
      sceneObjects: 0,
      sceneObjectSelection: 0,
    });
  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  const visualizerPanel = page.locator('[data-panel-id="panel-Visualizer"]');
  await expect(visualizerPanel).toBeVisible();
  await expect(visualizerPanel.locator("canvas").first()).toBeVisible();
  await expect(visualizerPanel.locator(".fps-label")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page
      .getByRole("region", { name: "Application status bar" })
      .getByRole("status", { name: "Connected", exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(1_000);
  await page.addStyleTag({
    content:
      "#profiler-panel, #profiler-mini-panel { display: none !important; }",
  });
  await waitForDockApi(page);
  await waitForMainThreadVisualizerApi(page);
}

/**
 * Waits until the Dockview API is available through appStores.
 */
async function waitForDockApi(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as any).appStores?.dockApi?.get?.()),
    { timeout: 15_000 },
  );
}

/**
 * Waits for the main-thread visualizer API to expose a Three.js scene.
 */
async function waitForMainThreadVisualizerApi(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as any).visualizerApi?.getScene?.()),
    { timeout: 15_000 },
  );
}

/**
 * Adds a uniquely identified visible Scene Objects panel beside the visualizer.
 */
async function addSceneObjectsPanel(page: Page): Promise<string> {
  const panelId = `panel-SceneObjects-selection-e2e-${crypto.randomUUID()}`;
  await page.evaluate((nextPanelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: nextPanelId,
      component: "SceneObjects",
      title: "Scene Objects",
      params: {},
      position: {
        referencePanel: "panel-Visualizer",
        direction: "right",
      },
    });
  }, panelId);
  await expect(page.locator(`[data-panel-id="${panelId}"]`)).toBeVisible();
  return panelId;
}

/**
 * Seeds one large stage element at the camera target.
 */
async function seedSceneObject(page: Page): Promise<string> {
  const uid = crypto.randomUUID().replaceAll("-", "");
  const id = 990_000 + Math.floor(Math.random() * 9_000);
  const result = await page.evaluate(
    async ({ id, label, uid }) => {
      const stores = (window as any).appStores;
      stores.programmerSelection.set([]);
      stores.visualizerSceneObjectSelection.set([]);
      stores.visualizerEditSelection.set([]);
      return stores.sendAndAwait({
        module: "SceneObjectCommand",
        command: {
          type: "StoreSceneObject",
          data: {
            identifiers: {
              id,
              uid,
              label,
            },
            objectType: "stageElement",
            placement: {
              position: { x: 1_000, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
            properties: {
              type: "StageElement",
              data: {
                modelPath: "",
                scale: 4,
              },
            },
          },
        },
      });
    },
    { id, label: SCENE_OBJECT_LABEL, uid },
  );
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys((window as any).appStores.sceneObjects.get()),
      ),
    )
    .toContain(uid);
  await page.evaluate(() => {
    (window as any).visualizerApi.setCameraState({
      position: { x: 1_000, y: 2, z: 10 },
      target: { x: 1_000, y: 2, z: 0 },
    });
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  return uid;
}

/**
 * Clicks the visible body of the seeded scene object in the visualizer canvas.
 */
async function clickSeededSceneObject(page: Page): Promise<void> {
  const canvas = page.getByRole("img", { name: "3D visualizer viewport" });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("expected visible visualizer canvas bounds");
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
}

/**
 * Focuses the visualizer panel and waits for the canvas to accept input.
 */
async function focusVisualizer(page: Page): Promise<void> {
  await page
    .locator(".dv-default-tab")
    .filter({ hasText: "3D Visualizer" })
    .first()
    .click();
  await expect(page.locator("canvas:visible").first()).toBeVisible();
}

/**
 * Verifies clicking a scene object selects it and syncs visible affordances.
 */
test("visualizer click selects scene object and syncs scene object panel", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openVisualizerApp(page, backendSlot.backendPort);
  const sceneObjectUid = await seedSceneObject(page);
  await focusVisualizer(page);

  await page.keyboard.press("s");
  await expect(
    page.getByRole("button", { name: "Select (S)" }),
  ).toHaveAttribute("aria-pressed", "true");
  await clickSeededSceneObject(page);

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerSceneObjectSelection.get(),
      ),
    )
    .toEqual([sceneObjectUid]);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual([]);
  const sceneObjectsPanelId = await addSceneObjectsPanel(page);
  await expect(
    page.getByRole("button", { name: "Delete selected (1) (Del/Backspace)" }),
  ).toBeEnabled();
  const sceneObjectsPanel = page.locator(
    `[data-panel-id="${sceneObjectsPanelId}"]`,
  );
  await expect(
    sceneObjectsPanel.locator('input[aria-label^="Select row"]:checked'),
  ).toHaveCount(1);

  await testInfo.attach("scene-object-selected-from-visualizer", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

/**
 * Verifies ordinary grid cell focus remains separate from visualizer selection.
 */
test("scene object grid cell focus does not select object for visualizer workflows", async ({
  backendSlot,
  page,
}) => {
  await openVisualizerApp(page, backendSlot.backendPort);
  const sceneObject = {
    label: SCENE_OBJECT_LABEL,
    uid: await seedSceneObject(page),
  };
  const sceneObjectsPanelId = await addSceneObjectsPanel(page);

  const sceneObjectsPanel = page.locator(
    `[data-panel-id="${sceneObjectsPanelId}"]`,
  );
  const sceneObjectLabelCell = sceneObjectsPanel.locator(
    `[role="gridcell"][data-grid-row-key="${sceneObject.uid}"][data-grid-column-key="label"]`,
  );
  await expect(sceneObjectLabelCell).toContainText(sceneObject.label);
  await sceneObjectLabelCell.click();
  await page.waitForTimeout(250);

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerSceneObjectSelection.get(),
      ),
    )
    .toEqual([]);
});
