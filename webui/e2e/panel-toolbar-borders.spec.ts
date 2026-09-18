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

/** Checks that a toolbar draws a single bottom divider without a border around its action groups. */
async function expectBottomDivider(toolbar: Locator) {
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCSS("border-bottom-width", "1px");
  for (const edge of ["top", "left", "right"]) {
    await expect(toolbar).toHaveCSS(`border-${edge}-width`, "0px");
  }
  await expect(toolbar).toHaveCSS("border-radius", "0px");
  for (const slot of ["left", "right"]) {
    await expect(toolbar.locator(`[data-slot="${slot}"]`)).toHaveCSS(
      "border-bottom-width",
      "0px",
    );
  }
}

/** Exercises CRUD and visualizer controls with consistent border geometry at wide and narrow widths. */
test("CRUD and visualizer toolbars share a bottom-only divider", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.getByRole("tab", { name: "Fixtures", exact: true }).click();
  const fixtures = page.locator('[data-component="PanelToolbar"]').filter({
    has: page.getByRole("switch", { name: "Hide default values" }),
  });
  await expectBottomDivider(fixtures);
  const showDmx = fixtures.getByRole("switch", {
    name: "Show DMX",
    exact: true,
  });
  const wasChecked = await showDmx.isChecked();
  await fixtures.getByText("Show DMX", { exact: true }).click();
  await expect(showDmx).toBeChecked({ checked: !wasChecked });
  await fixtures.getByText("Show DMX", { exact: true }).click();
  await page.getByRole("tab", { name: "Groups", exact: true }).click();
  const groups = page.locator('[data-component="PanelToolbar"]').filter({
    has: page.getByRole("button", { name: "Add group", exact: true }),
  });
  await expectBottomDivider(groups);
  await page.screenshot({
    path: testInfo.outputPath("crud-bottom-dividers.png"),
  });

  await page.getByRole("tab", { name: "3D Visualizer", exact: true }).click();
  const visualizer = page.locator(
    '[data-component="PanelToolbar"][aria-label="Visualizer toolbar"]',
  );
  await expectBottomDivider(visualizer);
  await expect(visualizer).toHaveCSS(
    "border-bottom-color",
    await groups.evaluate(
      (element) => getComputedStyle(element).borderBottomColor,
    ),
  );
  const move = visualizer.getByRole("button", {
    name: "Move (M)",
    exact: true,
  });
  await move.click();
  await expect(move).toHaveAttribute("aria-pressed", "true");
  const camera = visualizer.getByRole("button", {
    name: "Camera (C)",
    exact: true,
  });
  await camera.click();
  await expect(camera).toHaveAttribute("aria-pressed", "true");
  await expect(move).toHaveAttribute("aria-pressed", "false");
  await visualizer
    .getByRole("button", { name: "Add fixture or object" })
    .click();
  await expect(
    page.getByRole("button", { name: "New Object", exact: true }),
  ).toBeVisible();
  await visualizer
    .getByRole("button", { name: "Add fixture or object" })
    .click();
  await expect(
    page.getByRole("button", { name: "New Object", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath("visualizer-bottom-divider.png"),
  });

  await page.setViewportSize({ width: 700, height: 800 });
  await expectBottomDivider(visualizer);
  await expect(camera).toBeInViewport();
  await expect(
    visualizer.getByRole("button", { name: /Grid.*\(G\)/ }),
  ).toBeInViewport();
  expect(
    await visualizer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("visualizer-toolbar-narrow.png"),
  });
});
