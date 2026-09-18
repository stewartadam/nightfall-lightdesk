// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";

/**
 * Verifies a restored cue editor can mount before cue data has hydrated.
 */
test("cue editor reloads without crashing while cue data is loading", async ({
  backendSlot,
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.dockApi?.get?.()),
  );

  await page.evaluate(() => {
    const panelId = "panel-CueEditor-loading-refresh-e2e";
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: "Cue Loading Refresh E2E",
      params: {
        initialPanelId: panelId,
        initialCueUid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      },
    });
  });

  await expect(
    page.getByText("Cue Loading Refresh E2E", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();

  await expect(page.getByText("Error rendering component")).toHaveCount(0);
  expect(runtimeErrors).not.toContainEqual(
    expect.stringContaining("addEventListener"),
  );
});
