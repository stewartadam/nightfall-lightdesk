// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Checks category ordering and verifies switching categories retains panel state and active navigation. */
test("component index separates alphabetized core UI and custom widgets", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  const core = index.getByRole("region", { name: "Core UI", exact: true });
  const widgets = index.getByRole("region", {
    name: "Custom widgets",
    exact: true,
  });
  await expect(core).toBeVisible();
  await expect(widgets).toBeVisible();
  for (const section of [core, widgets]) {
    const titles = (await section.getByRole("button").allTextContents()).map(
      (title) => title.replace(/^\d+\s*/, "").trim(),
    );
    expect(titles.length).toBeGreaterThan(0);
    expect(titles).toEqual(
      [...titles].sort((left, right) => left.localeCompare(right)),
    );
  }
  const buttons = core.getByRole("button", { name: /Buttons/ });
  await buttons.click();
  const buttonPanel = page.getByRole("region", { name: "Button examples" });
  await buttonPanel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(buttonPanel.getByRole("status")).toHaveText(
    "Sample changes applied.",
  );
  const picker = widgets.getByRole("button", { name: /Color picker/ });
  await picker.click();
  await expect(
    page.getByRole("region", { name: "Color picker examples" }),
  ).toBeVisible();
  await expect(picker).toHaveAttribute("aria-current", "page");
  await expect(buttons).not.toHaveAttribute("aria-current", "page");
  await buttons.click();
  await expect(buttonPanel.getByRole("status")).toHaveText(
    "Sample changes applied.",
  );
  await expect(buttons).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("tab", { name: "Buttons", exact: true }),
  ).toHaveCount(1);
  await index.screenshot({
    path: testInfo.outputPath("component-index-wide.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await index.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  await picker.click();
  await expect(picker).toHaveAttribute("aria-current", "page");
  await index.screenshot({
    path: testInfo.outputPath("component-index-narrow.png"),
  });
});
