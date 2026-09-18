// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

/** Waits for the dev appStores bridge used by focused Playwright checks. */
async function waitForAppStores(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const appStores = (window as any).appStores;
    return (
      appStores?.notificationHistory &&
      appStores?.clearNotificationHistory &&
      appStores?.pushToast
    );
  });
}

/** Adds deterministic toast notifications through the same frontend toast path. */
async function seedNotificationHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const appStores = (window as any).appStores;
    appStores.clearNotificationHistory();
    appStores.pushToast("info", "Desk connected", 100);
    appStores.pushToast("warning", "Fixture library changed", 100);
    appStores.pushToast(
      "error",
      "Showfile save failed\nThe destination is unavailable. Choose another folder and try saving again.",
      100,
    );
  });
}

test("notification history opens from the header bell and lists recent toasts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await page.evaluate(() => {
    (window as any).appStores.clearNotificationHistory();
  });

  const bellButton = page.getByRole("button", {
    exact: true,
    name: "Notification history",
  });
  await expect(bellButton).toBeVisible();
  await bellButton.click();

  const popout = page.getByRole("region", { name: "Notification history" });
  await expect(popout).toBeVisible();
  await expect(
    popout.getByText("Notification History", { exact: true }),
  ).toBeVisible();
  await expect(popout.getByText("No notifications yet")).toBeVisible();

  await seedNotificationHistory(page);
  await expect(bellButton).toHaveAccessibleName("Notification history");
  await expect(bellButton).not.toContainText("3");

  const rows = popout.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Error");
  await expect(rows.nth(0)).toContainText("Showfile save failed");
  await expect(rows.nth(1)).toContainText("Warning");
  await expect(rows.nth(1)).toContainText("Fixture library changed");
  await expect(rows.nth(2)).toContainText("Info");
  await expect(rows.nth(2)).toContainText("Desk connected");
  await expect(rows.first()).toContainText(/now|\d+s ago/);
  await expect(page.locator(".toastify.on")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("shared-notifications.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Clear notification history" })
    .click();
  await expect(popout.getByText("No notifications yet")).toBeVisible();
});
