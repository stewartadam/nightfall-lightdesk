// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { dockFixturesInMainGrid, waitForDockviewApp } from "./showfile-startup";

const commandInputSelector = "#header-cmdline";

test.setTimeout(150_000);

/** Opens a fresh backend with two RGBW fixtures to build blueprints and a group from. */
async function openBoardApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await dockFixturesInMainGrid(page);

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (const fixtureId of [311, 312]) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Board Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`failed to create fixture ${fixtureId}`);
      }
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(2);
}

/** Submits one operator command and waits for its success response. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(commandInputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submitted) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submitted,
        );
        return matches[matches.length - 1]?.status ?? null;
      }, command),
    )
    .toBe("success");
}

/**
 * Runs a command palette command by its name, confirming with `key` so modifier keys can pick
 * where an opened panel goes.
 */
async function runPaletteCommand(
  page: Page,
  name: string,
  key = "Enter",
): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(name);
  await page.keyboard.press(key);
}

/** Opens a board by name through the object palette's board type. */
async function openBoardFromObjectPalette(
  page: Page,
  name: string,
): Promise<void> {
  await page.keyboard.press("ControlOrMeta+P");
  const input = page.getByPlaceholder("Search showfile objects...");
  await expect(input).toBeFocused();
  await input.fill(`board ${name}`);
  await page.keyboard.press("Enter");
}

/** Opens a panel by title through the command palette. */
async function openPanel(page: Page, title: string): Promise<void> {
  await runPaletteCommand(page, `Open ${title}`);
}

/** Returns the dock tab of the panel titled `title`. */
function dockTab(page: Page, title: string): Locator {
  return page.locator(".dv-default-tab").filter({ hasText: title });
}

/** Returns the stored elements of the only board, in paint order. */
async function boardElements(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const boards = Object.values(
      (window as any).appStores.boards.get(),
    ) as any[];
    return boards[0]?.elements ?? [];
  });
}

/** Returns the state each button of a board element shows, in display order. */
function buttonStates(element: Locator): Promise<(string | null)[]> {
  return element
    .locator(".nf-board-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-state")),
    );
}

/** Returns the board element locator for the only element of `kind` in the panel. */
function elementOfKind(panel: Locator, kind: string): Locator {
  return panel.locator(`[data-kind="${kind}"]`);
}

/** Picks an entry from the open right-click menu by its leading label. */
async function chooseMenuItem(page: Page, label: string): Promise<void> {
  await page
    .getByRole("menuitem", { name: new RegExp(`^${label}`) })
    .first()
    .click();
}

/** Side of one board grid cell in CSS pixels, matching BOARD_CELL_PX. */
const CELL = 24;

/** Returns the page-space bounding box of a board grid cell. */
async function cellBox(panel: Locator, x: number, y: number) {
  const grid = await panel.locator("[data-board-grid]").boundingBox();
  if (!grid) throw new Error("board grid is not visible");
  return {
    x: grid.x + x * CELL,
    y: grid.y + y * CELL,
    width: CELL,
    height: CELL,
  };
}

/** Returns the centre of a grid cell relative to the grid's top-left corner. */
function cellCenter(x: number, y: number): { x: number; y: number } {
  return { x: x * CELL + CELL / 2, y: y * CELL + CELL / 2 };
}

/** Presses at the centre of one cell and drags to the centre of another before releasing. */
async function dragCells(
  page: Page,
  panel: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  // Earlier clicks may have scrolled the narrow board sideways; start from its top-left corner.
  await panel
    .locator("[data-board-grid]")
    .evaluate((grid) => grid.parentElement?.scrollTo(0, 0));
  const start = await cellBox(panel, from.x, from.y);
  const end = await cellBox(panel, to.x, to.y);
  await page.mouse.move(start.x + CELL / 2, start.y + CELL / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + CELL / 2, end.y + CELL / 2, { steps: 6 });
  await beforeRelease?.();
  await page.mouse.up();
}

/**
 * Builds a board with a solo blueprint collection and a pinned group button, then operates it:
 * the new board is named from its settings, solo and title are set from the element menus, a
 * button is added by dragging out empty cells, elements cannot be dragged over each other,
 * elements are copied, pasted and deleted from the keyboard, a group is dragged in from the
 * Groups panel, blueprint presses replace each other and the group button selects its fixtures.
 */
test("boards press blueprints exclusively and select groups", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openBoardApp(page, backendSlot.backendPort);

  await submitCommand(page, "fix 311>312");
  await submitCommand(page, "store group 1");
  await submitCommand(page, "fix 311");
  await submitCommand(page, "store group 2");
  await submitCommand(page, "fix 311>312");
  await submitCommand(page, "red @ 100");
  await submitCommand(page, "store blueprint 1 filter color");
  await submitCommand(page, "clear values");
  await submitCommand(page, "blue @ 100");
  await submitCommand(page, "store blueprint 2 filter color");
  await submitCommand(page, "clear values");
  await submitCommand(page, "fix 311");

  // New Board in the command palette opens an empty board in its own panel, here in a new
  // group beside the Groups panel so objects can be dragged in later.
  await runPaletteCommand(page, "New Board", "Control+Enter");
  const panel = page.locator('[data-panel-kind="boards"]:visible');
  await expect(panel.locator("[data-board-grid]")).toBeVisible();

  // A new board opens its settings so it can be named straight away.
  const label = page
    .getByRole("menu", { name: "Board settings" })
    .getByRole("textbox", { name: "Label" });
  await expect(label).toBeFocused();
  await label.fill("Busk");
  await page.screenshot({ path: testInfo.outputPath("board-settings.png") });
  await label.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Object.values((window as any).appStores.boards.get())[0] as any)
            ?.identifiers.label,
      ),
    )
    .toBe("Busk");
  await page.keyboard.press("Escape");
  await expect(dockTab(page, "Busk")).toBeVisible();

  // Edit mode: add a collection of every blueprint from the toolbar.
  await panel.getByRole("button", { name: "Add to board" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: "All blueprints", exact: true })
    .click();
  await expect.poll(async () => (await boardElements(page)).length).toBe(1);
  const collection = elementOfKind(panel, "Collection");
  expect((await boardElements(page))[0]?.cell).toEqual({
    x: 0,
    y: 0,
    width: 16,
    height: 7,
  });
  await expect(collection.locator(".nf-board-button")).toHaveCount(2);

  // Right-click sets Solo; the gear pop-out hides the title.
  await collection.click({ button: "right" });
  await page.screenshot({
    path: testInfo.outputPath("board-element-menu.png"),
  });
  await chooseMenuItem(page, "Solo");
  await expect
    .poll(async () => (await boardElements(page))[0]?.kind.data.exclusive)
    .toBe(true);
  await collection.hover();
  await collection.getByRole("button", { name: "Element settings" }).click();
  const showTitle = page
    .getByRole("menu", { name: "Element settings" })
    .getByRole("checkbox", { name: "Show title" });
  await expect(showTitle).toBeChecked();
  // Typing in the pop-out keeps spaces and arrow keys inside the field.
  const title = page
    .getByRole("menu", { name: "Element settings" })
    .getByRole("textbox", { name: "Title" });
  await title.click();
  await title.pressSequentially("Front wash");
  await title.press("ArrowLeft");
  await title.press("Enter");
  await expect
    .poll(async () => (await boardElements(page))[0]?.label)
    .toBe("Front wash");
  expect((await boardElements(page))[0]?.cell.x).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("board-element-settings.png"),
  });
  await showTitle.click();
  await expect
    .poll(async () => (await boardElements(page))[0]?.show_title)
    .toBe(false);
  await expect(collection.locator(".nf-board-caption")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Dragging out an area of empty cells offers to add a button filling it.
  await dragCells(page, panel, { x: 0, y: 8 }, { x: 3, y: 10 }, async () => {
    await expect(panel.locator("[data-board-area]")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("board-area-drag.png") });
  });
  await page.getByRole("menuitem", { name: /^Button/ }).hover();
  await chooseMenuItem(page, "Group");
  await expect.poll(async () => (await boardElements(page)).length).toBe(2);
  const groupButton = elementOfKind(panel, "Target");
  await expect(groupButton).toBeVisible();
  const targetCell = async () =>
    (await boardElements(page)).find(
      (element) => element.kind.type === "Target",
    ).cell;
  expect(await targetCell()).toEqual({ x: 0, y: 8, width: 4, height: 3 });

  // Dragging the button up into the collection stops at the last free spot.
  await dragCells(page, panel, { x: 1, y: 9 }, { x: 1, y: 3 }, async () => {
    await page.screenshot({
      path: testInfo.outputPath("board-blocked-drag.png"),
    });
  });
  await expect.poll(async () => (await targetCell()).y).toBe(7);
  expect((await targetCell()).x).toBe(0);

  // Keyboard editing: arrows move the element, copy and paste duplicate it, Delete removes it.
  await groupButton.click();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await targetCell()).y).toBe(8);
  await page.keyboard.press("ControlOrMeta+c");
  const pasteCell = await cellBox(panel, 0, 13);
  await page.mouse.click(
    pasteCell.x + pasteCell.width / 2,
    pasteCell.y + pasteCell.height / 2,
  );
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await boardElements(page)).length).toBe(3);
  const pasted = (await boardElements(page)).at(-1);
  expect(pasted.cell).toEqual({ x: 0, y: 13, width: 4, height: 3 });
  await page.screenshot({ path: testInfo.outputPath("board-editing.png") });
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await boardElements(page)).length).toBe(2);

  // A frame added over an area moves by its title bar.
  await dragCells(page, panel, { x: 5, y: 8 }, { x: 10, y: 11 });
  await chooseMenuItem(page, "Frame");
  await expect.poll(async () => (await boardElements(page)).length).toBe(3);
  const frameCell = async () =>
    (await boardElements(page)).find((element) => element.kind.type === "Frame")
      .cell;
  expect(await frameCell()).toEqual({ x: 5, y: 8, width: 6, height: 4 });
  const handle = elementOfKind(panel, "Frame").locator(
    ".nf-board-frame-handle",
  );
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("frame handle is not visible");
  await page.mouse.move(handleBox.x + 5, handleBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 5 + CELL * 2, handleBox.y + 5, {
    steps: 5,
  });
  // Record every column the frame is drawn at from the drop until the engine confirms it, so
  // a frame flashing back to its old spot after mouseup is caught.
  await elementOfKind(panel, "Frame").evaluate((frame) => {
    const seen: string[] = [];
    (window as any).__frameColumns = seen;
    new MutationObserver(() => seen.push(frame.style.gridColumn)).observe(
      frame,
      { attributes: true, attributeFilter: ["style"] },
    );
  });
  await page.mouse.up();
  await expect.poll(async () => (await frameCell()).x).toBe(7);
  expect(
    await page.evaluate(() =>
      ((window as any).__frameColumns as string[]).map(
        (column) => column.split(" ")[0],
      ),
    ),
  ).not.toContain("6");

  await panel.getByRole("tab", { name: "Operate" }).click();

  // Operate: blueprints in the solo collection replace each other.
  await expect.poll(() => buttonStates(collection)).toEqual(["Off", "Off"]);
  await collection.locator(".nf-board-button").nth(0).click();
  await expect.poll(() => buttonStates(collection)).toEqual(["On", "Off"]);
  await collection.locator(".nf-board-button").nth(1).click();
  await expect.poll(() => buttonStates(collection)).toEqual(["Off", "On"]);

  // Pressing the lit blueprint releases it.
  await collection.locator(".nf-board-button").nth(1).click();
  await expect.poll(() => buttonStates(collection)).toEqual(["Off", "Off"]);
  await collection.locator(".nf-board-button").nth(0).click();
  await expect.poll(() => buttonStates(collection)).toEqual(["On", "Off"]);

  // The group button lights once the Programmer selection matches the group.
  await expect(groupButton.locator(".nf-board-button")).toHaveAttribute(
    "data-state",
    "Off",
  );
  await groupButton.locator(".nf-board-button").click();
  await expect(groupButton.locator(".nf-board-button")).toHaveAttribute(
    "data-state",
    "On",
  );
  // Fixture 312 joins the selection without the blueprint, so the red button is partial.
  await expect.poll(() => buttonStates(collection)).toEqual(["Partial", "Off"]);

  await page.screenshot({ path: testInfo.outputPath("board-operating.png") });

  // A second board opens in its own panel; the object palette brings the first one back.
  await runPaletteCommand(page, "New Board");
  await expect(label).toBeFocused();
  await label.fill("Colors");
  await label.press("Enter");
  await page.keyboard.press("Escape");
  await expect(dockTab(page, "Colors")).toBeVisible();
  await expect(
    page.locator('[data-panel-kind="boards"]').filter({
      has: page.locator('[data-kind="Collection"]'),
    }),
  ).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("board-second.png") });
  await openBoardFromObjectPalette(page, "Busk");
  await expect(page.locator('[data-panel-kind="boards"]')).toHaveCount(2);
  await expect
    .poll(() =>
      buttonStates(
        page
          .locator('[data-panel-kind="boards"]:visible')
          .locator('[data-kind="Collection"]'),
      ),
    )
    .toEqual(["Partial", "Off"]);

  // Groups drag in from the Groups panel onto a board, even outside edit mode.
  await openPanel(page, "Groups");
  const group2Uid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.groups.get()) as any[]).find(
        (group) => group.identifiers.id === 2,
      ).identifiers.uid,
  );
  const groupCard = page.locator(`[data-crud-select-id="${group2Uid}"]`);
  await expect(groupCard).toBeVisible();
  const visibleGrid = page
    .locator('[data-panel-kind="boards"]:visible')
    .first()
    .locator("[data-board-grid]");
  await groupCard.dragTo(visibleGrid, { targetPosition: cellCenter(0, 12) });
  await expect.poll(async () => (await boardElements(page)).length).toBe(4);
  const dropped = (await boardElements(page)).at(-1);
  expect(dropped.kind.data.target.uid).toBe(group2Uid);
  expect(dropped.cell).toEqual({ x: 0, y: 12, width: 4, height: 3 });
  await page.screenshot({ path: testInfo.outputPath("board-drag-in.png") });

  // Boards are listed in the layout switcher; picking one fills the workspace with that board.
  const switcher = page.getByRole("group", { name: "Layout switcher" });
  const activeLayoutSlot = switcher.locator(
    '.nf-layout-slot-trigger[aria-pressed="true"]',
  );
  await expect(activeLayoutSlot).toHaveCount(1);
  const layoutLabel = await activeLayoutSlot.getAttribute("aria-label");
  await switcher.getByRole("button", { name: "Board: Busk" }).click();
  const workspace = page.locator("[data-board-workspace]");
  await expect(workspace).toBeVisible();
  await expect
    .poll(() => buttonStates(workspace.locator('[data-kind="Collection"]')))
    .toEqual(["Partial", "Off"]);
  await expect(
    switcher.getByRole("button", { name: "Board: Busk" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(activeLayoutSlot).toHaveCount(0);
  // Moves the pointer off the switcher so its tooltip does not cover the pressed slot.
  await page.mouse.move(900, 600);
  await page.screenshot({
    path: testInfo.outputPath("board-workspace.png"),
  });
  // Board shortcuts reach the board, not the hidden layout's panels: copy, paste, then delete.
  await workspace.getByRole("tab", { name: "Edit" }).click();
  await workspace.locator('[data-kind="Target"]').last().click();
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await boardElements(page)).length).toBe(5);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await boardElements(page)).length).toBe(4);
  // Picking the layout again returns to its panels.
  await switcher.getByRole("button", { name: layoutLabel! }).click();
  await expect(workspace).toHaveCount(0);
  await expect(activeLayoutSlot).toHaveCount(1);
  // Opening a panel while a board fills the workspace brings the layout back to show it.
  await switcher.getByRole("button", { name: "Board: Colors" }).click();
  await expect(workspace).toBeVisible();
  await openPanel(page, "Groups");
  await expect(workspace).toHaveCount(0);
  await expect(groupCard).toBeVisible();

  // The layout manager lists boards so they can be hidden from the switcher and shown again.
  await switcher.getByRole("button", { name: "Manage layouts" }).click();
  const manager = page.getByRole("dialog", { name: "Manage layouts" });
  const showColors = manager.getByRole("checkbox", {
    name: "Show Colors in switcher",
  });
  await expect(showColors).toBeChecked();
  await showColors.uncheck();
  await expect(
    switcher.getByRole("button", { name: "Board: Colors" }),
  ).toHaveCount(0);
  await expect(showColors).not.toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("board-layout-manager.png"),
  });
  await showColors.check();
  await expect(
    switcher.getByRole("button", { name: "Board: Colors" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(manager).toHaveCount(0);

  // The Boards panel lists boards as cards or rows; clicking a card opens its board.
  await openPanel(page, "Boards");
  const boardList = page.locator('[data-panel-kind="board-list"]');
  await boardList.getByRole("button", { name: "Switch to grid view" }).click();
  await expect(boardList.locator("[data-crud-select-id]")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("board-list-grid.png") });
  await boardList.getByRole("button", { name: "Switch to list view" }).click();
  await expect(boardList.getByText("Colors")).toBeAttached();
  // Lets the row grid finish measuring its columns before the screenshot.
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("board-list-rows.png") });
  await boardList.getByRole("button", { name: "Switch to grid view" }).click();
  await boardList.getByRole("button", { name: /^Board 1: Busk/ }).click();
  await expect(
    page
      .locator('[data-panel-kind="boards"]:visible')
      .locator('[data-kind="Collection"]'),
  ).toHaveCount(1);

  // Deleting a board from its settings closes its panel.
  await openBoardFromObjectPalette(page, "Colors");
  const colorsPanel = page.locator('[data-panel-kind="boards"]:visible');
  // Colors is the empty board, so the visible panel shows no collection once it is in front.
  await expect(colorsPanel.locator('[data-kind="Collection"]')).toHaveCount(0);
  await colorsPanel.getByRole("button", { name: "Board settings" }).click();
  await page
    .getByRole("menu", { name: "Board settings" })
    .getByRole("button", { name: "Delete board" })
    .click();
  await expect(page.locator('[data-panel-kind="boards"]')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.boards.get()).length,
      ),
    )
    .toBe(1);

  await submitCommand(page, "clear");
});

/**
 * Adds a Tempo element to a board and operates it: it shows the engine's tempo with beat dots,
 * pressing it in Operate mode taps the tempo, and pressing it while editing selects it without
 * tapping.
 */
test("board tempo pad shows and taps the show tempo", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.showTempo?.get()),
  );
  const targetBpm = () =>
    page.evaluate(
      () => (window as any).appStores.showTempo.get()?.snapshot.target_bpm,
    );

  await runPaletteCommand(page, "New Board");
  const panel = page.locator('[data-panel-kind="boards"]:visible');
  await expect(panel.locator("[data-board-grid]")).toBeVisible();
  await page.keyboard.press("Escape");

  await panel.getByRole("button", { name: "Add to board" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: "Tempo", exact: true })
    .click();
  await expect
    .poll(async () => (await boardElements(page))[0]?.kind.type)
    .toBe("Tempo");
  expect((await boardElements(page))[0]?.cell).toEqual({
    x: 0,
    y: 0,
    width: 8,
    height: 3,
  });

  const tempo = elementOfKind(panel, "Tempo");
  const pad = tempo.getByRole("button", { name: "Tap tempo" });
  await expect(tempo.getByTestId("tempo-bpm")).toHaveText("120");
  await expect(tempo.locator(".nf-tempo-beat")).toHaveCount(4);

  // While editing, pressing the pad selects the element instead of tapping.
  await tempo.click();
  await page.waitForTimeout(600);
  await tempo.click();
  await page.waitForTimeout(600);
  await tempo.click();
  expect(await targetBpm()).toBe(120);

  await panel.getByRole("tab", { name: "Operate" }).click();
  for (let index = 0; index < 6; index += 1) {
    await pad.dispatchEvent("pointerdown", { button: 0 });
    await page.waitForTimeout(400);
  }
  await expect.poll(() => targetBpm(), { timeout: 5_000 }).toBeGreaterThan(140);
  await expect.poll(() => targetBpm()).toBeLessThan(160);
  await expect(tempo.getByTestId("tempo-bpm")).not.toHaveText("120", {
    timeout: 5_000,
  });
  await page.screenshot({
    path: "test-results/playwright/board-tempo-pad.png",
  });
});
