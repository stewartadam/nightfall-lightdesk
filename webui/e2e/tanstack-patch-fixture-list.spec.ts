// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const PATCH_PANEL_ID = "panel-PatchEditor-tanstack-e2e";
const OWNED_FIXTURE_IDS = [96_300, 96_301, 96_302, 96_303] as const;
const OWNED_FIXTURE_UIDS = [
  "c7400000000000000000000000000001",
  "c7400000000000000000000000000002",
  "c7400000000000000000000000000003",
  "c7400000000000000000000000000004",
] as const;

test.describe.configure({ timeout: 120_000 });

/** Replaces the backend after each scenario and proves fixture runtime state is blank. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedPatchStoreCounts(page))
    .toEqual({
      fixtures: 0,
      parameters: 0,
    });
});

/** Reads the backend-driven stores owned by the Patch fixture scenarios. */
async function ownedPatchStoreCounts(
  page: import("@playwright/test").Page,
): Promise<{ fixtures: number; parameters: number }> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      fixtures: Object.keys(stores?.fixtures?.get?.() ?? {}).length,
      parameters: stores?.parameters?.get?.()?.size ?? 0,
    };
  });
}

/** Sends one correlated backend command and rejects a failed command outcome. */
async function sendOwnedPatchCommand(
  page: import("@playwright/test").Page,
  message: object,
): Promise<void> {
  const result = await page.evaluate(async (command) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(command);
  }, message);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds one deterministic intensity fixture with editable 3D placement. */
function ownedPatchFixture(index: number): object {
  const id = OWNED_FIXTURE_IDS[index];
  const uid = OWNED_FIXTURE_UIDS[index];
  if (id === undefined || uid === undefined) {
    throw new Error(`Missing owned Patch fixture at index ${index}`);
  }
  return {
    identifiers: {
      id,
      uid,
      label: `Owned Patch Fixture ${index + 1}`,
    },
    make: "E2E",
    model: "TanStack Patch Fixture",
    mode: "Intensity",
    elements: [
      {
        label: "Main",
        parameters: [
          {
            resolution: "Coarse",
            attribute: { type: "Intensity" },
            value_polarity: "Unsigned",
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
      position: { x: index + 1, y: index + 11, z: index + 21 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  };
}

/** Opens a fresh backend session and persists the exact four-fixture graph. */
async function openOwnedPatchApp(
  page: import("@playwright/test").Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.parameters?.get),
  );
  await expect
    .poll(() => ownedPatchStoreCounts(page))
    .toEqual({
      fixtures: 0,
      parameters: 0,
    });

  for (let index = 0; index < OWNED_FIXTURE_IDS.length; index += 1) {
    await sendOwnedPatchCommand(page, {
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: ownedPatchFixture(index),
      },
    });
  }
  await expect
    .poll(() => ownedPatchStoreCounts(page))
    .toEqual({
      fixtures: OWNED_FIXTURE_IDS.length,
      parameters: OWNED_FIXTURE_IDS.length,
    });
}

/**
 * Reads the active cell rectangle against the visible grid viewport.
 */
async function readActiveCellViewportMetrics(grid: Locator) {
  return await grid.evaluate((element) => {
    const activeCell = element.querySelector<HTMLElement>(
      '[role="gridcell"][aria-selected="true"]',
    );
    if (!activeCell) {
      throw new Error("No active TanStack grid cell found");
    }
    const activeMatch = activeCell.id.match(/^tanstack-cell-(\d+)-(\d+)$/);
    if (!activeMatch) {
      throw new Error(`Unexpected active cell id ${activeCell.id}`);
    }

    const activeRect = activeCell.getBoundingClientRect();
    const gridRect = element.getBoundingClientRect();
    const rowIndex = activeMatch[2]!;
    const frozenCell = element.querySelector<HTMLElement>(
      `#tanstack-cell-0-${rowIndex}`,
    );
    const frozenRight =
      frozenCell?.getBoundingClientRect().right ?? gridRect.left;
    const headerBottom = Array.from(
      element.querySelectorAll<HTMLElement>("[data-grid-header-id]"),
    ).reduce((bottom, header) => {
      const rect = header.getBoundingClientRect();
      const intersectsGrid =
        rect.bottom > gridRect.top &&
        rect.top < gridRect.bottom &&
        rect.right > gridRect.left &&
        rect.left < gridRect.right;
      return intersectsGrid ? Math.max(bottom, rect.bottom) : bottom;
    }, gridRect.top);

    return {
      activeId: activeCell.id,
      bottom: activeRect.bottom,
      frozenRight,
      gridBottom: gridRect.bottom,
      gridRight: gridRect.right,
      headerBottom,
      left: activeRect.left,
      right: activeRect.right,
      top: activeRect.top,
    };
  });
}

/**
 * Waits until the Dockview API is available on appStores.
 */
async function waitForDockApi(page: import("@playwright/test").Page) {
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
 * Adds a Patch panel and focuses it.
 */
async function addPatchPanel(
  page: import("@playwright/test").Page,
  panelId: string,
) {
  await waitForDockApi(page);
  await page.evaluate((id) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel(id)?.api.close();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const nextPanel = api.addPanel({
      id,
      component: "PatchEditor",
      title: "Patch",
      params: {},
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
  }, panelId);
}

/**
 * Opens a Patch panel and proves its rows are the four exact owned fixtures.
 */
async function openPatchPanelWithTanStackGrid(
  page: import("@playwright/test").Page,
  panelId = PATCH_PANEL_ID,
) {
  await addPatchPanel(page, panelId);

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await expect(
    panel.getByRole("button", { name: "Add fixture", exact: true }),
  ).toBeVisible();

  const grid = panel.locator('[data-grid-kind="tanstack"]').filter({
    has: page.locator('[data-grid-header-id="tanstack-header-group:Position"]'),
  });
  await expect(grid).toBeVisible();
  for (const [row, id] of OWNED_FIXTURE_IDS.entries()) {
    await expect(grid.locator(`#tanstack-cell-0-${row}`)).toHaveText(
      String(id),
    );
  }
  return grid;
}

/** Opens a fresh app with owned fixtures and returns its Patch fixture grid. */
async function openPatchWithTanStackGrid(
  page: import("@playwright/test").Page,
  backendPort: number,
  panelId = PATCH_PANEL_ID,
) {
  await openOwnedPatchApp(page, backendPort);
  return openPatchPanelWithTanStackGrid(page, panelId);
}

/** Drags from one rendered grid cell to another while holding optional modifiers. */
async function dragBetweenGridCells(
  page: import("@playwright/test").Page,
  start: import("@playwright/test").Locator,
  end: import("@playwright/test").Locator,
  modifiers: string[] = [],
) {
  await start.scrollIntoViewIfNeeded();
  await end.scrollIntoViewIfNeeded();
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  if (!startBox || !endBox) {
    throw new Error("Unable to resolve tanstack patch cell bounds for drag");
  }

  for (const modifier of modifiers) {
    await page.keyboard.down(modifier);
  }
  await page.mouse.move(
    startBox.x + startBox.width / 2,
    startBox.y + startBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    endBox.x + endBox.width / 2,
    endBox.y + endBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) {
    await page.keyboard.up(modifier);
  }
}

/** Verifies an exact owned fixture placement cell commits an inline edit. */
test("TanStack patch fixture list commits an editable placement cell", async ({
  backendSlot,
  page,
}, testInfo) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const editableCell = grid.locator("#tanstack-cell-6-0");
  const nextRowCell = grid.locator("#tanstack-cell-6-1");
  await expect(editableCell).toHaveText(/-?\d/);
  await expect(nextRowCell).toHaveText(/-?\d/);

  await editableCell.dblclick();
  const editor = editableCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("12.345");
  await editor.press("Enter");

  await expect(editor).toBeHidden();
  await expect(editableCell).toHaveAttribute("aria-selected", "true");
  await expect(nextRowCell).toHaveAttribute("aria-selected", "false");
  await expect(editableCell).toHaveText(/^12\.345/);
  const screenshotPath = testInfo.outputPath("owned-placement-cell-edit.png");
  await grid.screenshot({ path: screenshotPath });
  await testInfo.attach("owned-placement-cell-edit", {
    path: screenshotPath,
    contentType: "image/png",
  });
});

/** Verifies the shell help shortcut does not enter grid type-to-edit mode. */
test("TanStack patch fixture list leaves cells unchanged for shell help shortcut", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const editableCell = grid.locator("#tanstack-cell-6-0");
  await expect(editableCell).toHaveText(/-?\d/);
  const originalCellText = (await editableCell.innerText()).trim();

  await editableCell.click();
  await page.keyboard.press("Shift+/");

  await expect(
    page.getByRole("heading", { name: "Keyboard Shortcuts" }),
  ).toBeVisible();
  await expect(editableCell.locator("input")).toBeHidden();
  await expect(editableCell).toHaveText(originalCellText);
});

/** Verifies Delete applies the shared numeric empty value to editable grid cells. */
test("TanStack patch fixture list clears editable numeric cells with Delete", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const editableCell = grid.locator("#tanstack-cell-6-0");
  await expect(editableCell).toHaveText(/-?\d/);

  await editableCell.dblclick();
  const editor = editableCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("12.345");
  await editor.press("Enter");
  await expect(editor).toBeHidden();
  await expect(editableCell).toHaveText(/^12\.345/);

  await editableCell.click();
  await page.keyboard.press("Delete");

  await expect(editableCell).toHaveText(/^0(?:\.0+)?$/);
});

/** Verifies fixture ID seek selects the second exact owned row. */
test("TanStack patch fixture list supports type-to-seek by primary ID", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const firstIdCell = grid.locator("#tanstack-cell-0-0");
  const secondIdCell = grid.locator("#tanstack-cell-0-1");
  await expect(firstIdCell).toHaveText(/\d/);
  const secondId = (await secondIdCell.innerText()).trim();

  await firstIdCell.click();
  await expect(firstIdCell).toHaveAttribute("data-selected", "true");

  await page.keyboard.press("ControlOrMeta+g");
  const seekInput = page.getByRole("textbox", { name: "Fixture ID seek" });
  await expect(seekInput).toBeVisible();
  await seekInput.fill(secondId);
  await seekInput.press("Enter");

  await expect(secondIdCell).toHaveAttribute("aria-selected", "true");
});

/** Verifies keyboard navigation scrolls an owned placement cell into view. */
test("TanStack patch fixture list keeps keyboard active cell visible", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  await grid.locator("#tanstack-cell-5-0").click();
  await expect(grid.locator("#tanstack-cell-5-0")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await grid.evaluate((element) => {
    element.scrollLeft = 540;
  });
  await grid.locator("xpath=ancestor::*[@role='grid'][1]").focus();
  await page.keyboard.press("ArrowRight");

  await expect(grid.locator("#tanstack-cell-6-0")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const metrics = await readActiveCellViewportMetrics(grid);
  expect(metrics.activeId).toBe("tanstack-cell-6-0");
  expect(metrics.left).toBeGreaterThanOrEqual(metrics.frozenRight - 1);
  expect(metrics.right).toBeLessThanOrEqual(metrics.gridRight + 1);
  expect(metrics.top).toBeGreaterThanOrEqual(metrics.headerBottom - 1);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.gridBottom + 1);
});

/** Verifies shift-selection spans the first three exact fixture markers. */
test("TanStack patch fixture list supports row marker range selection", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const panel = page.locator(`[data-panel-id="${PATCH_PANEL_ID}"]`);
  const deleteButton = panel.getByRole("button", {
    name: "Delete selected fixtures",
    exact: true,
  });
  await expect(deleteButton).toBeDisabled();

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await grid
    .getByRole("checkbox", { name: "Select row 3", exact: true })
    .click({ modifiers: ["Shift"] });

  await expect(deleteButton).toBeEnabled();
  await expect(deleteButton).toContainText("3");
});

/** Verifies a marker-selected owned fixture opens the morph workflow. */
test("TanStack patch fixture list opens morph wizard for selected rows", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);
  const panel = page.locator(`[data-panel-id="${PATCH_PANEL_ID}"]`);
  const morphButton = panel.getByRole("button", {
    name: "Morph selected fixtures",
    exact: true,
  });

  await expect(morphButton).toBeDisabled();

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();

  await expect(morphButton).toBeEnabled();
  await expect(morphButton).toContainText("1");
  await morphButton.click();

  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Morph Fixture" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Configure", { exact: true }),
  ).not.toBeVisible();
});

/** Verifies a cell range drives fixture row actions for all four owned rows. */
test("TanStack patch fixture list uses cell ranges for row actions", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);
  const panel = page.locator(`[data-panel-id="${PATCH_PANEL_ID}"]`);
  const morphButton = panel.getByRole("button", {
    name: "Morph selected fixtures",
    exact: true,
  });
  const deleteButton = panel.getByRole("button", {
    name: "Delete selected fixtures",
    exact: true,
  });
  const firstCell = grid.locator("#tanstack-cell-0-0");

  await expect(morphButton).toBeDisabled();
  await expect(deleteButton).toBeDisabled();

  await firstCell.click();

  await expect(morphButton).toBeEnabled();
  await expect(deleteButton).toBeEnabled();
  await expect(morphButton).toContainText("1");
  await expect(deleteButton).toContainText("1");

  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");

  await expect(
    grid.locator("xpath=ancestor::*[@role='grid'][1]"),
  ).toHaveAttribute("data-selection-range", "0,0,1,4");
  await expect(morphButton).toContainText("4");
  await expect(deleteButton).toContainText("4");

  await morphButton.click();

  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Morph Fixture" }),
  ).toBeVisible();
});

/** Verifies the Position group selects only its three owned coordinate columns. */
test("TanStack patch fixture list grouped header selects its columns", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  await grid
    .locator('[data-grid-header-id="tanstack-header-group:Position"]')
    .click();

  await expect(grid.locator("#tanstack-cell-6-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-7-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-8-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-5-0")).toHaveAttribute(
    "data-selected",
    "false",
  );
});

/** Verifies a Pos X range edit applies to two exact owned fixture rows. */
test("TanStack patch fixture list applies range edits to selected rows", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const firstRowCell = grid.locator("#tanstack-cell-6-0");
  const secondRowCell = grid.locator("#tanstack-cell-6-1");
  await expect(firstRowCell).toHaveText(/-?\d/);
  await expect(secondRowCell).toHaveText(/-?\d/);

  await firstRowCell.click();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(
    grid.locator("xpath=ancestor::*[@role='grid'][1]"),
  ).toHaveAttribute("data-selection-range", "6,0,1,2");
  await page.keyboard.press("Enter");

  const editor = secondRowCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("23.456");
  await editor.press("Enter");

  await expect(editor).toBeHidden();
  await expect(firstRowCell).toHaveText(/^23\.456/);
  await expect(secondRowCell).toHaveText(/^23\.456/);
});

/** Verifies additive drag selections keep all selected row targets during edit commit. */
test("TanStack patch fixture list applies edits across additive drag ranges", async ({
  backendSlot,
  page,
}) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  const targetCells = [0, 1, 2, 3].map((row) =>
    grid.locator(`#tanstack-cell-6-${row}`),
  );
  for (const cell of targetCells) {
    await expect(cell).toHaveText(/-?\d/);
  }

  await dragBetweenGridCells(page, targetCells[0]!, targetCells[1]!);
  await dragBetweenGridCells(page, targetCells[2]!, targetCells[3]!, [
    "ControlOrMeta",
  ]);

  for (const cell of targetCells) {
    await expect(cell).toHaveAttribute("data-selected", "true");
  }

  await page.keyboard.press("Enter");
  const editor = targetCells[3]!.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("34.567");
  await editor.press("Enter");

  await expect(editor).toBeHidden();
  for (const cell of targetCells) {
    await expect(cell).toHaveText(/^34\.567/);
  }
});

/** Verifies marker-selected placement edits survive a fresh websocket snapshot. */
test("TanStack patch fixture list persists marker-selected Pos Y edits after reload", async ({
  backendSlot,
  page,
}, testInfo) => {
  const grid = await openPatchWithTanStackGrid(page, backendSlot.backendPort);

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await grid
    .getByRole("checkbox", { name: "Select row 2", exact: true })
    .click({ modifiers: ["Shift"] });

  const firstRowCell = grid.locator("#tanstack-cell-7-0");
  const secondRowCell = grid.locator("#tanstack-cell-7-1");
  await firstRowCell.dblclick();
  const editor = firstRowCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("34.567");
  await editor.press("Enter");

  await expect(editor).toBeHidden();
  await expect(firstRowCell).toHaveText(/^34\.567/);
  await expect(secondRowCell).toHaveText(/^34\.567/);

  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedPatchStoreCounts(page))
    .toEqual({
      fixtures: OWNED_FIXTURE_IDS.length,
      parameters: OWNED_FIXTURE_IDS.length,
    });
  const reloadedGrid = await openPatchPanelWithTanStackGrid(
    page,
    "panel-PatchEditor-tanstack-e2e-reload",
  );
  await expect(reloadedGrid.locator("#tanstack-cell-7-0")).toHaveText(
    /^34\.567/,
  );
  await expect(reloadedGrid.locator("#tanstack-cell-7-1")).toHaveText(
    /^34\.567/,
  );
  const screenshotPath = testInfo.outputPath(
    "owned-placement-edit-after-reload.png",
  );
  await reloadedGrid.screenshot({ path: screenshotPath });
  await testInfo.attach("owned-placement-edit-after-reload", {
    path: screenshotPath,
    contentType: "image/png",
  });
});
