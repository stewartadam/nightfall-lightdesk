// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Verifies detached content respects curved borders as a panel moves between edges and the grid. */
test("panel content follows edge corners when moved", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  for (const edge of ["bottom", "left", "right"]) {
    await page.evaluate((edge) => {
      const api = (window as any).appStores.dockApi.get();
      const edgeGroup = api.getEdgeGroup(edge);
      api.setEdgeGroupVisible(edge, true);
      const panel = api.getPanel("panel-ProgrammerGrid");
      panel.api.moveTo({
        group: api.groups.find(
          (candidate: { id: string }) => candidate.id === edgeGroup.id,
        ),
        position: "center",
      });
      edgeGroup.expand();
      panel.api.setActive();
    }, edge);
    const root = page
      .locator(`[data-panel-edge="${edge}"]`)
      .filter({ hasText: "Programmer is empty." });
    await expect(root).toBeVisible();
    await expect
      .poll(() =>
        root.evaluate((element, edge) => {
          const rect = element.getBoundingClientRect();
          const corners = {
            topLeft: [rect.left + 0.5, rect.top + 0.5],
            topRight: [rect.right - 0.5, rect.top + 0.5],
            bottomLeft: [rect.left + 0.5, rect.bottom - 0.5],
            bottomRight: [rect.right - 0.5, rect.bottom - 0.5],
          };
          const rounded: Array<keyof typeof corners> =
            edge === "bottom"
              ? ["topLeft", "topRight"]
              : edge === "left"
                ? ["topRight", "bottomRight"]
                : ["topLeft", "bottomLeft"];
          return rounded.map((corner) => {
            const [x, y] = corners[corner];
            return element.contains(document.elementFromPoint(x, y));
          });
        }, edge),
      )
      .toEqual([false, false]);
    await page.screenshot({ path: testInfo.outputPath(`${edge}.png`) });
  }
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-ProgrammerGrid").api.moveTo({
      group: api.getPanel("panel-FixtureGrid").api.group,
      position: "center",
    });
  });
  const programmer = page
    .locator("[data-panel-active]")
    .filter({ hasText: "Programmer is empty." });
  await expect(programmer).toBeVisible();
  await expect(programmer).not.toHaveAttribute("data-panel-edge");
  await expect(programmer).toHaveCSS("border-radius", "0px");
});
