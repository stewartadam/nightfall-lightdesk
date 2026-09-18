// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the visual properties that should stay consistent across form contexts. */
async function controlAppearance(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.border,
      radius: style.borderRadius,
      font: style.font,
      padding: style.padding,
      height: style.height,
    };
  });
}

/** Compares lab and production controls, then submits a real entity editor using the keyboard. */
test("lab, settings and entity editors share form controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  const lab = page.getByRole("region", { name: "Input form examples" });
  const name = lab.getByRole("textbox", { name: "Cue name *", exact: true });
  const appearance = await controlAppearance(name);
  const completion = lab.getByRole("combobox", { name: "On completion" });
  await completion.selectOption("release");
  await lab.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(completion).toHaveValue("release");
  await expect(completion).toHaveCSS("height", "28px");
  await lab.getByRole("tab", { name: "Standard", exact: true }).click();
  await lab.getByRole("button", { name: "Reset form" }).click();
  await expect(completion).toHaveValue("hold");
  const selectAppearance = await controlAppearance(completion);

  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const retention = settings.getByLabel("Backups to keep");
  await expect(retention).toBeVisible();
  expect(await controlAppearance(retention)).toEqual(appearance);
  expect(
    await controlAppearance(settings.getByLabel("Selection flatten behavior")),
  ).toEqual(selectAppearance);
  await page.screenshot({
    path: testInfo.outputPath("shared-settings-controls.png"),
  });
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Groups", exact: true }).click();
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Create group",
    exact: true,
  });
  const label = editor.getByRole("textbox", { name: "Label", exact: true });
  await expect(label).toBeFocused();
  expect(await controlAppearance(label)).toEqual(appearance);
  const id = editor.getByRole("spinbutton", { name: "ID", exact: true });
  expect(await controlAppearance(id)).toEqual(appearance);
  await label.fill("Shared form controls");
  await page.screenshot({
    path: testInfo.outputPath("shared-entity-controls.png"),
  });
  await label.press("Enter");
  await expect(editor).toBeHidden();
  await expect(
    page
      .locator(".nf-crud-card:visible")
      .filter({ hasText: "Shared form controls" }),
  ).toBeVisible();
});
