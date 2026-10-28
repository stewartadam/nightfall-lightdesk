// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { decodePng } from "./png-decode";
import { waitForDockviewApp } from "./showfile-startup";

// Keep the backend unloaded so startup shows the picker and a fresh default show is created.
test.use({ emptyStartupWorld: true });

const PATCH_PANEL_ID = "panel-PatchEditor-hidden-highlight-e2e";

/** Creates a fresh default showfile, with its default scene objects, using the main-thread visualizer. */
async function openNewDefaultShow(page: Page): Promise<void> {
  const testInfo = test.info();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false&e2e=1",
  );
  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await newDialog
    .getByLabel("Show name")
    .fill(`hidden-highlight-${testInfo.workerIndex}-${Date.now()}`);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).visualizerApi?.getScene?.()),
    { timeout: 15_000 },
  );
}

/**
 * Patches a built-in moving head at the stage origin and encloses it in a 4m stage-element box,
 * so it is fully hidden from every camera angle.
 */
async function patchFixtureInsideBox(page: Page): Promise<string> {
  const uid = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const id = Math.floor(600_000 + Math.random() * 100_000);
    const created = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id,
          label: "Hidden Fixture",
          make: "Generic",
          model: "Moving Head Spot 16ch",
          mode: "Spot",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (created.outcome.type !== "Succeeded")
      throw new Error(JSON.stringify(created));
    const fixture = Object.values(
      stores.fixtures.get() as Record<string, any>,
    ).find((candidate) => candidate.identifiers.id === id);
    if (!fixture) throw new Error(`fixture ${id} was not created`);
    await stores.sendAndAwait({
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: {
          ...fixture,
          placement: {
            position: { x: 0, y: 1, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
          },
        },
      },
    });
    const fixtureUid: string = fixture.identifiers.uid;
    await stores.sendAndAwait({
      module: "SceneObjectCommand",
      command: {
        type: "StoreSceneObject",
        data: {
          identifiers: {
            id: 990_000 + Math.floor(Math.random() * 9_000),
            uid: crypto.randomUUID().replace(/-/g, ""),
            label: "Enclosing Box",
          },
          objectType: "stageElement",
          placement: {
            position: { x: 0, y: -1, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
          },
          properties: {
            type: "StageElement",
            data: { modelPath: "", scale: 4 },
          },
        },
      },
    });
    return fixtureUid;
  });
  await expect
    .poll(() =>
      page.evaluate(
        (fixtureUid) =>
          Boolean((window as any).appStores.fixtures.get()[fixtureUid]),
        uid,
      ),
    )
    .toBe(true);
  return uid;
}

/** Opens a Patch panel beside the visualizer and returns its fixture grid. */
async function openPatchGrid(page: Page): Promise<Locator> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.addPanel({
      id: panelId,
      component: "PatchEditor",
      title: "Patch",
      params: {},
      position: { referencePanel: "panel-Visualizer", direction: "right" },
    });
    panel.api.setActive();
  }, PATCH_PANEL_ID);
  const grid = page.locator(
    `[data-panel-id="${PATCH_PANEL_ID}"] [data-grid-kind="tanstack"]`,
  );
  await expect(grid).toBeVisible();
  return grid;
}

/** Points the visualizer camera at the stage origin from the front and lets a frame render. */
async function frameOrigin(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).visualizerApi.setCameraState({
      position: { x: 0, y: 1.8, z: 4.5 },
      target: { x: 0, y: 1, z: 0 },
    });
  });
  await page.waitForTimeout(1_000);
}

/** Captures the visualizer viewport and keeps a named copy in the test's output folder. */
async function viewport(page: Page, name: string): Promise<Buffer> {
  return page
    .getByRole("img", { name: "3D visualizer viewport" })
    .screenshot({ path: test.info().outputPath(`${name}.png`) });
}

/**
 * Counts pixels tinted toward the yellow edit-selection color, including the dimmer fill over a
 * dark occluder that a strict "yellow-dominant" test would miss.
 */
function yellowTintedPixelCount(png: Buffer): number {
  const decoded = decodePng(png);
  let count = 0;
  for (let i = 0; i < decoded.width * decoded.height; i++) {
    const offset = i * decoded.channels;
    const red = decoded.data[offset];
    const green = decoded.data[offset + 1];
    const blue = decoded.data[offset + 2];
    if (red > 40 && green > 30 && red > blue + 25 && green > blue + 20) count++;
  }
  return count;
}

/**
 * Verifies a Patch-highlighted fixture buried inside a scene object is filled with the yellow
 * edit color through the occluder, and that the fill clears once the row is deselected.
 */
test("patch highlight shows a fixture hidden inside a scene object", async ({
  page,
}, testInfo) => {
  await openNewDefaultShow(page);
  const fixtureUid = await patchFixtureInsideBox(page);
  const grid = await openPatchGrid(page);
  await frameOrigin(page);
  const unselected = await viewport(page, "unselected");
  await testInfo.attach("unselected", {
    body: unselected,
    contentType: "image/png",
  });
  const baseline = yellowTintedPixelCount(unselected);

  const row = grid.getByRole("row").filter({ hasText: "Hidden Fixture" });
  await row.getByRole("checkbox").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual([fixtureUid]);
  await frameOrigin(page);
  const highlighted = await viewport(page, "highlighted");
  await testInfo.attach("highlighted", {
    body: highlighted,
    contentType: "image/png",
  });
  // Hidden edges alone tint about 1,000 pixels at this framing; the fill covers the whole
  // silhouette at about 2,400.
  expect(yellowTintedPixelCount(highlighted) - baseline).toBeGreaterThan(1_800);

  await row.getByRole("checkbox").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual([]);
  await frameOrigin(page);
  const cleared = await viewport(page, "cleared");
  expect(Math.abs(yellowTintedPixelCount(cleared) - baseline)).toBeLessThan(50);
});
