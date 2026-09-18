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
    name: /^(Switch|Fader|Attribute slider|Object selector|Inline rename|Sparkline|Tooltip) examples$/,
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
  const value = panel.getByRole("spinbutton", { name: "Dimmer value" });
  await panel.getByRole("button", { name: "Rel", exact: true }).click();
  await value.fill("-42");
  await value.press("Tab");
  await expect(
    panel.getByRole("slider", { name: "Dimmer", exact: true }),
  ).toHaveValue("-42");
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
