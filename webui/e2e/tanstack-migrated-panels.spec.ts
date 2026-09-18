// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

/**
 * Opens the application with TanStack-backed panels enabled.
 */
async function openTanStackApp(page: Page) {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
  });
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
  await expect(page.locator("main#app")).toBeVisible();
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
 * Disconnects the frontend websocket so seeded stores remain deterministic.
 */
async function disconnectBackend(page: Page) {
  await page.evaluate(async () => {
    const { engineRuntime } = await import(
      /* @vite-ignore */ "/lib/engine-runtime.ts"
    );
    engineRuntime.stop();
  });
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
 * Finds the grid that contains a given text marker.
 */
function gridContaining(page: Page, text: string | RegExp): Locator {
  return page
    .locator('[data-grid-kind="tanstack"]')
    .filter({ hasText: text })
    .last();
}

/**
 * Edits a grid cell by replacing its text value.
 */
async function editCellText(cell: Locator, value: string) {
  await cell.dblclick();
  const editor = cell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await editor.press("Enter");
  await expect(editor).toBeHidden();
}

/**
 * Seeds mapping-related stores for migrated panel tests.
 */
async function seedMappingStores(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.midiMappings.set([
      {
        device_name: "E2E Controller",
        channel: 144,
        note: 60,
        velocity: 127,
        action: { type: "StartClip", data: 1 },
      },
      {
        device_name: "E2E Controller",
        channel: 144,
        note: 61,
        velocity: undefined,
        action: { type: "StopClip", data: 1 },
      },
    ]);
    stores.oscMappings.set([
      {
        source: "127.0.0.1:9000",
        address: "/e2e/go",
        arg_index: 0,
        arg_value: "1",
        action: { type: "GoClip", data: 1 },
      },
      {
        source: "127.0.0.1:9000",
        address: "/e2e/stop",
        arg_index: 0,
        arg_value: "0",
        action: { type: "StopClip", data: 1 },
      },
    ]);
  });
}

/**
 * Seeds scene and fixture-library stores for migrated panel tests.
 */
async function seedSceneAndLibraryStores(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const sceneObject = {
      identifiers: {
        id: 701,
        uid: "scene-object-e2e",
        label: "E2E Stage Deck",
      },
      objectType: "stageElement",
      placement: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 10, z: 20 },
      },
      properties: {
        type: "StageElement",
        data: { modelPath: "stage-deck.glb", scale: 1 },
      },
    };
    stores.sceneObjects.set({
      ...stores.sceneObjects.get(),
      "scene-object-e2e": sceneObject,
    });
    stores.fixtureLibrary.set([
      {
        make: "E2E Lighting",
        model: "Spot 3000",
        modes: ["Default", "Extended"],
        source_format: "OFL",
        asset_etag: "fixture-e2e-v1",
      },
    ]);
    stores.objectLibrary.set([
      {
        name: "E2E Road Case",
        category: "Props",
        description: "Road case for panel coverage",
        scale: 1.25,
        tags: ["case", "tour"],
        modelPath: "e2e-road-case.glb",
        assetVersion: "object-e2e-v1",
      },
    ]);
  });
}

/**
 * Seeds clip rows for migrated panel tests.
 */
async function seedClips(page: Page) {
  await page.evaluate(() => {
    /** Builds a seeded clip tuple for migrated panel rows. */
    const clip = (id: number, uid: string, label: string) => [
      {
        identifiers: { id, uid, label },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      },
      false,
    ];
    (window as any).appStores.clips.set({
      "clip-e2e-1": clip(1, "clip-e2e-1", "E2E Clip 1"),
      "clip-e2e-2": clip(2, "clip-e2e-2", "E2E Clip 2"),
      "clip-e2e-3": clip(3, "clip-e2e-3", "E2E Clip 3"),
    });
  });
}

/**
 * Seeds one cue row with readonly boolean fields for migrated panel selection.
 */
async function seedCues(page: Page) {
  await page.evaluate(() => {
    (window as any).appStores.cues.set({
      "cue-tanstack-readonly": {
        identifiers: {
          id: 1,
          uid: "cue-tanstack-readonly",
          label: "E2E Readonly Cue",
        },
        description: "Owns the readonly boolean selection fixture",
      },
    });
  });
}

/**
 * Seeds patch binding stores for migrated panel table tests.
 */
async function seedPatchBindingTableStores(page: Page) {
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
          priority: 0,
          clone: false,
        },
      ],
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

test("TanStack migrated MIDI and OSC mapping panels edit live rows", async ({
  page,
}) => {
  await openTanStackApp(page);
  await seedMappingStores(page);

  await addPanel(page, {
    id: "panel-MidiInput-tanstack-e2e",
    component: "MidiInput",
    title: "MIDI Input",
  });
  const midiGrid = gridContaining(page, "E2E Controller");
  await expect(midiGrid).toBeVisible();
  await expect(midiGrid.locator("#tanstack-cell-0-0")).toHaveText(
    "E2E Controller",
  );
  await midiGrid.locator("#tanstack-cell-0-0").click();
  await expect(
    page.getByRole("button", { name: /Delete/ }).last(),
  ).toContainText("1");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(
    page.getByRole("button", { name: /Delete/ }).last(),
  ).toContainText("2");
  await editCellText(midiGrid.locator("#tanstack-cell-2-0"), "64");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.midiMappings.get()[0].note),
    )
    .toBe(64);

  await addPanel(page, {
    id: "panel-OscInput-tanstack-e2e",
    component: "OscInput",
    title: "OSC Input",
  });
  const oscGrid = page.locator('[data-grid-kind="tanstack"]').last();
  await expect(oscGrid).toBeVisible();
  await expect(oscGrid.locator("#tanstack-cell-1-0")).toHaveText("/e2e/go");
  await oscGrid.locator("#tanstack-cell-1-0").click();
  await expect(
    page.getByRole("button", { name: /Delete/ }).last(),
  ).toContainText("1");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(
    page.getByRole("button", { name: /Delete/ }).last(),
  ).toContainText("2");
  await editCellText(oscGrid.locator("#tanstack-cell-1-0"), "/e2e/stop");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscMappings.get()[0].address,
      ),
    )
    .toBe("/e2e/stop");
});

test("TanStack migrated scene and library panels render rows and row-marker selection", async ({
  page,
}) => {
  await openTanStackApp(page);
  await seedSceneAndLibraryStores(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.sceneObjects.get()["scene-object-e2e"]
            ?.identifiers.label,
      ),
    )
    .toBe("E2E Stage Deck");
  await addPanel(page, {
    id: "panel-SceneObjects-tanstack-e2e",
    component: "SceneObjects",
    title: "Scene Objects",
    params: { initialPanelId: "panel-SceneObjects-tanstack-e2e" },
  });
  await seedSceneAndLibraryStores(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.sceneObjects.get()["scene-object-e2e"]
            ?.identifiers.label,
      ),
    )
    .toBe("E2E Stage Deck");
  await page.getByText("Scene Objects", { exact: true }).last().click();
  await expect(page.getByText("Label", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Pos X", { exact: true }).last()).toBeVisible();
  const sceneObjectsGrid = page.locator('[data-grid-kind="tanstack"]').last();
  await expect(sceneObjectsGrid).toBeVisible();
  await sceneObjectsGrid.locator("#tanstack-cell-0-0").click();
  await expect(
    page.getByRole("button", { name: "Delete selected scene objects" }),
  ).toContainText("1");

  await addPanel(page, {
    id: "panel-FixtureLibrary-tanstack-e2e",
    component: "FixtureLibrary",
    title: "Fixture Library",
    params: { initialPanelId: "panel-FixtureLibrary-tanstack-e2e" },
  });
  await page.getByText("Fixture Library", { exact: true }).last().click();
  await seedSceneAndLibraryStores(page);
  const fixtureLibraryGrid = gridContaining(page, "E2E Lighting");
  await expect(fixtureLibraryGrid).toBeVisible();
  await expect(fixtureLibraryGrid.locator("#tanstack-cell-0-0")).toHaveText(
    "E2E Lighting",
  );
  await fixtureLibraryGrid.locator("#tanstack-cell-0-0").click();
  await expect(
    page.getByRole("button", { name: "Delete selected (1)" }).last(),
  ).toBeVisible();

  await addPanel(page, {
    id: "panel-ObjectLibrary-tanstack-e2e",
    component: "ObjectLibrary",
    title: "Object Library",
    params: { initialPanelId: "panel-ObjectLibrary-tanstack-e2e" },
  });
  await page.getByText("Object Library", { exact: true }).last().click();
  await seedSceneAndLibraryStores(page);
  const objectLibraryGrid = gridContaining(page, "E2E Road Case");
  await expect(objectLibraryGrid).toBeVisible();
  await expect(objectLibraryGrid.locator("#tanstack-cell-0-0")).toHaveText(
    "E2E Road Case",
  );
  await objectLibraryGrid.locator("#tanstack-cell-0-0").click();
  await expect(
    page.getByRole("button", { name: "Delete selected (1)" }).last(),
  ).toBeVisible();
});

/**
 * Verifies Scene Objects warning cells repaint from store updates without grid invalidation props.
 */
test("TanStack scene object warning clears reactively after version update", async ({
  page,
}) => {
  await openTanStackApp(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.sceneObjects.set({
      "scene-warning-e2e": {
        identifiers: {
          id: 702,
          uid: "scene-warning-e2e",
          label: "E2E Warning Case",
        },
        objectType: "custom",
        placement: {
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 10, z: 20 },
        },
        properties: {
          type: "Custom",
          data: {
            modelPath: "show-warning-case.glb",
            scale: 1,
            libraryObjectName: "E2E Warning Case",
            libraryObjectVersion: "object-e2e-v1",
          },
        },
      },
    });
    stores.objectLibrary.set([
      {
        name: "E2E Warning Case",
        category: "Props",
        description: "Version warning coverage",
        scale: 1,
        tags: ["case"],
        modelPath: "library-warning-case.glb",
        assetVersion: "object-e2e-v2",
      },
    ]);
  });
  await addPanel(page, {
    id: "panel-SceneObjects-warning-e2e",
    component: "SceneObjects",
    title: "Scene Objects",
    params: { initialPanelId: "panel-SceneObjects-warning-e2e" },
  });

  const sceneObjectsGrid = gridContaining(page, "E2E Warning Case");
  const typeCell = sceneObjectsGrid.locator("#tanstack-cell-2-0");
  await expect(typeCell).toHaveText("Custom ⚠️");

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const sceneObject = stores.sceneObjects.get()["scene-warning-e2e"];
    stores.sceneObjects.setKey("scene-warning-e2e", {
      ...sceneObject,
      properties: {
        ...sceneObject.properties,
        data: {
          ...sceneObject.properties.data,
          libraryObjectVersion: "object-e2e-v2",
        },
      },
    });
  });

  await expect(typeCell).toHaveText("Custom");
});

test("TanStack readonly boolean cells do not intercept row selection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-crud-panel-view-mode:cue-list",
      "list",
    );
  });
  await openTanStackApp(page);
  await seedCues(page);
  await addPanel(page, {
    id: "panel-CueList-readonly-boolean-tanstack-e2e",
    component: "CueList",
    title: "Cues",
    params: { initialPanelId: "panel-CueList-readonly-boolean-tanstack-e2e" },
  });

  const grid = page
    .locator('[data-grid-kind="tanstack"]')
    .filter({ has: page.locator('[data-grid-header-id="tanstack-header-id"]') })
    .last();
  await expect(grid).toBeVisible();

  const readonlyCheckbox = grid
    .locator('[role="gridcell"] input[type="checkbox"]:disabled')
    .first();
  await expect(readonlyCheckbox).toBeVisible();
  const markerCell = readonlyCheckbox.locator(
    "xpath=ancestor::*[@role='gridcell'][1]",
  );
  await markerCell.click();
  await expect(markerCell).toHaveAttribute("data-selected", "true");
});

test("TanStack migrated patch binding group tables render and resize columns", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "bindings");
    window.localStorage.setItem(
      "nightfall-patch-panel:bindings-group-by",
      "none",
    );
  });
  await openTanStackApp(page);
  await disconnectBackend(page);
  await addPanel(page, {
    id: "panel-PatchEditor-tanstack-e2e",
    component: "PatchEditor",
    title: "Patch",
  });
  await disconnectBackend(page);
  await seedPatchBindingTableStores(page);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        fixtureLabel: (window as any).appStores.fixtures.get().fixturee2e1
          ?.identifiers?.label,
        inputCount: (window as any).appStores.bindings.get().input.length,
        outputCount: (window as any).appStores.bindings.get().output.length,
      })),
    )
    .toEqual({
      fixtureLabel: "E2E Patch Fixture",
      inputCount: 2,
      outputCount: 2,
    });
  const patchPanel = page.locator("main#app");

  const bindingsGrid = page
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator('[data-grid-header-id="tanstack-header-source"]'),
    })
    .last();
  await expect(bindingsGrid).toBeVisible();
  await expect(
    bindingsGrid.locator('[data-grid-header-id="tanstack-header-target"]'),
  ).toBeVisible();
  await expectPatchConflictCellPresentation(
    bindingsGrid
      .locator('[data-grid-column-key="source"]')
      .filter({ hasText: /sACN 1\.(?:1|\*)/ })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    bindingsGrid
      .locator('[data-grid-column-key="source"]')
      .filter({ hasText: /sACN 2\.(?:1|\*)/ })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    bindingsGrid
      .locator('[data-grid-column-key="target"]')
      .filter({ hasText: "sACN 1.1" })
      .first(),
  );
  const deleteBindingsButton = page.getByRole("button", {
    name: "Delete selected bindings",
  });
  await expect(deleteBindingsButton).toBeDisabled();
  await bindingsGrid.locator("#tanstack-cell-0-0").click();
  await expect(deleteBindingsButton).toBeEnabled();
  await expect(deleteBindingsButton).toContainText("1");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(deleteBindingsButton).toContainText("2");

  const sourceHeader = bindingsGrid.locator(
    '[data-grid-header-id="tanstack-header-source"]',
  );
  await expect(sourceHeader).toBeVisible();
  const initialWidth = await sourceHeader.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const sourceBox = await sourceHeader.boundingBox();
  expect(sourceBox).not.toBeNull();
  await sourceHeader.hover({ position: { x: initialWidth - 2, y: 12 } });
  await page.mouse.down();
  await page.mouse.move(sourceBox!.x + initialWidth + 42, sourceBox!.y + 12);
  await page.mouse.up();
  await expect
    .poll(() =>
      sourceHeader.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(initialWidth + 20);

  await patchPanel.getByRole("tab", { name: "Fixture", exact: true }).click();
  const fixturesGrid = page
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator('[data-grid-header-id="tanstack-header-fixture"]'),
    })
    .last();
  await expect(fixturesGrid).toBeVisible();
  await expectPatchConflictCellPresentation(
    fixturesGrid.getByRole("gridcell", { name: "In - 2x" }),
  );
  await expectPatchConflictCellPresentation(
    fixturesGrid.getByRole("gridcell", { name: "DMX - 2x" }),
  );
  await expect(
    fixturesGrid.getByRole("gridcell", { name: "DMX - 2x" }),
  ).toBeVisible();
  await fixturesGrid
    .getByRole("gridcell", { name: "Fixture 501 (E2E Patch Fixture)" })
    .click();
  await fixturesGrid
    .locator('[data-grid-column-key="source"]')
    .filter({ hasText: "sACN 1.1" })
    .first()
    .click({ button: "right" });
  let menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Show binding" }),
  ).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).not.toBeVisible();
  await expectPatchConflictCellPresentation(
    fixturesGrid
      .locator('[data-grid-column-key="source"]')
      .filter({ hasText: "sACN 1.1" })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    fixturesGrid
      .locator('[data-grid-column-key="source"]')
      .filter({ hasText: "sACN 2.1" })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    fixturesGrid
      .locator('[data-grid-column-key="target"]')
      .filter({ hasText: "sACN 1.1" })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    fixturesGrid
      .locator('[data-grid-column-key="target"]')
      .filter({ hasText: "sACN 1.1" })
      .nth(1),
  );
  await patchPanel.getByRole("tab", { name: "Universe" }).click();
  const universesGrid = page
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator('[data-grid-header-id="tanstack-header-universe"]'),
    })
    .last();
  await expect(universesGrid).toBeVisible();
  await expectPatchConflictCellPresentation(
    universesGrid.getByRole("gridcell", { name: "DMX - 2" }),
  );
  await expect(
    universesGrid.getByRole("gridcell", { name: "DMX - 2" }),
  ).toBeVisible();
  await universesGrid
    .locator(
      '[data-grid-column-key="universe"][data-grid-row-key="universe:1"]',
    )
    .click();
  await universesGrid
    .locator('[data-grid-column-key="source"]')
    .filter({ hasText: "sACN 1.1" })
    .first()
    .click({ button: "right" });
  menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Show binding" }),
  ).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).not.toBeVisible();
  await expectPatchConflictCellPresentation(
    universesGrid
      .locator('[data-grid-column-key="source"]')
      .filter({ hasText: "sACN 1.1" })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    universesGrid
      .locator('[data-grid-column-key="target"]')
      .filter({ hasText: "sACN 1.1" })
      .first(),
  );
  await expectPatchConflictCellPresentation(
    universesGrid
      .locator('[data-grid-column-key="target"]')
      .filter({ hasText: "sACN 1.1" })
      .nth(1),
  );
  await universesGrid
    .locator(
      '[data-grid-column-key="universe"][data-grid-row-key="universe:2"]',
    )
    .click();
  await expectPatchConflictCellPresentation(
    universesGrid
      .locator('[data-grid-column-key="source"]')
      .filter({ hasText: "sACN 2.1" })
      .first(),
  );
});

test("TanStack CRUD list preserves row click, ctrl toggle, and shift range selection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-crud-panel-view-mode:clips-list",
      "list",
    );
  });
  await openTanStackApp(page);
  await seedClips(page);
  await addPanel(page, {
    id: "panel-ClipList-selection-tanstack-e2e",
    component: "ClipList",
    title: "Clips",
    params: { initialPanelId: "panel-ClipList-selection-tanstack-e2e" },
  });

  const clipPanel = page.locator(
    '[data-panel-kind="clips"][data-panel-id="panel-ClipList-selection-tanstack-e2e"]',
  );
  const grid = clipPanel.locator('[data-grid-kind="tanstack"]');
  const deleteButton = clipPanel.getByRole("button", {
    name: "Delete selected clips",
  });
  await expect(grid).toBeVisible();
  await expect(deleteButton).toBeDisabled();

  await grid.locator("#tanstack-cell-1-0").click();
  await expect(deleteButton).toBeEnabled();
  await expect(deleteButton).toContainText("1");

  await grid
    .locator("#tanstack-cell-1-1")
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(deleteButton).toContainText("2");

  await grid.locator("#tanstack-cell-1-2").click({ modifiers: ["Shift"] });
  await expect(deleteButton).toContainText("3");

  await grid
    .locator("#tanstack-cell-1-1")
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(deleteButton).toContainText("2");
});
