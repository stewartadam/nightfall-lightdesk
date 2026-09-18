// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Verifies tile geometry survives reflow and filtering, with tags contained at both densities. */
test("object tiles reflow without resizing and display tags", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.goto("/design-lab.html");
  const library = page.getByRole("region", { name: "Group library" });
  const tiles = library.locator(".object-tile");
  await expect(tiles).toHaveCount(6);
  const first = tiles.first();
  const original = (await first.boundingBox())!;
  expect(original.width).toBe(140);
  expect(original.height).toBe(60);
  const last = tiles.last();
  await expect.poll(async () => (await last.boundingBox())!.y).toBe(original.y);
  await expect(first.locator(".tile-tag")).toHaveText(["Wash", "Stage left"]);
  await expect(tiles.nth(2).locator(".tile-tag")).toHaveText(["Spots"]);
  await expect(tiles.nth(3).locator(".tile-tags")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("tiles-wide.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 900, height: 1200 });
  await expect
    .poll(
      async () =>
        (await last.boundingBox())!.y - (await first.boundingBox())!.y,
    )
    .toBeGreaterThan(0);
  await expect(first).toHaveCSS("width", `${original.width}px`);
  await expect(first).toHaveCSS("height", `${original.height}px`);
  await page.screenshot({
    path: testInfo.outputPath("tiles-reflow.png"),
    fullPage: true,
  });

  await page
    .getByRole("textbox", { name: "Search groups" })
    .fill("Bstrip 1 left");
  await expect(tiles).toHaveCount(1);
  await expect(first).toHaveCSS("width", `${original.width}px`);
  await expect(first).toHaveCSS("height", `${original.height}px`);
  await page.getByRole("textbox", { name: "Search groups" }).fill("");

  for (const density of ["Comfort", "Compact"]) {
    await page.getByRole("button", { name: density, exact: true }).click();
    for (const tab of ["Groups", "Flows"]) {
      await page
        .locator(".dv-tab")
        .filter({ hasText: new RegExp(`^${tab}$`) })
        .click();
      const tilePanel = page.getByRole("region", {
        name: tab === "Groups" ? "Group library" : "Flow library",
      });
      await expect(tilePanel).toBeVisible();
      const visibleTiles = tilePanel.locator(".object-tile");
      await expect(visibleTiles.first()).toBeVisible();
      await expect(visibleTiles.first()).toHaveCSS("width", "140px");
      await expect(visibleTiles.first()).toHaveCSS("height", "60px");
      await expect(visibleTiles.first().locator(".tile-tag").first()).toHaveCSS(
        "font-size",
        "8px",
      );
      const overflow = await visibleTiles.evaluateAll((elements) =>
        elements.some(
          (element) =>
            element.scrollWidth > element.clientWidth ||
            element.scrollHeight > element.clientHeight,
        ),
      );
      expect(overflow).toBe(false);
      await tilePanel.screenshot({
        path: testInfo.outputPath(`tiles-${tab}-${density}.png`),
      });
    }
  }
});

/** Exercises the standalone visual study without a native backend or live show. */
test("design lab supports styling, tiles, cue edits, and dock resizing", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await expect(
    page.getByRole("region", { name: "Interactive dock workspace" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page
          .getByRole("region", { name: "Group library" })
          .boundingBox())!.width,
    )
    .toBeGreaterThan(700);
  const tile = page.getByRole("button", { name: /GRP 17/ });
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  const properties = page.getByRole("region", { name: "Design properties" });
  await expect(
    properties.getByRole("button", { name: "Blue accent" }),
  ).toBeVisible();
  await expect(
    properties.getByRole("button", { name: "Compact", exact: true }),
  ).toBeVisible();
  await expect(
    properties.getByRole("button", { name: "Reset layout", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Data grid example" }),
  ).toHaveCount(0);
  const libraryBounds = (await page
    .getByRole("region", { name: "Group library" })
    .boundingBox())!;
  const propertiesBounds = (await properties.boundingBox())!;
  expect(propertiesBounds.x).toBeGreaterThan(
    libraryBounds.x + libraryBounds.width,
  );
  expect(propertiesBounds.y).toBeCloseTo(libraryBounds.y, 0);
  await page.screenshot({
    path: testInfo.outputPath("graphite-mint.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Blue accent" }).click();
  await expect(page.locator(".design-lab")).toHaveCSS("--accent", "#398bfa");
  const comfortHeight = (await tile.boundingBox())!.height;
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await expect(page.locator(".design-lab")).toHaveClass(/compact/);
  expect((await tile.boundingBox())!.height).toBeLessThan(comfortHeight * 0.78);
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  await page.getByRole("switch", { name: "Column guides" }).check();
  const grid = page.getByRole("grid");
  await expect(grid).toHaveAttribute("data-grid-model-row-count", "120");
  for (const [group, children] of [
    ["Cue details", ["Cue", "Label"]],
    ["Timing", ["Trigger", "Fade in", "Delay"]],
  ] as const) {
    const header = grid.getByRole("columnheader", { name: group, exact: true });
    await expect(header).toBeVisible();
    const bounds = (await header.boundingBox())!;
    const first = (await grid
      .getByRole("columnheader", { name: children[0], exact: true })
      .boundingBox())!;
    const last = (await grid
      .getByRole("columnheader", { name: children.at(-1)!, exact: true })
      .boundingBox())!;
    expect(bounds.x).toBeCloseTo(first.x, 0);
    expect(bounds.x + bounds.width).toBeCloseTo(last.x + last.width, 0);
    expect(Math.abs(bounds.y + bounds.height - first.y)).toBeLessThanOrEqual(1);
  }
  await expect(
    grid.getByRole("columnheader", { name: "Tracking", exact: true }),
  ).toBeVisible();
  await grid.screenshot({ path: testInfo.outputPath("grouped-columns.png") });
  const labelCell = grid.locator(
    '[data-grid-row-index="0"][data-grid-column-index="1"]',
  );
  await labelCell.dblclick();
  await expect(labelCell.locator("input")).toHaveCSS("outline-style", "none");
  await expect(labelCell.locator("input")).toHaveCSS("box-shadow", "none");
  await labelCell.screenshot({
    path: testInfo.outputPath("text-cell-editor.png"),
  });
  await labelCell.locator("input").fill("Opening blackout");
  await labelCell.locator("input").press("Enter");
  await expect(labelCell).toHaveText("Opening blackout");
  const designControls = page.getByRole("complementary", {
    name: "Design controls",
  });
  await expect(designControls.getByText("Tab position")).toHaveCount(0);
  await expect(designControls.getByText("Table structure")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Data grid example" })
      .getByRole("group", { name: "Table structure" })
      .getByRole("switch", { name: "Column guides" }),
  ).toBeChecked();
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Docking/ })
    .click();
  await page.getByRole("button", { name: "Bottom tabs", exact: true }).click();
  await page.getByRole("region", { name: "Docking examples" }).screenshot({
    path: testInfo.outputPath("docking-options.png"),
  });
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();

  const dataGridTab = page
    .locator(".dv-tab")
    .filter({ hasText: /^Data grid$/ });
  await expect
    .poll(async () => (await dataGridTab.boundingBox())!.y)
    .toBeGreaterThan((await grid.boundingBox())!.y);
  await expect(labelCell).toHaveText("Opening blackout");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Docking/ })
    .click();
  await page.getByRole("button", { name: "Top tabs", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  await expect
    .poll(async () => (await dataGridTab.boundingBox())!.y)
    .toBeLessThan((await grid.boundingBox())!.y);
  const fadeCell = grid.locator(
    '[data-grid-row-index="0"][data-grid-column-index="3"]',
  );
  await fadeCell.dblclick();
  await expect(fadeCell.locator("input")).toHaveCSS("outline-style", "none");
  await expect(fadeCell.locator("input")).toHaveCSS("box-shadow", "none");
  await expect(fadeCell.locator("input")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await fadeCell.screenshot({
    path: testInfo.outputPath("number-cell-editor.png"),
  });
  await fadeCell.locator("input").fill("4.5");
  await fadeCell.locator("input").press("Enter");
  await expect(fadeCell).toHaveText("4.5 s");
  const triggerCell = grid.locator(
    '[data-grid-row-index="0"][data-grid-column-index="2"]',
  );
  await triggerCell.dblclick();
  await page
    .locator(".nf-select-menu:visible")
    .getByText("Timecode", { exact: true })
    .click();
  await expect(triggerCell).toHaveText("Timecode");
  await triggerCell.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set trigger" }).hover();
  await page
    .getByRole("menuitem", { name: "After previous", exact: true })
    .click();
  await expect(triggerCell).toHaveText("After previous");
  await page.getByRole("button", { name: "Add cue" }).click();
  await expect(grid).toHaveAttribute("data-grid-model-row-count", "121");
  await expect(
    grid.locator('[data-grid-row-index="0"][data-grid-column-index="1"]'),
  ).toHaveText("Cue 121");
  await page
    .locator(".dv-tab")
    .filter({ hasText: /^Flows$/ })
    .click();
  await expect(
    page.getByRole("button", {
      name: /Metronome pulse with alternating accents/,
    }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search flows" }).fill("modulated");
  await expect(page.locator(".object-tile:visible")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search flows" }).fill("");
  await page.screenshot({
    path: testInfo.outputPath("graphite-blue-flows.png"),
    fullPage: true,
  });
  const sash = page
    .locator(".dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled")
    .first();
  const bounds = await sash.boundingBox();
  const before = await properties.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds!.x - 60, bounds!.y + bounds!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await properties.boundingBox())!.width)
    .toBeGreaterThan(before!.width + 30);
  await properties.getByRole("button", { name: "Reset layout" }).click();
  expect(errors).toEqual([]);
  await expect(
    page.getByRole("region", { name: "Data grid example" }),
  ).toHaveCount(0);
  await expect(
    properties.getByRole("button", { name: "Blue accent" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    properties.getByRole("button", { name: "Compact", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "Group library" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Selects/ })
    .click();
  await page.getByRole("button", { name: "Trigger mode", exact: true }).click();
  await page
    .locator(".nf-select-menu:visible")
    .getByText("Timecode", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Trigger mode", exact: true }),
  ).toContainText("Timecode");
  await expect(page.locator('select[aria-label="Fixture zones"]')).toHaveValues(
    ["left", "right"],
  );
  await page
    .getByRole("button", { name: "Fixture zones", exact: true })
    .click();
  await page
    .locator(".nf-select-menu:visible")
    .getByText("Downstage", { exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("multi-select.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".nf-select-menu:visible")).toHaveCount(0);
  await expect(
    page.getByText("3 zones selected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Context menus/ })
    .click();
  await page.getByRole("button", { name: "Object actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Send to live output" }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "Accent color" }).hover();
  await expect
    .poll(
      async () =>
        (await page
          .getByRole("region", { name: "Context menu examples" })
          .boundingBox())!.width,
    )
    .toBeGreaterThan(250);
  await page.screenshot({
    path: testInfo.outputPath("context-menu.png"),
    fullPage: true,
  });
  await page.getByRole("menuitem", { name: "Violet", exact: true }).click();
  await expect(page.locator("body")).toHaveCSS("--accent", "#b080ff");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  await grid.locator('[data-grid-kind="tanstack"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    grid.locator('[data-grid-row-index="119"][data-grid-column-index="1"]'),
  ).toBeVisible();
  expect(await grid.getByRole("gridcell").count()).toBeLessThan(120 * 6);
  expect(errors).toEqual([]);
});

/** Verifies the visible perimeter and single optional dividers of adjacent selected cells. */
test("adjacent selected cells share a perimeter and optional column guides", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Data grid/ })
    .click();
  const grid = page.getByRole("grid");
  /** Locates a logical cell without relying on virtualized DOM ordering. */
  const cell = (col: number, row: number) =>
    grid.locator(
      `[data-grid-row-index="${row}"][data-grid-column-index="${col}"]`,
    );
  await cell(1, 1).click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(cell(2, 2)).toHaveAttribute("data-selected", "true");
  await expect(cell(2, 2)).toHaveCSS("box-shadow", "none");
  await expect(cell(2, 2)).toHaveCSS("border-right-color", "rgba(0, 0, 0, 0)");
  await expect(cell(2, 2)).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  await expect(cell(1, 1)).toHaveCSS("background-origin", /border-box/);
  const topLeft = (await cell(1, 1).boundingBox())!;
  const nextColumn = (await cell(2, 1).boundingBox())!;
  const nextRow = (await cell(1, 2).boundingBox())!;
  const pixels = await page.screenshot();
  const joins = await page.evaluate(
    async ({ png, x, y, columnX, rowY }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [-1, 0, 1].flatMap((offset) => [
        Array.from(
          context.getImageData(
            Math.round(columnX) + offset,
            Math.round(y),
            1,
            1,
          ).data,
        ),
        Array.from(
          context.getImageData(Math.round(x), Math.round(rowY) + offset, 1, 1)
            .data,
        ),
      ]);
    },
    {
      png: pixels.toString("base64"),
      x: topLeft.x,
      y: topLeft.y,
      columnX: nextColumn.x,
      rowY: nextRow.y,
    },
  );
  for (const pixel of joins) expect(pixel).toEqual([84, 213, 180, 255]);
  await page.screenshot({
    path: testInfo.outputPath("selection-no-guides.png"),
    fullPage: true,
  });
  await page.getByRole("switch", { name: "Column guides" }).check();
  await expect(cell(2, 2)).toHaveCSS("box-shadow", "none");
  await expect(cell(2, 2)).toHaveCSS("border-right-width", "1px");
  await expect(cell(2, 2)).toHaveCSS("border-left-width", "0px");
  await expect(cell(2, 2)).toHaveCSS("border-top-width", "0px");
  await expect(cell(2, 2)).toHaveCSS(
    "border-right-color",
    "rgba(255, 255, 255, 0.094)",
  );
  await expect(cell(2, 2)).toHaveCSS(
    "border-bottom-color",
    "rgba(255, 255, 255, 0.094)",
  );
  await page.screenshot({
    path: testInfo.outputPath("selection-with-guides.png"),
    fullPage: true,
  });
});

/** Checks narrow-screen composition, full tile titles, and keyboard focus visibility. */
test("design lab remains usable on a narrow screen", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/design-lab.html");
  await expect(
    page.getByRole("region", { name: "Group library" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  const amber = page.getByRole("button", { name: "Amber accent" });
  await amber.focus();
  await page.keyboard.press("Enter");
  await expect(amber).toHaveAttribute("aria-pressed", "true");
  await expect(amber).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("narrow-amber.png"),
    fullPage: true,
  });
});

/** Verifies the catalog opens, focuses, and reopens component panels while range inputs and handles stay synchronized. */
test("component catalog preserves open demos and supports range sliders", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Data grid/ }).click();
  const dataGridTab = page
    .locator(".dv-tab")
    .filter({ hasText: /^Data grid$/ });
  await expect(dataGridTab).toHaveCount(1);
  await expect(dataGridTab).toHaveClass(/dv-active-tab/);
  await expect(
    page.getByRole("region", { name: "Data grid example" }),
  ).toBeVisible();
  await index.getByRole("button", { name: /Sliders/ }).click();
  const sliders = page.getByRole("region", { name: "Slider examples" });
  const lower = sliders.getByRole("spinbutton", {
    name: "Intensity minimum",
    exact: true,
  });
  const upper = sliders.getByRole("spinbutton", {
    name: "Intensity maximum",
    exact: true,
  });
  await lower.fill("30");
  await lower.press("Enter");
  await expect(
    sliders.getByRole("slider", { name: "Intensity minimum", exact: true }),
  ).toHaveAttribute("aria-valuenow", "30.0");
  await upper.fill("70");
  await upper.press("Tab");
  await sliders
    .getByRole("slider", { name: "Intensity maximum", exact: true })
    .press("ArrowRight");
  await expect(upper).toHaveValue("71");
  await lower.fill("95");
  await lower.press("Tab");
  await expect(lower).toHaveValue("71");
  const phase = sliders.getByRole("spinbutton", {
    name: "Phase minimum",
    exact: true,
  });
  await phase.fill("-45.5");
  await phase.press("Tab");
  await expect(phase).toHaveValue("-45.5");
  const amplitude = sliders.getByRole("spinbutton", {
    name: "Amplitude",
    exact: true,
  });
  await amplitude.fill("75");
  await amplitude.press("Enter");
  await expect(
    sliders.getByRole("slider", { name: "Amplitude", exact: true }),
  ).toHaveAttribute("aria-valuenow", "75.0");
  const handle = sliders.getByRole("slider", {
    name: "Phase maximum",
    exact: true,
  });
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds.x - 35, bounds.y + bounds.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  expect(
    Number(
      await sliders
        .getByRole("spinbutton", { name: "Phase maximum", exact: true })
        .inputValue(),
    ),
  ).toBeLessThan(90);
  await sliders.getByRole("switch", { name: "Disable sliders" }).check();
  await expect(lower).toBeDisabled();
  await sliders.getByRole("switch", { name: "Disable sliders" }).uncheck();
  await expect(
    sliders.locator(".range-slider.noUi-target.noUi-horizontal"),
  ).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath("slider-catalog.png"),
    fullPage: true,
  });
  await index.getByRole("button", { name: /Buttons/ }).click();
  await expect(
    page.getByRole("region", { name: "Button examples" }),
  ).toBeVisible();
  const buttons = page.getByRole("region", { name: "Button examples" });
  const apply = buttons.getByRole("button", { name: "Apply", exact: true });
  await apply.focus();
  await page.keyboard.down("Space");
  await expect(apply).toHaveCSS("filter", "brightness(0.82)");
  await expect(apply).toHaveCSS("transform", "matrix(0.98, 0, 0, 0.98, 0, 2)");
  await expect(apply).toHaveCSS("box-shadow", /inset/);
  await buttons.screenshot({
    path: testInfo.outputPath("button-depressed.png"),
  });
  await page.keyboard.up("Space");
  await expect(apply).toHaveCSS("transform", "none");
  await expect(apply).toHaveCSS("filter", "none");
  await expect(buttons.getByRole("status")).toHaveText(
    "Sample changes applied.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.down("Space");
  await expect(apply).toHaveCSS("filter", "brightness(0.82)");
  await expect(apply).toHaveCSS("transform", "none");
  await page.keyboard.up("Space");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await index.getByRole("button", { name: /Sliders/ }).click();
  await expect(lower).toHaveValue("71");
  const tab = page.locator(".dv-tab").filter({ hasText: /^Sliders$/ });
  await expect(tab).toHaveCount(1);
  await tab.locator(".dv-default-tab-action").click();
  await expect(sliders).toHaveCount(0);
  await index.getByRole("button", { name: /Sliders/ }).click();
  await expect(lower).toHaveValue("20");
  await index.getByRole("button", { name: /Docking/ }).click();
  await expect(
    page.getByRole("region", { name: "Docking examples" }),
  ).toBeVisible();
  await index.getByRole("button", { name: /Docking/ }).click();
  await expect(
    page.locator(".dv-tab").filter({ hasText: /^Docking$/ }),
  ).toHaveCount(1);
});

/** Checks submenu borders touch their parent when opening on either side of the viewport. */
test("context submenus meet their parent on the left and right", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Context menus/ })
    .click();
  const target = page.locator(".menu-demo-target");
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Accent color" }).hover();
  const root = page.locator('[data-menu-kind="context"]');
  const submenu = page
    .locator('[data-menu-kind="context-submenu"][aria-hidden="false"]')
    .first();
  const parentRight = (await root.boundingBox())!;
  const childRight = (await submenu.boundingBox())!;
  expect(childRight.x).toBeCloseTo(parentRight.x + parentRight.width - 1, 0);
  await page.screenshot({
    path: testInfo.outputPath("joined-context-menu.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 900, height: 1200 });
  const targetBounds = (await target.boundingBox())!;
  await target.click({
    button: "right",
    position: { x: targetBounds.width - 4, y: targetBounds.height / 2 },
  });
  await page.getByRole("menuitem", { name: "Accent color" }).hover();
  const parentLeft = (await root.boundingBox())!;
  const childLeft = (await submenu.boundingBox())!;
  expect(childLeft.x + childLeft.width).toBeCloseTo(parentLeft.x + 1, 0);
});

/** Exercises toolbar actions, exclusive modes, keyboard grouping tabs, transport, and selection-aware commands. */
test("toolbar catalog demonstrates shared action and toggle states", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Toolbars/ })
    .click();
  const panel = page.getByRole("region", { name: "Toolbar examples" });
  await expect(panel.locator('[data-component="PanelToolbar"]')).toHaveCount(5);
  await panel
    .getByRole("button", { name: "Add sample group", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("Sample group added.");
  await panel.getByRole("button", { name: "List view", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "List view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("button", { name: "Grid view", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  const listView = panel.getByRole("button", {
    name: "List view",
    exact: true,
  });
  await listView.hover();
  await page.mouse.down();
  await expect(listView).toHaveCSS("filter", "brightness(0.82)");
  await expect(listView).toHaveCSS(
    "transform",
    "matrix(0.98, 0, 0, 0.98, 0, 2)",
  );
  await expect(listView).toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await expect(listView).toHaveCSS("transform", "none");
  const modes = panel.getByRole("group", {
    name: "Interaction mode",
    exact: true,
  });
  await expect(
    modes.getByRole("button", { pressed: true }),
  ).toHaveAccessibleName("Camera");
  for (const name of ["Measure", "Move", "Rotate", "Select", "Camera"]) {
    const mode = modes.getByRole("button", { name, exact: true });
    await mode.click();
    await mode.click();
    await expect(modes.getByRole("button", { pressed: true })).toHaveCount(1);
    await expect(mode).toHaveAttribute("aria-pressed", "true");
    await expect(
      panel.getByText(`${name} mode`, { exact: true }),
    ).toBeVisible();
  }
  await modes.getByRole("button", { name: "Move", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(
    modes.getByRole("button", { pressed: true }),
  ).toHaveAccessibleName("Move");

  const tabs = panel.getByRole("tablist", { name: "Group by", exact: true });
  await expect(panel.getByRole("tabpanel")).toHaveAccessibleName("None");
  await tabs.getByRole("tab", { name: "Fixture", exact: true }).click();
  const bindings = panel.getByRole("tabpanel");
  await expect(bindings).toHaveAccessibleName("Fixture");
  await expect(bindings.getByRole("group")).toHaveCount(2);
  await expect(
    bindings.getByRole("group", { name: "Wash left" }),
  ).toContainText("Universe 2");
  await page.keyboard.press("ArrowRight");
  await expect(
    tabs.getByRole("tab", { name: "Universe", exact: true }),
  ).toBeFocused();
  await expect(bindings).toHaveAccessibleName("Universe");
  await expect(
    bindings.getByRole("group", { name: "Universe 1" }),
  ).toContainText("Wash right");
  await page.keyboard.press("ArrowRight");
  await expect(
    tabs.getByRole("tab", { name: "None", exact: true }),
  ).toBeFocused();
  await expect(bindings.getByRole("group")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(bindings).toHaveAccessibleName("Universe");
  await page.keyboard.press("Home");
  await expect(bindings).toHaveAccessibleName("None");
  await page.keyboard.press("End");
  await expect(bindings).toHaveAccessibleName("Universe");
  await expect(tabs.getByRole("tab", { selected: true })).toHaveCount(1);
  await panel
    .getByRole("group", { name: "Tool mode toolbar", exact: true })
    .screenshot({
      path: testInfo.outputPath("toolbar-radio-modes.png"),
    });
  await panel
    .getByRole("group", { name: "Grouping toolbar", exact: true })
    .screenshot({
      path: testInfo.outputPath("toolbar-grouping-tabs.png"),
    });
  await expect(
    panel.getByRole("button", { name: "Stop preview", exact: true }),
  ).toBeDisabled();
  const stop = panel.getByRole("button", { name: "Stop preview", exact: true });
  await stop.hover();
  await page.mouse.down();
  await expect(stop).toHaveCSS("transform", "none");
  await expect(stop).toHaveCSS("filter", "none");
  await page.mouse.up();
  await panel
    .getByRole("button", { name: "Play preview", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Stop preview", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Loop preview", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Stop preview", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Delete selected (2)", exact: true })
    .click();
  await expect(panel.getByText("0 selected", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /Delete selected/ }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Select sample rows" }).click();
  await page.screenshot({
    path: testInfo.outputPath("toolbars.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 1200 });
  await modes.scrollIntoViewIfNeeded();
  await expect(modes).toBeInViewport({ ratio: 1 });
  await tabs.scrollIntoViewIfNeeded();
  await expect(tabs).toBeInViewport({ ratio: 1 });
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("toolbars-narrow.png"),
    fullPage: true,
  });
});

/** Opens production dialogs and moves one stateful preview from a floating group into a separate window. */
test("popup catalog launches dialogs and a stateful Dockview popout", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Popups & popouts/ }).click();
  const panel = page.getByRole("region", { name: "Popup examples" });
  await panel.getByRole("button", { name: "Open editor dialog" }).click();
  const editor = page.getByRole("dialog", { name: "Edit sample group" });
  await editor
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Downstage wash");
  await page.screenshot({
    path: testInfo.outputPath("editor-popup.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Save sample" }).click();
  await expect(panel.getByRole("status")).toContainText("Downstage wash");
  await panel.getByRole("button", { name: "Open confirmation" }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete sample group?" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await panel.getByRole("button", { name: "Open floating panel" }).click();
  const note = page.getByRole("textbox", { name: "Preview note" });
  await note.fill("Keep this note");
  await index.getByRole("button", { name: /Popups & popouts/ }).click();
  const popupPromise = page.waitForEvent("popup");
  await panel.getByRole("button", { name: "Open pop-out window" }).click();
  const popup = await popupPromise;
  try {
    await expect(
      popup.getByRole("textbox", { name: "Preview note" }),
    ).toHaveValue("Keep this note");
    await expect(popup.locator("body")).toHaveCSS("color-scheme", "dark");
    await expect(popup.locator(".dv-tabs-and-actions-container")).toHaveCSS(
      "height",
      "34px",
    );
    await popup
      .getByRole("textbox", { name: "Preview note" })
      .fill("Edited in popout");
    await popup.screenshot({
      path: testInfo.outputPath("detached-window.png"),
    });
  } finally {
    await popup.close({ runBeforeUnload: true });
  }
  await expect(note).toHaveValue("Edited in popout");
  await page.getByRole("button", { name: "Close preview panel" }).click();
  expect(errors).toEqual([]);
});

/** Uses the production toast service to verify severity, literal message text, stacking, and dismissal. */
test("toast catalog emits and dismisses typed notifications", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Toasts/ })
    .click();
  const panel = page.getByRole("region", { name: "Toast examples" });
  await panel.getByRole("switch", { name: "Keep until dismissed" }).check();
  for (const name of ["Information", "Success", "Warning", "Error"])
    await panel.getByRole("button", { name, exact: true }).click();
  await expect(page.locator('[data-component="Toast"]')).toHaveCount(4);
  for (const level of ["info", "success", "warning", "error"])
    await expect(
      page.locator(`[data-component="Toast"][data-level="${level}"]`),
    ).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("toast-spectrum.png"),
    fullPage: true,
  });
  for (const level of ["info", "success", "warning", "error"])
    await page
      .locator(`[data-component="Toast"][data-level="${level}"]`)
      .getByRole("button", { name: "Close", exact: true })
      .click();
  await expect(page.locator('[data-component="Toast"]')).toHaveCount(0);
  await panel
    .getByRole("textbox", { name: "Custom message" })
    .fill("<sample> & ready");
  await panel.getByRole("switch", { name: "Keep until dismissed" }).uncheck();
  await panel.getByRole("button", { name: "Success", exact: true }).click();
  await expect(page.locator('[data-component="Toast"]')).toContainText(
    "<sample> & ready",
  );
  await expect(page.locator('[data-component="Toast"]')).toHaveCount(0, {
    timeout: 6500,
  });
  await panel.getByRole("button", { name: "Show undo toast" }).click();
  const undoToast = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Sample cue removed." });
  const undo = undoToast.getByRole("button", { name: "Undo", exact: true });
  await undo.focus();
  await undo.press("Enter");
  await expect(panel.getByRole("status")).toHaveText("Sample cue restored.");
  await expect(undoToast).toHaveCount(0);
  await panel.getByRole("button", { name: "Show retry toast" }).click();
  const retryToast = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Sample export failed." });
  await retryToast
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Sample details: destination unavailable.",
  );
  await expect(retryToast).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("toast-actions.png"),
    fullPage: true,
  });
  await retryToast.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Sample export retried.");
  await expect(retryToast).toHaveCount(0);
  await panel.getByRole("button", { name: "Show notification prompt" }).click();
  const prompt = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "App notifications" });
  await expect(prompt.locator(".toast-title")).toHaveText("App notifications");
  await expect(prompt.locator(".toast-icon svg")).toBeVisible();
  const allow = prompt.getByRole("button", { name: "Allow", exact: true });
  await expect(allow).toHaveCSS("font-size", "12px");
  await expect(allow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await prompt.screenshot({
    path: testInfo.outputPath("toast-notification.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(prompt).toBeInViewport({ ratio: 1 });
  await expect(allow).toBeInViewport({ ratio: 1 });
  await prompt.screenshot({
    path: testInfo.outputPath("toast-notification-narrow.png"),
  });
  await allow.focus();
  await allow.press("Enter");
  await expect(prompt).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText(
    "Sample notifications allowed.",
  );
});
