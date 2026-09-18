// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Exercises the real palette's search, command execution, keyboard navigation, and empty-state dismissal. */
test("command palette panel launches working lab commands", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Command palette/ }).click();
  const panel = page.getByRole("region", { name: "Command palette examples" });
  const launch = panel.getByRole("button", {
    name: "Open command palette",
    exact: true,
  });
  await launch.click();
  const palette = page.locator('[data-dialog-kind="command-palette"]');
  const search = palette.getByPlaceholder("Type a command or search...");
  await expect(search).toBeFocused();
  await expect(
    palette.locator('[data-command-id="design-lab.open.input-forms"]'),
  ).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("command-palette.png"),
    fullPage: true,
  });
  const field = palette.locator(".nf-search-picker-field");
  const iconBox = await field.locator("svg").first().boundingBox();
  const inputBox = await search.boundingBox();
  expect(iconBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(
    Math.abs(
      iconBox!.y + iconBox!.height / 2 - inputBox!.y - inputBox!.height / 2,
    ),
  ).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 720 });
  const surfaceBox = await palette.locator(".nf-search-picker").boundingBox();
  expect(surfaceBox).not.toBeNull();
  expect(surfaceBox!.x).toBeGreaterThanOrEqual(0);
  expect(surfaceBox!.x + surfaceBox!.width).toBeLessThanOrEqual(390);
  expect(surfaceBox!.y + surfaceBox!.height).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("shared-palette-narrow.png"),
  });
  await page.setViewportSize({ width: 1600, height: 1200 });
  await search.fill("input forms");
  await search.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Input form examples" }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(search).toBeFocused();
  await search.fill("no matching command xyz");
  await expect(
    palette.getByText("No commands found", { exact: true }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(palette).toHaveCount(0);
  await index.getByRole("button", { name: /Command palette/ }).click();
  await launch.click();
  await search.fill("density");
  await search.press("Enter");
  await expect(page.locator(".design-lab")).toHaveClass(/compact/);
  await launch.click();
  await search.fill("Open");
  const firstSelected = await palette
    .locator('[data-selected="true"]')
    .getAttribute("data-command-id");
  await search.press("ArrowDown");
  await expect(palette.locator('[data-selected="true"]')).not.toHaveAttribute(
    "data-command-id",
    firstSelected!,
  );
  await search.press("Escape");
  expect(errors).toEqual([]);
});

/** Checks registered shortcuts, editable-field protection, and narrow palette layout. */
test("shortcuts panel demonstrates live bindings", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Shortcuts/ })
    .click();
  const panel = page.getByRole("region", { name: "Shortcut examples" });
  await expect(panel.getByText("Undo", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Redo", { exact: true })).toHaveCount(0);
  await expect(
    panel.getByText("Open command palette", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Toggle Comfort / Compact density", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("status")).toContainText("Comfort density");
  await page.keyboard.press("Alt+Shift+D");
  await expect(panel.getByRole("status")).toContainText("Compact density");
  const accentBefore = await panel.getByRole("status").textContent();
  await page.keyboard.press("Alt+Shift+C");
  await expect(panel.getByRole("status")).not.toHaveText(accentBefore!);
  await page.screenshot({
    path: testInfo.outputPath("shortcuts-panel.png"),
    fullPage: true,
  });
  const practice = panel.getByRole("textbox", { name: "Typing practice" });
  await practice.fill("Keep this note");
  await practice.press("Alt+Shift+D");
  await expect(panel.getByRole("status")).toContainText("Compact density");
  await practice.press("ControlOrMeta+Shift+P");
  const palette = page.locator('[data-dialog-kind="command-palette"]');
  const search = palette.getByPlaceholder("Type a command or search...");
  await expect(search).toBeFocused();
  await page.setViewportSize({ width: 390, height: 800 });
  await search.fill("shortcuts");
  const bounds = (await palette.locator(":scope > div").boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
  await page.screenshot({
    path: testInfo.outputPath("command-palette-narrow.png"),
  });
  await search.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(practice).toHaveValue("Keep this note");
  await expect(
    page.locator(".dv-tab").filter({ hasText: /^Shortcuts$/ }),
  ).toHaveCount(1);
});
