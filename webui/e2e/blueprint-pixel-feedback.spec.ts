// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Recalling position onto the sample pixel group keeps feedback and the page responsive. */
test("pixel group recall bounds incompatible blueprint feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await page
    .getByRole("dialog", { name: "Open Showfile", exact: true })
    .getByRole("button", { name: "New showfile" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New Showfile",
    exact: true,
  });
  await dialog.getByLabel("Show name").fill("Blueprint Feedback");
  await dialog.getByRole("checkbox", { name: "Include sample data" }).check();
  await dialog.getByRole("button", { name: "Create Show" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.blueprints.get()).length,
      ),
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Groups");
  await page.keyboard.press("Enter");
  await page
    .locator("[data-crud-select-id]")
    .filter({ hasText: "Pixel Tapes Left" })
    .click();
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Blueprints");
  await page.keyboard.press("Enter");
  await page.evaluate(() =>
    (window as any).appStores.notificationHistory.set([]),
  );
  await page
    .locator('[data-panel-kind="blueprints"] [data-crud-select-id]')
    .filter({ hasText: "Pan 25 Tilt 75" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.notificationHistory
            .get()
            .filter((entry: any) =>
              entry.message.includes("blueprint.no_applicable_values"),
            ).length,
      ),
    )
    .toBe(1);
  await expect(
    page.locator(".toastify").filter({ hasText: "640" }),
  ).toBeVisible();
  await page.locator("#header-cmdline").fill("clear");
  await expect(page.locator("#header-cmdline")).toHaveValue("clear");
  await page.screenshot({
    path: test.info().outputPath("pixel-blueprint-feedback.png"),
  });
});
