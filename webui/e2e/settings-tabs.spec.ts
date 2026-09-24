// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks category content, keyboard selection, and access to the segmented strip on narrow screens. */
test("settings segmented tabs support pointer and keyboard navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const tablist = dialog.getByRole("tablist", { name: "Settings categories" });
  await expect(tablist.getByRole("tab")).toHaveCount(5);
  const general = tablist.getByRole("tab", { name: "General", exact: true });
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel", { name: "General" })).toBeVisible();
  await expect(dialog.getByLabel("Backups to keep")).toBeVisible();

  const appearance = tablist.getByRole("tab", { name: "Appearance" });
  const indicator = tablist.locator(".nf-segmented-tabs-indicator");
  await expect(indicator).toBeVisible();
  const initialPosition = await indicator.evaluate(
    (element) => element.getBoundingClientRect().x,
  );
  await appearance.click();
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("Table gridlines")).toBeVisible();
  await expect(dialog.getByLabel("Backups to keep")).toBeHidden();
  await expect
    .poll(async () => {
      const highlight = await indicator.boundingBox();
      const tab = await appearance.boundingBox();
      return Math.abs((highlight?.x ?? 0) - (tab?.x ?? 0));
    })
    .toBeLessThan(1);
  expect(
    await indicator.evaluate((element) => element.getBoundingClientRect().x),
  ).toBeGreaterThan(initialPosition);
  await expect(indicator).toHaveCSS("transition-duration", "0.12s, 0.12s");
  await page.screenshot({
    path: testInfo.outputPath("settings-segmented.png"),
  });

  await appearance.press("ArrowRight");
  const editors = tablist.getByRole("tab", { name: "Editors" });
  await expect(editors).toBeFocused();
  await expect(dialog.getByLabel("Insert and paste position")).toBeVisible();
  await editors.press("ArrowRight");
  const network = tablist.getByRole("tab", { name: "Network" });
  await expect(network).toBeFocused();
  await expect(dialog.getByLabel("Input signal loss policy")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 780 });
  await network.press("End");
  const visualizer = tablist.getByRole("tab", { name: "Visualizer" });
  await expect(visualizer).toBeFocused();
  await expect(visualizer).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByLabel("Quality preset")).toBeVisible();
  const quality = dialog.getByRole("slider", { name: "Quality preset" });
  await quality.focus();
  await quality.press("Home");
  await expect(quality).toHaveAttribute("aria-valuetext", "Low (faster)");
  await expect(
    dialog.getByText("Simple geometry beams for maximum performance."),
  ).toBeVisible();
  await quality.press("ArrowRight");
  await expect(quality).toHaveAttribute("aria-valuetext", "Medium");
  await expect(
    dialog.getByText(
      "Smoothly shaded beams and surface lighting, without fog or glow.",
    ),
  ).toBeVisible();
  await quality.press("End");
  await expect(quality).toHaveAttribute("aria-valuetext", "High (slower)");
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
  await visualizer.press("ArrowRight");
  await expect(general).toBeFocused();
  await expect(general).toBeInViewport({ ratio: 1 });
  await general.press("ArrowLeft");
  await expect(visualizer).toBeFocused();
  await visualizer.press("Home");
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

/** Verifies both content slide directions, captures an intermediate frame, and honors reduced motion. */
test("shared tabs slide their associated content", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const tablist = dialog.getByRole("tablist", { name: "Settings categories" });

  for (const [name, offset] of [
    ["Appearance", "100%"],
    ["General", "-100%"],
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
          getComputedStyle(panel!).getPropertyValue("--tw-enter-translate-x"),
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
