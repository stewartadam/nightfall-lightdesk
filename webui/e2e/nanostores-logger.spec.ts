// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies Nano Store logger modules follow runtime nightfallLog configuration. */
test("nanostores logger supports root and store-level toggles", async ({
  page,
}) => {
  await page.goto("/?e2e=nanostores-logger");
  await expect(page.locator("main#app")).toBeVisible();

  await page.evaluate(() => {
    window.nightfallLog.configure("info,nanostores:serverVersion=trace");
  });
  const targetedConfig = await page.evaluate(() =>
    window.nightfallLog.getConfig(),
  );
  expect(targetedConfig.defaultLevel).toBe("info");
  expect(targetedConfig.moduleOverrides["nanostores:serverversion"]).toBe(
    "trace",
  );

  await page.evaluate(() => {
    window.nightfallLog.configure("info,nanostores=trace");
  });
  const rootConfig = await page.evaluate(() => window.nightfallLog.getConfig());
  expect(rootConfig.defaultLevel).toBe("info");
  expect(rootConfig.moduleOverrides.nanostores).toBe("trace");

  await page.evaluate(() => {
    window.nightfallLog.configure("info");
  });
  const resetConfig = await page.evaluate(() =>
    window.nightfallLog.getConfig(),
  );
  expect(resetConfig.defaultLevel).toBe("info");
  expect(resetConfig.moduleOverrides).toEqual({});
});
