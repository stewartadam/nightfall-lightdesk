// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { harnessPageUrl } from "./app-hooks";
import {
  expect,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Loads the browser demo shell without a native backend. */
async function openDemoApp(page: Page): Promise<void> {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
}

/** Opens the stacked-dialogs fixture and its inner dialog on top of the outer one. */
async function openStackedDialogs(page: Page) {
  await page.goto(harnessPageUrl("stacked-dialogs"));
  const outer = page.getByRole("dialog", { name: "Outer dialog" });
  await expect(outer).toBeVisible();
  await outer.getByRole("button", { name: "Open inner dialog" }).click();
  const inner = page.getByRole("dialog", { name: "Inner dialog" });
  await expect(inner).toBeVisible();
  return { outer, inner };
}

/** Verifies Escape closes only the frontmost of two stacked dialogs. */
test("escape closes only the frontmost stacked dialog", async ({ page }) => {
  const { outer, inner } = await openStackedDialogs(page);

  await page.keyboard.press("Escape");
  await expect(inner).toBeHidden();
  await expect(outer).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(outer).toBeHidden();
});

/** Verifies Enter in a field of the frontmost dialog stays with that field instead of dismissing dialogs. */
test("enter in a stacked dialog field keeps both dialogs open", async ({
  page,
}) => {
  const { outer, inner } = await openStackedDialogs(page);

  const search = inner.getByRole("searchbox");
  await search.fill("preline");
  await search.press("Enter");
  await expect(inner).toBeVisible();
  await expect(outer).toBeVisible();
  await expect(search).toHaveValue("preline");
});

/** Verifies Enter on controls inside Settings never dismisses the dialog. */
test("enter inside settings keeps the dialog open", async ({ page }) => {
  await openDemoApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();

  const firstSwitch = settings.getByRole("switch").first();
  await firstSwitch.focus();
  await page.keyboard.press("Enter");
  await expect(settings).toBeVisible();

  await settings.getByRole("heading", { name: "Settings" }).click();
  await page.keyboard.press("Enter");
  await expect(settings).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});

/** Verifies Enter on non-interactive About content does not close the dialog. */
test("enter inside about keeps the dialog open", async ({ page }) => {
  await openDemoApp(page);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  const about = page.getByRole("dialog", { name: /^About nightfall$/i });
  await expect(about).toBeVisible();

  await about.getByRole("heading", { name: "nightfall", exact: true }).click();
  await page.keyboard.press("Enter");
  await expect(about).toBeVisible();
});
