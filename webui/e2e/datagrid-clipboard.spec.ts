// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(120_000);

const AXIS_BOX_SHADOW_COLORS = {
  x: "rgba(239, 68, 68, 0.55)",
  y: "rgba(34, 197, 94, 0.55)",
  z: "rgba(59, 130, 246, 0.55)",
} as const;

type CoordinateAxis = keyof typeof AXIS_BOX_SHADOW_COLORS;

/**
 * Verifies a rendered coordinate cell keeps its axis border visible.
 */
async function expectCoordinateAxisBorder(cell: Locator, axis: CoordinateAxis) {
  await expect(cell).toHaveAttribute("data-coordinate-axis", axis);
  await expect
    .poll(() => cell.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain(AXIS_BOX_SHADOW_COLORS[axis]);
  await expect
    .poll(() => cell.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain("-3px 0px 0px 0px");
  await expect(cell).toHaveCSS("padding-right", "11px");
}

/**
 * Opens the app shell without relying on backend sample data.
 */
async function openApp(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
}

/**
 * Waits until the Dockview API is available on appStores.
 */
async function waitForDockApi(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();

      /** Polls until the app shell has installed the Dockview API. */
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

/**
 * Adds a panel directly through the Dockview API.
 */
async function addPanel(
  page: Page,
  panel: {
    id: string;
    component: string;
    title: string;
    params?: Record<string, unknown>;
  },
) {
  await waitForDockApi(page);
  await page.evaluate((panel) => {
    const api = (window as any).appStores.dockApi.get();
    const existingPanel = api.getPanel(panel.id);
    if (existingPanel) {
      existingPanel.api.close();
    }
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const nextPanel = api.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      params: panel.params ?? {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  }, panel);
}

/**
 * Adds a Patch panel directly through the Dockview API.
 */
async function addPatchPanel(page: Page) {
  await addPanel(page, {
    id: "panel-PatchEditor-clipboard-e2e",
    component: "PatchEditor",
    title: "Patch",
  });
}

/**
 * Returns the Patch fixture TanStack grid by matching its grouped placement header.
 */
function patchFixtureGrid(page: Page): Locator {
  return page
    .locator('[data-panel-id="panel-PatchEditor-clipboard-e2e"]')
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator(
        '[data-grid-header-id="tanstack-header-group:Position"]',
      ),
    });
}

/**
 * Returns the Scene Objects TanStack grid by matching its Scale header.
 */
function sceneObjectsGrid(page: Page): Locator {
  return page
    .locator('[data-panel-id="panel-SceneObjects-clipboard-e2e"]')
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator('[data-grid-header-id="tanstack-header-scale"]'),
    });
}

/**
 * Adds a Scene Objects panel directly through the Dockview API.
 */
async function addSceneObjectsPanel(page: Page) {
  await addPanel(page, {
    id: "panel-SceneObjects-clipboard-e2e",
    component: "SceneObjects",
    title: "Scene Objects",
    params: { initialPanelId: "panel-SceneObjects-clipboard-e2e" },
  });
  await page.getByText("Scene Objects", { exact: true }).last().click();
  await expect(page.getByText("Label", { exact: true }).last()).toBeVisible();
}

/**
 * Closes a Dockview panel directly through the app API.
 */
async function closePanel(page: Page, panelId: string) {
  await waitForDockApi(page);
  await page.evaluate((id) => {
    (window as any).appStores.dockApi.get().getPanel(id)?.api.close();
  }, panelId);
}

/**
 * Seeds the fixture store with simple rows for patch grid tests.
 */
async function seedFixtureRows(page: Page, count = 3) {
  await page.evaluate((fixtureCount) => {
    const stores = (window as any).appStores;
    stores.fixtures.set(
      Object.fromEntries(
        Array.from({ length: fixtureCount }, (_, index) => [
          `fixture-clipboard-${index + 1}`,
          {
            identifiers: {
              id: index + 1,
              uid: `fixture-clipboard-${index + 1}`,
              label: `Fixture ${index + 1}`,
            },
            make: "E2E",
            model: "Clipboard",
            mode: "Default",
            elements: [],
            placement: {
              position: { x: index, y: index + 10, z: index + 20 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          },
        ]),
      ),
    );
  }, count);
}

/**
 * Seeds scene object rows for visualizer-selection styling tests.
 */
async function seedSceneObjectRows(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.sceneObjects.set({
      "scene-object-clipboard-1": {
        identifiers: {
          id: 41,
          uid: "scene-object-clipboard-1",
          label: "Scene Object 1",
        },
        objectType: "stageElement",
        placement: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
        properties: {
          type: "StageElement",
          data: { scale: 1, color: "#808080" },
        },
      },
    });
  });
}

/**
 * Opens the seeded Patch fixture grid.
 */
async function openSeededPatchGrid(page: Page, fixtureCount = 3) {
  await openApp(page);
  await addPatchPanel(page);
  await seedFixtureRows(page, fixtureCount);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys((window as any).appStores.fixtures.get()).join(","),
      ),
    )
    .toBe(
      Array.from(
        { length: fixtureCount },
        (_, index) => `fixture-clipboard-${index + 1}`,
      ).join(","),
    );
  const grid = patchFixtureGrid(page);
  await expect(grid).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveText("1");
  return grid;
}

test("patch fixture grid persists row-selection edits across selected rows", async ({
  page,
}) => {
  const grid = await openSeededPatchGrid(page);

  await grid.getByRole("checkbox", { name: "Select row 1" }).click();
  await grid.getByRole("checkbox", { name: "Select row 2" }).click();

  const firstY = grid.locator("#tanstack-cell-7-0");
  const secondY = grid.locator("#tanstack-cell-7-1");
  await firstY.dblclick();
  const editor = firstY.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("99");
  await editor.press("Enter");

  await expect(firstY).toHaveText(/^99/);
  await expect(secondY).toHaveText(/^99/);
});

test("patch fixture grid pastes tabular clipboard values into concrete cells", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const grid = await openSeededPatchGrid(page);

  await page.evaluate(() =>
    navigator.clipboard.writeText("101\t102\n201\t202"),
  );
  await grid.locator("#tanstack-cell-6-0").click();
  await page.keyboard.press("Meta+V");

  await expect(grid.locator("#tanstack-cell-6-0")).toHaveText(/^101/);
  await expect(grid.locator("#tanstack-cell-7-0")).toHaveText(/^102/);
  await expect(grid.locator("#tanstack-cell-6-1")).toHaveText(/^201/);
  await expect(grid.locator("#tanstack-cell-7-1")).toHaveText(/^202/);
});

/** Verifies placement coordinate cells use persistent axis color borders. */
test("patch fixture grid color-codes coordinate cells", async ({ page }) => {
  const grid = await openSeededPatchGrid(page);
  const posXCell = grid.locator("#tanstack-cell-6-0");
  const posYCell = grid.locator("#tanstack-cell-7-0");
  const posZCell = grid.locator("#tanstack-cell-8-0");

  await expectCoordinateAxisBorder(posXCell, "x");
  await expectCoordinateAxisBorder(posYCell, "y");
  await expectCoordinateAxisBorder(posZCell, "z");
  await expect(posXCell.locator("span").first()).toHaveCSS(
    "text-align",
    "right",
  );

  await posXCell.click();
  await expectCoordinateAxisBorder(posXCell, "x");

  await page.keyboard.press("Enter");
  await expect(posXCell.locator("input")).toBeVisible();
  await expect(posXCell.locator("input")).toHaveCSS("text-align", "right");
  await expectCoordinateAxisBorder(posXCell, "x");
});

/** Verifies explicit Mod+G type-seek jumps by fixture ID. */
test("patch fixture grid supports Mod+G fixture ID seek", async ({ page }) => {
  const grid = await openSeededPatchGrid(page, 50);
  const firstIdCell = grid.locator("#tanstack-cell-0-0");
  const startingCell = grid.locator("#tanstack-cell-6-0");
  const targetIdCell = grid.locator("#tanstack-cell-0-39");
  const targetOriginalColumnCell = grid.locator("#tanstack-cell-6-39");
  const seekInput = grid.getByLabel("Fixture ID seek");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await startingCell.click();
  await page.keyboard.press(`${modifier}+G`);
  await expect(seekInput).toBeVisible();
  const idCellBox = await firstIdCell.boundingBox();
  const seekInputBox = await seekInput.boundingBox();
  if (!idCellBox || !seekInputBox) {
    throw new Error("Unable to resolve fixture ID seek bounds");
  }
  expect(Math.abs(idCellBox.x - seekInputBox.x)).toBeLessThan(2);

  await page.keyboard.type("40");

  await expect(targetOriginalColumnCell).toBeVisible();
  await expect(targetOriginalColumnCell).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(targetIdCell).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("Enter");
  await expect(seekInput).toBeHidden();
});

/** Verifies Escape cancels fixture ID seek. */
test("patch fixture grid cancels Mod+G fixture ID seek", async ({ page }) => {
  const grid = await openSeededPatchGrid(page, 50);
  const startingCell = grid.locator("#tanstack-cell-6-0");
  const targetOriginalColumnCell = grid.locator("#tanstack-cell-6-39");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await startingCell.click();
  await expect(startingCell).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(`${modifier}+G`);
  await page.keyboard.type("40");
  await expect(targetOriginalColumnCell).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("Escape");

  await expect(grid.getByLabel("Fixture ID seek")).toBeHidden();
});

/** Verifies printable keys still start inline editing in editable cells. */
test("patch fixture grid starts numeric editing from printable keys", async ({
  page,
}) => {
  const grid = await openSeededPatchGrid(page);
  const editableCell = grid.locator("#tanstack-cell-6-0");

  await editableCell.click();
  await page.keyboard.type("1");

  await expect(editableCell.locator("input")).toHaveValue("1");
});

/** Verifies column-header typed edits mount the editor in the scrolled viewport. */
test("patch fixture grid starts column editing from a visible row", async ({
  page,
}) => {
  const grid = await openSeededPatchGrid(page, 50);
  await grid.evaluate((element) => {
    element.scrollTo({ top: 600 });
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() => grid.evaluate((element) => Math.round(element.scrollTop)))
    .toBeGreaterThan(0);

  await grid.locator('[data-grid-header-id="tanstack-header-pos_x"]').click();
  await page.keyboard.type("4");

  const editor = grid.locator('input:not([type="checkbox"])');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("4");
});

test("patch fixture grid uses Tab and Shift+Tab for horizontal navigation", async ({
  page,
}) => {
  const grid = await openSeededPatchGrid(page);

  await grid.locator("#tanstack-cell-6-0").click();
  await page.keyboard.press("Tab");
  await expect(grid.locator("#tanstack-cell-7-0")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("Shift+Tab");
  await expect(grid.locator("#tanstack-cell-6-0")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

/**
 * Verifies programmer selection marks ID cells without becoming edit selection.
 */
test("patch and scene object panels mark programmer-selected IDs red", async ({
  page,
}) => {
  await openApp(page);
  await addPatchPanel(page);

  await seedFixtureRows(page);
  await seedSceneObjectRows(page);
  const patchGrid = patchFixtureGrid(page);
  await expect(patchGrid).toBeVisible();

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.programmerSelection.set(["fixture-clipboard-1"]);
    stores.visualizerSceneObjectSelection.set(["scene-object-clipboard-1"]);
  });

  await expect(
    patchGrid.getByRole("checkbox", { name: "Select row 1", exact: true }),
  ).not.toBeChecked();
  await expect(patchGrid.locator("#tanstack-cell-0-0")).toHaveCSS(
    "color",
    "rgb(255, 0, 0)",
  );

  await addSceneObjectsPanel(page);
  const sceneGrid = sceneObjectsGrid(page);
  await expect(
    sceneGrid.getByRole("checkbox", { name: "Select row 1", exact: true }),
  ).toBeChecked();
  await expect(sceneGrid.locator("#tanstack-cell-0-0")).toHaveCSS(
    "color",
    "rgb(255, 0, 0)",
  );
});

test("patch and scene object panels clear edit highlights on close", async ({
  page,
}) => {
  await openApp(page);
  await seedFixtureRows(page);
  await seedSceneObjectRows(page);

  await addPatchPanel(page);
  const patchGrid = patchFixtureGrid(page);
  await expect(patchGrid).toBeVisible();
  await patchGrid.locator("#tanstack-cell-6-0").click({ force: true });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual(["fixture-clipboard-1"]);

  await closePanel(page, "panel-PatchEditor-clipboard-e2e");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual([]);

  await addSceneObjectsPanel(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.visualizerEditSelection.set(["scene-object-clipboard-1"]);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual(["scene-object-clipboard-1"]);

  await closePanel(page, "panel-SceneObjects-clipboard-e2e");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerEditSelection.get(),
      ),
    )
    .toEqual([]);
});
