// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Opens a catalog demo in the left pane for interaction and visual inspection. */
async function openDemo(page: Page, title: string, region: string) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: new RegExp(title) })
    .click();
  const panel = page.getByRole("region", { name: region, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

/** Checks that each new example stays within its panel at a narrow viewport and captures that layout. */
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "passed") return;
  await page.setViewportSize({ width: 900, height: 1200 });
  const panel = page.getByRole("region", {
    name: /^(Alert|Badge|Switch|Fader|Attribute slider|Object selector|Inline rename|Sparkline|Tooltip) examples$/,
  });
  await panel.scrollIntoViewIfNeeded();
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: testInfo.outputPath("narrow.png"),
    animations: "disabled",
  });
});

/** Verifies paired production switches, keyboard focus, disabled states, and retained values. */
test("transport switches expose independent and disabled states", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Switches", "Switch examples");
  const input = panel.getByRole("switch", { name: "Art-Net input" });
  const output = panel.getByRole("switch", { name: "Art-Net output" });
  await expect(input).toBeChecked();
  await expect(output).not.toBeChecked();
  await input.focus();
  await input.press("Space");
  await expect(input).not.toBeChecked();
  await output.click();
  await expect(output).toBeChecked();
  await expect(
    panel.getByRole("switch", { name: "Unavailable input" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("switch", { name: "Unavailable input" }),
  ).toBeChecked();
  await expect(
    panel.getByRole("switch", { name: "Unavailable output" }),
  ).not.toBeChecked();
  await expect(
    panel.getByRole("switch", { name: "Unavailable output" }),
  ).toBeDisabled();
  await output.press("Shift+Tab");
  await expect(input).toBeFocused();
  await expect(panel.locator(".nf-switch-track").first()).toHaveCSS(
    "box-shadow",
    /^rgb\(.+\) 0px 0px 0px 1px$/,
  );
  await page.screenshot({
    path: testInfo.outputPath("switches.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Switches/ })
    .click();
  await expect(output).toBeChecked();
  await expect(
    page.getByRole("tab", { name: "Switches", exact: true }),
  ).toHaveCount(1);
});

/**
 * Verifies each switch layout places the switch where it promises: after the label, at the far
 * edge, alone, or before the label with inset content lining up under the label text.
 */
test("switch layouts place the switch around its label", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Switches", "Switch examples");
  const layouts = panel.getByTestId("switch-layouts");
  /** Returns the bounding boxes of a layout's label text and switch track. */
  const boxes = async (name: string) => {
    const row = layouts.locator("label.nf-switch", {
      has: page.getByRole("switch", { name }),
    });
    const track = await row.locator(".nf-switch-track").boundingBox();
    const label = row.locator(".nf-switch-label");
    return {
      row: await row.boundingBox(),
      track,
      label: (await label.count()) ? await label.boundingBox() : null,
    };
  };

  const right = await boxes("Switch right layout");
  expect(right.track!.x).toBeGreaterThan(right.label!.x + right.label!.width);

  const end = await boxes("Switch end layout");
  const card = await layouts.locator(".widget-switch-stack").boundingBox();
  expect(end.track!.x + end.track!.width).toBeCloseTo(card!.x + card!.width, 0);

  const only = await boxes("Switch only layout");
  expect(only.label).toBeNull();

  const left = await boxes("Switch left layout");
  expect(left.track!.x + left.track!.width).toBeLessThan(left.label!.x);
  const inset = await layouts
    .locator(".nf-switch-label-inset")
    .evaluate(
      (element) =>
        element.getBoundingClientRect().left +
        Number.parseFloat(getComputedStyle(element).paddingInlineStart),
    );
  expect(inset).toBeCloseTo(left.label!.x, 0);

  await layouts.screenshot({ path: testInfo.outputPath("switch-layouts.png") });
});

/**
 * Verifies settings rows put every control at the right edge, centered beside its title, with
 * the title labelling the control and the description describing it, except for action buttons,
 * which keep their own name.
 */
test("settings rows align controls to the right edge", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Switches", "Switch examples");
  const rows = panel.getByTestId("settings-rows");
  const right = await rows
    .locator(".nf-settings-rows")
    .evaluate((element) => element.getBoundingClientRect().right);
  const controls = [
    page.getByRole("switch", { name: "Settings row switch" }),
    page.getByRole("combobox", { name: "Settings row select" }),
    page.getByRole("button", { name: "Manage" }),
  ];
  for (const control of controls) {
    const row = rows.locator(".nf-settings-row", { has: control });
    await expect(row).toHaveCount(1);
    const slot = await row.locator(".nf-settings-row-control").boundingBox();
    const box = await row.boundingBox();
    expect(slot!.x + slot!.width).toBeCloseTo(right, 0);
    expect(slot!.y + slot!.height / 2).toBeCloseTo(box!.y + box!.height / 2, 0);
  }
  await expect(controls[0]).toHaveAccessibleDescription(
    /Title and explanation/,
  );
  await expect(controls[1]).toHaveAccessibleDescription(
    /size to their content/,
  );
  await expect(
    rows.locator(".nf-settings-rows > .nf-settings-row").nth(1),
  ).toHaveCSS("border-top-width", "1px");
  await rows.screenshot({ path: testInfo.outputPath("settings-rows.png") });
});

/** Checks keyboard and pointer fader changes, reference markers, reset, and initial or dynamic locks. */
test("vertical faders synchronize keyboard pointer and reset values", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Vertical faders", "Fader examples");
  const intensity = panel.getByRole("slider", { name: "Preview intensity" });
  await intensity.focus();
  await intensity.press("Home");
  await expect(panel.getByLabel("Intensity readout")).toHaveText("0%");
  await intensity.press("End");
  await expect(panel.getByLabel("Intensity readout")).toHaveText("100%");
  const speed = panel.getByRole("slider", { name: "Preview speed" });
  await speed.focus();
  await speed.press("Home");
  await speed.press("ArrowUp");
  await expect(panel.getByLabel("Speed readout")).toHaveText("5%");
  const track = panel.locator(".vertical-range-slider").first();
  const bounds = (await track.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(panel.getByLabel("Intensity readout")).toHaveText(
    /^(49|50|51)%$/,
  );
  await expect(panel.locator(".vertical-slider-value-marker")).toHaveCount(2);
  await expect(
    panel.getByRole("slider", { name: "Locked level" }),
  ).not.toHaveAttribute("tabindex", "0");
  await expect(panel.locator(".vertical-range-slider").last()).toHaveAttribute(
    "disabled",
    "",
  );
  await panel.getByRole("switch", { name: "Lock preview faders" }).click();
  await expect(track).toHaveAttribute("disabled", "");
  await panel.getByRole("switch", { name: "Lock preview faders" }).click();
  await expect(track).not.toHaveAttribute("disabled");
  await panel.getByRole("button", { name: "Reset levels" }).click();
  await expect(intensity).toHaveAttribute("aria-valuenow", "65.0");
  await expect(panel.getByLabel("Speed readout")).toHaveText("100%");
  await expect(panel.locator(".noUi-state-tap")).toHaveCount(0);
  const trackBounds = (await track.boundingBox())!;
  const handleBounds = (await intensity.boundingBox())!;
  const handlePosition =
    (handleBounds.y + handleBounds.height / 2 - trackBounds.y) /
    trackBounds.height;
  expect(handlePosition).toBeCloseTo(0.35, 1);
  await page.screenshot({
    path: testInfo.outputPath("faders.png"),
    fullPage: true,
  });
});

/** Exercises signed relative values, mode clamping, and the linked numeric and range controls. */
test("attribute sliders support relative adjustments and numeric commits", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(
    page,
    "Attribute sliders",
    "Attribute slider examples",
  );
  const value = panel.getByRole("spinbutton", { name: "Dimmer", exact: true });
  await panel.getByRole("button", { name: "Rel", exact: true }).click();
  await value.fill("-42");
  await value.press("Tab");
  await expect(
    panel.getByRole("slider", { name: "Dimmer", exact: true }),
  ).toHaveAttribute("aria-valuenow", "-42.0");
  await expect(panel.getByRole("status")).toContainText(
    "Last committed value: -42",
  );
  await page.screenshot({
    path: testInfo.outputPath("attribute-relative.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Abs", exact: true }).click();
  await expect(value).toHaveValue("0");
  await expect(
    panel.getByRole("button", { name: "Abs", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

/** Validates secondary-text search, keyboard selection, and empty-result feedback. */
test("object selectors filter and select local objects", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(
    page,
    "Object selector",
    "Object selector examples",
  );
  const search = panel.getByRole("textbox", { name: "Search sample objects" });
  await search.fill("wash");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(panel.getByRole("status")).toHaveText("Selected: Side wash");
  await search.fill("24 fixtures");
  await search.press("Enter");
  await expect(panel.getByRole("status")).toHaveText("Selected: House lights");
  await search.fill("unmatched");
  await expect(panel.getByText("No matching objects.")).toBeVisible();
  await search.fill("");
  await expect(
    panel.getByRole("button", { name: /House lights/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: testInfo.outputPath("object-selector.png"),
    fullPage: true,
  });
});

/** Verifies focus and selection on rename, committing by Enter or blur, and cancelling with Escape. */
test("inline rename commits or cancels its draft", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Inline rename", "Inline rename examples");
  const rename = panel.getByRole("button", { name: "Rename", exact: true });
  await rename.click();
  const input = panel.getByRole("textbox", { name: "Group name" });
  await expect(input).toBeFocused();
  await input.fill("Evening wash");
  await input.press("Enter");
  await expect(panel.getByRole("status")).toHaveText(
    "Saved name: Evening wash",
  );
  await rename.click();
  await input.fill("Discard me");
  await input.press("Escape");
  await expect(panel.getByRole("status")).toHaveText(
    "Saved name: Evening wash",
  );
  await rename.click();
  await input.fill("House wash");
  await panel.getByRole("heading").click();
  await expect(panel.getByRole("status")).toHaveText("Saved name: House wash");
  await rename.click();
  await page.screenshot({
    path: testInfo.outputPath("inline-rename.png"),
    fullPage: true,
  });
});

/** Checks every badge tone and appearance renders, and that count bubbles track, cap, and hide at zero. */
test("badges show tones, appearances and corner counts", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Badges", "Badge examples");
  for (const appearance of ["outline", "soft", "solid"]) {
    await expect(
      panel.locator(
        `[data-component="Badge"][data-appearance="${appearance}"][data-uppercase="true"]`,
      ),
    ).toHaveCount(appearance === "soft" ? 7 : 6);
  }
  const counts = panel.locator('[data-component="CountBadge"]');
  await expect(counts).toHaveText(["3", "3", "99+"]);
  const button = panel.getByRole("button", { name: "Delete selected" });
  const bubble = button.locator('[data-component="CountBadge"]');
  const buttonBox = await button.boundingBox();
  const bubbleBox = await bubble.boundingBox();
  expect(bubbleBox!.x + bubbleBox!.width).toBeGreaterThan(
    buttonBox!.x + buttonBox!.width,
  );
  expect(bubbleBox!.y).toBeLessThan(buttonBox!.y);
  await panel.screenshot({
    path: testInfo.outputPath("badges.png"),
    animations: "disabled",
  });
  for (let index = 0; index < 3; index += 1) {
    await panel.getByRole("button", { name: "Remove", exact: true }).click();
  }
  await expect(counts).toHaveCount(0);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(counts).toHaveText(["1", "1", "40"]);
});

/** Confirms sparse metric histories remain blank and flat histories produce a valid visible line. */
test("sparklines handle normal flat and missing histories", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Sparklines", "Sparkline examples");
  await expect(
    panel.getByRole("group", { name: "Frame time" }).locator("path"),
  ).toHaveAttribute("d", /^M /);
  await expect(
    panel.getByRole("group", { name: "Output rate" }).locator("path"),
  ).toHaveAttribute("d", /^M .* L /);
  await expect(
    panel.getByRole("group", { name: "New metric" }).locator("path"),
  ).toHaveAttribute("d", "");
  await expect(
    panel.getByRole("group", { name: "No samples" }).locator("path"),
  ).toHaveAttribute("d", "");
  await page.screenshot({
    path: testInfo.outputPath("sparklines.png"),
    fullPage: true,
  });
});

/** Exercises all tooltip placements, focus activation, wrapped text, and a reactive interactive action. */
test("tooltip catalog displays placements and interactive content", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Tooltips", "Tooltip examples");
  for (const position of ["top", "bottom", "left", "right"]) {
    await panel.getByRole("button", { name: position, exact: true }).focus();
    await expect(
      page.getByRole("tooltip").filter({ hasText: `${position} placement` }),
    ).toBeVisible();
  }
  await panel.getByRole("button", { name: "Long hint", exact: true }).focus();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "Keep the output" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("tooltip-long.png"),
    fullPage: true,
  });
  await panel
    .getByRole("button", { name: "Interactive hint", exact: true })
    .hover();
  const interactive = page
    .getByRole("tooltip")
    .filter({ hasText: "Preview count" });
  await expect(interactive).toBeVisible();
  await interactive.getByRole("button", { name: "Increment" }).click();
  await expect(interactive).toContainText("Preview count: 1");
  await expect(panel.getByRole("status")).toHaveText("Preview count: 1");
  await page.screenshot({
    path: testInfo.outputPath("tooltip-interactive.png"),
    fullPage: true,
  });
});

/** Verifies alert kinds, border placements, optional titles and icons, the exit transition and timed flashes, and captures the catalog. */
test("alerts render every kind with a distinct accent border", async ({
  page,
}, testInfo) => {
  const panel = await openDemo(page, "Alerts", "Alert examples");
  const alerts = panel.locator(".nf-alert");
  await expect(alerts).toHaveCount(12);
  const borders = await alerts.evaluateAll((elements) =>
    elements
      .slice(0, 5)
      .map((element) => getComputedStyle(element).borderInlineStartColor),
  );
  expect(new Set(borders).size).toBe(5);
  await expect(panel.locator(".nf-alert-title")).toHaveText([
    "Note",
    "Tip",
    "Important",
    "Warning",
    "Caution",
  ]);
  await expect(alerts.nth(7).locator(".nf-alert-icon")).toHaveCount(0);
  await expect(
    alerts.nth(4).getByRole("button", { name: "Delete sequence" }),
  ).toBeVisible();
  const borderWidths = await alerts.evaluateAll((elements) =>
    elements.slice(8, 11).map((element) => {
      const style = getComputedStyle(element);
      return [style.borderInlineStartWidth, style.borderBlockStartWidth];
    }),
  );
  expect(borderWidths).toEqual([
    ["4px", "0px"],
    ["0px", "4px"],
    ["0px", "0px"],
  ]);
  await panel.screenshot({
    path: testInfo.outputPath("alerts.png"),
    animations: "disabled",
  });

  const warning = panel.locator(".nf-alert", { hasText: "Slides in and out" });
  await expect(warning).toHaveCSS("animation-name", "enter");
  await panel.getByRole("button", { name: "Hide warning" }).click();
  await expect(warning).toHaveAttribute("data-state", "closed");
  await expect(warning).toHaveCount(0);
  await panel.getByRole("button", { name: "Show warning" }).click();
  await expect(warning).toBeVisible();

  const saved = panel.getByRole("alert").filter({ hasText: "Saved." });
  await expect(saved).toHaveCount(0);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved).toBeVisible();
  await panel.screenshot({
    path: testInfo.outputPath("alerts-flash.png"),
    animations: "disabled",
  });
  await expect(saved).toHaveCount(0, { timeout: 4000 });
});
