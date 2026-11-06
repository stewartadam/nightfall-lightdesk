// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { resetToDefaultLayout, waitForDockviewApp } from "./showfile-startup";

/**
 * Guards the dockview-core patch across upgrades: every group, with its header on any side, must
 * size its active panel to the space inside its themed border and beside its header.
 */
test("active panels are sized inside the group border", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getEdgeGroup("left")?.expand();
    api.getEdgeGroup("right")?.expand();
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const groups = (window as any).appStores.dockApi.get().groups as any[];
        const measured = groups
          .filter(
            (group) =>
              group.activePanel &&
              group.api.isVisible &&
              !group.api.isCollapsed?.(),
          )
          .map((group) => {
            const style = getComputedStyle(group.element);
            const header = group.element.querySelector(
              ":scope > .dv-tabs-and-actions-container",
            ) as HTMLElement;
            const position = group.model.headerPosition as string;
            const vertical = position === "left" || position === "right";
            const borderX =
              Number.parseFloat(style.borderLeftWidth) +
              Number.parseFloat(style.borderRightWidth);
            const borderY =
              Number.parseFloat(style.borderTopWidth) +
              Number.parseFloat(style.borderBottomWidth);
            return {
              vertical,
              hasBorder: borderX > 0 && borderY > 0,
              widthError:
                group.api.width -
                borderX -
                (vertical ? header.offsetWidth : 0) -
                group.activePanel.api.width,
              heightError:
                group.api.height -
                borderY -
                (vertical ? 0 : header.offsetHeight) -
                group.activePanel.api.height,
            };
          });
        return {
          horizontalHeaders: measured.some((group) => !group.vertical),
          verticalHeaders: measured.some((group) => group.vertical),
          bordered: measured.every((group) => group.hasBorder),
          insideBorder: measured.every(
            (group) =>
              Math.abs(group.widthError) < 1 && Math.abs(group.heightError) < 1,
          ),
          measured,
        };
      }),
    )
    .toMatchObject({
      horizontalHeaders: true,
      verticalHeaders: true,
      bordered: true,
      insideBorder: true,
    });

  await page.screenshot({
    path: testInfo.outputPath("expanded-layout.png"),
    fullPage: true,
  });
});
