// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

const REST_BACKGROUND = "rgb(32, 35, 37)";
const REST_BORDER = "rgb(55, 62, 64)";
const HOVER_BACKGROUND = "rgb(41, 46, 48)";
const HOVER_BORDER = "rgb(101, 113, 110)";
const ACCENT = "rgb(84, 213, 180)";

/**
 * Walks a pair of adjacent selectable surfaces through rest, hover, selected
 * and keyboard focus, asserting the shared colors and capturing each state of
 * the surrounding container.
 */
async function exerciseSelectableSurface(
  page: Page,
  testInfo: TestInfo,
  container: Locator,
  first: Locator,
  second: Locator,
  prefix: string,
) {
  await page.mouse.move(0, 0);
  await expect(first).toHaveAttribute("data-selectable-surface");
  await expect(first).toHaveAttribute("data-selected", "false");
  await expect(first).toHaveCSS("background-color", REST_BACKGROUND);
  await expect(first).toHaveCSS("border-top-color", REST_BORDER);
  await container.screenshot({
    path: testInfo.outputPath(`${prefix}-1-normal.png`),
  });

  await first.hover();
  await expect(first).toHaveCSS("background-color", HOVER_BACKGROUND);
  await expect(first).toHaveCSS("border-top-color", HOVER_BORDER);
  await container.screenshot({
    path: testInfo.outputPath(`${prefix}-2-hover.png`),
  });

  await first.click();
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(first).toHaveCSS("border-top-color", ACCENT);
  await expect(first).toHaveCSS(
    "box-shadow",
    `${ACCENT} 3px 0px 0px 0px inset`,
  );
  await page.mouse.move(0, 0);
  await expect(first).toHaveCSS("border-top-color", ACCENT);
  await container.screenshot({
    path: testInfo.outputPath(`${prefix}-3-selected.png`),
  });

  await page.keyboard.press("Tab");
  await expect(second).toBeFocused();
  await expect(second).toHaveCSS("outline-style", "solid");
  await expect(second).toHaveCSS("outline-color", ACCENT);
  await expect(second).toHaveCSS("background-color", REST_BACKGROUND);
  await container.screenshot({
    path: testInfo.outputPath(`${prefix}-4-keyboard-focus.png`),
  });
}

/** Verifies design lab object tiles render the shared selectable surface states through the shared Button. */
test("object tiles use the shared selectable surface", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.goto("/design-lab.html");
  const library = page.getByRole("region", { name: "Group library" });
  const tiles = library.locator(".object-tile");
  await expect(tiles.first()).toBeVisible();
  // The lab may preselect tiles; start from two adjacent unselected tiles.
  const states = await tiles.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-selected")),
  );
  const start = states.findIndex(
    (state, index) => state === "false" && states[index + 1] === "false",
  );
  expect(start).toBeGreaterThanOrEqual(0);
  await exerciseSelectableSurface(
    page,
    testInfo,
    library,
    tiles.nth(start),
    tiles.nth(start + 1),
    "object-tile",
  );
});

/** Verifies CRUD panel cards render the same selectable surface states as object tiles. */
test("CRUD cards use the shared selectable surface", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  const groupsPanel = page.locator('[data-panel-id="panel-Groups"]:visible');
  const cards = groupsPanel.locator(".nf-crud-card");
  await expect(cards.nth(1)).toBeVisible();
  await groupsPanel
    .getByRole("button", { name: "Toggle selection mode", exact: true })
    .click();
  await exerciseSelectableSurface(
    page,
    testInfo,
    cards.first().locator(".."),
    cards.nth(0),
    cards.nth(1),
    "crud-card",
  );
});
