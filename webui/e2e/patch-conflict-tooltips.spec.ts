// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

type PatchBindingGroup = "none" | "fixture" | "universe";

/**
 * Opens the app directly to the patch bindings tab with the requested grouping.
 */
async function openPatchBindingsPanel(page: Page, groupBy: PatchBindingGroup) {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript((groupBy) => {
    window.localStorage.removeItem("nightfall-ui-layouts");
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "bindings");
    window.localStorage.setItem(
      "nightfall-patch-panel:bindings-group-by",
      groupBy,
    );
  }, groupBy);
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await addPanel(page, {
    id: `panel-PatchEditor-conflict-tooltips-${groupBy}`,
    component: "PatchEditor",
    title: "Patch",
  });
}

/**
 * Waits for the Dockview API to be available in the browser.
 */
async function waitForDockApi(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();

      /** Polls browser state until the awaited test condition is satisfied. */
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
 * Adds and focuses a Dockview panel for a test.
 */
async function addPanel(
  page: Page,
  panel: {
    id: string;
    component: string;
    title: string;
    params?: Record<string, unknown>;
    position?: Record<string, unknown>;
  },
) {
  await waitForDockApi(page);
  await page.evaluate((panel) => {
    const api = (window as any).appStores.dockApi.get();
    const existingPanel = api.getPanel(panel.id);
    if (existingPanel) {
      existingPanel.api.close();
    }
    const nextPanel = api.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      params: panel.params ?? {},
      position: panel.position ?? {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  }, panel);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(panel.id);
}

/**
 * Returns the visible patch bindings grid for the active grouping.
 */
function patchBindingsGrid(page: Page, headerId: string): Locator {
  return page
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator(`[data-grid-header-id="tanstack-header-${headerId}"]`),
    })
    .last();
}

/**
 * Verifies a patch conflict cell uses conflict text and draws a warning decoration.
 */
async function expectPatchConflictCellPresentation(cell: Locator) {
  await expect(cell).toHaveCSS("color", "rgb(239, 68, 68)");
  await expect
    .poll(() =>
      cell.locator("canvas").evaluate((canvasElement) => {
        const canvas = canvasElement as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context || canvas.width <= 0 || canvas.height <= 0) {
          return false;
        }

        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) return true;
        }
        return false;
      }),
    )
    .toBe(true);
}

/**
 * Hovers a conflict cell and verifies the shared tooltip explains the warning.
 */
async function expectConflictTooltip(
  page: Page,
  cell: Locator,
  expectedText: string,
) {
  await expectPatchConflictCellPresentation(cell);
  await cell.hover();
  await expect(page.getByRole("tooltip")).toContainText(expectedText);
  await page.screenshot({ path: test.info().outputPath("patch-conflict.png") });
}

/**
 * Seeds the fixture row used by patch conflict tooltip tests.
 */
async function seedPatchFixture(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.fixtures.set({
      fixturee2e1: {
        identifiers: {
          id: 501,
          uid: "fixturee2e1",
          label: "E2E Patch Fixture",
        },
        make: "E2E Lighting",
        model: "Patch Spot",
        mode: "Default",
        elements: [],
      },
    });
  });
}

/**
 * Seeds duplicate fixture output bindings that overlap on the same transport endpoint.
 */
async function seedDuplicateFixtureOutputBindings(page: Page) {
  await seedPatchFixture(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.bindings.set({
      input: [],
      output: [
        {
          source: {
            type: "Fixture",
            data: {
              uids: ["fixturee2e1"],
              param: "Intensity",
            },
          },
          target: {
            type: "Transport",
            data: {
              target: "sacn",
              universe: { start: 1, end: 1 },
              address: 1,
            },
          },
          priority: 0,
          clone: false,
        },
        {
          source: {
            type: "Fixture",
            data: {
              uids: ["fixturee2e1"],
              param: "Intensity",
            },
          },
          target: {
            type: "Transport",
            data: {
              target: "sacn",
              universe: { start: 1, end: 1 },
              address: 1,
            },
          },
          priority: 1,
          clone: false,
        },
      ],
      disabled: [],
    });
  });
}

/**
 * Seeds duplicate fixture input bindings that target the same fixture parameter.
 */
async function seedDuplicateFixtureInputBindings(page: Page) {
  await seedPatchFixture(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.bindings.set({
      input: [
        {
          source: {
            type: "Transport",
            data: {
              transport: "sacn",
              universe: { start: 1, end: 1 },
              address: 1,
            },
          },
          target: {
            type: "Fixture",
            data: {
              uids: ["fixturee2e1"],
              param: "Intensity",
            },
          },
          priority: 0,
          clone: false,
        },
        {
          source: {
            type: "Transport",
            data: {
              transport: "sacn",
              universe: { start: 2, end: 2 },
              address: 1,
            },
          },
          target: {
            type: "Fixture",
            data: {
              uids: ["fixturee2e1"],
              param: "Intensity",
            },
          },
          priority: 1,
          clone: false,
        },
      ],
      output: [],
      disabled: [],
    });
  });
}

/**
 * Seeds duplicate input bindings that overlap on the same console target endpoint.
 */
async function seedDuplicateConsoleInputBindings(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.fixtures.set({});
    stores.bindings.set({
      input: [
        {
          source: {
            type: "Transport",
            data: {
              transport: "sacn",
              universe: { start: 10, end: 10 },
              address: 1,
            },
          },
          target: {
            type: "Console",
            data: {
              universe: { start: 50, end: 50 },
              address: 5,
            },
          },
          priority: 0,
          clone: false,
        },
        {
          source: {
            type: "Transport",
            data: {
              transport: "artnet",
              universe: { start: 11, end: 11 },
              address: 1,
            },
          },
          target: {
            type: "Console",
            data: {
              universe: { start: 50, end: 50 },
              address: 5,
            },
          },
          priority: 1,
          clone: false,
        },
      ],
      output: [],
      disabled: [],
    });
  });
}

test.describe("patch conflict tooltips", () => {
  /**
   * Covers flat binding, fixture summary, and universe summary output conflict tooltips.
   */
  test("explains duplicate fixture output conflicts on hover", async ({
    page,
  }) => {
    await openPatchBindingsPanel(page, "none");
    await seedDuplicateFixtureOutputBindings(page);

    const flatGrid = patchBindingsGrid(page, "source");
    await expect(flatGrid).toBeVisible();
    await expectConflictTooltip(
      page,
      flatGrid.getByRole("gridcell", { name: "sACN 1.1" }).first(),
      "This output binding overlaps another output route on at least one universe/address.",
    );

    await page
      .locator("main#app")
      .getByRole("tab", { name: "Fixture", exact: true })
      .click();
    const fixturesGrid = patchBindingsGrid(page, "fixture");
    await expect(fixturesGrid).toBeVisible();
    await expectConflictTooltip(
      page,
      fixturesGrid.getByRole("gridcell", { name: "DMX - 2x" }),
      "Fixture 501 (E2E Patch Fixture) has overlapping DMX output bindings.",
    );

    await page
      .locator("main#app")
      .getByRole("tab", { name: "Universe" })
      .click();
    const universesGrid = patchBindingsGrid(page, "universe");
    await expect(universesGrid).toBeVisible();
    await expectConflictTooltip(
      page,
      universesGrid.getByRole("gridcell", { name: "DMX - 2" }),
      "Universe 1 has overlapping output bindings on at least one address.",
    );
  });

  /**
   * Covers the fixture summary tooltip for duplicate input bindings targeting one fixture parameter.
   */
  test("explains duplicate fixture input conflicts on hover", async ({
    page,
  }) => {
    await openPatchBindingsPanel(page, "fixture");
    await seedDuplicateFixtureInputBindings(page);

    const fixturesGrid = patchBindingsGrid(page, "fixture");
    await expect(fixturesGrid).toBeVisible();
    await expectConflictTooltip(
      page,
      fixturesGrid.getByRole("gridcell", { name: "In - 2x" }),
      "Fixture 501 (E2E Patch Fixture) has overlapping input bindings.",
    );
  });

  /**
   * Covers flat binding and universe summary input conflict tooltips.
   */
  test("explains duplicate console input conflicts on hover", async ({
    page,
  }) => {
    await openPatchBindingsPanel(page, "none");
    await seedDuplicateConsoleInputBindings(page);

    const flatGrid = patchBindingsGrid(page, "source");
    await expect(flatGrid).toBeVisible();
    await expectConflictTooltip(
      page,
      flatGrid.getByRole("gridcell", { name: "Console 50.5" }).first(),
      "This input binding overlaps another input route on at least one universe/address.",
    );

    await page
      .locator("main#app")
      .getByRole("tab", { name: "Universe" })
      .click();
    const universesGrid = patchBindingsGrid(page, "universe");
    await expect(universesGrid).toBeVisible();
    await expectConflictTooltip(
      page,
      universesGrid.getByRole("gridcell", { name: "In - 2" }),
      "Universe 50 has overlapping input bindings on at least one address.",
    );
  });
});
