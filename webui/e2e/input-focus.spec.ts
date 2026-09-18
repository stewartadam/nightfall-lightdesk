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

/** Checks that a field has exactly one visible one-pixel focus indicator. */
async function expectSingleRing(field: Locator) {
  await expect(field).toHaveCSS("outline-style", "none");
  await expect(field).toHaveCSS("box-shadow", /^rgb\(.+\) 0px 0px 0px 1px$/);
}

/** Exercises shared native controls and composite fields at both form densities. */
test("native and composite inputs share focus geometry and validation colors", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Input forms/ }).click();
  const panel = page.getByRole("region", { name: "Input form examples" });
  const name = panel.getByRole("textbox", { name: "Cue name *", exact: true });
  const notes = panel.getByRole("textbox", { name: "Notes", exact: true });
  const select = panel.getByRole("combobox", { name: "On completion" });
  const checkbox = panel.getByRole("checkbox", { name: "Enable cue" });
  const radio = panel.getByRole("radio", { name: "Track changes" });
  const advancedSelect = panel.locator(".nf-select-toggle");
  const intensity = panel.getByRole("spinbutton", { name: "Intensity *" });
  const group = intensity.locator("..");

  for (const layout of ["Standard", "Properties"]) {
    await panel.getByRole("tab", { name: layout, exact: true }).click();
    await page.keyboard.press("Tab");
    for (const field of [
      name,
      notes,
      select,
      checkbox,
      radio,
      advancedSelect,
    ]) {
      await field.focus();
      await expectSingleRing(field);
      await expect(group).toHaveCSS("box-shadow", "none");
    }
    await name.focus();
    const ring = await name.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    await panel.screenshot({
      path: testInfo.outputPath(`native-${layout}.png`),
    });
    await intensity.focus();
    await expectSingleRing(group);
    await expect(group).toHaveCSS("box-shadow", ring);
    await expect(intensity).toHaveCSS("box-shadow", "none");
    await expect(intensity).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(name).toHaveCSS("box-shadow", "none");
    await panel.screenshot({
      path: testInfo.outputPath(`composite-${layout}.png`),
    });
  }

  await name.fill("");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expectSingleRing(name);
  await expect(name).toHaveCSS(
    "box-shadow",
    "rgb(241, 139, 142) 0px 0px 0px 1px",
  );
  await panel.screenshot({ path: testInfo.outputPath("invalid-input.png") });

  await index.getByRole("button", { name: /Sliders/ }).click();
  const range = page.getByRole("region", { name: "Slider examples" });
  const numeric = range.getByRole("spinbutton").first();
  await numeric.focus();
  await expectSingleRing(numeric.locator(".."));
  await expect(numeric).toHaveCSS("box-shadow", "none");
  await range.screenshot({ path: testInfo.outputPath("range-input.png") });
  await page.keyboard.press("Tab");
  const handle = range.getByRole("slider").first();
  await handle.focus();
  await expectSingleRing(handle);
  await page.emulateMedia({ forcedColors: "active" });
  await numeric.focus();
  await expect(numeric.locator("..")).toHaveCSS("outline-width", "1px");
  await expect(numeric.locator("..")).toHaveCSS("outline-style", "solid");
  await expect(numeric).toHaveCSS("outline-style", "none");
});
