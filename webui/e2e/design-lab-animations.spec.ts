// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Verifies directional entrances, replay interruption, reduced motion, and narrow layout. */
test("animation controls replay content entrances", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Animations/ })
    .click();
  const panel = page.getByRole("region", { name: "Animation examples" });
  const content = panel.getByTestId("animation-content");
  const duration = panel.getByRole("slider", { name: "Animation duration" });
  await expect(duration).toHaveAttribute("aria-valuenow", "600.0");
  await duration.press("ArrowRight");
  await expect(duration).toHaveAttribute("aria-valuenow", "650.0");
  const durationInput = panel.getByRole("spinbutton", {
    name: "Animation duration",
  });
  await durationInput.fill("1200");
  await durationInput.press("Tab");
  await expect(duration).toHaveAttribute("aria-valuenow", "1200.0");
  for (const [name, property, value] of [
    ["Sweep from left", "--tw-enter-translate-x", "-100%"],
    ["Sweep from right", "--tw-enter-translate-x", "100%"],
    ["Sweep from top", "--tw-enter-translate-y", "-100%"],
    ["Sweep from bottom", "--tw-enter-translate-y", "100%"],
    ["Fade in", "--tw-enter-opacity", "0"],
    ["Zoom in", "--tw-enter-scale", "0.8"],
  ]) {
    await panel.getByRole("button", { name, exact: true }).click();
    expect(
      await content.evaluate((element, property) => {
        const animation = element.getAnimations()[0];
        animation.pause();
        animation.currentTime = 150;
        if (!(animation instanceof CSSAnimation))
          throw new Error("Expected a CSS animation");
        return getComputedStyle(element).getPropertyValue(property);
      }, property),
    ).toBe(value);
    await expect(content).toBeVisible();
    expect(
      await content.evaluate(
        (element) => element.getAnimations()[0].effect?.getTiming().duration,
      ),
    ).toBe(1200);
    if (name === "Sweep from left") {
      await panel.screenshot({
        path: testInfo.outputPath("sweep-in-progress.png"),
        animations: "allow",
      });
    }
  }
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Zoom in · Complete");
  await expect(content).toHaveCSS("transform", "none");
  await panel.screenshot({ path: testInfo.outputPath("animations.png") });
  for (const [label, value] of [
    ["Animation delay", "200"],
    ["Slide distance", "50"],
    ["Starting opacity", "25"],
    ["Starting zoom", "60"],
  ]) {
    const input = panel.getByRole("spinbutton", { name: label, exact: true });
    await input.fill(value);
    await input.press("Tab");
  }
  await panel.getByRole("combobox", { name: "Easing" }).selectOption("linear");
  await panel
    .getByRole("button", { name: "Sweep from right", exact: true })
    .click();
  expect(
    await content.evaluate((element) => {
      const animation = element.getAnimations()[0];
      animation.pause();
      const style = getComputedStyle(element);
      return [
        animation.effect?.getTiming().delay,
        animation.effect?.getTiming().easing,
        style.getPropertyValue("--tw-enter-translate-x"),
        style.getPropertyValue("--tw-enter-opacity"),
      ];
    }),
  ).toEqual([200, "linear", "50%", "0.25"]);
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(
    await content.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--tw-enter-scale"),
    ),
  ).toBe("0.6");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await panel
    .getByRole("button", { name: "Sweep from left", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Reduced motion");
  expect(
    await content.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: testInfo.outputPath("animations-narrow.png"),
  });
});
