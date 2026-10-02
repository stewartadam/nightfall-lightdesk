// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

/** Opens the Open Showfile dialog from the status bar menu. */
async function openShowfileDialog(page: Page) {
  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Open Showfile" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Confirms the delete confirmation prompt with the given confirm label. */
async function confirmPrompt(page: Page, title: string, label: string) {
  const prompt = page.locator('[data-modal-kind="delete-confirm"]');
  await expect(prompt.getByRole("heading", { name: title })).toBeVisible();
  await prompt.getByRole("button", { name: label, exact: true }).click();
  await expect(prompt).toBeHidden();
}

/** Verifies deleting, restoring, and emptying the trash against a real backend. */
test("deletes, restores, and empties showfile trash", async ({
  backendSlot,
  page,
}) => {
  const deletedName = await prepareFreshBackendShowfile(
    backendSlot.backendPort,
  );
  const openName = await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript((name) => {
    window.localStorage.setItem("nightfall.currentShowfileName", name);
  }, openName);
  await page.goto("/?startup:draftRecovery=false");
  await waitForDockviewApp(page);

  let dialog = await openShowfileDialog(page);
  await expect(
    dialog.getByRole("button", { name: `Delete showfile ${openName}` }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: `Show revisions for ${deletedName}` })
    .hover();
  await page.screenshot({ path: test.info().outputPath("delete-hover.png") });
  await dialog
    .getByRole("button", { name: `Delete showfile ${deletedName}` })
    .click();
  await confirmPrompt(page, "Delete Showfile", "Delete");

  await expect(
    dialog.getByRole("button", { name: `Show revisions for ${deletedName}` }),
  ).toHaveCount(0);
  const trash = dialog.getByRole("region", { name: "Recently deleted" });
  await expect(trash.getByText(deletedName)).toBeVisible();
  await expect(trash.getByText(/Expires /)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("recently-deleted.png"),
  });

  await trash
    .getByRole("button", { name: `Restore showfile ${deletedName}` })
    .click();
  await expect(
    dialog.getByRole("button", { name: `Show revisions for ${deletedName}` }),
  ).toBeVisible();
  await expect(trash).toBeHidden();

  await dialog
    .getByRole("button", { name: `Delete showfile ${deletedName}` })
    .click();
  await confirmPrompt(page, "Delete Showfile", "Delete");
  await expect(trash.getByText(deletedName)).toBeVisible();
  await trash.getByRole("button", { name: "Empty trash" }).click();
  await confirmPrompt(page, "Empty Trash", "Empty trash");
  await expect(trash).toBeHidden();

  await dialog
    .getByRole("button", { name: "Close open showfile dialog" })
    .click();
  dialog = await openShowfileDialog(page);
  await expect(
    dialog.getByRole("button", { name: `Show revisions for ${deletedName}` }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "Recently deleted" }),
  ).toHaveCount(0);
});
