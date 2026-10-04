// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Describes where keyboard focus sits: the focused control's label when it is
 * inside `dialog`, "outside" when a page control behind the dialog has focus,
 * or "none" when focus has left the page content (the browser chrome step).
 */
async function focusLocation(dialog: Locator): Promise<string> {
  return dialog.evaluate((element) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return "none";
    if (!element.contains(active)) return "outside";
    return (
      active.getAttribute("aria-label") ??
      active.textContent?.trim() ??
      active.tagName
    ).slice(0, 40);
  });
}

/**
 * Presses a key `count` times, asserting focus never lands on page content
 * behind the dialog, and returns where focus was after each press.
 */
async function walkFocus(
  page: Page,
  dialog: Locator,
  key: "Tab" | "Shift+Tab",
  count: number,
): Promise<string[]> {
  const stops: string[] = [];
  for (let press = 0; press < count; press += 1) {
    await page.keyboard.press(key);
    const location = await focusLocation(dialog);
    expect(location).not.toBe("outside");
    stops.push(location);
  }
  return stops;
}

/** Reports whether an element sits inside an inert subtree. */
async function isInert(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.closest("[inert]") !== null);
}

/** Opens the design lab task dialog from its trigger button. */
async function openTaskDialog(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Dialogs/ })
    .click();
  const panel = page.getByRole("region", { name: "Dialog examples" });
  const opener = panel.getByRole("button", { name: "Task dialog" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Rename sample group" });
  await expect(dialog).toBeVisible();
  return { panel, opener, dialog };
}

/** Verifies Tab and Shift+Tab reach every dialog control and never the page behind it. */
test("tab moves only through the open dialog's controls", async ({
  page,
}, testInfo) => {
  const { panel, opener, dialog } = await openTaskDialog(page);
  await expect(dialog).toBeFocused();
  expect(await isInert(panel)).toBe(true);

  const forward = await walkFocus(page, dialog, "Tab", 12);
  for (const control of ["Close", "Cancel", "Save"]) {
    expect(forward).toContain(control);
  }
  const backward = await walkFocus(page, dialog, "Shift+Tab", 12);
  for (const control of ["Close", "Cancel", "Save"]) {
    expect(backward).toContain(control);
  }

  await dialog.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Tab");
  if ((await focusLocation(dialog)) === "none")
    await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("focus-wrapped-to-first-control.png"),
  });

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await isInert(panel)).toBe(false);
  await expect(opener).toBeFocused();
});

/** Verifies background controls cannot be clicked into focus while a dialog is open. */
test("page behind the dialog is inert", async ({ page }) => {
  const { panel, dialog } = await openTaskDialog(page);
  const background = panel.getByRole("button", { name: "Info dialog" });
  await background.focus();
  await expect(background).not.toBeFocused();
  await expect(dialog).toBeVisible();
});

/** Verifies only the frontmost of two stacked dialogs is reachable, and closing it returns focus to its opener. */
test("stacked dialogs keep focus in the frontmost one", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  const about = page.getByRole("dialog", { name: /^About nightfall$/i });
  await expect(about).toBeVisible();
  const opener = about.getByRole("button", {
    name: "View Third-Party Licenses",
  });
  await opener.click();
  const licenses = page.getByRole("dialog", { name: "Third-Party Licenses" });
  await expect(licenses).toBeVisible();
  await expect(licenses).toBeFocused();

  await walkFocus(page, licenses, "Tab", 12);
  await walkFocus(page, licenses, "Shift+Tab", 12);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("stacked-licenses-focus.png"),
  });

  await page.keyboard.press("Escape");
  await expect(licenses).toBeHidden();
  await expect(opener).toBeFocused();
  await walkFocus(page, about, "Tab", 8);
});
