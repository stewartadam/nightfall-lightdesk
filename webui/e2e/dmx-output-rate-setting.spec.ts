// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the DMX output rate from the backend's latest IO settings snapshot. */
async function storedRate(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => (window as any).appStores.ioSettings.get().dmx_output_rate_hz,
  );
}

/** The Network tab edits the showfile's DMX output rate, and the backend clamps it to 60 Hz. */
test("sets and clamps the DMX output rate from the Network settings tab", async ({
  page,
  backendSlot,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();
  const rate = dialog.getByLabel("DMX output rate (Hz)");
  await expect(rate).toHaveValue("44");
  await expect.poll(() => storedRate(page)).toBe(44);

  await rate.fill("30");
  await rate.press("Enter");
  await expect.poll(() => storedRate(page)).toBe(30);
  await expect(rate).toHaveValue("30");
  await dialog.screenshot({ path: testInfo.outputPath("dmx-output-rate.png") });

  await rate.fill("500");
  await rate.press("Enter");
  await expect.poll(() => storedRate(page)).toBe(60);
  await expect(rate).toHaveValue("60");

  // Clamping back to the rate already stored must still replace the typed value.
  await rate.fill("90");
  await rate.press("Enter");
  await expect(rate).toHaveValue("60");

  // A cleared field restores the stored rate instead of staying empty.
  await rate.fill("");
  await rate.press("Enter");
  await expect(rate).toHaveValue("60");
  expect(await storedRate(page)).toBe(60);
});
