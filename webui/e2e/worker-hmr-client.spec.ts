// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Request } from "@playwright/test";
import { REQUIRES_DEV_SERVER, servesE2eBuild } from "./app-hooks";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Dev server URLs the app's `?worker` and `new URL(...)` imports spawn workers from. */
const WORKER_ENTRIES = [
  "/lib/engine-runtime-worker.ts?worker_file&type=module",
  "/features/visualizer/rendering/renderers/worker-renderer.ts?worker_file&type=module",
];

/** How long the worker's module graph must go without a new request to count as loaded. */
const QUIET_MS = 1_000;

/**
 * Keeps Vite's HMR client out of worker module graphs. A worker that loads it
 * applies CSS hot updates by querying `document`, which workers lack, so every
 * stylesheet edit raised uncaught rejections the app reported as errors. Each
 * worker starts from a static asset page, which loads no Vite client itself,
 * so any request for it comes from the worker's own imports.
 */
test("app workers do not load Vite's HMR client", async ({ page }) => {
  test.skip(servesE2eBuild, REQUIRES_DEV_SERVER);

  for (const entry of WORKER_ENTRIES) {
    await page.goto("/logo.svg");
    const requested: string[] = [];
    const pending = new Set<Request>();
    let lastActivity = Date.now();
    /** Records a request and marks the module graph as still loading. */
    const onRequest = (request: Request) => {
      requested.push(new URL(request.url()).pathname);
      pending.add(request);
      lastActivity = Date.now();
    };
    /** Marks a request as settled, whether it loaded or failed. */
    const onSettled = (request: Request) => {
      pending.delete(request);
      lastActivity = Date.now();
    };
    page.on("request", onRequest);
    page.on("requestfinished", onSettled);
    page.on("requestfailed", onSettled);

    await page.evaluate((url) => {
      new Worker(url, { type: "module" });
    }, entry);
    await expect
      .poll(
        () =>
          requested.includes("/lib/logger.ts") &&
          pending.size === 0 &&
          Date.now() - lastActivity >= QUIET_MS,
        { message: `${entry} finished loading its modules`, timeout: 60_000 },
      )
      .toBe(true);
    expect(
      requested.filter((path) => path.startsWith("/@vite/client")),
      `${entry} must not import /@vite/client`,
    ).toEqual([]);

    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
  }
});
