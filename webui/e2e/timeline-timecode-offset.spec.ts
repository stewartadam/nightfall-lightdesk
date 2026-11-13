// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import type { Locator, Page } from "./playwright-fixtures";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CUE_UID = "c9710000000000000000000000000001";
const SEQUENCE_UID = "c9710000000000000000000000000002";
const SETUP_CUE_UID = "c9710000000000000000000000000003";
const RELEASE_CUE_UID = "c9710000000000000000000000000004";
const CLIP_UID = "c9710000000000000000000000000005";
const TIMECODE_UID = "c9710000000000000000000000000006";
const TIMELINE_UID = "c9710000000000000000000000000007";
const TIMECODE_ID = 971;
const TIMELINE_ID = 971;
const TRACK_ID = "offset-track";
const ACTION_ID = "offset-start";
const TIMECODE_START_SECS = 10;
const ACTION_SECS = 2;

test.describe.configure({ timeout: 120_000 });

/** Sends one correlated backend command and rejects a failed outcome. */
async function sendCommand(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(async (message) => {
    const stores = (window as any).appStores;
    return stores.sendAndAwait(message);
  }, data);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds one empty manual cue for a sequence step or setup/release slot. */
function emptyCue(id: number, uid: string, label: string): object {
  return {
    identifiers: { id, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the one-step sequence the timeline action starts. */
function sequence(): object {
  const zero = { type: "Fixed", data: { secs: 0, nanos: 0 } };
  return {
    identifiers: { id: 971, uid: SEQUENCE_UID, label: "Offset" },
    steps: [CUE_UID],
    wrap: false,
    release_on_start: false,
    setup_cue: emptyCue(0, SETUP_CUE_UID, "Setup"),
    release_cue: emptyCue(0, RELEASE_CUE_UID, "Release"),
    default_timing: {
      delay_in: zero,
      fade_in: zero,
      curve_in: "Linear",
      delay_out: zero,
      fade_out: zero,
      curve_out: "Linear",
    },
    tracking_mode: { type: "Inherit" },
  };
}

/**
 * Builds a timeline that starts 10 s into its timecode, with one action 2 s into the
 * timeline and a loop from 2 s to 4 s that is off until a test enables it.
 */
function timeline(loopEnabled: boolean): object {
  return {
    identifiers: { id: TIMELINE_ID, uid: TIMELINE_UID, label: "Offset" },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: TIMECODE_START_SECS, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: "",
    audio_enabled: false,
    nondeterministic_seek_behavior: "Ignore",
    lookahead: "disabled",
    loop_range: {
      start: { secs: 2, nanos: 0 },
      end: { secs: 4, nanos: 0 },
      enabled: loopEnabled,
    },
    tracks: [
      {
        id: TRACK_ID,
        label: "Offset",
        muted: false,
        solo: false,
        expanded: false,
        automation_lanes: [],
        actions: [
          {
            id: ACTION_ID,
            label: "Start Offset",
            position: { secs: ACTION_SECS, nanos: 0 },
            duration: { secs: 0, nanos: 0 },
            action: { id: "clip.start", arguments: { clip: CLIP_UID } },
          },
        ],
      },
    ],
    markers: [],
    regions: [],
    bpm: 120,
    beats_per_bar: 4,
    use_beat_grid: false,
    scroll_mode: "free",
  };
}

/** Opens a blank backend, stores the clip, timecode and offset timeline, and opens it. */
async function openOffsetTimeline(page: Page, backendPort: number) {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () => typeof (window as any).appStores?.sendAndAwait === "function",
  );

  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: emptyCue(1, CUE_UID, "Look") },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequence() },
  });
  await sendCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StoreClip",
      data: {
        identifiers: { id: 971, uid: CLIP_UID, label: "Offset Clip" },
        source: { type: "Sequence", data: SEQUENCE_UID },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      },
    },
  });
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: {
      type: "StoreTimecode",
      data: {
        identifiers: { id: TIMECODE_ID, uid: TIMECODE_UID, label: "Offset" },
        rate: "Fps30",
        source: "Internal",
      },
    },
  });
  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "StoreTimeline", data: timeline(false) },
  });

  await page.evaluate((uid) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.addPanel({
      id: `e2e-timecode-offset-${uid}`,
      component: "Timeline",
      title: "Offset",
      params: { initialTimelineUid: uid },
    });
    panel.api.setActive();
    panel.api.maximize();
  }, TIMELINE_UID);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${TIMELINE_UID}"]:visible`,
  );
  await expect(surface).toBeVisible({ timeout: 20_000 });
  return surface;
}

/** Returns the linked timecode's position in milliseconds. */
async function timecodePositionMs(page: Page) {
  return page.evaluate((uid) => {
    const state = (window as any).appStores.timecodes.get()[uid]?.[1];
    return state?.current_time
      ? state.current_time.secs * 1000 + state.current_time.nanos / 1_000_000
      : Number.NaN;
  }, TIMECODE_UID);
}

/** Returns the left edge of an element's bounding box. */
async function leftOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element is not visible");
  return box.x;
}

/**
 * Verifies a timeline starting at a timecode offset draws its actions and playhead in
 * timeline time: the playhead lines up with an action when the timecode reaches it, a ruler
 * click seeks the timecode with the offset added, and Play with a loop starts at the loop
 * start rather than before the timeline.
 */
test("timeline with a timecode offset lines actions up with the playhead", async ({
  backendSlot,
  page,
}, testInfo) => {
  const surface = await openOffsetTimeline(page, backendSlot.backendPort);
  const action = surface.locator(
    `[data-timeline-action="true"][data-action-id="${ACTION_ID}"]:not([data-drag-preview="true"])`,
  );
  const playhead = surface.locator('[data-timeline-playhead="true"]').first();
  await expect(action).toBeVisible();

  await sendCommand(page, {
    module: "TimecodeCommand",
    command: {
      type: "SeekTimecode",
      data: {
        id: TIMECODE_ID,
        position: { secs: TIMECODE_START_SECS + ACTION_SECS, nanos: 0 },
      },
    },
  });
  await expect
    .poll(async () =>
      Math.abs((await leftOf(playhead)) - (await leftOf(action))),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("offset-playhead-on-action.png"),
  });

  const ruler = surface.locator('[data-timeline-ruler="true"]').first();
  const rulerLeft = await leftOf(ruler);
  const actionLeft = await leftOf(action);
  // A click halfway between the ruler start and the action is 1 s into the timeline.
  await ruler.click({
    position: { x: (actionLeft - rulerLeft) / 2, y: 5 },
  });
  await expect
    .poll(async () =>
      Math.abs(
        (await timecodePositionMs(page)) - (TIMECODE_START_SECS + 1) * 1000,
      ),
    )
    .toBeLessThan(100);
  await page.screenshot({
    path: testInfo.outputPath("offset-ruler-seek.png"),
  });

  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "StoreTimeline", data: timeline(true) },
  });
  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "PlayTimeline", data: TIMELINE_ID },
  });
  await expect
    .poll(() => timecodePositionMs(page))
    .toBeGreaterThanOrEqual((TIMECODE_START_SECS + 2) * 1000);
  expect(await timecodePositionMs(page)).toBeLessThan(
    (TIMECODE_START_SECS + 4) * 1000,
  );
  await page.screenshot({
    path: testInfo.outputPath("offset-loop-play.png"),
  });
  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "PauseTimeline", data: TIMELINE_ID },
  });
});
