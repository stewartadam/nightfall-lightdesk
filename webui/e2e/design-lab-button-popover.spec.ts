// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Edits inline tempo content, verifies its limits, and retains values across pointer and keyboard opening. */
test("button catalog opens editable inline tempo content", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Buttons/ })
    .click();
  const buttons = page.getByRole("region", { name: "Button examples" });
  const trigger = buttons.getByRole("button", { name: "Tempo controls" });
  const content = page.getByRole("group", { name: "Tempo settings" });
  await expect(trigger).toHaveText("120 BPM");
  await trigger.click();
  await expect(content).toBeVisible();
  await content.getByRole("spinbutton", { name: "BPM rate" }).fill("128");
  await content.getByRole("spinbutton", { name: "Beats per bar" }).fill("3");
  await content.getByRole("button", { name: "Increase sample BPM" }).click();
  await expect(trigger).toHaveText("129 BPM");
  await expect(content).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("inline-tempo-popover.png"),
    fullPage: true,
  });
  await content.getByRole("spinbutton", { name: "BPM rate" }).fill("240");
  await content.getByRole("spinbutton", { name: "BPM rate" }).press("Tab");
  await expect(
    content.getByRole("button", { name: "Increase sample BPM" }),
  ).toBeDisabled();
  await content.getByRole("button", { name: "Decrease sample BPM" }).click();
  await expect(trigger).toHaveText("239 BPM");
  await buttons.getByRole("heading").click();
  await expect(content).toBeHidden();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(content).toBeVisible();
  await expect(
    content.getByRole("spinbutton", { name: "Beats per bar" }),
  ).toHaveValue("3");
  await trigger.click();
  await expect(content).toBeHidden();
});
