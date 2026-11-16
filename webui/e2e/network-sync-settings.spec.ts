// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the sync fields from the backend's latest IO settings snapshot. */
async function storedSync(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const io = (window as any).appStores.settings.get().io;
    return {
      artnet: io.artnet_sync_enabled,
      sacn: io.sacn_sync_enabled,
      universe: io.sacn_sync_universe,
    };
  });
}

/**
 * The Network tab turns Art-Net and sACN sync on, and the sACN sync universe field is only
 * editable while sACN sync is on, with the backend clamping it to the sACN universe range.
 */
test("turns on Art-Net and sACN sync from the Network settings tab", async ({
  page,
  backendSlot,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();

  const artnetSync = dialog.getByRole("switch", { name: "Art-Net sync" });
  const sacnSync = dialog.getByRole("switch", {
    name: "sACN sync",
    exact: true,
  });
  const universe = dialog.getByLabel("sACN sync universe");
  await expect(artnetSync).not.toBeChecked();
  await expect(sacnSync).not.toBeChecked();
  await expect(universe).toBeDisabled();
  await expect(universe).toHaveValue("1");
  await expect
    .poll(() => storedSync(page))
    .toEqual({ artnet: false, sacn: false, universe: 1 });
  await dialog.screenshot({ path: testInfo.outputPath("sync-off.png") });

  await artnetSync.click();
  await sacnSync.click();
  await expect(artnetSync).toBeChecked();
  await expect(sacnSync).toBeChecked();
  await expect(universe).toBeEnabled();

  await universe.fill("7000");
  await universe.press("Enter");
  await expect
    .poll(() => storedSync(page))
    .toEqual({ artnet: true, sacn: true, universe: 7000 });

  await universe.fill("65000");
  await universe.press("Enter");
  await expect.poll(() => storedSync(page)).toMatchObject({ universe: 63999 });
  await expect(universe).toHaveValue("63999");

  await universe.fill("7000");
  await universe.press("Enter");
  await expect(universe).toHaveValue("7000");
  await universe.scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: testInfo.outputPath("sync-on.png") });
});
