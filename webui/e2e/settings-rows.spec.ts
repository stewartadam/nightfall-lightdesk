// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/** Settings tabs laid out as settings rows, with every row's control on the right edge. */
const ROW_TABS = ["General", "Appearance", "Editors", "Network", "Visualizer"];

/**
 * Walks each Settings tab and checks that every settings row ends its control at the same right
 * edge, so switches, selects, fields and sliders line up down the dialog, then captures each tab.
 */
test("settings tabs align every control to the right edge", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  for (const name of ROW_TABS) {
    await dialog.getByRole("tab", { name, exact: true }).click();
    const panel = dialog.getByRole("tabpanel", { name });
    const rows = panel.locator(".nf-settings-row");
    await expect(rows.first()).toBeVisible();
    const edges = await rows.evaluateAll((elements) =>
      elements.map((row) => {
        const control = row.querySelector(".nf-settings-row-control");
        return Math.round(
          (control?.lastElementChild?.getBoundingClientRect().right ?? 0) -
            row.getBoundingClientRect().right,
        );
      }),
    );
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(Math.abs(edge)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(250);
    await dialog.screenshot({
      path: testInfo.outputPath(`settings-${name.toLowerCase()}.png`),
    });
  }
  await dialog.getByRole("tab", { name: "Privacy", exact: true }).click();
  await page.waitForTimeout(250);
  await dialog.screenshot({
    path: testInfo.outputPath("settings-privacy.png"),
  });
});
