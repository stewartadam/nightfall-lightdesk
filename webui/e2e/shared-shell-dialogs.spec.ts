// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks that the shared About dialog keeps its close action usable on small screens, on every tab. */
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
  await page.setViewportSize({ width: 390, height: 320 });
  const body = about.locator(".nf-dialog-body");
  /** Finds one of the dialog body's own scroll edges, skipping the tab strip's nested ones. */
  const bodyEdge = (edge: "top" | "bottom") =>
    body.locator(`:scope > div > [data-edge="${edge}"]`);
  await expect(bodyEdge("bottom")).toHaveAttribute("data-visible", "true");
  await body.locator(":scope > .nf-scroll-viewport").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(bodyEdge("top")).toHaveAttribute("data-visible", "true");
  await expect(bodyEdge("bottom")).toHaveAttribute("data-visible", "false");
  await expect(
    about.getByRole("button", { name: "Close about dialog" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-about-scrolled.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await about.getByRole("tab", { name: "Third-Party Notices" }).click();
  const licenses = about.getByRole("tabpanel");
  await licenses.getByRole("searchbox").fill("preline");
  await licenses
    .locator(".nf-collapsible-trigger")
    .filter({ hasText: /^preline / })
    .click();
  await expect(
    licenses.locator('.nf-collapsible[data-open="true"] pre'),
  ).toContainText("Preline UI Fair Use License");
  await expect(
    about.getByRole("button", { name: "Close about dialog" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-licenses-narrow.png"),
  });
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
  const about = page.getByRole("dialog", { name: /^About nightfall$/i });
  await about.getByRole("tab", { name: "Third-Party Notices" }).click();
  const licenses = about.getByRole("tabpanel");
  await expect(licenses.getByRole("alert")).toContainText(
    "could not be loaded",
  );
  await page.unroute("**/notices/THIRD-PARTY-NOTICES.json");
  await licenses.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(licenses.getByRole("searchbox")).toBeVisible();
});
