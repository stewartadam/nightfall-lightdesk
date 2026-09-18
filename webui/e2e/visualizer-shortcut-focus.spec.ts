// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const HEADER_COMMAND_INPUT = "#header-cmdline";

type OwnedPatchFixture = {
  id: number;
  uid: string;
};

/** Opens a unique blank showfile with main-thread visualizer rendering. */
async function openOwnedVisualizerShortcutApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `visualizer-shortcut-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false&e2e=1",
  );

  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();

  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
}

/** Creates one fixture with an editable placement row in the Patch grid. */
async function createOwnedPatchFixture(page: Page): Promise<OwnedPatchFixture> {
  const fixture = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const id = Math.floor(600_000 + Math.random() * 100_000);
    const uid = crypto.randomUUID().replace(/-/g, "");
    await stores.sendAndAwait({
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: {
          identifiers: {
            id,
            uid,
            label: "Visualizer Shortcut Fixture",
          },
          make: "E2E",
          model: "Shortcut Focus Fixture",
          mode: "Intensity",
          elements: [
            {
              label: "Main",
              parameters: [
                {
                  resolution: "Coarse",
                  attribute: { type: "Intensity" },
                  min: 0,
                  max: 255,
                  offset: { type: "Absolute", data: { value: 0 } },
                  is_inverted: false,
                  is_snap: false,
                  merge_type: "HTP",
                  use_grandmaster: true,
                },
              ],
            },
          ],
          placement: {
            position: { x: 1, y: 2, z: 3 },
            rotation: { x: 0, y: 0, z: 0 },
          },
        },
      },
    });
    return { id, uid };
  });

  await expect
    .poll(() =>
      page.evaluate(
        (uid) => Boolean((window as any).appStores.fixtures.get()[uid]),
        fixture.uid,
      ),
    )
    .toBe(true);
  return fixture;
}

/** Deletes the fixture created for the Patch grid shortcut scenario. */
async function deleteOwnedPatchFixture(
  page: Page,
  fixture: OwnedPatchFixture,
): Promise<void> {
  await page.evaluate(async (id) => {
    await (window as any).appStores.sendAndAwait({
      module: "FixtureCommand",
      command: { type: "DeleteFixture", data: id },
    });
  }, fixture.id);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => !(window as any).appStores.fixtures.get()[uid],
        fixture.uid,
      ),
    )
    .toBe(true);
}

/** Waits for the app shell to publish Dockview on the shared stores. */
async function waitForDockApi(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();

      /** Polls until Dockview has been initialized by the shell. */
      const tick = () => {
        const api = (window as any).appStores?.dockApi?.get?.();
        if (api) {
          resolve();
          return;
        }
        if (Date.now() - started > 15_000) {
          reject(new Error("dock API did not initialize"));
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  });
}

/** Opens a Patch panel showing the TanStack fixture grid. */
async function openPatchGrid(page: Page): Promise<Locator> {
  await waitForDockApi(page);
  await page.evaluate(() => {
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PatchEditor-shortcut-focus-e2e")?.api.close();
    const nextPanel = api.addPanel({
      id: "panel-PatchEditor-shortcut-focus-e2e",
      component: "PatchEditor",
      title: "Patch",
      params: {},
      position: {
        referencePanel: "panel-Visualizer",
        direction: "right",
      },
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  });

  const grid = page
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator(
        '[data-grid-header-id="tanstack-header-group:Position"]',
      ),
    })
    .last();
  await expect(grid).toBeVisible();
  return grid;
}

/** Makes the default visualizer panel visible and active. */
async function focusVisualizerPanel(page: Page): Promise<void> {
  await waitForDockApi(page);
  await page.evaluate(() => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel("panel-Visualizer");
    panel?.api.setActive();
    panel?.focus();
  });
}

/** Returns the toolbar button for one visualizer tool. */
function visualizerToolButton(page: Page, label: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${label} \\(`) });
}

/** Returns the focusable 3D visualizer canvas. */
function visualizerCanvas(page: Page): Locator {
  return page.getByRole("img", { name: "3D visualizer viewport" });
}

/** Moves DOM focus to the current visualizer canvas instance. */
async function focusVisualizerCanvas(page: Page): Promise<void> {
  await focusVisualizerPanel(page);
  const canvas = visualizerCanvas(page);
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("visualizer canvas has no bounding box");
  await page.mouse.click(
    box.x + Math.min(20, box.width / 2),
    box.y + Math.min(20, box.height / 2),
  );
  if (
    !(await canvas.evaluate((element) => document.activeElement === element))
  ) {
    await canvas.evaluate((element) =>
      (element as HTMLCanvasElement).focus({ preventScroll: true }),
    );
  }
  await expect
    .poll(() =>
      canvas.evaluate((element) => document.activeElement === element),
    )
    .toBe(true);
}

/** Switches the visualizer to move mode using its panel-local shortcut. */
async function switchVisualizerToMove(page: Page): Promise<void> {
  await focusVisualizerPanel(page);
  await expect(
    page.getByRole("tab", { name: "3D Visualizer", selected: true }),
  ).toBeVisible();
  await focusVisualizerCanvas(page);
  await page.keyboard.press("m");
  await expect(visualizerToolButton(page, "Move")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** Verifies the visualizer camera shortcut stays idle after header command-line editing. */
test("visualizer shortcut does not leak after editing the header command line", async ({
  page,
}) => {
  await openOwnedVisualizerShortcutApp(page);
  await switchVisualizerToMove(page);

  const commandInput = page.locator(HEADER_COMMAND_INPUT);
  await commandInput.click();
  await commandInput.evaluate((element) =>
    (element as HTMLInputElement).blur(),
  );
  await page.keyboard.press("c");

  await expect(visualizerToolButton(page, "Move")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(visualizerToolButton(page, "Camera")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await commandInput.click();
  await page.keyboard.type("c");
  await commandInput.evaluate((element) =>
    (element as HTMLInputElement).blur(),
  );
  await page.keyboard.press("c");

  await expect(visualizerToolButton(page, "Move")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(visualizerToolButton(page, "Camera")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

/** Verifies visualizer shortcuts stay idle after editable TanStack grid cells own focus. */
test("visualizer shortcut does not leak after editing a TanStack grid cell", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await openOwnedVisualizerShortcutApp(page);
  const fixture = await createOwnedPatchFixture(page);
  try {
    await switchVisualizerToMove(page);
    await page.keyboard.press("s");
    await expect(visualizerToolButton(page, "Select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const grid = await openPatchGrid(page);
    const editableCell = grid.locator("#tanstack-cell-6-0");
    await editableCell.dblclick();
    const editor = editableCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.fill("12.345");
    await page.keyboard.press("Enter");
    await expect(editor).not.toBeVisible();

    await page.keyboard.press("c");

    await expect(visualizerToolButton(page, "Select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(visualizerToolButton(page, "Camera")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await focusVisualizerCanvas(page);
    await page.keyboard.press("c");

    await expect(visualizerToolButton(page, "Camera")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await deleteOwnedPatchFixture(page, fixture);
  }
});
