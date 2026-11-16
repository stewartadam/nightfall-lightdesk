// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import {
  enterCompactShell,
  resetToDefaultLayout,
  waitForDockviewApp,
} from "./showfile-startup";

/** Exercises saved Patch views and grouping, keyboard selection, and the sideways-scrolling compact toolbar. */
test("Patch segmented tabs switch views and preserve grouping", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill("Open Patch");
  await page.keyboard.press("Enter");
  const panel = page.locator('[data-panel-kind="patch"]:visible');
  await expect(panel).toHaveCount(1);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.activePanel.api.maximize();
  });
  const views = panel.getByRole("tablist", { name: "Patch views" });
  const fixtures = views.getByRole("tab", { name: "Fixtures", exact: true });
  const dmx = views.getByRole("tab", { name: "DMX Routes" });
  await expect(fixtures).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("button", { name: "Add fixture", exact: true }),
  ).toBeVisible();
  await dmx.click();
  await expect(
    panel.getByRole("button", { name: "Add fixture", exact: true }),
  ).toBeHidden();
  const grouping = panel.getByRole("tablist", { name: "Group by" });
  const none = grouping.getByRole("tab", { name: "None" });
  const fixture = grouping.getByRole("tab", { name: "Fixture", exact: true });
  const universe = grouping.getByRole("tab", { name: "Universe" });
  await expect(none).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("tabpanel", { name: "None", exact: true }),
  ).toBeVisible();
  await fixture.click();
  await expect(
    panel.getByRole("tabpanel", { name: "Fixture", exact: true }),
  ).toBeVisible();
  await expect(
    panel.locator('[data-grid-header-id="tanstack-header-fixture"]'),
  ).toBeVisible();
  await fixture.press("ArrowRight");
  await expect(universe).toBeFocused();
  await expect(universe).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("tabpanel", { name: "Universe", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("patch-segmented-desktop.png"),
  });
  await fixtures.click();
  await fixtures.press("ArrowRight");
  await expect(dmx).toBeFocused();
  await expect(universe).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("nightfall-patch-panel:routes-group-by"),
      ),
    )
    .toBe("universe");

  await enterCompactShell(page, { width: 390, height: 780 });
  // The compact shell scrolls a long toolbar sideways; every control stays reachable.
  // Scroll offsets land on sub-pixel positions, so allow a sliver of edge clipping.
  for (const control of [
    dmx,
    universe,
    panel.getByRole("button", { name: "Column visibility" }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 0.95 });
  }
  await page.screenshot({
    path: testInfo.outputPath("patch-segmented-narrow.png"),
  });
  await universe.press("Home");
  await expect(none).toBeFocused();
  await expect(none).toHaveAttribute("aria-selected", "true");
  await none.press("End");
  await expect(universe).toBeFocused();
  await universe.press("ArrowRight");
  await expect(none).toBeFocused();
  await expect(grouping.locator('[tabindex="0"]')).toHaveCount(1);
});
