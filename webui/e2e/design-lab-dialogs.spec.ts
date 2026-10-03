// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Verifies each proposed dialog kind exposes exactly its close affordances and dismissal paths. */
test("design lab dialogs follow the task, info and required close pattern", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Dialogs/ })
    .click();
  const panel = page.getByRole("region", { name: "Dialog examples" });
  await expect(
    panel
      .getByRole("list", { name: "Current close buttons" })
      .getByRole("listitem"),
  ).toHaveCount(5);
  await panel.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dialogs-panel.png"),
  });
  const status = panel.getByRole("status");

  await panel.getByRole("button", { name: "Task dialog" }).click();
  const task = page.getByRole("dialog", { name: "Rename sample group" });
  await expect(task.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(task.getByRole("button", { name: "Cancel" })).toBeVisible();
  await task.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dialog-task.png"),
  });
  await page.mouse.click(5, 5);
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: "Cancel" }).click();
  await expect(task).toBeHidden();
  await expect(status).toHaveText("Rename cancelled");

  await panel.getByRole("button", { name: "Task dialog" }).click();
  await task.getByLabel("Label").fill("Back wash");
  await task.getByRole("button", { name: "Save" }).click();
  await expect(task.getByRole("button", { name: "Close" })).toBeDisabled();
  await expect(task.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(task).toBeVisible();
  await expect(task).toBeHidden();
  await expect(status).toHaveText("Saved sample: Back wash");

  await panel.getByRole("button", { name: "Info dialog" }).click();
  const info = page.getByRole("dialog", { name: "About this sample" });
  await expect(info.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(info.locator(".nf-dialog-footer")).toHaveCount(0);
  await info.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dialog-info.png"),
  });
  await page.mouse.click(5, 5);
  await expect(info).toBeHidden();
  await panel.getByRole("button", { name: "Info dialog" }).click();
  await page.keyboard.press("Escape");
  await expect(info).toBeHidden();

  await panel.getByRole("button", { name: "Required choice" }).click();
  const required = page.getByRole("alertdialog", { name: "Resume your work?" });
  await expect(required.getByRole("button", { name: "Close" })).toHaveCount(0);
  await required.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dialog-required.png"),
  });
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(required).toBeVisible();
  await required.getByRole("button", { name: "Load draft" }).click();
  await expect(required).toBeHidden();
  await expect(status).toHaveText("Loaded draft");
});
