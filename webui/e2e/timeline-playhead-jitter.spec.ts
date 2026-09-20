// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Opens a blank showfile for an isolated playback timing measurement.
 */
async function openPlayheadTestApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-playhead-jitter-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");

  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();

  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
}

/**
 * Waits until app stores are exposed to the browser test page.
 */
async function waitForAppStores(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Boolean(
          (window as any).appStores?.dockApi?.get?.() &&
            (window as any).appStores?.send,
        ),
      ),
    )
    .toBe(true);
}

/** Verifies continuous forward motion between backend timecode snapshots. */
test("timeline playhead advances smoothly", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openPlayheadTestApp(page);
  await waitForAppStores(page);
  await page.evaluate(async () => {
    await (window as any).appStores.send({
      module: "DeskCommand",
      command: { type: "Eval", data: "fps 44" },
    });
  });

  const ids = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(800_000 + Math.random() * 100_000);
    const timelineId = idBase;
    const timecodeId = idBase + 1;

    await stores.send({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: {
            id: timecodeId,
            uid: timecodeUid,
            label: "Jitter Playback Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });

    await stores.send({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: {
            id: timelineId,
            uid: timelineUid,
            label: "Jitter Playback Timeline",
          },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          tracks: [],
          markers: [],
          regions: [],
          bpm: 120,
          beats_per_bar: 4,
          use_beat_grid: false,
          scroll_mode: "free",
        },
      },
    });

    return { timelineUid, timecodeUid, timelineId, timecodeId };
  });

  await expect
    .poll(async () =>
      page.evaluate(
        ({ timelineUid, timecodeUid }) => {
          const stores = (window as any).appStores;
          return Boolean(
            stores.timelines.get()[timelineUid] &&
              stores.timecodes.get()[timecodeUid],
          );
        },
        { timelineUid: ids.timelineUid, timecodeUid: ids.timecodeUid },
      ),
    )
    .toBe(true);

  await page.evaluate(({ timelineUid, timelineId }) => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: `panel-Timeline-uid-playback-${timelineUid}`,
      component: "Timeline",
      title: `Timeline ${timelineId}`,
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
  }, ids);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${ids.timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();
  await surface.getByRole("button", { name: "Play timeline" }).click();
  await page.mouse.move(0, 0);

  await expect
    .poll(async () =>
      page.evaluate((timecodeUid) => {
        const state = (window as any).appStores.timecodes.get()[
          timecodeUid
        ]?.[1];
        return state?.is_active ?? false;
      }, ids.timecodeUid),
    )
    .toBe(true);

  try {
    const samples = await page.evaluate(async (timecodeUid) => {
      const element = document.querySelector(
        '[data-timeline-playhead="true"]',
      )!;
      const samples: {
        time: number;
        left: number;
        sourceMs: number;
        fps: number;
      }[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        /** Samples the rendered playhead at the browser presentation cadence. */
        const sample = (time: number) => {
          const stores = (window as any).appStores;
          const source = stores.timecodes.get()[timecodeUid][1].current_time;
          samples.push({
            time,
            left: element.getBoundingClientRect().left,
            sourceMs: source.secs * 1000 + source.nanos / 1e6,
            fps: stores.engineMetrics.get()?.fps ?? 0,
          });
          if (time - start >= 5000) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      return samples;
    }, ids.timecodeUid);
    await test.info().attach("playhead-samples", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    const backwards = samples
      .slice(1)
      .filter((sample, index) => sample.left < samples[index].left);
    const stalls = samples
      .slice(1)
      .filter((sample, index) => sample.left === samples[index].left);
    await test.info().attach("playhead-metrics", {
      body: JSON.stringify({
        frames: samples.length,
        backwards: backwards.length,
        stalls: stalls.length,
      }),
      contentType: "application/json",
    });
    await page.screenshot({ path: test.info().outputPath("playhead.png") });
    expect(backwards.length).toBe(0);
    expect(stalls.length / samples.length).toBeLessThan(0.05);
  } finally {
    await surface
      .getByRole("button", { name: "Stop timeline", exact: true })
      .click();
  }
});
