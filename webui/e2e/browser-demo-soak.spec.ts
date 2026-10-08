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

const SOAK_DURATION_MS = 5 * 60 * 1_000;
const SAMPLE_INTERVAL_MS = 5_000;
const MAX_WASM_GROWTH_BYTES = 32 * 1024 * 1024;
/** Lo-fi timeline in the generated sample show, the one the demo opens with. */
const DEMO_TIMELINE_LABEL = "Lo-fi";

interface SoakSample {
  elapsedMs: number;
  jsHeapBytes: number | null;
  positionMs: number;
  queueDepth: number;
  wasmMemoryBytes: number;
}

interface DemoTimeline {
  uid: string;
  contentEndMs: number;
}

/** Return the URL for either embedded-demo development or deployment mode. */
function demoPath(): string {
  return process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
    ? "/demo/app/?startup:draftRecovery=false&e2e=1"
    : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1";
}

/**
 * Open the seeded timeline in a panel unless the demo layout already shows it,
 * and return the timeline with the time its last action ends, which is where
 * the loop range wraps playback.
 */
async function openDemoTimeline(page: Page): Promise<DemoTimeline> {
  await waitForDockviewApp(page);
  const timeline = await page.evaluate((label) => {
    const stores = (window as any).appStores;
    const durationMs = (duration: { secs: number; nanos: number }) =>
      duration.secs * 1_000 + duration.nanos / 1_000_000;
    const entry = Object.values(stores.timelines.get()).find(
      (candidate: any) => candidate.identifiers.label === label,
    ) as any;
    if (!entry) throw new Error("Seeded demo timeline was unavailable");
    const alreadyOpen = document.querySelector(
      `[data-timeline-surface="true"][data-timeline-uid="${entry.identifiers.uid}"]`,
    );
    if (!alreadyOpen) {
      stores.dockApi.get().addPanel({
        id: `browser-demo-soak-${entry.identifiers.uid}`,
        component: "Timeline",
        title: `${label} Timeline`,
        params: { initialTimelineUid: entry.identifiers.uid },
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
      });
    }
    const actionEnds = entry.tracks.flatMap((track: any) =>
      track.actions.map(
        (action: any) =>
          durationMs(action.position) + durationMs(action.duration),
      ),
    );
    return {
      uid: entry.identifiers.uid as string,
      contentEndMs: Math.max(...actionEnds),
    };
  }, DEMO_TIMELINE_LABEL);
  await expect(timelineSurface(page, timeline.uid)).toBeVisible();
  return timeline;
}

/** Locate the first editing surface showing one timeline. */
function timelineSurface(page: Page, timelineUid: string) {
  return page
    .locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    )
    .first();
}

/**
 * Enable a loop range covering every action, so the engine wraps playback to
 * the start instead of playing on past the last cue.
 */
async function loopWholeTimeline(page: Page, timeline: DemoTimeline) {
  await page.evaluate(
    async ({ uid, endMs }) => {
      const stores = (window as any).appStores;
      const entry = stores.timelines.get()[uid];
      const result = await stores.sendAndAwait({
        module: "TimelineCommand",
        command: {
          type: "SetTimelineLoopRange",
          data: {
            timeline_id: entry.identifiers.id,
            loop_range: {
              start: { secs: 0, nanos: 0 },
              end: {
                secs: Math.floor(endMs / 1_000),
                nanos: Math.round((endMs % 1_000) * 1_000_000),
              },
              enabled: true,
            },
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `Unable to loop demo timeline: ${JSON.stringify(result)}`,
        );
      }
    },
    { uid: timeline.uid, endMs: Math.ceil(timeline.contentEndMs) },
  );
  await expect(
    timelineSurface(page, timeline.uid).locator(
      '[data-timeline-loop-overlay="true"]',
    ),
  ).toBeVisible();
}

/**
 * Capture the playhead, live worker queue, WASM allocation, and optional
 * Chromium heap metrics.
 */
async function sampleRuntime(
  page: Page,
  timelineUid: string,
  elapsedMs: number,
): Promise<SoakSample> {
  return page.evaluate(
    ({ elapsed, uid }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const position = stores.timecodes.get()[timeline.timecode_uid]?.[1]
        ?.current_time ?? { secs: 0, nanos: 0 };
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
        positionMs: position.secs * 1_000 + position.nanos / 1_000_000,
        queueDepth: stats?.aggregate?.queueDepth ?? 0,
        wasmMemoryBytes: runtime?.wasmMemoryBytes ?? 0,
      };
    },
    { elapsed: elapsedMs, uid: timelineUid },
  );
}

/**
 * Loop the whole demo timeline for five minutes, then assert that playback
 * kept wrapping and that runtime resource use stayed bounded.
 */
test("embedded demo remains stable while looping a timeline for five minutes", async ({
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

  const timeline = await openDemoTimeline(page);
  const surface = timelineSurface(page, timeline.uid);
  await loopWholeTimeline(page, timeline);
  const samples: SoakSample[] = [];
  const startedAt = Date.now();
  const finishesAt = startedAt + SOAK_DURATION_MS;

  try {
    await surface.getByRole("button", { name: "Play timeline" }).click();
    while (Date.now() < finishesAt) {
      samples.push(
        await sampleRuntime(page, timeline.uid, Date.now() - startedAt),
      );
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

  const positions = samples.map((sample) => sample.positionMs);
  const wraps = positions.filter(
    (position, index) => index > 0 && position < positions[index - 1],
  ).length;
  // Allow for wraps that land between samples or near the run's edges.
  expect(wraps).toBeGreaterThanOrEqual(
    Math.floor(SOAK_DURATION_MS / timeline.contentEndMs / 2),
  );
  expect(Math.max(...positions)).toBeLessThanOrEqual(
    timeline.contentEndMs + 1_000,
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
