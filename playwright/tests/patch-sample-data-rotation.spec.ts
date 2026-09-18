// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "@playwright/test";

test("sample-data fixture 212 is loaded in Patch", async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto("/");

  await expect(page).toHaveTitle(/^nightfall(?: \(.+\))?$/);
  await expect(page.locator("main#app")).toBeVisible();

  // Sample-data fixtures arrive shortly after the shell connects to the backend.
  await page.waitForTimeout(3_000);

  await page.keyboard.press("Meta+K");

  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Patch");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Add fixture" })).toBeVisible();
  await expect(page.locator("#glide-cell-1-3")).toHaveText("212");
});
