// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Exercises the shared picker's canvas modes, keyboard presets, brightness, readouts, and controlled reset. */
test("color picker catalog previews local colors in both shapes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const openPicker = page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Color picker/ });
  await openPicker.click();
  const panel = page.getByRole("region", { name: "Color picker examples" });
  const hex = panel.getByLabel("Selected hex color");
  await expect(hex).toHaveText("#54D5B4");
  await panel
    .getByRole("button", { name: "Choose #FF0000", exact: true })
    .click();
  await expect(hex).toHaveText("#FF0000");
  const blue = panel.getByRole("button", {
    name: "Choose #0000FF",
    exact: true,
  });
  await blue.focus();
  await blue.press("Enter");
  await expect(hex).toHaveText("#0000FF");
  const brightness = panel.getByRole("slider", { name: "Color brightness" });
  await brightness.focus();
  await brightness.press("Home");
  await expect(hex).toHaveText("#000000");
  await brightness.press("End");
  await expect(hex).toHaveText("#0000FF");
  const canvas = panel.locator("canvas");
  await canvas.click({ position: { x: 128, y: 96 } });
  await expect(hex).not.toHaveText("#0000FF");
  await expect(
    panel.getByRole("tabpanel", { name: "RGB", exact: true }),
  ).toContainText(await hex.innerText());
  await page.screenshot({
    path: testInfo.outputPath("color-picker-square.png"),
    fullPage: true,
  });
  await panel.getByRole("tab", { name: "HSV", exact: true }).click();
  await expect(
    panel.getByRole("tabpanel", { name: "HSV", exact: true }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "HSV", exact: true }).press("ArrowLeft");
  await expect(
    panel.getByRole("tab", { name: "RGB", exact: true }),
  ).toBeFocused();
  await expect(
    panel.getByRole("tabpanel", { name: "RGB", exact: true }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "RGB", exact: true }).press("End");
  await expect(
    panel.getByRole("tab", { name: "HSV", exact: true }),
  ).toBeFocused();
  await panel.getByRole("button", { name: "circle", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "circle", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  const centerColor = (await hex.innerText()).slice(1);
  for (const channel of centerColor.match(/.{2}/g)!) {
    expect(Number.parseInt(channel, 16)).toBeGreaterThanOrEqual(250);
  }
  await page.screenshot({
    path: testInfo.outputPath("color-picker-circle.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Reset color" }).click();
  await expect(hex).toHaveText("#54D5B4");
  await openPicker.click();
  await expect(
    page.getByRole("tab", { name: "Color picker", exact: true }),
  ).toHaveCount(1);
  await expect(hex).toHaveText("#54D5B4");
  await page.setViewportSize({ width: 900, height: 1200 });
  await expect(canvas).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("color-picker-narrow.png"),
    fullPage: true,
  });
});
