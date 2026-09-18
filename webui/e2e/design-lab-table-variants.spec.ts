// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Exercises numeric sorting, stable selected rows, copy and keyboard resizing on the live shared grid. */
test("read-only grid sorts numeric values and preserves selected source identity", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const panel = page.getByRole("region", { name: "Data grid example" });
  await panel.getByRole("tab", { name: "Read-only status" }).click();
  const grid = panel.getByRole("grid", { name: "Timecode source status" });
  const source = grid.getByRole("gridcell", { name: "Main show", exact: true });
  await source.click();
  const idHeader = grid.getByRole("columnheader", { name: "ID", exact: true });
  await idHeader.click();
  await expect(idHeader).toHaveAttribute("aria-sort", "ascending");
  await idHeader.press("Enter");
  await expect(idHeader).toHaveAttribute("aria-sort", "descending");
  await expect(
    grid.locator('[data-grid-row-index="0"][data-grid-column-index="0"]'),
  ).toHaveText("24");
  await expect(grid).toHaveAttribute("data-selection-range", "1,23,1,1");
  const copied = await grid.evaluate((element) => {
    const data = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: data, bubbles: true }),
    );
    return data.getData("text/plain");
  });
  expect(copied).toBe("Main show");
  await expect(
    panel.getByText("Main show selected", { exact: true }),
  ).toBeVisible();
  await idHeader.press("Space");
  await expect(idHeader).toHaveAttribute("aria-sort", "none");
  await expect(grid).toHaveAttribute("data-selection-range", "1,0,1,1");
  const sourceHeader = grid.getByRole("columnheader", {
    name: "Source",
    exact: true,
  });
  await sourceHeader.click();
  await expect(sourceHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(
    grid.locator('[data-grid-row-index="0"][data-grid-column-index="1"]'),
  ).toHaveText("Backup clock");
  await expect(
    panel.getByText("Main show selected", { exact: true }),
  ).toBeVisible();
  await sourceHeader.click();
  await sourceHeader.click();
  await expect(sourceHeader).toHaveAttribute("aria-sort", "none");
  const clock = grid.locator(
    '[data-grid-row-index="0"][data-grid-column-index="2"]',
  );
  const previousClock = await clock.textContent();
  await expect(clock).not.toHaveText(previousClock!);
  await expect(grid).toHaveAttribute("data-selection-range", "1,0,1,1");
  const resize = grid.getByRole("separator", {
    name: "Resize Source",
    exact: true,
  });
  const width = Number(await resize.getAttribute("aria-valuenow"));
  await resize.focus();
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", String(width + 10));
  await resize.dblclick();
  await expect
    .poll(async () => Number(await resize.getAttribute("aria-valuenow")))
    .not.toBe(width + 10);
  await expect(grid).toHaveAttribute("data-selection-range", "1,0,1,1");
  await resize.press("Home");
  await expect(resize).toHaveAttribute("aria-valuenow", String(width));
  await expect(
    grid.getByRole("columnheader", { name: "Source", exact: true }),
  ).toHaveAttribute("aria-sort", "none");
  await page.screenshot({
    path: testInfo.outputPath("read-only-sorting.png"),
    fullPage: true,
  });
});

/** Verifies content tabs preserve cue edits while the monitoring variant uses the production read-only grid. */
test("data table variants preserve edits and expose read-only status", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const panel = page.getByRole("region", { name: "Data grid example" });
  const editable = panel.getByRole("tab", {
    name: "Editable cues",
    exact: true,
  });
  const readonly = panel.getByRole("tab", {
    name: "Read-only status",
    exact: true,
  });
  await expect(editable).toHaveAttribute("aria-selected", "true");
  const cue = panel
    .getByRole("grid")
    .locator('[data-grid-row-index="0"][data-grid-column-index="1"]');
  await cue.dblclick();
  await cue.locator("input").fill("Keep this cue edit");
  await cue.locator("input").press("Enter");
  await readonly.click();
  await expect(readonly).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("grid")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Add cue" })).toHaveCount(0);
  const table = panel.getByRole("grid", { name: "Timecode source status" });
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("aria-readonly", "true");
  await expect(table).toHaveAttribute("data-grid-model-row-count", "24");
  await expect(table.getByRole("columnheader")).toHaveText([
    /^ID/,
    /^Source/,
    /^Timecode/,
    /^Rate/,
    /^Status/,
  ]);
  const source = table.getByRole("gridcell", {
    name: "Main show",
    exact: true,
  });
  await source.dblclick();
  await page.keyboard.press("Enter");
  await expect(source).toHaveText("Main show");
  await expect(
    table.locator("input, textarea, [contenteditable=true]"),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("read-only-status.png"),
    fullPage: true,
  });
  await readonly.focus();
  await readonly.press("ArrowLeft");
  await expect(editable).toBeFocused();
  await expect(cue).toHaveText("Keep this cue edit");
  await editable.press("End");
  const progress = panel.getByRole("tab", {
    name: "Progress bars",
    exact: true,
  });
  await expect(progress).toBeFocused();
  await progress.press("ArrowLeft");
  await expect(readonly).toBeFocused();
  await expect(table).toBeVisible();
  const rowHeight = (await source.boundingBox())!.height;
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  expect((await source.boundingBox())!.height).toBeLessThan(rowHeight);
  await page.getByRole("switch", { name: "Column guides" }).check();
  await expect(table).toHaveAttribute("data-column-guides", "true");
  await expect(
    table.getByRole("columnheader", { name: "ID", exact: true }),
  ).toHaveCSS("border-right-width", "1px");
  await page.setViewportSize({ width: 1800, height: 500 });
  const scroller = panel
    .getByRole("grid", { name: "Timecode source status" })
    .locator("[data-grid-kind]");
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    )
    .toBeGreaterThan(0);
  await table.focus();
  await table.press("Control+End");
  await expect
    .poll(async () => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

/** Checks the read-only grid scrolls inside a narrow panel without widening the workspace. */
test("read-only table fits narrow panel with horizontal scrolling", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const panel = page.getByRole("region", { name: "Data grid example" });
  await panel.getByRole("tab", { name: "Read-only status" }).click();
  const scroller = panel
    .getByRole("grid", { name: "Timecode source status" })
    .locator("[data-grid-kind]");
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await scroller.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(
    panel.getByRole("columnheader", { name: "Status", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("read-only-status-narrow.png"),
    fullPage: true,
  });
});

/** Shares one cell-owned focus perimeter for text and numeric editors in the lab. */
test("inline grid editors use the cell selection perimeter", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const grid = page.getByRole("grid");
  for (const column of [1, 3]) {
    const cell = grid.locator(
      `[data-grid-row-index="0"][data-grid-column-index="${column}"]`,
    );
    await cell.dblclick();
    const editor = cell.locator("input");
    await expect(editor).toBeFocused();
    await editor.press("ControlOrMeta+A");
    await expect(editor).toHaveCSS("box-shadow", "none");
    await expect(editor).toHaveCSS("outline-style", "none");
    await expect(cell).toHaveCSS("background-image", /linear-gradient/);
    await cell.screenshot({
      path: testInfo.outputPath(`lab-editor-${column}.png`),
    });
    await editor.press("Escape");
  }
});
