// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const PATCH_PANEL_ACTIVE_TAB_KEY = "nightfall-patch-panel:active-tab";

type OwnedPatchFixtures = {
  ids: number[];
  uids: string[];
};

type OwnedPatchGrid = {
  fixtures: OwnedPatchFixtures;
  grid: Locator;
};

/** Opens a blank showfile with two owned fixture rows in the Patch grid. */
async function openPatchFixtureGrid(page: Page): Promise<OwnedPatchGrid> {
  const testInfo = test.info();
  const showfileName = `data-grid-enter-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
  await page.addInitScript((activeTabKey) => {
    window.localStorage.clear();
    window.localStorage.setItem(activeTabKey, "fixtures");
  }, PATCH_PANEL_ACTIVE_TAB_KEY);
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");

  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  const fixtures = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const idBase = Math.floor(500_000 + Math.random() * 100_000);
    const ids = [idBase, idBase + 1];
    const uids = [
      crypto.randomUUID().replace(/-/g, ""),
      crypto.randomUUID().replace(/-/g, ""),
    ];
    for (const [index, id] of ids.entries()) {
      await stores.sendAndAwait({
        module: "FixtureCommand",
        command: {
          type: "StoreFixture",
          data: {
            identifiers: {
              id,
              uid: uids[index],
              label: `Enter Edit Fixture ${id}`,
            },
            make: "E2E",
            model: "Keyboard Editing Fixture",
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
              position: { x: index + 1, y: 2, z: 3 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          },
        },
      });
    }
    return { ids, uids };
  });
  await expect
    .poll(() =>
      page.evaluate((uids) => {
        const storedFixtures = (window as any).appStores.fixtures.get();
        return uids.every((uid) => Boolean(storedFixtures[uid]));
      }, fixtures.uids),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Patch");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add fixture" })).toBeVisible();
  const grid = page
    .locator('[data-panel-kind="patch"] [data-grid-kind="tanstack"]')
    .filter({
      has: page.locator(
        '[data-grid-header-id="tanstack-header-group:Position"]',
      ),
    });
  await expect(grid).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-0")).toContainText(
    String(fixtures.ids[0]),
  );
  await expect(grid.locator("#tanstack-cell-0-1")).toContainText(
    String(fixtures.ids[1]),
  );
  return { fixtures, grid };
}

/** Deletes the two fixtures created for one keyboard editing scenario. */
async function deleteOwnedPatchFixtures(
  page: Page,
  fixtures: OwnedPatchFixtures,
): Promise<void> {
  await page.evaluate(async (ids) => {
    const stores = (window as any).appStores;
    for (const id of ids) {
      await stores.sendAndAwait({
        module: "FixtureCommand",
        command: { type: "DeleteFixture", data: id },
      });
    }
  }, fixtures.ids);
  await expect
    .poll(() =>
      page.evaluate((uids) => {
        const storedFixtures = (window as any).appStores.fixtures.get();
        return uids.every((uid) => !storedFixtures[uid]);
      }, fixtures.uids),
    )
    .toBe(true);
}

/** Verifies Enter accepts an inline edit without changing the selected row. */
test("Enter commits an editable grid cell without moving to the next row", async ({
  page,
}) => {
  const { fixtures, grid } = await openPatchFixtureGrid(page);
  try {
    const editableCell = grid.locator("#tanstack-cell-7-0");
    const nextRowCell = grid.locator("#tanstack-cell-7-1");

    await expect(editableCell).toHaveText(/-?\d/);
    await expect(nextRowCell).toHaveText(/-?\d/);

    await editableCell.dblclick();
    const editor = editableCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.press("ControlOrMeta+A");
    await expect(editor).toHaveCSS("box-shadow", "none");
    await expect(editor).toHaveCSS("outline-style", "none");
    await editableCell.screenshot({
      path: test.info().outputPath("numeric-editor-border.png"),
    });
    await editor.fill("12.345");
    await page.keyboard.press("Enter");

    await expect(editor).toBeHidden();
    await expect(editableCell).toHaveAttribute("aria-selected", "true");
    await expect(nextRowCell).toHaveAttribute("aria-selected", "false");
    await expect(editableCell).toHaveText(/^12\.345/);
  } finally {
    await deleteOwnedPatchFixtures(page, fixtures);
  }
});

/** Verifies Tab accepts inline edits and moves the grid selection horizontally. */
test("Tab and Shift+Tab commit editable grid cells while moving selection", async ({
  page,
}) => {
  const { fixtures, grid } = await openPatchFixtureGrid(page);
  try {
    const editableCell = grid.locator("#tanstack-cell-7-0");
    const leftCell = grid.locator("#tanstack-cell-6-0");
    const rightCell = grid.locator("#tanstack-cell-8-0");

    await expect(editableCell).toHaveText(/-?\d/);

    await editableCell.dblclick();
    const tabEditor = editableCell.locator("input");
    await expect(tabEditor).toBeVisible();
    await tabEditor.fill("12.345");
    await page.keyboard.press("Tab");

    await expect(tabEditor).toBeHidden();
    await expect(editableCell).toHaveText(/^12\.345/);
    await expect(editableCell).toHaveAttribute("aria-selected", "false");
    await expect(rightCell).toHaveAttribute("aria-selected", "true");

    await editableCell.dblclick();
    const shiftTabEditor = editableCell.locator("input");
    await expect(shiftTabEditor).toBeVisible();
    await shiftTabEditor.fill("23.456");
    await page.keyboard.press("Shift+Tab");

    await expect(shiftTabEditor).toBeHidden();
    await expect(editableCell).toHaveText(/^23\.456/);
    await expect(editableCell).toHaveAttribute("aria-selected", "false");
    await expect(leftCell).toHaveAttribute("aria-selected", "true");
  } finally {
    await deleteOwnedPatchFixtures(page, fixtures);
  }
});
