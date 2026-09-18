// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  cueGridAttributeValueColumnKey,
  gridCellByIdentifier,
} from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const commandInputSelector = "#header-cmdline";
const blueprintReferenceTextColor = "rgb(110, 231, 183)";

test.setTimeout(120_000);

/** Opens a fresh backend and creates the RGBW fixtures used by the Blueprint workflow. */
async function openOwnedBlueprintApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (const fixtureId of [311, 312, 313]) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Blueprint Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to create Blueprint fixture ${fixtureId}: ${JSON.stringify(result)}`,
        );
      }
    }
    const pixelBarResult = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: 314,
          make: "Generic",
          model: "12-segment RGBW Bar",
          mode: "RGBW",
          label: "Blueprint Pixel Bar 314",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (pixelBarResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to create Blueprint pixel bar 314: ${JSON.stringify(pixelBarResult)}`,
      );
    }
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          fixtureCount: Object.keys(stores.fixtures.get()).length,
          parameterCount: stores.parameters.get().size,
        };
      }),
    )
    .toMatchObject({ fixtureCount: 4 });
}

/** Waits for the command response recorded by the connected backend. */
async function waitForCommandSuccess(
  page: Page,
  command: string,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submittedCommand,
        );
        const last = matches[matches.length - 1];
        return last
          ? { status: last.status, errorMessage: last.errorMessage }
          : null;
      }, command),
    )
    .toEqual({ status: "success" });
}

/** Submits one operator command and waits for its structured success response. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(commandInputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await waitForCommandSuccess(page, command);
}

/** Opens the singleton Blueprints panel through the command palette. */
async function openBlueprintsPanel(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Blueprints");
  await page.keyboard.press("Enter");
  const panel = page.locator('[data-panel-kind="blueprints"]:visible');
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens the Programmer panel and returns its visible attribute grid. */
async function openProgrammerGrid(page: Page): Promise<Locator> {
  await page.getByText("Programmer", { exact: true }).first().click();
  const panel = page.locator('[data-panel-kind="programmer"]:visible');
  await expect(panel).toBeVisible();
  const grid = panel.locator('[data-grid-kind="tanstack"]').filter({
    has: page.locator('[data-grid-header-id="tanstack-header-category:Color"]'),
  });
  await expect(grid).toBeVisible();
  return grid;
}

/** Resolves one visible Programmer leaf header to its rendered column index. */
async function programmerColumnIndex(
  grid: Locator,
  headerId: string,
): Promise<number> {
  return grid.evaluate((element, targetHeaderId) => {
    const headers = Array.from(
      element.querySelectorAll<HTMLElement>("[data-grid-header-id]"),
    )
      .map((header) => ({
        id: header.dataset.gridHeaderId,
        rect: header.getBoundingClientRect(),
      }))
      .filter(
        ({ id, rect }) =>
          id?.startsWith("tanstack-header-") &&
          !id.includes("category:") &&
          !id.includes("group:") &&
          rect.width > 0 &&
          rect.height > 0,
      );
    const leafTop = Math.max(...headers.map(({ rect }) => rect.top));
    const leafHeaders = headers
      .filter(({ rect }) => Math.abs(rect.top - leafTop) < 1)
      .sort((left, right) => left.rect.left - right.rect.left);
    const index = leafHeaders.findIndex(({ id }) => id === targetHeaderId);
    if (index < 0) throw new Error(`No visible leaf header ${targetHeaderId}`);
    return index;
  }, headerId);
}

/** Resolves a fixture ID to its rendered Programmer row index. */
async function programmerRowIndex(
  grid: Locator,
  fixtureId: number,
): Promise<number> {
  return grid.evaluate((element, targetFixtureId) => {
    const fixturePattern = new RegExp(`(^|\\s)${targetFixtureId}(\\s|$)`);
    const idCells = Array.from(
      element.querySelectorAll<HTMLElement>('[id^="tanstack-cell-0-"]'),
    );
    const cell = idCells.find((candidate) =>
      fixturePattern.test(candidate.textContent?.trim() ?? ""),
    );
    const match = cell?.id.match(/^tanstack-cell-0-(\d+)$/);
    if (!match) throw new Error(`No visible fixture row ${targetFixtureId}`);
    return Number(match[1]);
  }, fixtureId);
}

/** Returns one Programmer value cell for a fixture and attribute. */
async function programmerValueCell(
  grid: Locator,
  fixtureId: number,
  attribute: string,
): Promise<Locator> {
  const [columnIndex, rowIndex] = await Promise.all([
    programmerColumnIndex(grid, `tanstack-header-${attribute}_Value`),
    programmerRowIndex(grid, fixtureId),
  ]);
  return grid.locator(`#tanstack-cell-${columnIndex}-${rowIndex}`);
}

/** Applies an existing Blueprint through the nested Color header context menu. */
async function applyBlueprintFromColorHeader(
  page: Page,
  grid: Locator,
  blueprintLabel: string,
  resolutionLabel: string,
  targetFixtureId: number,
): Promise<void> {
  const header = grid
    .locator('[data-grid-header-id="tanstack-header-category:Color"]:visible')
    .last();
  await header.click({ button: "right" });

  const applyBlueprint = page
    .locator('button[role="menuitem"]')
    .filter({ hasText: "Apply Blueprint" });
  await expect(applyBlueprint).toBeVisible();
  await applyBlueprint.hover();

  const blueprint = page
    .locator('button[role="menuitem"]')
    .filter({ hasText: blueprintLabel });
  await expect(blueprint).toBeVisible();
  await blueprint.hover();
  await expect(
    page.locator('button[role="menuitem"]').filter({ hasText: "Reference" }),
  ).toBeVisible();

  const resolution = page
    .locator('button[role="menuitem"]')
    .filter({ hasText: resolutionLabel });
  await expect(resolution).toBeVisible();
  const menuScreenshotPath = test
    .info()
    .outputPath("nested-blueprint-menu.png");
  await page.screenshot({ path: menuScreenshotPath });
  await test.info().attach("nested-blueprint-menu", {
    path: menuScreenshotPath,
    contentType: "image/png",
  });
  await resolution.click();
  await expect(page.locator('[data-menu-kind="context"]')).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const stores = (window as any).appStores;
        const fixture = Object.values(stores.fixtures.get()).find(
          (candidate: any) => candidate.identifiers.id === fixtureId,
        ) as any;
        const row = stores.programmerState
          .get()
          .find(
            (candidate: any) =>
              candidate.fixtureUid === fixture?.identifiers.uid,
          );
        return Object.keys(row?.attributes ?? {}).sort();
      }, targetFixtureId),
    )
    .toEqual(["Green", "Red"]);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.undoState.get().undo_description,
      ),
    )
    .toBe("Apply Attribute Operations");
}

/** Sends one connected undo or redo command and requires backend completion. */
async function submitHistoryCommand(
  page: Page,
  commandType: "Undo" | "Redo",
): Promise<void> {
  const result = await page.evaluate(async (type) => {
    return (window as any).appStores.sendAndAwait({
      module: "UndoCommand",
      command: { type, data: {} },
    });
  }, commandType);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Stores a new label on Blueprint 5 while preserving its stable UUID and values. */
async function labelBlueprint(page: Page, label: string): Promise<void> {
  await page.evaluate(async (nextLabel) => {
    const stores = (window as any).appStores;
    const blueprint = Object.values(stores.blueprints.get()).find(
      (candidate: any) => candidate.identifiers.id === 5,
    ) as any;
    if (!blueprint) throw new Error("Blueprint 5 did not arrive");
    const result = await stores.sendAndAwait({
      module: "BlueprintCommand",
      command: {
        type: "StoreBlueprint",
        data: {
          ...blueprint,
          identifiers: { ...blueprint.identifiers, label: nextLabel },
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`failed to label Blueprint 5: ${JSON.stringify(result)}`);
    }
  }, label);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            Object.values((window as any).appStores.blueprints.get()).find(
              (candidate: any) => candidate.identifiers.id === 5,
            ) as any
          )?.identifiers.label,
      ),
    )
    .toBe(label);
}

/** Changes Blueprint 5's Color values while retaining the referenced category selector. */
async function reviseBlueprintColor(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const blueprint = Object.values(stores.blueprints.get()).find(
      (candidate: any) => candidate.identifiers.id === 5,
    ) as any;
    if (!blueprint) throw new Error("Blueprint 5 did not arrive");
    const result = await stores.sendAndAwait({
      module: "BlueprintCommand",
      command: {
        type: "StoreBlueprint",
        data: {
          ...blueprint,
          values: {
            Red: {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value: 0.8 } },
            },
            Blue: {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value: 0.6 } },
            },
          },
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to revise Blueprint 5: ${JSON.stringify(result)}`,
      );
    }
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const blueprint = Object.values(
          (window as any).appStores.blueprints.get(),
        ).find((candidate: any) => candidate.identifiers.id === 5) as any;
        return Object.keys(blueprint?.values ?? {}).sort();
      }),
    )
    .toEqual(["Blue", "Red"]);
}

/** Opens the stored cue in a dedicated editor and returns its data grid. */
async function openStoredCueGrid(
  page: Page,
  options: {
    cueId?: number;
    panelId?: string;
  } = {},
): Promise<Locator> {
  const cueId = options.cueId ?? 1;
  const panelId = options.panelId ?? "panel-CueEditor-blueprint-reference-e2e";
  await page.evaluate(
    ({ ownedPanelId, targetCueId }) => {
      const stores = (window as any).appStores;
      const cue = Object.values(stores.cues.get()).find(
        (candidate: any) => candidate.identifiers.id === targetCueId,
      ) as any;
      if (!cue) throw new Error(`Cue ${targetCueId} did not arrive`);
      const api = stores.dockApi.get();
      const existing = api.getPanel(ownedPanelId);
      if (existing) {
        existing.api.setActive();
        existing.focus();
        return;
      }
      const panel = api.addPanel({
        id: ownedPanelId,
        component: "CueEditor",
        title: "Blueprint Reference Cue",
        params: {
          initialPanelId: ownedPanelId,
          initialCueUid: cue.identifiers.uid,
        },
      });
      panel.api.setActive();
      panel.focus();
    },
    { ownedPanelId: panelId, targetCueId: cueId },
  );
  const grid = page
    .locator(`[data-panel-id="${panelId}"]:visible`)
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible({ timeout: 30_000 });
  return grid;
}

/** Counts the stored cue's live Blueprint-backed instruction rows. */
async function storedCueBlueprintReferenceCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cue = Object.values((window as any).appStores.cues.get()).find(
      (candidate: any) => candidate.identifiers.id === 1,
    ) as any;
    if (!cue) throw new Error("Cue 1.1 did not arrive");
    const instructionContainers = [
      cue.instructions ?? [],
      ...(cue.parts ?? []).map((part: any) => part.instructions ?? []),
    ];
    return instructionContainers
      .flat()
      .filter((item: any) => item.cue_instruction?.blueprint_application)
      .length;
  });
}

/** Captures one visible panel as acceptance evidence and attaches it to the test. */
async function attachPanelScreenshot(
  panel: Locator,
  name: string,
): Promise<void> {
  const screenshotPath = test.info().outputPath(`${name}.png`);
  await panel.screenshot({ path: screenshotPath });
  await test.info().attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
}

/** Moves one panel into the main grid and expands it for readable visual evidence. */
async function setPanelMaximized(
  page: Page,
  panelId: string,
  maximized: boolean,
): Promise<void> {
  await page.evaluate(
    ({ ownedPanelId, shouldMaximize }) => {
      const panel = (window as any).appStores.dockApi
        .get()
        .getPanel(ownedPanelId);
      if (!panel) throw new Error(`No Dockview panel ${ownedPanelId}`);
      if (shouldMaximize) {
        const api = (window as any).appStores.dockApi.get();
        const mainGroup = api.getPanel("panel-FixtureGrid")?.api.group;
        if (!mainGroup) throw new Error("No main-grid fixture panel");
        panel.api.moveTo({ group: mainGroup, position: "center" });
        panel.api.setActive();
        panel.focus();
        if (!panel.api.isMaximized()) panel.api.maximize();
      }
      if (!shouldMaximize && panel.api.isMaximized()) panel.api.exitMaximized();
    },
    { ownedPanelId: panelId, shouldMaximize: maximized },
  );
  if (maximized) {
    await expect
      .poll(() =>
        page
          .locator(`[data-component][data-panel-id="${panelId}"]:visible`)
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThan(1_000);
  }
}

/**
 * Proves live and absolute Blueprint recall across the parser, engine, cue store,
 * dependency index, and rendered Programmer/Cue/Blueprint panels.
 */
test("referenced Blueprint values stay live while absolute values remain stable", async ({
  backendSlot,
  page,
}) => {
  await openOwnedBlueprintApp(page, backendSlot.backendPort);

  await submitCommand(page, "fix 311>312");
  await submitCommand(page, "red @ 20 green @ 30");
  await submitCommand(page, "store group 13");
  await submitCommand(page, "store blueprint 5 filter color");
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.blueprints.get()).length,
      ),
    )
    .toBe(1);
  await labelBlueprint(page, "Sunset");

  const commandInput = page.locator(commandInputSelector);
  await commandInput.fill("color @ blueprint ");
  await expect(
    page.locator(
      '[data-command-autocomplete="suggestion-row"][data-insert-text="5"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator('[data-command-autocomplete="suggestion-row"]').filter({
      hasText: '"Sunset"',
    }),
  ).toBeVisible();
  await commandInput.fill('color @ blueprint "Sunset" /absolute');
  await expect(commandInput).not.toHaveAttribute("aria-invalid", "true");
  await commandInput.fill("");

  await submitCommand(page, "clear values");
  await submitCommand(page, "group 13 color @ bp 5");
  await submitCommand(page, "fix 312");
  await submitCommand(page, 'color @ blueprint "Sunset"');
  await submitCommand(page, "fix 313");
  const recallGrid = await openProgrammerGrid(page);
  await applyBlueprintFromColorHeader(
    page,
    recallGrid,
    "5: Sunset",
    "Absolute (copy current values)",
    313,
  );
  const recalledRedCell = await programmerValueCell(recallGrid, 313, "Red");
  await expect(recalledRedCell).toHaveText(/^20(?:\.0)?%$/);
  await submitHistoryCommand(page, "Undo");
  await expect(recalledRedCell).toHaveText("");
  await submitHistoryCommand(page, "Redo");
  await expect(recalledRedCell).toHaveText(/^20(?:\.0)?%$/);
  await submitCommand(page, "fix 314.1>314.12");
  await submitCommand(page, 'color @ blueprint "Sunset"');
  await submitCommand(page, "store cue 1.1");

  await expect
    .poll(() =>
      page.evaluate(() => ({
        cueCount: Object.keys((window as any).appStores.cues.get()).length,
        dependencyCount:
          (window as any).appStores.blueprintDependencies.get()[
            Object.keys((window as any).appStores.blueprints.get())[0]
          ]?.length ?? 0,
      })),
    )
    .toEqual({ cueCount: 1, dependencyCount: 2 });

  let blueprintPanel = await openBlueprintsPanel(page);
  await expect(blueprintPanel.getByText("5:", { exact: true })).toBeVisible();
  await expect(
    blueprintPanel.getByText("Sunset", { exact: true }),
  ).toBeVisible();
  await expect(
    blueprintPanel.getByText("Referenced", { exact: true }),
  ).toBeVisible();
  await expect(
    blueprintPanel.getByText("Color: Green, Red", { exact: true }),
  ).toBeVisible();
  await expect(
    blueprintPanel.getByText("2 refs", { exact: true }),
  ).toBeVisible();

  let programmerGrid = await openProgrammerGrid(page);
  const referencedProgrammerRed = await programmerValueCell(
    programmerGrid,
    311,
    "Red",
  );
  await expect(referencedProgrammerRed).toHaveText(
    /^20(?:\.0)?% · BP 5 Sunset$/,
  );
  await expect(referencedProgrammerRed).toHaveCSS(
    "color",
    blueprintReferenceTextColor,
  );
  await expect(
    await programmerValueCell(programmerGrid, 313, "Red"),
  ).toHaveText(/^20(?:\.0)?%$/);
  await expect(
    await programmerValueCell(programmerGrid, 313, "Red"),
  ).not.toContainText("BP 5 Sunset");

  let cueGrid = await openStoredCueGrid(page);
  const sourceHeader = cueGrid.locator(
    '[data-grid-header-id="tanstack-header-source"]',
  );
  await expect(sourceHeader).toBeVisible();
  await expect
    .poll(() =>
      sourceHeader.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(110);
  const referencedSource = await gridCellByIdentifier(cueGrid, {
    columnKey: "source",
    identifierColumnKey: "id",
    identifierText: "311",
  });
  await expect(referencedSource).toHaveText("p0");
  const absoluteSource = await gridCellByIdentifier(cueGrid, {
    columnKey: "source",
    identifierColumnKey: "id",
    identifierText: "313",
  });
  await expect(absoluteSource).toHaveText("p0");
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: cueGridAttributeValueColumnKey("Red"),
      identifierColumnKey: "id",
      identifierText: "314",
    }),
  ).toHaveText(/^20(?:\.0)?% · BP 5 Sunset$/);
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: cueGridAttributeValueColumnKey("Green"),
      identifierColumnKey: "id",
      identifierText: "314",
    }),
  ).toHaveText(/^30(?:\.0)?% · BP 5 Sunset$/);

  await reviseBlueprintColor(page);

  blueprintPanel = await openBlueprintsPanel(page);
  await expect(
    blueprintPanel.getByText("Color: Blue, Red", { exact: true }),
  ).toBeVisible();
  programmerGrid = await openProgrammerGrid(page);
  await expect(
    await programmerValueCell(programmerGrid, 311, "Red"),
  ).toHaveText(/^80(?:\.0)?% · BP 5 Sunset$/);
  await expect(
    await programmerValueCell(programmerGrid, 311, "Blue"),
  ).toHaveText(/^60(?:\.0)?% · BP 5 Sunset$/);
  await expect(
    await programmerValueCell(programmerGrid, 311, "Green"),
  ).toHaveText("");
  await expect(
    await programmerValueCell(programmerGrid, 313, "Red"),
  ).toHaveText(/^20(?:\.0)?%$/);
  await expect(
    await programmerValueCell(programmerGrid, 313, "Green"),
  ).toHaveText(/^30(?:\.0)?%$/);
  await expect(
    await programmerValueCell(programmerGrid, 313, "Blue"),
  ).toHaveText("");

  cueGrid = await openStoredCueGrid(page);
  const referencedRed = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: "311",
  });
  const referencedBlue = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Blue"),
    identifierColumnKey: "id",
    identifierText: "311",
  });
  const referencedGreen = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Green"),
    identifierColumnKey: "id",
    identifierText: "311",
  });
  await expect(referencedRed).toHaveText(/^80(?:\.0)?% · BP 5 Sunset$/);
  await expect(referencedBlue).toHaveText(/^60(?:\.0)?% · BP 5 Sunset$/);
  await expect(referencedGreen).toHaveText("");
  await expect(referencedRed).toHaveCSS("color", blueprintReferenceTextColor);

  const elementParentRed = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: "314",
  });
  const elementParentGreen = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Green"),
    identifierColumnKey: "id",
    identifierText: "314",
  });
  const elementParentBlue = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Blue"),
    identifierColumnKey: "id",
    identifierText: "314",
  });
  await expect(elementParentRed).toHaveText(/^80(?:\.0)?% · BP 5 Sunset$/);
  await expect(elementParentGreen).toHaveText("");
  await expect(elementParentBlue).toHaveText(/^60(?:\.0)?% · BP 5 Sunset$/);

  const absoluteRed = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: "313",
  });
  const absoluteGreen = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Green"),
    identifierColumnKey: "id",
    identifierText: "313",
  });
  const absoluteBlue = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Blue"),
    identifierColumnKey: "id",
    identifierText: "313",
  });
  await expect(absoluteRed).toHaveText(/^20(?:\.0)?%$/);
  await expect(absoluteGreen).toHaveText(/^30(?:\.0)?%$/);
  await expect(absoluteBlue).toHaveText("");

  await openProgrammerGrid(page);
  await setPanelMaximized(page, "panel-ProgrammerGrid", true);
  await attachPanelScreenshot(
    page.locator(
      '[data-component][data-panel-id="panel-ProgrammerGrid"]:visible',
    ),
    "blueprint-reference-programmer",
  );
  await setPanelMaximized(page, "panel-ProgrammerGrid", false);
  await openStoredCueGrid(page);
  await setPanelMaximized(
    page,
    "panel-CueEditor-blueprint-reference-e2e",
    true,
  );
  await attachPanelScreenshot(
    page.locator(
      '[data-component][data-panel-id="panel-CueEditor-blueprint-reference-e2e"]:visible',
    ),
    "blueprint-reference-cue",
  );

  const referenceCountBeforeAbsolute =
    await storedCueBlueprintReferenceCount(page);
  await elementParentRed.click({ button: "right" });
  const blueprintMenu = page
    .locator('button[role="menuitem"]')
    .filter({ hasText: "Blueprint" });
  await expect(blueprintMenu).toBeVisible();
  await blueprintMenu.hover();
  const makeAbsolute = page
    .locator('button[role="menuitem"]')
    .filter({ hasText: "Make Absolute (copy current values)" });
  await expect(makeAbsolute).toBeVisible();
  const menuScreenshotPath = test
    .info()
    .outputPath("cue-blueprint-make-absolute-menu.png");
  await page.screenshot({ path: menuScreenshotPath });
  await test.info().attach("cue-blueprint-make-absolute-menu", {
    path: menuScreenshotPath,
    contentType: "image/png",
  });
  await makeAbsolute.click();
  await expect
    .poll(() => storedCueBlueprintReferenceCount(page))
    .toBe(referenceCountBeforeAbsolute - 12);

  cueGrid = await openStoredCueGrid(page);
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: cueGridAttributeValueColumnKey("Red"),
      identifierColumnKey: "id",
      identifierText: "314",
    }),
  ).toHaveText(/^80(?:\.0)?%$/);
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: cueGridAttributeValueColumnKey("Blue"),
      identifierColumnKey: "id",
      identifierText: "314",
    }),
  ).toHaveText(/^60(?:\.0)?%$/);
  await attachPanelScreenshot(
    page.locator(
      '[data-component][data-panel-id="panel-CueEditor-blueprint-reference-e2e"]:visible',
    ),
    "blueprint-absolute-cue",
  );
});

/** Mixed tracked Block markers do not make a uniform Blueprint value appear varied. */
test("cue parent rows aggregate Blueprint values across mixed Block markers", async ({
  backendSlot,
  page,
}) => {
  await openOwnedBlueprintApp(page, backendSlot.backendPort);

  await submitCommand(page, "fix 311");
  await submitCommand(page, "red @ 100 blue @ 40");
  await submitCommand(page, "store blueprint 1 filter color");

  await submitCommand(page, "clear values");
  await submitCommand(page, "fix 314.1>314.6");
  await submitCommand(page, "red @ 100");
  await submitCommand(page, "store cue 1.1");

  await submitCommand(page, "clear values");
  await submitCommand(page, "fix 314.1>314.12");
  await submitCommand(page, "color @ bp 1");
  await submitCommand(page, "store cue 1.2");

  const panelId = "panel-CueEditor-blueprint-block-aggregate-e2e";
  const cueGrid = await openStoredCueGrid(page, { cueId: 2, panelId });
  const parentId = await gridCellByIdentifier(cueGrid, {
    columnKey: "id",
    identifierColumnKey: "id",
    identifierText: "314",
  });
  const parentRed = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: "314",
  });
  const parentBlue = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeValueColumnKey("Blue"),
    identifierColumnKey: "id",
    identifierText: "314",
  });
  await expect(parentRed).toHaveText(/^100(?:\.0)?% · BP 1 Blueprint 1$/);
  await expect(parentBlue).toHaveText(/^40(?:\.0)?% · BP 1 Blueprint 1$/);

  await parentId.click();
  await expect(parentId).toContainText("▼");
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: cueGridAttributeValueColumnKey("Red"),
      identifierColumnKey: "id",
      identifierText: "314.1",
    }),
  ).toHaveText(/^B 100(?:\.0)?% · BP 1 Blueprint 1$/);
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: cueGridAttributeValueColumnKey("Red"),
      identifierColumnKey: "id",
      identifierText: "314.12",
    }),
  ).toHaveText(/^100(?:\.0)?% · BP 1 Blueprint 1$/);

  await setPanelMaximized(page, panelId, true);
  await attachPanelScreenshot(
    page.locator(`[data-component][data-panel-id="${panelId}"]:visible`),
    "blueprint-mixed-block-parent-aggregate",
  );
});

/** Verifies Step FX accepts Blueprint targets and preserves reference versus absolute storage. */
test("Step FX targets support Blueprint references and absolute copies", async ({
  backendSlot,
  page,
}) => {
  await openOwnedBlueprintApp(page, backendSlot.backendPort);
  await submitCommand(page, "fix 311");
  await submitCommand(page, "red @ 20");
  await submitCommand(page, "store blueprint 5 filter color");

  const commandInput = page.locator(commandInputSelector);
  await commandInput.fill("store fx 91 step fix 311 1s red steps @ blueprint ");
  await expect(
    page.locator(
      '[data-command-autocomplete="suggestion-row"][data-insert-text="5"]',
    ),
  ).toBeVisible();
  await commandInput.fill("");

  await submitCommand(
    page,
    "store fx 91 step fix 311 1s red steps @ bp 5 @ bp 5 /absolute",
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stepFx = Object.values(
          (window as any).appStores.stepFx.get(),
        ).find((candidate: any) => candidate.identifiers.id === 91) as any;
        if (!stepFx) return null;
        return stepFx.sequences[0].steps.map((step: any) => step.target_value);
      }),
    )
    .toEqual([
      {
        type: "Blueprint",
        data: { blueprint_uid: expect.any(String) },
      },
      {
        type: "Direct",
        data: {
          type: "AbsolutePercent",
          data: { value: expect.closeTo(0.2, 5) },
        },
      },
    ]);
});
