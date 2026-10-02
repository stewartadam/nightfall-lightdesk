// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 1920, height: 1080 } });
test.setTimeout(90_000);

/**
 * Long-running clip IDs the sample timelines drive. The one-shot snap and synth fill
 * clips are covered by `world_factory_sample_rap_timeline_fires_one_shot_clips`, since
 * instance snapshots are droppable and can skip sub-second instances.
 */
const CLIP = {
  pastelRainbow: 405,
  pastelPulse: 406,
  sparklesFx: 33,
  sparklesInt: 34,
} as const;

/** Opens a timeline in the default layout, next to its 3D visualizer. */
async function openTimeline(page: Page, label: string): Promise<Locator> {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    (timelineLabel) =>
      Object.values((window as any).appStores?.timelines?.get() ?? {}).some(
        (timeline: any) => timeline.identifiers.label === timelineLabel,
      ),
    label,
  );
  const timelineUid = await page.evaluate((timelineLabel) => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (entry: any) => entry.identifiers.label === timelineLabel,
    ) as any;
    const api = stores.dockApi.get();
    api.addPanel({
      id: "sample-timeline",
      component: "Timeline",
      title: timelineLabel,
      params: { initialTimelineUid: timeline.identifiers.uid },
    });
    return timeline.identifiers.uid as string;
  }, label);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible({ timeout: 30_000 });
  return surface;
}

/** Seeks the timeline's timecode so playback starts just before the moment under test. */
async function seek(page: Page, label: string, positionMs: number) {
  await page.evaluate(
    async ({ timelineLabel, nextPositionMs }) => {
      const stores = (window as any).appStores;
      const timeline = Object.values(stores.timelines.get()).find(
        (entry: any) => entry.identifiers.label === timelineLabel,
      ) as any;
      const timecode = stores.timecodes.get()[timeline.timecode_uid]?.[0];
      const result = await stores.sendAndAwait({
        module: "TimecodeCommand",
        command: {
          type: "SeekTimecode",
          data: {
            id: timecode.identifiers.id,
            position: {
              secs: Math.floor(nextPositionMs / 1_000),
              nanos: (nextPositionMs % 1_000) * 1_000_000,
            },
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`Seek failed: ${JSON.stringify(result.outcome)}`);
      }
    },
    { timelineLabel: label, nextPositionMs: positionMs },
  );
}

/** Saves a screenshot of the layout's 3D visualizer panel. */
async function captureVisualizer(page: Page, path: string): Promise<void> {
  await page
    .locator('[data-panel-id="panel-Visualizer"]:visible')
    .screenshot({ path });
}

/** Returns whether a clip currently has an active instance. */
function isActive(page: Page, clipId: number): Promise<boolean> {
  return page.evaluate(
    (id) =>
      Object.values((window as any).appStores.activeInstances.get()).some(
        (instance: any) => instance.bound_clip_id === id,
      ),
    clipId,
  );
}

/** Plays the Lo-fi groove, then its first break, and captures the sparkle over the slow rainbow. */
test("Lo-fi pulses the rainbow in the groove and sparkles in the break", async ({
  page,
}, testInfo) => {
  const surface = await openTimeline(page, "Lo-fi");
  try {
    // Give the visualizer scene time to load before the groove screenshot.
    await page.waitForTimeout(4_000);
    await surface
      .getByRole("button", { name: "Play timeline", exact: true })
      .click();
    await expect.poll(() => isActive(page, CLIP.pastelPulse)).toBe(true);
    await page.waitForTimeout(1_500);
    await captureVisualizer(page, testInfo.outputPath("lofi-groove.png"));

    await seek(page, "Lo-fi", 13_000);
    await expect
      .poll(() => isActive(page, CLIP.sparklesFx), { timeout: 5_000 })
      .toBe(true);
    await expect.poll(() => isActive(page, CLIP.sparklesInt)).toBe(true);
    await expect.poll(() => isActive(page, CLIP.pastelRainbow)).toBe(true);
    await page.waitForTimeout(1_000);
    await captureVisualizer(page, testInfo.outputPath("lofi-break.png"));

    await expect
      .poll(() => isActive(page, CLIP.sparklesFx), { timeout: 10_000 })
      .toBe(false);
  } finally {
    await surface
      .getByRole("button", { name: "Stop timeline", exact: true })
      .click();
  }
});

/** Plays the Rap timeline into section B and captures the sparkle over the sped-up rainbow. */
test("Rap opens section B with a sparkle", async ({ page }, testInfo) => {
  const surface = await openTimeline(page, "Rap");
  try {
    // Give the visualizer scene time to load before the short sparkle starts.
    await page.waitForTimeout(4_000);
    await seek(page, "Rap", 11_000);
    await surface
      .getByRole("button", { name: "Play timeline", exact: true })
      .click();
    await expect
      .poll(() => isActive(page, CLIP.sparklesFx), { timeout: 5_000 })
      .toBe(true);
    await expect.poll(() => isActive(page, CLIP.pastelRainbow)).toBe(true);
    await page.waitForTimeout(500);
    await captureVisualizer(page, testInfo.outputPath("rap-sparkle.png"));
    await expect
      .poll(() => isActive(page, CLIP.sparklesFx), { timeout: 10_000 })
      .toBe(false);
  } finally {
    await surface
      .getByRole("button", { name: "Stop timeline", exact: true })
      .click();
  }
});
