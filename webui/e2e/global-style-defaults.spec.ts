// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

for (const entry of ["app", "lab"] as const) {
  /** Verifies native fields inherit the shared defaults without component classes or a theme wrapper. */
  test(`${entry} applies global field and palette defaults`, async ({
    page,
  }, testInfo) => {
    await page.goto(
      entry === "app"
        ? "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1"
        : "/design-lab.html",
    );
    if (entry === "app") await waitForDockviewApp(page);
    else
      await expect(
        page.getByRole("navigation", { name: "Component index" }),
      ).toBeVisible();
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.setAttribute("aria-label", "Native field defaults");
      form.style.cssText =
        "position:fixed;inset:80px auto auto 80px;width:320px;padding:16px;z-index:2147483647;background:var(--panel)";
      form.innerHTML =
        '<input aria-label="Plain input" placeholder="Native input"><textarea aria-label="Plain textarea" placeholder="Native textarea"></textarea><select aria-label="Plain select"><option>Native select</option></select><input type="checkbox" aria-label="Plain checkbox"><input type="text" data-density="compact" aria-label="Compact input">';
      document.body.append(form);
    });
    const input = page.getByLabel("Plain input");
    await expect(input).not.toHaveAttribute("class");
    await expect(input).toHaveCSS("min-height", "38px");
    await expect(input).toHaveCSS("font-size", "12px");
    await expect(input).toHaveCSS("border-top-width", "1px");
    await expect(input).toHaveCSS("background-color", "rgb(34, 37, 39)");
    await expect(page.getByLabel("Plain select")).toHaveCSS(
      "min-height",
      "38px",
    );
    await expect(page.getByLabel("Plain textarea")).toHaveCSS(
      "min-height",
      "80px",
    );
    await expect(page.getByLabel("Compact input")).toHaveCSS(
      "min-height",
      "28px",
    );
    await expect(page.getByLabel("Plain checkbox")).toHaveCSS(
      "accent-color",
      "rgb(84, 213, 180)",
    );
    await input.focus();
    await expect(input).toHaveCSS(
      "box-shadow",
      "rgb(84, 213, 180) 0px 0px 0px 1px",
    );
    await page.evaluate(() =>
      document.documentElement.style.setProperty(
        "--color-accent-mint",
        "#123456",
      ),
    );
    await expect(input).toHaveCSS(
      "box-shadow",
      "rgb(18, 52, 86) 0px 0px 0px 1px",
    );
    await page.screenshot({
      path: testInfo.outputPath(`${entry}-native-defaults.png`),
    });
  });
}
