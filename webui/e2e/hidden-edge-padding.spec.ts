// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks workspace spacing as the last tab leaves and returns to each edge. */
test("empty hidden edges add padding only on the left and right", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const host = page.getByTestId("dockview-host");

  for (const edge of ["left", "right", "bottom"] as const) {
    await expect(host).toHaveCSS(edge, "0px");
    const moved = await page.evaluate((edge) => {
      const api = (window as any).appStores.dockApi.get();
      const edgeGroup = api.getEdgeGroup(edge);
      const group = api.groups.find(
        (candidate: { id: string }) => candidate.id === edgeGroup.id,
      );
      const panels = group.panels.map((panel: { id: string }) => panel.id);
      for (const id of panels) {
        api.getPanel(id).api.moveTo({
          group: api.getPanel("panel-FixtureGrid").api.group,
          position: "center",
        });
      }
      return { groupId: group.id, panels };
    }, edge);
    await expect(host).toHaveCSS(edge, edge === "bottom" ? "0px" : "16px");
    await page.screenshot({ path: testInfo.outputPath(`${edge}-empty.png`) });

    await page.evaluate(
      ({ edge, moved }) => {
        const api = (window as any).appStores.dockApi.get();
        api.setEdgeGroupVisible(edge, true);
        for (const id of moved.panels) {
          api.getPanel(id).api.moveTo({
            group: api.groups.find(
              (candidate: { id: string }) => candidate.id === moved.groupId,
            ),
            position: "center",
          });
        }
        api.getEdgeGroup(edge).collapse();
      },
      { edge, moved },
    );
    await expect(host).toHaveCSS(edge, "0px");
  }
});
