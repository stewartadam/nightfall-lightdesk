// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Checks production canvas fills at empty, partial, and complete states and exercises local playback controls. */
test("progress table renders background bars and controls sample playback", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const panel = page.getByRole("region", { name: "Data grid example" });
  const progressTab = panel.getByRole("tab", {
    name: "Progress bars",
    exact: true,
  });
  await progressTab.click();
  const grid = panel.getByRole("grid");
  await expect(grid).toHaveAttribute("data-grid-model-row-count", "5");
  const time = panel.getByRole("spinbutton", {
    name: "Preview time",
    exact: true,
  });
  await expect(time).toHaveValue("2.5");
  /** Samples fill opacity above the value text in a production rich-time canvas. */
  const fillAt = async (row: number, fraction: number) =>
    grid
      .locator(
        `[data-grid-row-index="${row}"][data-grid-column-index="2"] canvas`,
      )
      .evaluate((canvas: HTMLCanvasElement, fraction) => {
        const context = canvas.getContext("2d")!;
        return context.getImageData(
          Math.floor(canvas.width * fraction),
          3,
          1,
          1,
        ).data[3];
      }, fraction);
  await expect.poll(() => fillAt(0, 0.25)).toBeGreaterThan(0);
  expect(await fillAt(0, 0.75)).toBe(0);
  expect(await fillAt(1, 0.25)).toBe(0);
  expect(await fillAt(2, 0.75)).toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("progress-bars-partial.png"),
    fullPage: true,
  });
  await time.fill("8");
  await time.press("Enter");
  await expect.poll(() => fillAt(0, 0.75)).toBeGreaterThan(0);
  await expect(panel.getByRole("status")).toHaveText("Complete · 8.0 / 8.0 s");
  await panel
    .getByRole("button", { name: "Reset preview", exact: true })
    .click();
  await expect.poll(() => fillAt(0, 0.25)).toBe(0);
  await panel
    .getByRole("button", { name: "Play preview", exact: true })
    .click();
  await expect
    .poll(async () => Number(await time.inputValue()))
    .toBeGreaterThan(0);
  await panel
    .getByRole("button", { name: "Pause preview", exact: true })
    .click();
  const paused = await time.inputValue();
  await page.waitForTimeout(150);
  await expect(time).toHaveValue(paused);
  await panel
    .getByRole("button", { name: "Play preview", exact: true })
    .click();
  await panel
    .getByRole("tab", { name: "Read-only status", exact: true })
    .click();
  await progressTab.click();
  await expect(
    panel.getByRole("button", { name: "Play preview", exact: true }),
  ).toBeVisible();
  const hiddenPause = await time.inputValue();
  await page.waitForTimeout(150);
  await expect(time).toHaveValue(hiddenPause);
  await time.fill("7.8");
  await time.press("Enter");
  await panel
    .getByRole("button", { name: "Play preview", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("Complete · 8.0 / 8.0 s");
  await expect(
    panel.getByRole("button", { name: "Play preview", exact: true }),
  ).toBeVisible();
});

/** Checks progress fills redraw at compact density and the tab/controls fit narrow panels. */
test("progress table stays usable at compact and narrow sizes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const panel = page.getByRole("region", { name: "Data grid example" });
  await panel.getByRole("tab", { name: "Progress bars", exact: true }).click();
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await panel
    .getByRole("button", { name: "Reset preview", exact: true })
    .click();
  const time = panel.getByRole("spinbutton", {
    name: "Preview time",
    exact: true,
  });
  await time.fill("4");
  await time.press("Enter");
  await expect(panel.getByRole("status")).toHaveText("Paused · 4.0 / 8.0 s");
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("progress-bars-narrow.png"),
    fullPage: true,
  });
});
