// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks that shared About and license dialogs keep their close actions usable on small screens. */
test("shared shell dialogs fit a narrow viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const about = page.getByRole("dialog", { name: /^About nightfall$/i });
  await expect(
    about.getByRole("button", { name: "Close about dialog" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-about-narrow.png"),
  });
  await page.setViewportSize({ width: 390, height: 420 });
  const body = about.locator(".nf-dialog-body");
  await expect(body.locator('[data-edge="bottom"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await body.locator(".nf-scroll-viewport").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(body.locator('[data-edge="top"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await expect(body.locator('[data-edge="bottom"]')).toHaveAttribute(
    "data-visible",
    "false",
  );
  await expect(
    about.getByRole("button", { name: "Close about dialog" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-about-scrolled.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await about
    .getByRole("button", { name: "View Third-Party Licenses" })
    .click();
  const licenses = page.getByRole("dialog", { name: "Third-Party Licenses" });
  await licenses.getByRole("searchbox").fill("preline");
  await licenses
    .locator("summary")
    .filter({ hasText: /^preline / })
    .click();
  await expect(licenses.locator("details[open] pre")).toContainText(
    "Preline UI Fair Use License",
  );
  await expect(
    licenses.getByRole("button", { name: "Close third-party licenses dialog" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-licenses-narrow.png"),
  });
  await licenses
    .getByRole("button", { name: "Close third-party licenses dialog" })
    .click();
  await expect(licenses).toBeHidden();
  await expect(about).toBeVisible();
  await about.getByRole("button", { name: "Close about dialog" }).click();
  await expect(about).toBeHidden();
});

/** Keep a notice-file failure recoverable without losing the application or About dialog. */
test("third-party notices can retry a failed load", async ({ page }) => {
  await page.route("**/notices/THIRD-PARTY-NOTICES.json", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.getByRole("button", { name: "View Third-Party Licenses" }).click();
  const licenses = page.getByRole("dialog", { name: "Third-Party Licenses" });
  await expect(licenses.getByRole("alert")).toContainText(
    "could not be loaded",
  );
  await page.unroute("**/notices/THIRD-PARTY-NOTICES.json");
  await licenses.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(licenses.getByRole("searchbox")).toBeVisible();
});
