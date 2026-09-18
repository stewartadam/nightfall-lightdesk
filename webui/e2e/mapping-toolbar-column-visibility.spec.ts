// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";

/**
 * Opens the named panel through the command palette.
 */
async function openPanel(page: Page, panelName: string) {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Asserts that the column visibility menu is aligned to the toolbar anchor.
 */
async function expectToolbarColumnVisibilityRightAligned(anchor: Locator) {
  await expect(anchor).toBeVisible();

  const metrics = await anchor.evaluate((element) => {
    const toolbar = element.closest('[class*="border-b"]');
    if (!toolbar) {
      throw new Error("Panel toolbar not found");
    }

    const columnButton = toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Column visibility"]',
    );
    if (!columnButton) {
      throw new Error("Column visibility control not found in toolbar");
    }

    const toolbarRect = toolbar.getBoundingClientRect();
    const columnRect = columnButton.getBoundingClientRect();
    return {
      columnTop: columnRect.top,
      columnRight: columnRect.right,
      toolbarTop: toolbarRect.top,
      toolbarBottom: toolbarRect.bottom,
      toolbarRight: toolbarRect.right,
    };
  });

  expect(metrics.columnTop).toBeGreaterThanOrEqual(metrics.toolbarTop);
  expect(metrics.columnTop).toBeLessThan(metrics.toolbarBottom);
  expect(metrics.toolbarRight - metrics.columnRight).toBeLessThanOrEqual(12);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
});

test("scene objects column visibility control is right aligned", async ({
  page,
}, testInfo) => {
  await openPanel(page, "Scene Objects");
  await expectToolbarColumnVisibilityRightAligned(
    page.getByRole("button", { name: "Add object" }),
  );

  await page.screenshot({
    path: testInfo.outputPath("scene-objects-toolbar-column-visibility.png"),
    fullPage: true,
  });
});

test("MIDI mapping column visibility control is right aligned", async ({
  page,
}, testInfo) => {
  await openPanel(page, "MIDI Input");
  await expectToolbarColumnVisibilityRightAligned(
    page.getByText("MIDI Mappings", { exact: true }),
  );

  await page.screenshot({
    path: testInfo.outputPath("midi-toolbar-column-visibility.png"),
    fullPage: true,
  });
});

test("OSC mapping column visibility control is right aligned", async ({
  page,
}, testInfo) => {
  await openPanel(page, "OSC Input");
  await expectToolbarColumnVisibilityRightAligned(
    page.getByText("OSC Mappings", { exact: true }),
  );

  await page.screenshot({
    path: testInfo.outputPath("osc-toolbar-column-visibility.png"),
    fullPage: true,
  });
});
