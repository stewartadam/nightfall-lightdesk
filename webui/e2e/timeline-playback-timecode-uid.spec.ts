// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Opens a unique blank showfile for a timeline playback UID scenario.
 */
async function openOwnedTimelinePlaybackApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-playback-uid-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

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

/**
 * Reads the timeline playhead's computed left offset in pixels.
 */
async function timelinePlayheadLeft(page: Page, timelineUid: string) {
  return await page
    .locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    )
    .locator('[data-timeline-playhead="true"]')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).left));
}

test("timeline playback targets linked timecode uid when numeric ids differ", async ({
  page,
}) => {
  await openOwnedTimelinePlaybackApp(page);
  await waitForAppStores(page);

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
            label: "UID Playback Timecode",
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
            label: "UID Playback Timeline",
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

  await page.evaluate(async ({ timelineId, timecodeId }) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "TimecodeCommand",
      command: { type: "StopTimecode", data: timecodeId },
    });
    await stores.send({
      module: "TimelineCommand",
      command: { type: "DeleteTimeline", data: timelineId },
    });
    await stores.send({
      module: "TimecodeCommand",
      command: { type: "DeleteTimecode", data: timecodeId },
    });
  }, ids);
});

test("deleting linked timecode stops visible timeline playhead", async ({
  page,
}) => {
  await openOwnedTimelinePlaybackApp(page);
  await waitForAppStores(page);

  const ids = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(900_000 + Math.random() * 50_000);
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
            label: "Delete Playback Timecode",
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
            label: "Delete Playback Timeline",
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
      id: `panel-Timeline-delete-playback-${timelineUid}`,
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
  const playhead = surface.locator('[data-timeline-playhead="true"]');
  await expect(playhead).toBeVisible();

  const playheadLeftBeforePlayback = await timelinePlayheadLeft(
    page,
    ids.timelineUid,
  );
  await surface.getByRole("button", { name: "Play timeline" }).click();

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
  await expect
    .poll(() => timelinePlayheadLeft(page, ids.timelineUid), {
      timeout: 10_000,
    })
    .toBeGreaterThan(playheadLeftBeforePlayback);

  await page.evaluate(async (timecodeId) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "TimecodeCommand",
      command: { type: "DeleteTimecode", data: timecodeId },
    });
  }, ids.timecodeId);

  await expect
    .poll(async () =>
      page.evaluate(
        (timecodeUid) =>
          !(window as any).appStores.timecodes.get()[timecodeUid],
        ids.timecodeUid,
      ),
    )
    .toBe(true);

  const playheadLeftAfterTimecodeDelete = await timelinePlayheadLeft(
    page,
    ids.timelineUid,
  );
  await page.waitForTimeout(250);
  await expect
    .poll(() => timelinePlayheadLeft(page, ids.timelineUid), {
      timeout: 1_000,
    })
    .toBe(playheadLeftAfterTimecodeDelete);

  await page.evaluate(async (timelineId) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "TimelineCommand",
      command: { type: "DeleteTimeline", data: timelineId },
    });
  }, ids.timelineId);
});
