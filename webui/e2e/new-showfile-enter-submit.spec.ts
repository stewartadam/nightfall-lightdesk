// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Verifies Enter in the show name field creates the show and closes the dialog like Create Show. */
test("pressing Enter in the new showfile name creates the show and closes the dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
  });
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page);

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /New Showfile/ }).click();
  const dialog = page.getByRole("dialog", { name: "New Showfile" });
  const showName = `enter-${Date.now()}`;
  const nameInput = dialog.getByLabel("Show name");
  await expect(nameInput).toBeFocused();
  await nameInput.fill(showName);
  await nameInput.press("Enter");

  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("nightfall.currentShowfileName"),
      ),
    )
    .toBe(showName);
  await expect(dialog).toBeHidden();
});
