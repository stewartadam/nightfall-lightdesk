// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "@playwright/test";

test("loads the app shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/^nightfall(?: \(.+\))?$/);
  await expect(page.getByRole("navigation", { name: "Global" })).toBeVisible();
  await expect(page.locator("main#app")).toBeVisible();
  await expect(page.locator("button[title='Menu']")).toBeVisible();
});
