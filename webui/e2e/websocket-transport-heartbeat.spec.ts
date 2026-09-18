// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies the live websocket transport heartbeat updates the latency metric. */
test("updates websocket latency from transport heartbeat", async ({ page }) => {
  await page.goto("/?e2e=1");

  await expect(page.getByRole("navigation", { name: "Global" })).toBeVisible();
  const latency = await page.waitForFunction(() => {
    const stores = (window as any).appStores;
    const value = stores?.wsLatency?.get();
    return typeof value === "number" && value > 0 && value < 1000
      ? value
      : undefined;
  });

  expect(await latency.jsonValue()).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        const transport =
          stores.performanceMeasureStats.get()[
            "nightfall:websocket.transport-rtt"
          ];
        const processing = stores.wsStats.get()?.worker.processing;
        return Boolean(
          transport?.count > 0 &&
            transport.p99Ms > 0 &&
            processing?.count > 0 &&
            processing.p99Ms >= processing.p95Ms &&
            processing.maxMs >= processing.p99Ms,
        );
      }),
    )
    .toBe(true);
});
