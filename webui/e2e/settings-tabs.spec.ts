// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/**
 * Checks category content and pointer and Up/Down keyboard selection in the vertical sidebar on
 * wide screens, then the horizontal strip that replaces it on narrow screens.
 */
test("settings segmented tabs support pointer and keyboard navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const tablist = dialog.getByRole("tablist", { name: "Settings categories" });
  await expect(tablist.getByRole("tab")).toHaveCount(7);
  await expect(tablist).toHaveAttribute("aria-orientation", "vertical");
  const content = dialog.getByRole("tabpanel");
  const [list, panel] = await Promise.all([
    tablist.boundingBox(),
    content.boundingBox(),
  ]);
  expect((list?.x ?? 0) + (list?.width ?? 0)).toBeLessThanOrEqual(
    panel?.x ?? 0,
  );
  const general = tablist.getByRole("tab", { name: "General", exact: true });
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel", { name: "General" })).toBeVisible();
  await expect(dialog.getByLabel("Backups to keep")).toBeVisible();

  const appearance = tablist.getByRole("tab", { name: "Appearance" });
  const indicator = tablist.locator(".nf-segmented-tabs-indicator");
  await expect(indicator).toBeVisible();
  const initialPosition = await indicator.evaluate(
    (element) => element.getBoundingClientRect().y,
  );
  await appearance.click();
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("Table gridlines")).toBeVisible();
  await expect(dialog.getByLabel("Backups to keep")).toBeHidden();
  await expect
    .poll(async () => {
      const highlight = await indicator.boundingBox();
      const tab = await appearance.boundingBox();
      return Math.abs((highlight?.y ?? 0) - (tab?.y ?? 0));
    })
    .toBeLessThan(1);
  expect(
    await indicator.evaluate((element) => element.getBoundingClientRect().y),
  ).toBeGreaterThan(initialPosition);
  await expect(indicator).toHaveCSS("transition-duration", "0.12s, 0.12s");
  await expect(indicator).toHaveCSS("transition-property", "transform, height");
  await page.screenshot({
    path: testInfo.outputPath("settings-segmented.png"),
  });

  await appearance.press("ArrowRight");
  await expect(appearance).toBeFocused();
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await appearance.press("ArrowDown");
  const editors = tablist.getByRole("tab", { name: "Editors" });
  await expect(editors).toBeFocused();
  await expect(dialog.getByLabel("Insert and paste position")).toBeVisible();
  await editors.press("ArrowDown");
  const network = tablist.getByRole("tab", { name: "Network" });
  await expect(network).toBeFocused();
  await expect(dialog.getByLabel("Input signal loss policy")).toBeVisible();
  await network.press("ArrowUp");
  await expect(editors).toBeFocused();
  await editors.press("ArrowDown");
  await expect(network).toBeFocused();

  // A short window makes the sidebar scroll; End must bring the last category into view.
  const wide = page.viewportSize();
  await page.setViewportSize({ width: wide?.width ?? 1280, height: 360 });
  await network.press("End");
  const lastTab = tablist.getByRole("tab", { name: "Privacy" });
  await expect(lastTab).toBeFocused();
  await expect(lastTab).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("settings-segmented-short.png"),
  });
  await lastTab.press("Home");
  await expect(general).toBeFocused();
  await expect(general).toBeInViewport({ ratio: 1 });
  for (let step = 0; step < 3; step++) {
    await page.keyboard.press("ArrowDown");
  }
  await expect(network).toBeFocused();
  if (wide) await page.setViewportSize(wide);

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
  await expect(network).toHaveAttribute("aria-selected", "true");
  await network.press("ArrowRight");
  const visualizer = tablist.getByRole("tab", { name: "Visualizer" });
  await expect(visualizer).toBeFocused();
  await expect(visualizer).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByLabel("Quality preset")).toBeVisible();
  for (const name of ["Highlight selection", "Show current orbit target"]) {
    const toggle = dialog.getByRole("switch", { name, exact: true });
    const checked = await toggle.isChecked();
    await toggle.focus();
    await toggle.press("Space");
    await expect(toggle).toBeChecked({ checked: !checked });
    await toggle.press("Space");
    await expect(toggle).toBeChecked({ checked });
  }
  const quality = dialog.getByRole("radiogroup", { name: "Quality preset" });
  await quality.locator('[role="radio"][tabindex="0"]').focus();
  await page.keyboard.press("Home");
  const low = quality.getByRole("radio", { name: "Low (faster)" });
  await expect(low).toBeChecked();
  await expect(low).toBeFocused();
  await expect(
    dialog.getByText(
      "Simple geometry beams without surface lighting, for maximum performance.",
    ),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(quality.getByRole("radio", { name: "Medium" })).toBeChecked();
  await expect(
    dialog.getByText(
      "Smoothly shaded beams and surface lighting, without fog or glow.",
    ),
  ).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    quality.getByRole("radio", { name: "High (slower)" }),
  ).toBeChecked();
  await expect(
    dialog.getByText("Atmospheric beams, fog, glow, and optical effects."),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const highlight = await indicator.boundingBox();
      const tab = await visualizer.boundingBox();
      return Math.abs((highlight?.x ?? 0) - (tab?.x ?? 0));
    })
    .toBeLessThan(1);
  await page.screenshot({
    path: testInfo.outputPath("settings-segmented-narrow.png"),
  });
  await visualizer.press("End");
  const privacy = tablist.getByRole("tab", { name: "Privacy" });
  await expect(privacy).toBeFocused();
  await expect(privacy).toBeInViewport({ ratio: 1 });
  await expect(
    dialog.getByText(
      "Sharing data is not supported in this version of Nightfall.",
    ),
  ).toBeVisible();
  await privacy.press("ArrowRight");
  await expect(general).toBeFocused();
  await expect(general).toBeInViewport({ ratio: 1 });
  await general.press("ArrowLeft");
  await expect(privacy).toBeFocused();
  await privacy.press("Home");
  await expect(general).toBeFocused();
  await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
  await expect
    .poll(async () => {
      const highlight = await indicator.boundingBox();
      const tab = await general.boundingBox();
      return Math.abs((highlight?.x ?? 0) - (tab?.x ?? 0));
    })
    .toBeLessThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(indicator).toHaveCSS("transition-duration", "0s");
  await general.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

/**
 * Verifies both content slide directions of the vertical sidebar (down for a later tab, up for an
 * earlier one), captures an intermediate frame, and honors reduced motion.
 */
test("shared tabs slide their associated content", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const tablist = dialog.getByRole("tablist", { name: "Settings categories" });

  for (const [name, offset] of [
    ["Appearance", "10%"],
    ["General", "-10%"],
  ] as const) {
    const frames = await tablist
      .getByRole("tab", { name, exact: true })
      .evaluate(async (tab) => {
        (tab as HTMLButtonElement).click();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const panel = document.getElementById(
          tab.getAttribute("aria-controls") ?? "",
        );
        const animation = panel
          ?.getAnimations()
          .find(
            (item) =>
              item instanceof CSSAnimation && item.animationName === "enter",
          );
        if (!animation) return [];
        animation.pause();
        animation.currentTime = 60;
        return [
          getComputedStyle(panel!).getPropertyValue("--tw-enter-translate-y"),
          animation instanceof CSSAnimation,
        ];
      });
    expect(frames).toEqual([offset, true]);
    await page.screenshot({
      path: testInfo.outputPath(`content-slide-${name}.png`),
    });
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await tablist.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(dialog.getByLabel("Table gridlines")).toBeVisible();
  expect(
    await dialog
      .getByRole("tabpanel")
      .evaluate((panel) => panel.getAnimations().length),
  ).toBe(0);
});
