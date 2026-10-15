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

const SEQUENCE_ID = 963;
const SEQUENCE_UID = "c9630000000000000000000000000001";
const SETUP_CUE_UID = "c9630000000000000000000000000002";
const RELEASE_CUE_UID = "c9630000000000000000000000000003";
const CUE_UIDS = [
  "c9630000000000000000000000000011",
  "c9630000000000000000000000000012",
  "c9630000000000000000000000000013",
];
const CLIP_ID = 963;
const CLIP_UID = "c9630000000000000000000000000004";
const TIMECODE_UID = "c9630000000000000000000000000005";
const TIMELINE_ID = 963;
const TIMELINE_UID = "c9630000000000000000000000000006";
const TRACK_ID = "go-label-track";
const GO_A_ID = "go-label-go-a";
const GO_B_ID = "go-label-go-b";

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

/** Builds the three-step non-wrapping sequence advanced by the timeline Go actions. */
function sequence(): object {
  const zero = { type: "Fixed", data: { secs: 0, nanos: 0 } };
  return {
    identifiers: { id: SEQUENCE_ID, uid: SEQUENCE_UID, label: "Go Labels" },
    steps: CUE_UIDS,
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

/** Builds a timeline action at a whole-second position. */
function timelineAction(id: string, second: number, action: object): object {
  return {
    id,
    label: "Exec 963: Go Labels Clip",
    position: { secs: second, nanos: 0 },
    duration: { secs: 0, nanos: 0 },
    action,
  };
}

/** Builds a timeline that starts the clip and then advances it twice. */
function timeline(): object {
  return {
    identifiers: { id: TIMELINE_ID, uid: TIMELINE_UID, label: "Go Labels" },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: "",
    audio_enabled: false,
    nondeterministic_seek_behavior: "Ignore",
    lookahead: "disabled",
    tracks: [
      {
        id: TRACK_ID,
        label: "Sequence",
        muted: false,
        solo: false,
        expanded: false,
        automation_lanes: [],
        actions: [
          timelineAction("go-label-start", 1, {
            id: "clip.start",
            arguments: { clip: CLIP_UID },
          }),
          timelineAction(GO_A_ID, 2, {
            id: "clip.go",
            arguments: { clip: CLIP_UID },
          }),
          timelineAction(GO_B_ID, 3, {
            id: "clip.go",
            arguments: { clip: CLIP_UID },
          }),
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

/** Opens a blank backend, stores the sequence, clip and timeline, and opens the timeline. */
async function openGoLabelTimeline(page: Page, backendPort: number) {
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

  for (const [index, uid] of CUE_UIDS.entries()) {
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: emptyCue(index + 1, uid, `Look ${index + 1}`),
      },
    });
  }
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequence() },
  });
  await sendCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StoreClip",
      data: {
        identifiers: { id: CLIP_ID, uid: CLIP_UID, label: "Go Labels Clip" },
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
        identifiers: { id: TIMELINE_ID, uid: TIMECODE_UID, label: "Go Labels" },
        rate: "Fps30",
        source: "Internal",
      },
    },
  });
  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "StoreTimeline", data: timeline() },
  });

  await page.evaluate((uid) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.addPanel({
      id: `e2e-go-label-${uid}`,
      component: "Timeline",
      title: "Go Labels",
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

/** Returns the rendered, non-preview chip for a timeline action. */
function actionChip(surface: Locator, actionId: string): Locator {
  return surface.locator(
    `[data-timeline-action="true"][data-track-id="${TRACK_ID}"][data-action-id="${actionId}"]:not([data-drag-preview="true"])`,
  );
}

/** Drags an action chip horizontally by a pixel offset along its track. */
async function dragActionBy(page: Page, chip: Locator, offsetPx: number) {
  const box = await chip.boundingBox();
  if (!box) throw new Error("Action chip is not visible");
  const startX = box.x + Math.min(12, box.width / 2);
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 5, startY, { steps: 3 });
  await page.mouse.move(startX + offsetPx, startY, { steps: 12 });
  await page.mouse.up();
}

/** Verifies a Go chip's cue number follows the action after it is dragged past another Go. */
test("timeline Go label follows its position after dragging", async ({
  backendSlot,
  page,
}, testInfo) => {
  const surface = await openGoLabelTimeline(page, backendSlot.backendPort);
  const goA = actionChip(surface, GO_A_ID);
  const goB = actionChip(surface, GO_B_ID);

  await expect(goA).toContainText(`Go ${SEQUENCE_ID}.2: Go Labels Clip`);
  await expect(goB).toContainText(`Go ${SEQUENCE_ID}.3: Go Labels Clip`);
  await page.screenshot({ path: testInfo.outputPath("go-labels-before.png") });

  const goABox = await goA.boundingBox();
  const goBBox = await goB.boundingBox();
  if (!goABox || !goBBox) throw new Error("Go chips are not visible");
  await dragActionBy(page, goA, 2 * (goBBox.x - goABox.x));

  await expect(goA).toContainText(`Go ${SEQUENCE_ID}.3: Go Labels Clip`);
  await expect(goB).toContainText(`Go ${SEQUENCE_ID}.2: Go Labels Clip`);
  await page.screenshot({ path: testInfo.outputPath("go-labels-after.png") });
});
