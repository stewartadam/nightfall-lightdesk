// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const VISUALIZER_PANEL_ID = "panel-Visualizer";

/** Counts visualizer renderer workers the page creates. */
async function trackVisualizerWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { created: 0 };
    (window as any).__visualizerWorkerCount = state;
    /** Counts each visualizer renderer worker as it is created. */
    class CountingWorker extends NativeWorker {
      /** Records creation of visualizer renderer workers. */
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (String(scriptURL).includes("worker-renderer")) state.created += 1;
      }
    }
    window.Worker = CountingWorker;
    window.localStorage.clear();
  });
}

/** Reads whether the panel's current renderer runs in a worker. */
function readUsingWorker(page: Page): Promise<boolean | undefined> {
  return page.evaluate(
    (panelId) => (window as any).visualizerApis?.[panelId]?.isUsingWorker(),
    VISUALIZER_PANEL_ID,
  );
}

/**
 * Breaks only worker renderers: the panel restarts the worker renderer once,
 * then moves to the main-thread renderer when the restart fails too, and keeps
 * drawing there without showing an error.
 */
test("a failing worker renderer restarts once, then falls back to the main thread", async ({
  page,
}, testInfo) => {
  await trackVisualizerWorkers(page);
  await page.goto(
    "/?e2e=1&visualizer:offscreenCanvas=true&visualizer:simulateFailure=render-worker",
  );
  await waitForDockviewApp(page);
  await expect.poll(() => readUsingWorker(page)).toBe(true);

  await expect
    .poll(() => readUsingWorker(page), { timeout: 90_000 })
    .toBe(false);
  expect(
    await page.evaluate(() => (window as any).__visualizerWorkerCount.created),
  ).toBeGreaterThanOrEqual(2);

  await expect(
    page.getByRole("img", { name: "3D visualizer viewport" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: /Visualizer (failed|stopped)/ }),
  ).toHaveCount(0);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).appStores.visualizerStats.get()?.renderMode,
        ),
      { timeout: 30_000 },
    )
    .toBe("main-thread");
  await page.screenshot({
    path: testInfo.outputPath("fell-back-to-main-thread.png"),
  });
});

for (const failure of ["render", "device-lost"] as const) {
  /**
   * Breaks every renderer: after the worker restart, the main-thread fallback
   * and its restart all fail, the panel stops retrying and shows the error with
   * a Retry button instead of throwing on every frame.
   */
  test(`a visualizer that keeps failing (${failure}) shows the error with Retry`, async ({
    page,
  }, testInfo) => {
    await trackVisualizerWorkers(page);
    await page.goto(
      `/?e2e=1&visualizer:offscreenCanvas=true&visualizer:simulateFailure=${failure}`,
    );
    await waitForDockviewApp(page);

    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Visualizer stopped" });
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(alert).toContainText(
      failure === "render"
        ? "Simulated visualizer render failure"
        : "GPU device lost",
    );
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "3D visualizer viewport" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`gave-up-${failure}.png`),
    });

    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(
      page.getByRole("img", { name: "3D visualizer viewport" }),
    ).toBeVisible();
  });
}
