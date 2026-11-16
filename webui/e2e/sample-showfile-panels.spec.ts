// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { lazyModuleRequest } from "./app-hooks";
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
  await page.route(
    lazyModuleRequest("features/groups/panel.tsx"),
    async (route) => {
      requestedPanel = true;
      await panelReady;
      await route.continue();
    },
  );
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.e2eAutoOpenStartupShowfile", "false");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1", {
    waitUntil: "domcontentloaded",
  });
  await waitForDockviewApp(page);
  await expect.poll(() => requestedPanel).toBe(true);
  // The workspace owner ignores activation while it is still establishing the
  // startup layout, so retry until it accepts the reset.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { activeLayoutId } = (await window.__nightfallHarness.load("app"))
          .layoutSwitcher;
        const { activateStoredLayout } = (
          await window.__nightfallHarness.load("app")
        ).layoutActivation;
        const api = (window as any).appStores.dockApi.get();
        const layoutId = activeLayoutId.get();
        return (
          !!layoutId &&
          (await activateStoredLayout(api, layoutId, { reset: true }))
        );
      }),
    )
    .toBe(true);
  await expect(page.locator("[data-layout-workspace]")).toHaveCount(1);
  releasePanel();
  await expect(
    page.getByRole("button", { name: "Add group", exact: true }),
  ).toBeVisible();
  const previousGroupUids = await page.evaluate(() =>
    Object.keys((window as any).appStores.groups.get()),
  );
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
  // The device's arrangement carries over to the new show, so its panels stay mounted.
  await expect(page.getByTestId("status-showfile-name")).toHaveText(
    "Lazy Sample Tour",
  );
  // Wait for the sample show's own groups, not ones left over from the previous show.
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const uids = Object.keys((window as any).appStores.groups.get());
        return uids.length > 0 && uids.every((uid) => !previous.includes(uid));
      }, previousGroupUids),
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
    page
      .locator("[data-clip-faders-section]")
      .getByRole("button", { name: "Faders", exact: true }),
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
