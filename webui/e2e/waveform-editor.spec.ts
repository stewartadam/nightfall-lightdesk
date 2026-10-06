// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { harnessPageUrl } from "./app-hooks";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Checks square defaults, subsequent edits, other presets, and wired values. */
test("square selection resets editable duty cycle to 50%", async ({
  page,
}, testInfo) => {
  await page.goto(harnessPageUrl("waveform-editor"));
  const editor = page.locator(".waveform-editor");
  const dutyCycle = editor.getByRole("spinbutton").nth(2);
  const square = editor.getByRole("button", { name: "Square" });
  const commitCount = page.getByTestId("commit-count");
  await expect(dutyCycle).toHaveValue("100");
  await expect(commitCount).toHaveText("0");
  await square.click();
  await expect(square).toHaveAttribute("aria-pressed", "true");
  await expect(dutyCycle).toHaveValue("50");
  await expect(page.locator("output")).toContainText('"duty_cycle":0.5');
  await expect(page.locator("output")).toContainText('"kind":"square"');
  await expect(commitCount).toHaveText("1");
  await editor.screenshot({
    path: testInfo.outputPath("square-50-percent.png"),
  });

  await dutyCycle.fill("25");
  await dutyCycle.press("Enter");
  await expect(dutyCycle).toHaveValue("25");
  await square.click();
  await expect(dutyCycle).toHaveValue("50");
  await expect(commitCount).toHaveText("3");

  await dutyCycle.fill("25");
  await dutyCycle.press("Enter");
  await editor.getByRole("button", { name: "Triangle" }).click();
  await expect(dutyCycle).toHaveValue("25");
  await page.getByLabel("Wired duty cycle").check();
  await square.click();
  await expect(square).toHaveAttribute("aria-pressed", "true");
  await expect(dutyCycle).toBeDisabled();
  await expect(dutyCycle).toHaveValue("25");
  await expect(commitCount).toHaveText("6");
});
