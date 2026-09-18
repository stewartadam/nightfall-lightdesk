// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads a rendered CSS color in sRGB so relative colors can be compared by channel. */
async function renderedColor(element: Locator, property = "color") {
  return element.evaluate((target, cssProperty) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(target).getPropertyValue(cssProperty);
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }, property);
}

/** Requires a visible neutral accent rather than a transparent or missing color. */
async function expectGreyAccent(element: Locator, property = "color") {
  await expect
    .poll(async () => {
      const channels = await renderedColor(element, property);
      return Math.max(...channels) - Math.min(...channels);
    })
    .toBeLessThanOrEqual(1);
  expect((await renderedColor(element, property))[0]).toBeGreaterThan(80);
}

/** Opens app appearance settings through the normal keyboard shortcut. */
async function openAppearance(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
  return dialog;
}

/** Verifies the screenshot's visualizer example, focus changes, live color updates, persistence, and opting out. */
test("app mutes only unfocused panel accents when enabled", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const camera = page.getByRole("button", { name: "Camera (C)", exact: true });
  await expect(camera).toBeVisible();
  let dialog = await openAppearance(page);
  const setting = dialog.getByLabel("Mute accents in unfocused panels");
  await expect(setting).not.toBeChecked();
  await dialog.getByRole("button", { name: "Orange accent" }).click();
  await setting.check();
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "3D Visualizer", exact: true }).click();
  await expect(camera).toHaveCSS("color", "rgb(251, 146, 60)");
  const activeBackground = await renderedColor(camera, "background-color");
  await page.getByRole("tab", { name: "Cues", exact: true }).click();
  await expectGreyAccent(camera);
  expect(await renderedColor(camera, "background-color")).not.toEqual(
    activeBackground,
  );
  // The scene keeps its colors; only accent tokens change.
  const canvas = page.locator("canvas").filter({ visible: true }).first();
  expect(
    await canvas.evaluate((element) => {
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      )
        if (getComputedStyle(current).filter !== "none") return false;
      return true;
    }),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("visualizer-unfocused.png"),
  });
  await camera.click();
  await expect(camera).toHaveCSS("color", "rgb(251, 146, 60)");
  await page.screenshot({
    path: testInfo.outputPath("visualizer-focused.png"),
  });

  dialog = await openAppearance(page);
  await dialog.getByRole("button", { name: "Violet accent" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Cues", exact: true }).click();
  await expectGreyAccent(camera);
  await page.reload();
  await waitForDockviewApp(page);
  dialog = await openAppearance(page);
  await expect(
    dialog.getByLabel("Mute accents in unfocused panels"),
  ).toBeChecked();
  await dialog.getByLabel("Mute accents in unfocused panels").uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Cues", exact: true }).click();
  await expect(camera).toHaveCSS("color", "rgb(176, 128, 255)");
});

/** Previews muted selections and controls while preserving the accent picker's literal swatch colors. */
test("design lab follows panel focus for muted accents", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/design-lab.html");
  const properties = page.getByRole("region", { name: "Design properties" });
  await properties
    .getByRole("switch", { name: "Mute accents in unfocused panels" })
    .check();
  const tile = page.getByRole("button", { name: /GRP 04 / });
  await expectGreyAccent(tile, "border-left-color");
  const mutedBackground = await renderedColor(tile, "background-color");
  await tile.click();
  await page.mouse.move(10, 10);
  await expect(tile).toHaveCSS("border-left-color", "rgb(84, 213, 180)");
  expect(await renderedColor(tile, "background-color")).not.toEqual(
    mutedBackground,
  );
  const track = properties.locator(".nf-switch-track").first();
  await expectGreyAccent(track, "background-color");
  const swatch = properties
    .getByRole("button", { name: "Orange accent" })
    .locator("span");
  await expect(swatch).toHaveCSS("background-color", "rgb(251, 146, 60)");
  await page.screenshot({
    path: testInfo.outputPath("lab-muted-properties.png"),
  });
  await properties.getByRole("button", { name: "Orange accent" }).click();
  await expectGreyAccent(tile, "border-left-color");
  await page.screenshot({
    path: testInfo.outputPath("lab-muted-selection.png"),
  });
  await properties
    .getByRole("switch", { name: "Mute accents in unfocused panels" })
    .uncheck();
  await expect(tile).toHaveCSS("border-left-color", "rgb(251, 146, 60)");
});
