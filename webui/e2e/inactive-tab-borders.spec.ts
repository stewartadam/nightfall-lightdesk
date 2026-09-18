// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks the shared divider behind inactive tabs in regular and expanded edge groups. */
test("inactive Dockview tabs share a grey content-edge divider", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    for (const edge of ["left", "right", "bottom"]) {
      const group = api.getEdgeGroup(edge);
      api.addPanel({
        id: `border-check-${edge}`,
        component: "GroupsPanel",
        title: `Extra ${edge}`,
        position: { referenceGroup: group.id, direction: "within" },
        inactive: true,
      });
      group.expand();
    }
  });

  for (const position of ["top", "bottom"]) {
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings
      .getByRole("tab", { name: "Appearance", exact: true })
      .click();
    await settings.getByLabel("Panel tab position").selectOption(position);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Sequences", exact: true }).click();
    const headers = page.locator(
      ".dv-groupview:not(.dv-edge-collapsed) > .dv-tabs-and-actions-container:visible",
    );
    expect(await headers.count()).toBeGreaterThanOrEqual(5);
    for (const header of await headers.all()) {
      const side = await header.evaluate((element) => {
        const group = element.parentElement!;
        if (group.classList.contains("dv-groupview-header-left"))
          return "right";
        if (group.classList.contains("dv-groupview-header-right"))
          return "left";
        if (group.classList.contains("dv-groupview-header-bottom"))
          return "top";
        return "bottom";
      });
      await expect(header).toHaveCSS(
        "background-image",
        "linear-gradient(rgb(52, 56, 59), rgb(52, 56, 59))",
      );
      const vertical = side === "left" || side === "right";
      await expect(header).toHaveCSS(
        "background-size",
        vertical ? "1px 100%" : "100% 1px",
      );
      await expect(header).toHaveCSS(
        "background-position",
        {
          top: "50% 0%",
          bottom: "50% 100%",
          left: "0% 50%",
          right: "100% 50%",
        }[side],
      );
      const inactive = header.locator(".dv-tab:not(.dv-active-tab)").first();
      await expect(inactive).toBeVisible();
      await expect(inactive).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    const selected = page.getByRole("tab", { name: "Sequences", exact: true });
    await expect(selected).toHaveCSS(
      `border-${position === "top" ? "bottom" : "top"}-width`,
      "2px",
    );
    await page.screenshot({
      path: testInfo.outputPath(`inactive-tabs-${position}.png`),
    });
  }
});
