// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies shared tooltips animate and render a pointer back to their trigger. */
test("shared tooltip fades and points at its trigger", async ({ page }) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("button[title='Menu']")).toBeVisible();

  const tooltipPoint = await page
    .locator('[data-component="Tooltip"]')
    .evaluateAll((elements) => {
      const visibleElement = elements.find((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });

      if (!visibleElement) return null;

      const rect = visibleElement.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
  expect(tooltipPoint).not.toBeNull();

  await page.mouse.move(tooltipPoint?.x ?? 0, tooltipPoint?.y ?? 0);

  const surface = page.locator('[data-slot="surface"]');
  const pointer = page.locator('[data-slot="pointer"]');

  await expect(surface).toBeVisible();
  await expect(pointer).toBeVisible();
  await expect(surface).toHaveClass(/opacity-100/);

  const transitionStyles = await surface.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      duration: style.transitionDuration,
      property: style.transitionProperty,
    };
  });
  expect(transitionStyles.property).toContain("opacity");
  expect(transitionStyles.duration).not.toBe("0s");

  const pointerBox = await pointer.boundingBox();
  expect(pointerBox?.width).toBeGreaterThan(0);
  expect(pointerBox?.height).toBeGreaterThan(0);

  await page.mouse.move(0, 0);

  await expect(surface).toHaveClass(/opacity-0/);
  await expect(surface).toBeHidden();
});
