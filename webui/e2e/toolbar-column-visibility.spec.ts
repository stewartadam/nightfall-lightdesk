// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

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
    const toolbar = element.closest('[data-component="PanelToolbar"]');
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

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
});

/** Panels whose toolbar carries a column visibility control, with an anchor inside that toolbar. */
const TOOLBAR_PANELS: ReadonlyArray<{
  panel: string;
  anchor: (page: Page) => Locator;
}> = [
  {
    panel: "Scene Objects",
    anchor: (page) => page.getByRole("button", { name: "Add object" }),
  },
  {
    panel: "MIDI Input",
    anchor: (page) => page.getByText("MIDI Mappings", { exact: true }),
  },
  {
    panel: "OSC Input",
    anchor: (page) => page.getByText("OSC Mappings", { exact: true }),
  },
  {
    panel: "Programmer",
    anchor: (page) =>
      page
        .locator('[data-panel-id="panel-ProgrammerGrid"]')
        .getByRole("button", { name: "Column visibility" }),
  },
];

for (const { panel, anchor } of TOOLBAR_PANELS) {
  /** Verifies the panel toolbar keeps its column visibility control at the right edge. */
  test(`${panel} column visibility control is right aligned`, async ({
    page,
  }, testInfo) => {
    await openPanel(page, panel);
    await expectToolbarColumnVisibilityRightAligned(anchor(page));
    await page.screenshot({
      path: testInfo.outputPath(
        `${panel.toLowerCase().replaceAll(" ", "-")}-toolbar-column-visibility.png`,
      ),
      fullPage: true,
    });
  });
}
