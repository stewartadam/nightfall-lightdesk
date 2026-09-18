// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Verifies corner styling reaches panels, controls, and portals and survives layout resets. */
test("Properties toggles rounded corners across the design lab", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/design-lab.html");
  const properties = page.getByRole("region", { name: "Design properties" });
  const toggle = properties.getByRole("switch", { name: "Rounded corners" });
  const tile = page.getByRole("button", { name: /GRP 17/ });
  const panel = page.locator(".dv-groupview").first();
  const button = properties.getByRole("button", { name: "Blue accent" });
  await expect(toggle).toBeChecked();
  await expect(panel).toHaveCSS("border-radius", "7px");
  await expect(tile).toHaveCSS("border-radius", "6px");
  await page.screenshot({ path: testInfo.outputPath("rounded.png") });

  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(toggle.locator("..").locator(".nf-switch-track")).toHaveCSS(
    "background-color",
    "rgb(34, 37, 39)",
  );
  await expect(panel).toHaveCSS("border-radius", "0px");
  await expect(tile).toHaveCSS("border-radius", "0px");
  await expect(button).toHaveCSS("border-radius", "0px");
  await expect(toggle.locator("..").locator(".nf-switch-thumb")).not.toHaveCSS(
    "border-radius",
    "0px",
  );
  await page.screenshot({ path: testInfo.outputPath("square.png") });
  await tile.click({ button: "right" });
  await expect(page.getByRole("menu").first()).toHaveCSS(
    "border-radius",
    "0px",
  );
  await page.screenshot({ path: testInfo.outputPath("square-menu.png") });
  await page.keyboard.press("Escape");

  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  await expect(page.getByRole("textbox", { name: "Cue name" })).toHaveCSS(
    "border-radius",
    "0px",
  );
  await properties.getByRole("button", { name: "Reset layout" }).click();
  await expect(tile).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(panel).toHaveCSS("border-radius", "0px");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(panel).toHaveCSS("border-radius", "7px");
  await expect(tile).toHaveCSS("border-radius", "6px");
  await tile.click({ button: "right" });
  await expect(page.getByRole("menu").first()).toHaveCSS(
    "border-radius",
    "7px",
  );
});
