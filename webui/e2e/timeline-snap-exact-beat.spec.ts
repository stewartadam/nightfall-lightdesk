// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const BPM = 128;
const BEAT_MS = 60000 / BPM;
/** First detected beat, deliberately off the 0 ms grid. */
const ANCHOR_MS = 237;
const MARKER_COUNT = 4;
const ZOOM = 100;
const ACTION_ID = "e2e-snap-action";

/** Returns the exact time of beat `index` counted from the detected beatgrid anchor. */
function beatMs(index: number): number {
  return ANCHOR_MS + index * BEAT_MS;
}

/** Converts a stored timeline duration into milliseconds. */
function durationMs(duration: { secs: number; nanos: number }): number {
  return duration.secs * 1000 + duration.nanos / 1_000_000;
}

/**
 * Adds a 128 BPM timeline whose detected beatgrid starts at 237 ms, with
 * one action at 500 ms, to the open show and opens it in a Timeline panel.
 */
async function openBeatgridTimeline(page: Page): Promise<string> {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);

  const markerTimes = Array.from({ length: MARKER_COUNT }, (_, index) =>
    beatMs(index),
  );
  const timelineUid = await page.evaluate(
    async ({ markerTimes, bpm, actionId }) => {
      const stores = (window as any).appStores;
      const timelineUid = crypto.randomUUID().replaceAll("-", "");
      const timecodeUid = crypto.randomUUID().replaceAll("-", "");
      const existingIds = [
        ...Object.values(stores.timelines.get()).map(
          (timeline: any) => timeline.identifiers.id,
        ),
        ...Object.values(stores.timecodes.get()).map(
          (timecode: any) => timecode[0].identifiers.id,
        ),
      ];
      const id = Math.max(0, ...existingIds) + 1;
      const label = `Snap Timeline ${id}`;
      /** Converts milliseconds into a backend duration. */
      const duration = (ms: number) => ({
        secs: Math.trunc(ms / 1000),
        nanos: Math.round((ms % 1000) * 1_000_000),
      });

      await stores.send({
        module: "TimecodeCommand",
        command: {
          type: "StoreTimecode",
          data: {
            identifiers: { id, uid: timecodeUid, label },
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
            identifiers: { id, uid: timelineUid, label },
            timecode_uid: timecodeUid,
            timecode_start: { secs: 0, nanos: 0 },
            audio_path: "",
            audio_enabled: false,
            end_time: null,
            trigger_mode: "FollowTimecode",
            seek_behavior: "ReconstructState",
            nondeterministic_seek_behavior: "Ignore",
            stop_behavior: "ResetAndReleaseOwnedActions",
            lookahead: "disabled",
            tracks: [
              {
                id: `e2e-snap-track-${timelineUid}`,
                label: "Snap Track",
                muted: false,
                solo: false,
                expanded: false,
                actions: [
                  {
                    id: actionId,
                    label: "Snap Me",
                    position: duration(500),
                    duration: { secs: 0, nanos: 0 },
                    action: { id: "programmer.clear", arguments: {} },
                  },
                ],
                automation_lanes: [],
              },
            ],
            markers: [],
            regions: [],
            loop_range: null,
            bpm,
            beats_per_bar: 4,
            use_beat_grid: true,
            beatgrid: {
              source: "manual",
              audio_fingerprint: "",
              bpm,
              beats_per_bar: 4,
              markers: markerTimes.map((ms, index) => ({
                time: duration(ms),
                beat_index: index,
                is_downbeat: index % 4 === 0,
              })),
              confidence: 1,
            },
            scroll_mode: "free",
          },
        },
      });
      return timelineUid;
    },
    { markerTimes, bpm: BPM, actionId: ACTION_ID },
  );

  await expect
    .poll(() =>
      page.evaluate(
        (uid) => Boolean((window as any).appStores.timelines.get()[uid]),
        timelineUid,
      ),
    )
    .toBe(true);

  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const panel = api.addPanel({
      id: `e2e-snap-timeline-${uid}`,
      component: "Timeline",
      title: "Snap Timeline",
      params: { initialTimelineUid: uid },
      position: { referencePanel: "panel-Groups", direction: "within" },
    });
    panel.api.setActive();
    panel.focus();
  }, timelineUid);

  return timelineUid;
}

/** Sets the timeline zoom and turns snapping on, so placements snap to the beatgrid. */
async function enableSnapAtZoom(page: Page, surface: Locator) {
  const zoom = surface.getByRole("textbox", { name: "Timeline zoom" });
  await zoom.fill(String(ZOOM));
  await zoom.press("Tab");
  await expect(zoom).toHaveValue(String(ZOOM));
  const snap = page
    .locator('[data-timeline-toolbar="true"]')
    .getByRole("button", { name: "Snap", exact: true });
  await snap.click();
  await expect(snap).toHaveAttribute("aria-pressed", "true");
}

/** Reads the stored positions, in milliseconds, of every action on the timeline. */
async function storedActionPositions(
  page: Page,
  timelineUid: string,
): Promise<Record<string, number>> {
  const positions = await page.evaluate((uid) => {
    const timeline = (window as any).appStores.timelines.get()[uid];
    return timeline.tracks.flatMap((track: any) =>
      track.actions.map((action: any) => [action.id, action.position]),
    );
  }, timelineUid);
  return Object.fromEntries(
    positions.map(
      ([id, position]: [string, { secs: number; nanos: number }]) => [
        id,
        durationMs(position),
      ],
    ),
  );
}

/**
 * Verifies a snapped drag stores the exact beat time past the detected markers. Beat 6 is
 * 3049.5 ms, which pixel-rounded snapping stored as 3050 ms.
 */
test("dragging an action with snap stores the exact beat time", async ({
  page,
}) => {
  const timelineUid = await openBeatgridTimeline(page);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await enableSnapAtZoom(page, surface);

  const action = surface.locator(
    `[data-timeline-action="true"][data-action-id="${ACTION_ID}"]:not([data-drag-preview="true"])`,
  );
  const lane = surface.locator('[data-timeline-track-lane="true"]').first();
  await expect(action).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("1-action-before-drag.png"),
  });

  const actionBox = await action.boundingBox();
  const laneBox = await lane.boundingBox();
  if (!actionBox || !laneBox) throw new Error("timeline is not visible");
  const startX = actionBox.x + 2;
  const y = actionBox.y + actionBox.height / 2;
  const targetX = laneBox.x + Math.ceil((beatMs(6) * ZOOM) / 1000);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + 5, y, { steps: 3 });
  await page.mouse.move(targetX, y, { steps: 12 });
  await page.screenshot({
    path: test.info().outputPath("2-action-dragging-onto-beat.png"),
  });
  await page.mouse.up();

  await expect
    .poll(
      async () => (await storedActionPositions(page, timelineUid))[ACTION_ID],
    )
    .toBe(beatMs(6));
  await page.screenshot({
    path: test.info().outputPath("3-action-dropped-on-beat.png"),
  });
});

/**
 * Verifies inserting an action with snap lands exactly on a detected beatgrid marker, which
 * is offset from 0 ms: insertion used to ignore the markers and round to a whole pixel.
 */
test("inserting an action with snap lands exactly on a beatgrid marker", async ({
  page,
}) => {
  const timelineUid = await openBeatgridTimeline(page);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await enableSnapAtZoom(page, surface);

  const lane = surface.locator('[data-timeline-track-lane="true"]').first();
  const markerX = Math.ceil((beatMs(2) * ZOOM) / 1000) + 1;
  await lane.click({ button: "right", position: { x: markerX, y: 18 } });
  await page
    .locator('[data-menu-kind="context"]')
    .getByRole("menuitem", { name: "Insert Action..." })
    .click();
  await page.getByPlaceholder("Insert action...").fill("Clear programmer");
  await page.keyboard.press("Enter");
  await page
    .locator("[data-insert-registered-action]")
    .getByRole("button", { name: "Insert Clear programmer" })
    .click();

  await expect
    .poll(async () =>
      Object.entries(await storedActionPositions(page, timelineUid))
        .filter(([id]) => id !== ACTION_ID)
        .map(([, positionMs]) => positionMs),
    )
    .toEqual([beatMs(2)]);
  await page.screenshot({
    path: test.info().outputPath("4-action-inserted-on-marker.png"),
  });
});
