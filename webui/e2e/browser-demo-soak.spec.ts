// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const SOAK_DURATION_MS = 15 * 60 * 1_000;
const SAMPLE_INTERVAL_MS = 5_000;
const ACTIVITY_INTERVAL_MS = 60_000;
const MAX_WASM_GROWTH_BYTES = 32 * 1024 * 1024;

interface SoakSample {
  elapsedMs: number;
  jsHeapBytes: number | null;
  queueDepth: number;
  wasmMemoryBytes: number;
}

/** Return the URL for either embedded-demo development or deployment mode. */
function demoPath(): string {
  return process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
    ? "/demo/app/?startup:draftRecovery=false&e2e=1"
    : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1";
}

/** Open the seeded timeline panel and return its visible timeline surface. */
async function openDemoTimeline(page: Page) {
  await waitForDockviewApp(page);
  const timelineUid = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (candidate: any) => candidate.identifiers.label === "Nightfall Demo",
    ) as any;
    if (!timeline) throw new Error("Seeded demo timeline was unavailable");
    stores.dockApi.get().addPanel({
      id: `browser-demo-soak-${timeline.identifiers.uid}`,
      component: "Timeline",
      title: "Nightfall Demo Timeline",
      params: { initialTimelineUid: timeline.identifiers.uid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    return timeline.identifiers.uid;
  });
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  return surface;
}

/** Capture live worker queue, WASM allocation, and optional Chromium heap metrics. */
async function sampleRuntime(
  page: Page,
  elapsedMs: number,
): Promise<SoakSample> {
  return page.evaluate((elapsed) => {
    const stores = (window as any).appStores;
    const runtime = stores.browserDemoRuntimeInfo.get();
    const stats = stores.wsStats.get();
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize: number };
      }
    ).memory;
    return {
      elapsedMs: elapsed,
      jsHeapBytes: memory?.usedJSHeapSize ?? null,
      queueDepth: stats?.aggregate?.queueDepth ?? 0,
      wasmMemoryBytes: runtime?.wasmMemoryBytes ?? 0,
    };
  }, elapsedMs);
}

/** Exercise playback over fifteen minutes and assert bounded runtime resource use. */
test("embedded demo remains stable during a fifteen-minute playback soak", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_BROWSER_DEMO_SOAK !== "1",
    "Set NIGHTFALL_BROWSER_DEMO_SOAK=1 to run the extended browser-demo soak.",
  );
  test.setTimeout(SOAK_DURATION_MS + 90_000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(demoPath());
  await expect(page.getByTestId("browser-demo-banner")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as any).appStores?.browserDemoRuntimeInfo?.get?.()
            ?.wasmMemoryBytes,
        ),
      ),
    )
    .toBe(true);

  const surface = await openDemoTimeline(page);
  const samples: SoakSample[] = [];
  const startedAt = Date.now();
  const finishesAt = startedAt + SOAK_DURATION_MS;
  let nextActivityAt = startedAt;

  try {
    while (Date.now() < finishesAt) {
      if (Date.now() >= nextActivityAt) {
        await surface.getByRole("button", { name: "Play timeline" }).click();
        await page.waitForTimeout(1_500);
        await surface.getByRole("button", { name: "Stop timeline" }).click();
        nextActivityAt += ACTIVITY_INTERVAL_MS;
      }
      samples.push(await sampleRuntime(page, Date.now() - startedAt));
      await page.waitForTimeout(
        Math.min(SAMPLE_INTERVAL_MS, Math.max(0, finishesAt - Date.now())),
      );
    }
  } finally {
    if (!page.isClosed()) {
      const stopButton = surface.getByRole("button", { name: "Stop timeline" });
      if (await stopButton.isVisible()) await stopButton.click();
    }
  }

  await writeFile(
    testInfo.outputPath("browser-demo-soak.json"),
    JSON.stringify({ durationMs: Date.now() - startedAt, samples }, null, 2),
  );

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(Math.max(...samples.map((sample) => sample.queueDepth))).toBeLessThan(
    100,
  );
  const wasmSizes = samples.map((sample) => sample.wasmMemoryBytes);
  expect(Math.min(...wasmSizes)).toBeGreaterThan(0);
  expect(Math.max(...wasmSizes) - Math.min(...wasmSizes)).toBeLessThanOrEqual(
    MAX_WASM_GROWTH_BYTES,
  );
});
