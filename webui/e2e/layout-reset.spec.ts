// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

/** Opens an empty disconnected app for client-side layout reset checks. */
async function openLayoutResetApp(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
}

test("resetting the layout keeps panel toolbars pinned to the top at large viewports", async ({
  page,
}) => {
  await page.setViewportSize({ width: 3000, height: 1700 });
  await openLayoutResetApp(page);

  /** Runs the command-palette action that resets the saved layout. */
  const resetLayout = async () => {
    await page.getByRole("button", { name: "Open command palette" }).click();

    const commandInput = page.getByPlaceholder("Type a command or search...");
    await expect(commandInput).toBeVisible();
    await commandInput.fill("Reset Layout");
    await page.keyboard.press("Enter");
  };

  await resetLayout();
  await resetLayout();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();

        return {
          bottomCollapsed: api.getEdgeGroup("bottom")?.isCollapsed(),
          leftCollapsed: api.getEdgeGroup("left")?.isCollapsed(),
          rightCollapsed: api.getEdgeGroup("right")?.isCollapsed(),
        };
      }),
    )
    .toEqual({
      bottomCollapsed: true,
      leftCollapsed: true,
      rightCollapsed: true,
    });

  await expect(
    page.locator(".dv-tab").filter({ hasText: "Clips" }).first(),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Groups" }).click();

  const addGroupButton = page.getByRole("button", { name: "Add group" });
  await expect(addGroupButton).toBeVisible();

  await expect
    .poll(async () => {
      const box = await addGroupButton.boundingBox();
      return box?.y ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(200);
});
