// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Opens a unique blank showfile and waits for the application shell to render.
 */
async function openOwnedToolbarAlignmentApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `toolbar-alignment-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");

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

test("programmer column visibility control is right aligned", async ({
  page,
}, testInfo) => {
  await openOwnedToolbarAlignmentApp(page);

  await page.getByText("Programmer", { exact: true }).first().click();
  const programmerPanel = page.locator(
    '[data-panel-id="panel-ProgrammerGrid"]',
  );
  const columnButton = programmerPanel.getByRole("button", {
    name: "Column visibility",
  });
  await expect(columnButton).toBeVisible();

  const metrics = await columnButton.evaluate((button) => {
    const toolbar = button.closest(
      '[class*="justify-between"][class*="border-b"]',
    );
    if (!toolbar) {
      throw new Error("Programmer toolbar not found");
    }

    const buttonRect = button.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    return {
      buttonRight: buttonRect.right,
      toolbarRight: toolbarRect.right,
    };
  });

  expect(metrics.toolbarRight - metrics.buttonRight).toBeLessThanOrEqual(12);

  await page.screenshot({
    path: testInfo.outputPath("programmer-column-visibility-alignment.png"),
    fullPage: true,
  });
});

test("CRUD list column visibility control is aligned with grid header", async ({
  page,
}, testInfo) => {
  await openOwnedToolbarAlignmentApp(page);

  await page.getByRole("tab", { name: "FX List", exact: true }).click();
  const fxListPanel = page.locator('[data-panel-id="panel-FxList"]');
  await fxListPanel
    .getByRole("button", { name: "Switch to list view" })
    .click();

  const columnButton = fxListPanel.getByRole("button", {
    name: "Column visibility",
  });
  await expect(columnButton).toBeVisible();
  const grid = fxListPanel.getByRole("grid");
  await expect(grid).toBeVisible();

  const [buttonTop, gridTop] = await Promise.all([
    columnButton.evaluate((button) => button.getBoundingClientRect().top),
    grid.evaluate((element) => element.getBoundingClientRect().top),
  ]);

  expect(buttonTop - gridTop).toBeGreaterThanOrEqual(0);
  expect(buttonTop - gridTop).toBeLessThanOrEqual(4);

  await page.screenshot({
    path: testInfo.outputPath("crud-list-column-visibility-alignment.png"),
    fullPage: true,
  });
});
