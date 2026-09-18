// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

for (const surface of ["app", "designer"] as const) {
  /** Verifies focus changes only the outer frame while preserving the divider and accent tab. */
  test(`${surface} uses grey region focus frames`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(
      surface === "app"
        ? "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1"
        : "/design-lab.html",
    );
    if (surface === "app") await waitForDockviewApp(page);
    const tab = page.getByRole("tab", {
      name: surface === "app" ? "Fixtures" : "Groups",
      exact: true,
    });
    await tab.click();
    const group = page.locator(".dv-groupview").filter({ has: tab });
    const header = group.locator(":scope > .dv-tabs-and-actions-container");
    const bounds = await group.boundingBox();
    await expect(group).toHaveCSS("border-top-color", "rgb(160, 167, 170)");
    await expect(header).toHaveCSS(
      "background-image",
      "linear-gradient(rgb(52, 56, 59), rgb(52, 56, 59))",
    );
    const accent = await tab.evaluate(
      (element) => getComputedStyle(element).borderBottomColor,
    );
    expect(accent).not.toBe("rgb(160, 167, 170)");
    await page.screenshot({
      path: testInfo.outputPath(`${surface}-focused.png`),
    });

    await page
      .getByRole("tab", {
        name: surface === "app" ? "Clips" : "Properties",
        exact: true,
      })
      .click();
    await expect(group).toHaveClass(/dv-inactive-group/);
    await expect(group).toHaveCSS("border-top-color", "rgb(52, 56, 59)");
    expect(await group.boundingBox()).toEqual(bounds);
    await tab.click();
    await expect(group).toHaveCSS("border-top-color", "rgb(160, 167, 170)");
    await expect(tab).toHaveCSS("border-bottom-color", accent);

    if (surface === "designer") {
      await expect(
        page.getByRole("group", { name: "Focus border", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("navigation", { name: "Component index" })
        .getByRole("button", { name: /Docking/ })
        .click();
      await page
        .getByRole("button", { name: "Bottom tabs", exact: true })
        .click();
      await tab.click();
      await expect(group).toHaveClass(/dv-groupview-header-bottom/);
      await expect(group).toHaveCSS("border-top-color", "rgb(160, 167, 170)");
      await expect(header).toHaveCSS(
        "background-image",
        "linear-gradient(rgb(52, 56, 59), rgb(52, 56, 59))",
      );
      await expect(tab).toHaveCSS("border-top-color", accent);
      await expect(
        page.getByRole("region", { name: "Group library", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("designer-bottom-tabs.png"),
      });
    }
  });
}
