// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/**
 * Guards the dockview-core patch across upgrades: every visible top-header
 * group must size its active panel to the space inside the themed 1px border,
 * leaving a 2px gap on each axis once the header is excluded.
 */
test("active panels are sized inside the group border", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const groups = (window as any).appStores.dockApi.get().groups as any[];
        const measured = groups
          .filter(
            (group) =>
              group.activePanel &&
              group.api.isVisible &&
              group.model.headerPosition === "top",
          )
          .map((group) => {
            const header = group.element.querySelector(
              ":scope > .dv-tabs-and-actions-container",
            ) as HTMLElement;
            return {
              widthGap: group.api.width - group.activePanel.api.width,
              heightGap:
                group.api.height -
                header.offsetHeight -
                group.activePanel.api.height,
            };
          });
        return {
          hasGroups: measured.length > 0,
          allInsideBorder: measured.every(
            ({ widthGap, heightGap }) => widthGap === 2 && heightGap === 2,
          ),
          measured,
        };
      }),
    )
    .toMatchObject({ hasGroups: true, allInsideBorder: true });

  await page.screenshot({
    path: testInfo.outputPath("default-layout.png"),
    fullPage: true,
  });
});
