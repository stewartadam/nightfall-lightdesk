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
  await expect(panel).toBeVisible();
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
  const required = page.getByRole("dialog", { name: "Resume your work?" });
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

/** Verifies a dropdown inside a modal dialog takes the first Escape and leaves the dialog open for the second. */
test("escape closes a dropdown inside a dialog before the dialog", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Dialogs/ })
    .click();
  const panel = page.getByRole("region", { name: "Dialog examples" });
  await panel.getByRole("button", { name: "Task dialog" }).click();
  const task = page.getByRole("dialog", { name: "Rename sample group" });
  await expect(task).toBeVisible();

  const trigger = task.getByRole("button", { name: "Group color" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Group colors" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(4);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dropdown-in-dialog-open.png"),
  });

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(task).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dropdown-in-dialog-after-first-escape.png"),
  });

  await trigger.click();
  await menu.getByRole("button", { name: "Cyan" }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveText("Cyan");
  await trigger.click();
  await expect(menu).toBeVisible();
  await task.getByLabel("Label").click();
  await expect(menu).toBeHidden();
  await expect(task).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(task).toBeHidden();
  await expect(panel.getByRole("status")).toHaveText("Rename cancelled");
});

/**
 * Verifies a dialog closed and reopened within one task stays open without errors.
 * The browser delivers the old dialog's `close` event a task later, after the old
 * element has left the page, and the Modal must not try to reopen that element. A close
 * the browser forces on the current dialog while it should stay open is still undone.
 */
test("a dialog reopened right after closing shows without errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Dialogs/ })
    .click();
  const panel = page.getByRole("region", { name: "Dialog examples" });
  await panel.getByRole("button", { name: "Required choice" }).click();
  const required = page.getByRole("dialog", { name: "Resume your work?" });
  await expect(required).toBeVisible();

  await page.evaluate(() => {
    /** Finds a button by its visible text, even one behind the inert modal backdrop. */
    const buttonNamed = (name: string) =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === name,
      );
    buttonNamed("Load draft")?.click();
    buttonNamed("Required choice")?.click();
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );

  await expect(required).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        [...document.querySelectorAll("dialog")].filter((dialog) => dialog.open)
          .length,
    ),
  ).toBe(1);
  expect(pageErrors).toEqual([]);

  await page.evaluate(() =>
    [...document.querySelectorAll("dialog")]
      .find((dialog) => dialog.open)
      ?.close(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll("dialog")].some(
          (dialog) => dialog.open && dialog.matches(":modal"),
        ),
      ),
    )
    .toBe(true);
  await expect(required).toBeVisible();
  expect(pageErrors).toEqual([]);

  await required.getByRole("button", { name: "Load draft" }).click();
  await expect(required).toBeHidden();
});
