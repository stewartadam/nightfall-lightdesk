// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads rendered control bounds after confirming that the control is visible. */
async function bounds(control: Locator) {
  await expect(control).toBeVisible();
  return (await control.boundingBox())!;
}

/** Compares left icon slots and gaps with undo/redo while exercising the menu and metrics toggle. */
test("status bar left icons match undo and redo sizing and spacing", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const bar = page.getByRole("region", { name: "Application status bar" });
  const menu = bar.getByRole("button", { name: "Menu", exact: true });
  const connection = bar.getByRole("status", {
    name: "Connected",
    exact: true,
  });
  const metrics = bar.getByRole("button", {
    name: "Show metrics",
    exact: true,
  });
  const undo = bar.getByRole("button", { name: /^(Nothing to undo|Undo:)/ });
  const redo = bar.getByRole("button", { name: /^(Nothing to redo|Redo:)/ });
  const undoBox = await bounds(undo);
  const redoBox = await bounds(redo);
  const expectedGap = redoBox.x - undoBox.x - undoBox.width;
  const left = await Promise.all([
    bounds(menu),
    bounds(connection),
    bounds(metrics),
  ]);
  for (const box of left) {
    expect(box.width).toBe(undoBox.width);
    expect(box.height).toBe(undoBox.height);
    expect(box.y).toBe(undoBox.y);
  }
  for (let index = 1; index < left.length; index++) {
    expect(left[index].x - left[index - 1].x - left[index - 1].width).toBe(
      expectedGap,
    );
  }
  const iconWidth = (await bounds(undo.locator("svg"))).width;
  expect((await bounds(menu.locator("svg"))).width).toBe(iconWidth);
  expect((await bounds(metrics.locator("svg"))).width).toBe(iconWidth);
  await expect(
    bar.getByTestId("status-showfile-name").getByText("Show", { exact: true }),
  ).toHaveCount(0);
  await expect(bar.getByTestId("status-showfile-name")).not.toHaveText("");
  await menu.click();
  await expect(
    page.getByRole("button", { name: /Open Showfile/ }),
  ).toBeVisible();
  await menu.click();
  await expect(
    page.getByRole("button", { name: /Open Showfile/ }),
  ).toBeHidden();
  await connection.focus();
  await expect(
    page.getByRole("tooltip", { name: "Connected", exact: true }),
  ).toBeVisible();
  await metrics.click();
  await expect(bar.locator("#status-metrics")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("status-bar-icons-expanded.png"),
  });
  await bar.getByRole("button", { name: "Hide metrics", exact: true }).click();
  await expect(bar.locator("#status-metrics")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("status-bar-icons.png") });
});
