// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 2048, height: 1056 } });

/** Retires a lazy panel's original workspace, then verifies restored and new-show content without a reload. */
test("lazy panels render after layout replacement and sample show creation", async ({
  page,
}, testInfo) => {
  let releasePanel!: () => void;
  const panelReady = new Promise<void>((resolve) => {
    releasePanel = resolve;
  });
  let requestedPanel = false;
  await page.route("**/features/groups/panel.tsx*", async (route) => {
    requestedPanel = true;
    await panelReady;
    await route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.e2eAutoOpenStartupShowfile", "false");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1", {
    waitUntil: "domcontentloaded",
  });
  await waitForDockviewApp(page);
  await expect.poll(() => requestedPanel).toBe(true);
  await page.evaluate(async () => {
    const { activeLayoutId } = await import(
      /* @vite-ignore */ "/state/layout-switcher.ts"
    );
    const { activateStoredLayout } = await import(
      /* @vite-ignore */ "/lib/layout-activation.ts"
    );
    const api = (window as any).appStores.dockApi.get();
    const layoutId = activeLayoutId.get();
    if (
      !layoutId ||
      !(await activateStoredLayout(api, layoutId, { reset: true }))
    ) {
      throw new Error("Could not reset the active workspace");
    }
  });
  await expect(page.locator("[data-layout-workspace]")).toHaveCount(1);
  releasePanel();
  await expect(
    page.getByRole("button", { name: "Add group", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).initialGroupsPanel = (window as any).appStores.dockApi
      .get()
      .getPanel("panel-Groups");
  });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /New Showfile/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "New Showfile",
    exact: true,
  });
  await dialog.getByLabel("Show name").fill("Lazy Sample Tour");
  await dialog.getByRole("checkbox", { name: "Include sample data" }).check();
  await dialog.getByRole("button", { name: "Create Show" }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const panel = (window as any).appStores.dockApi
          .get()
          ?.getPanel("panel-Groups");
        return !!panel && panel !== (window as any).initialGroupsPanel;
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Add group", exact: true }),
  ).toBeVisible();
  const groupLabel = await page.evaluate(() => {
    const group = Object.values(
      (window as any).appStores.groups.get(),
    )[0] as any;
    return group.identifiers.label as string;
  });
  await expect(
    page.getByText(groupLabel, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Collapse controls", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Lo-fi", { exact: true })).toBeVisible();
  await expect(page.getByText("Rap", { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-panel-id="panel-Visualizer"]:visible')
      .getByText(/^\d+ FPS$/),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sample-panels-without-refresh.png"),
  });
});
