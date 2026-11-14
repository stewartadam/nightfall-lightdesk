// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { dockFixturesInMainGrid, waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

/** IDs of the timeline the scenario edits. */
type ConcurrentEditFixture = {
  timelineUid: string;
  timelineId: number;
  trackId: string;
};

/** Opens the app against a fresh backend showfile and waits for awaited commands to work. */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await dockFixturesInMainGrid(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()),
  );
}

/** Creates a timeline with two empty tracks and opens it in a timeline panel. */
async function openTimelineFixture(page: Page): Promise<ConcurrentEditFixture> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const timelineId = Math.floor(960_000 + Math.random() * 20_000);
    const trackId = `e2e-concurrent-track-${Date.now()}`;
    /** Builds an empty track for the fixture timeline. */
    const track = (id: string, label: string) => ({
      id,
      label,
      muted: false,
      solo: false,
      expanded: false,
      actions: [],
      automation_lanes: [],
    });

    const results = [
      await stores.sendAndAwait({
        module: "TimecodeCommand",
        command: {
          type: "StoreTimecode",
          data: {
            identifiers: {
              id: timelineId,
              uid: timecodeUid,
              label: "E2E Concurrent Edits Timecode",
            },
            rate: "Fps30",
            source: "Internal",
          },
        },
      }),
      await stores.sendAndAwait({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: {
            identifiers: {
              id: timelineId,
              uid: timelineUid,
              label: "E2E Concurrent Edits",
            },
            timecode_uid: timecodeUid,
            timecode_start: { secs: 0, nanos: 0 },
            audio_path: "",
            tracks: [
              track(trackId, "Concurrent Track"),
              track(`${trackId}-2`, "Other Track"),
            ],
            markers: [],
            regions: [],
            bpm: 120,
            beats_per_bar: 4,
            use_beat_grid: false,
            scroll_mode: "free",
          },
        },
      }),
    ];
    for (const result of results) {
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`timeline setup failed: ${JSON.stringify(result)}`);
      }
    }
    for (let attempts = 0; attempts < 200; attempts += 1) {
      if (stores.timelines.get()[timelineUid]) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }

    stores.dockApi.get().addPanel({
      id: `e2e-concurrent-edits-${timelineUid}`,
      component: "Timeline",
      title: "Concurrent Edits",
      params: { initialTimelineUid: timelineUid },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
    return { timelineUid, timelineId, trackId };
  });
}

/** Reads what the engine stores for the fixture timeline's first track, markers and loop. */
async function storedState(page: Page, timelineUid: string) {
  return page.evaluate((uid) => {
    const timeline = (window as any).appStores.timelines.get()[uid];
    return {
      muted: timeline?.tracks?.[0]?.muted,
      markers: (timeline?.markers ?? []).map((marker: any) => marker.label),
      loopEnabled: timeline?.loop_range?.enabled ?? false,
    };
  }, timelineUid);
}

/**
 * Muting a track in the timeline panel right after another client's marker and loop range
 * reach the engine keeps them. The panel used to send the whole timeline from its local copy,
 * which didn't have the marker or loop range yet, so the mute erased them.
 */
test("a track edit keeps a marker and loop range set elsewhere", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openApp(page, backendSlot.backendPort);
  const fixture = await openTimelineFixture(page);
  const header = page.locator(
    `[data-timeline-track-header="true"][data-track-id="${fixture.trackId}"]`,
  );
  const mute = header.getByRole("button", { name: "Mute", exact: true });
  await expect(mute).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-before.png") });

  // Send the marker and loop range as another client would, then press Mute in the same task,
  // so the panel can't have received the engine's update before the mute goes out.
  await page.evaluate(
    ({ timelineId, trackId }) => {
      const stores = (window as any).appStores;
      void stores.sendAndAwait({
        module: "TimelineCommand",
        command: {
          type: "StoreTimelineMarker",
          data: {
            timeline_id: timelineId,
            marker: {
              uid: crypto.randomUUID().replace(/-/g, ""),
              label: "Drop",
              time: { secs: 2, nanos: 0 },
            },
          },
        },
      });
      void stores.sendAndAwait({
        module: "TimelineCommand",
        command: {
          type: "SetTimelineLoopRange",
          data: {
            timeline_id: timelineId,
            loop_range: {
              start: { secs: 1, nanos: 0 },
              end: { secs: 3, nanos: 0 },
              enabled: true,
            },
          },
        },
      });
      const button = document.querySelector<HTMLButtonElement>(
        `[data-timeline-track-header="true"][data-track-id="${trackId}"] button[aria-label="Mute"]`,
      );
      if (!button) throw new Error("Mute button not found");
      button.click();
    },
    { timelineId: fixture.timelineId, trackId: fixture.trackId },
  );

  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: true, markers: ["Drop"], loopEnabled: true });
  await expect(
    header.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-timeline-marker="true"]', { hasText: "Drop" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("2-after-mute.png") });

  // Undoing the mute restores only the mute; the marker and loop range stay.
  await page.getByRole("button", { name: /Undo: Edit Track/ }).click();
  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: false, markers: ["Drop"], loopEnabled: true });
  await expect(mute).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("3-after-undo.png") });
});
