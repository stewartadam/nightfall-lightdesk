// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Locates one sample tab of the design lab's Tab menu demo by its panel ID. */
function sampleTab(page: Page, panel: string) {
  return page.locator(`.dv-default-tab[data-dockview-panel-id="${panel}"]`);
}

/**
 * Walks the caret tab menu: hovering the active tab swaps its icon for a caret,
 * the caret opens the tab menu led by Settings when the panel offers them, and
 * inactive tabs keep their icon.
 */
test("active tab icon turns into a caret that opens the tab menu", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Tab menu/ })
    .click();
  const demo = page.getByRole("region", { name: "Tab menu examples" });
  await expect(demo).toBeVisible();

  const clips = sampleTab(page, "tab-menu-clips");
  const caret = clips.getByRole("button", { name: "Clips tab menu" });
  await expect(caret).toHaveCount(0);
  await clips.hover();
  await expect(caret).toBeVisible();
  await demo.screenshot({ path: testInfo.outputPath("01-caret-on-hover.png") });

  await caret.click();
  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu.getByRole("menuitem").first()).toHaveText(/Settings…/);
  await expect(
    menu.getByRole("menuitem", { name: "Close Others in Group" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("02-tab-menu.png") });

  await menu.getByRole("menuitem", { name: /Settings…/ }).click();
  await expect(menu.getByText("Clips settings")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("03-panel-settings.png") });
  await menu.getByRole("menuitem", { name: "Compact rows" }).click();
  await expect(demo.getByText("Compact rows: on")).toBeVisible();

  const board = sampleTab(page, "tab-menu-board");
  await board.hover();
  await expect(board.getByRole("button")).toHaveCount(0);

  // Clicking an inactive tab's icon only activates it, even though the caret
  // appears under the pointer as the tab becomes visible.
  const timecodes = sampleTab(page, "tab-menu-timecodes");
  await timecodes.locator("span[aria-hidden]").first().click();
  await expect(menu).toBeHidden();
  await timecodes.hover();
  await timecodes.getByRole("button", { name: "Timecodes tab menu" }).click();
  await expect(menu.getByRole("menuitem").first()).toHaveText("Close");
  await expect(menu.getByRole("menuitem", { name: /Settings…/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");

  await sampleTab(page, "tab-menu-visualizer").click({ button: "right" });
  await expect(menu.getByRole("menuitem").first()).toHaveText(/Settings…/);
  await page.keyboard.press("Escape");
});
