// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Opens the patch panel before checking toolbar column visibility behavior.
 */
async function openPatchPanel(page: Page): Promise<Locator> {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);

  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Patch");
  await page.keyboard.press("Enter");

  const patchPanel = page.locator('[data-panel-kind="patch"]:visible');
  await expect(patchPanel).toHaveCount(1);
  await expect(
    patchPanel.getByRole("button", { name: "Add fixture" }),
  ).toBeVisible();
  await expect(
    patchPanel.getByRole("button", { name: "Column visibility" }),
  ).toBeVisible();
  return patchPanel;
}

test("patch column visibility control is right aligned in the main toolbar", async ({
  page,
}, testInfo) => {
  const patchPanel = await openPatchPanel(page);

  const addFixtureButton = patchPanel.getByRole("button", {
    name: "Add fixture",
  });
  const metrics = await addFixtureButton.evaluate((button) => {
    const toolbar = button.closest('[data-component="PanelToolbar"]');
    if (!toolbar) {
      throw new Error("Patch toolbar not found");
    }

    const columnButton = toolbar.querySelector<HTMLButtonElement>(
      'button[aria-label="Column visibility"]',
    );
    if (!columnButton) {
      throw new Error("Column visibility control not found in Patch toolbar");
    }

    const tabButtons = [...toolbar.querySelectorAll("button")].filter(
      (candidate) => {
        const text = candidate.textContent?.trim();
        return text === "Fixtures" || text === "DMX Routes";
      },
    );
    if (tabButtons.length !== 2) {
      throw new Error("Patch view toggles not found");
    }

    const columnRect = columnButton.getBoundingClientRect();
    const lastTabRect =
      tabButtons[tabButtons.length - 1].getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const divider = [...toolbar.querySelectorAll("div")]
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          candidate.getAttribute("aria-hidden") === "true" &&
          rect.width <= 2 &&
          rect.height >= 20
        );
      })
      .sort(
        (left, right) =>
          right.getBoundingClientRect().left -
          left.getBoundingClientRect().left,
      )[0];

    if (!divider) {
      throw new Error(
        "Divider between column visibility and view toggles not found",
      );
    }

    const dividerRect = divider.getBoundingClientRect();
    return {
      columnTop: columnRect.top,
      columnRight: columnRect.right,
      columnLeft: columnRect.left,
      dividerLeft: dividerRect.left,
      dividerRight: dividerRect.right,
      lastTabRight: lastTabRect.right,
      toolbarTop: toolbarRect.top,
      toolbarBottom: toolbarRect.bottom,
      toolbarRight: toolbarRect.right,
    };
  });

  expect(metrics.columnTop).toBeGreaterThanOrEqual(metrics.toolbarTop);
  expect(metrics.columnTop).toBeLessThan(metrics.toolbarBottom);
  expect(metrics.lastTabRight).toBeLessThan(metrics.dividerLeft);
  expect(metrics.dividerRight).toBeLessThan(metrics.columnLeft);
  expect(metrics.toolbarRight - metrics.columnRight).toBeLessThanOrEqual(12);

  await page.screenshot({
    path: testInfo.outputPath("patch-toolbar-column-visibility.png"),
    fullPage: true,
  });
});

/**
 * In DMX Routes, the toolbar stays in view however the panel is scrolled, every route cell's text
 * fits its content-sized column, and the validation mode button opens Settings on that setting.
 */
test("patch routes view keeps its toolbar, fits cells, and links its validation setting", async ({
  page,
}, testInfo) => {
  const patchPanel = await openPatchPanel(page);
  await patchPanel.locator('[role="tab"][id$="-routes"]').click();
  await expect(patchPanel.locator('[role="gridcell"]').first()).toBeVisible();

  const scrollable = await patchPanel.evaluate((panel) => {
    const viewport = panel.closest(".nf-scroll-viewport");
    return viewport ? viewport.scrollHeight - viewport.clientHeight : 0;
  });
  expect(scrollable).toBeLessThanOrEqual(0);

  for (const groupBy of ["None", "Fixture", "Universe"]) {
    await patchPanel
      .getByRole("tablist", { name: "Group by" })
      .getByRole("tab", { name: groupBy, exact: true })
      .click();
    await expect(patchPanel.locator('[role="gridcell"]').first()).toBeVisible();
    if (groupBy !== "None") {
      await patchPanel.locator('[role="gridcell"]').first().click();
      await expect(
        patchPanel
          .locator('[role="gridcell"][data-grid-column-key="type"]')
          .filter({ hasText: /^Output$/ })
          .first(),
      ).toBeVisible();
    }
    const clipped = await patchPanel.evaluate((panel) =>
      [...panel.querySelectorAll<HTMLElement>('[role="gridcell"] .truncate')]
        .filter((text) => text.scrollWidth > text.clientWidth)
        .map((text) => text.textContent),
    );
    expect(clipped, `clipped cells grouped by ${groupBy}`).toEqual([]);
  }
  await page.screenshot({
    path: testInfo.outputPath("patch-routes-columns.png"),
  });

  await patchPanel
    .getByRole("button", { name: /^(Strict|Permissive) Mode$/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByLabel("Overlap validation mode", { exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("patch-validation-setting.png"),
  });
});
