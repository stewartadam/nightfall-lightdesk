// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

/** Runs a command palette entry by name. */
async function runCommand(page: Page, commandName: string) {
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P",
  );
  const input = page.getByPlaceholder("Type a command or search...");
  await expect(input).toBeVisible();
  await input.fill(commandName);
  await page.keyboard.press("Enter");
}

/** Opens a showfile action from the status bar menu. */
async function openMenuItem(page: Page, name: string) {
  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

/** Verifies info dialogs close from outside clicks and Escape while task dialogs only close on Escape or Cancel. */
test("app dialogs follow the info and task close pattern", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  await runCommand(page, "Manage Layouts");
  const layouts = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(layouts.locator(".nf-dialog-footer")).toHaveCount(0);
  await layouts.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("layouts.png"),
  });
  await page.mouse.click(5, 5);
  await expect(layouts).toBeHidden();

  await openMenuItem(page, "Open Showfile");
  const showfiles = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(showfiles).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(showfiles).toBeHidden();

  await openMenuItem(page, "Import Showfile");
  const importDialog = page.getByRole("dialog", { name: "Import Showfile" });
  await expect(
    importDialog.getByRole("button", { name: "Close import showfile dialog" }),
  ).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(importDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(importDialog).toBeHidden();
  await openMenuItem(page, "Import Showfile");
  await importDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(importDialog).toBeHidden();

  await openMenuItem(page, "Export Showfile");
  const exportDialog = page.getByRole("dialog", { name: "Export Showfile" });
  await expect(
    exportDialog.getByRole("button", { name: "Close export showfile dialog" }),
  ).toBeVisible();
  await exportDialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("export.png"),
  });
  await page.mouse.click(5, 5);
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(exportDialog).toBeHidden();

  await openMenuItem(page, "About");
  const about = page.getByRole("dialog", { name: /^About/ });
  await expect(about.locator(".nf-dialog-footer")).toHaveCount(0);
  await about.locator(".nf-dialog-surface").screenshot({
    animations: "disabled",
    path: testInfo.outputPath("about.png"),
  });
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();
});
