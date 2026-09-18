// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getNightfallDataDirectoryPath } from "../lib/tauri";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks app title, lowercase About branding, metadata, and bundled notices. */
test("opens about dialog from the status bar menu", async ({
  context,
  page,
}, testInfo) => {
  const expectedDataDirectoryPath =
    process.env.NIGHTFALL_DATA_DIR ?? getNightfallDataDirectoryPath();

  await page.goto("/?e2e=1");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await expect(page).toHaveTitle(/^nightfall(?: \(.+\))?$/);
  await waitForDockviewApp(page);
  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Application status bar" })
      .getByTestId("status-build-name"),
  ).toBeVisible();

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "About" }).click();

  const dialog = page.getByRole("dialog", { name: "About nightfall" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "nightfall", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("about-branding.png") });
  await expect(dialog.getByAltText("nightfall logo")).toBeVisible();
  await expect(dialog.getByText("Version")).toBeVisible();
  await expect(dialog.getByText("0.1.0")).toBeVisible();
  await expect(dialog.getByText("Build ID")).toBeVisible();
  await expect(
    dialog
      .locator("span")
      .filter({ hasText: /^(unknown|[0-9a-f]{7,12})$/i })
      .first(),
  ).toBeVisible();
  await expect(dialog.getByText("Build Name")).toBeVisible();
  await expect(dialog.getByTestId("build-name")).toContainText(/.+/);
  await expect(
    dialog
      .locator("span")
      .filter({ hasText: /^MPL-2\.0$/ })
      .first(),
  ).toBeVisible();
  await expect(dialog.getByText(/\u00A9 .* Stewart Adam/)).toBeVisible();
  await expect(dialog.getByText("Third-Party Notices")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Copy Data Directory Path" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Copy Data Directory Path" })
    .hover();
  await expect(page.getByText(expectedDataDirectoryPath)).toBeVisible();
  await expect(
    dialog.getByText("Copyright (c) 2026 SquidLab"),
  ).not.toBeVisible();

  await dialog
    .getByRole("button", { name: "Copy Data Directory Path" })
    .click();
  await expect(
    page.getByText("Copied nightfall data directory path"),
  ).toBeVisible();

  await dialog
    .getByRole("button", { name: "View Third-Party Licenses" })
    .click();
  const licensesDialog = page.getByRole("dialog", {
    name: "Third-Party Licenses",
  });
  const search = licensesDialog.getByRole("searchbox");
  await search.fill("@squidlab/phosphor-solid");
  await licensesDialog
    .locator("summary")
    .filter({ hasText: /^@squidlab\/phosphor-solid / })
    .click();
  await expect(licensesDialog.locator("pre")).toContainText(
    "Copyright (c) 2026 SquidLab",
  );
  await search.fill("original artwork");
  await licensesDialog.locator("summary").click();
  await expect(licensesDialog.locator("pre")).toContainText(
    "Copyright (c) 2023 Phosphor Icons",
  );
  await search.fill("Beat This");
  await licensesDialog
    .locator("summary")
    .filter({ hasText: /^Beat This / })
    .click();
  await expect(licensesDialog.locator("details[open] pre")).toContainText(
    "Copyright (c) 2024 Institute of Computational Perception",
  );
  await expect(licensesDialog.locator("details[open] pre")).toContainText(
    "c5c1466e08abdb03fdeb50668a06f244",
  );
  await search.fill("preline");
  const preline = licensesDialog
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: /^preline / }) });
  await preline.locator("summary").click();
  await expect(preline.locator("pre")).toContainText(
    "Preline UI Fair Use License",
  );
  await expect(preline.getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/htmlstreamofficial/preline.git",
  );
  await page.screenshot({
    path: testInfo.outputPath("third-party-preline.png"),
  });
});
