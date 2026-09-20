// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSilentWavBuffer } from "./audio-fixture";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CUE_ID = 96_400;
const TIMECODE_ID = 96_400;
const TIMELINE_ID = 96_400;
const CUE_UID = "c7500000000000000000000000000001";
const TIMECODE_UID = "c7500000000000000000000000000002";
const TIMELINE_UID = "c7500000000000000000000000000003";
const BASE_TRACK_ID = "owned-operator-base-track";
const BASE_ITEM_ID = "owned-operator-base-item";
const DRAG_TRACK_ID = "owned-operator-drag-track";
const DRAG_ITEM_ID = "owned-operator-drag-item";
const DENSE_TRACK_ID = "owned-operator-dense-track";
const DENSE_NEW_ITEM_ID = "owned-operator-dense-new-item";

/** Exercises parameter lane creation, cancellation, deletion, and backend persistence. */
test("parameter lane controls persist additions and deletions", async ({
  page,
}, testInfo) => {
  await openFirstTimeline(page);
  const header = page.locator(
    `[data-timeline-track-header="true"][data-track-id="${BASE_TRACK_ID}"]`,
  );
  const add = header.getByRole("button", {
    name: "Add parameter lane",
    exact: true,
  });
  await expect(add).toBeVisible();
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Add parameter lane" });
  await expect(
    dialog.getByRole("button", { name: "Add lane", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Parameter type").selectOption("RateMaster");
  await expect(
    dialog.getByText("Create a clip to add a clip rate lane."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add lane", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await add.click();
  await dialog.getByLabel("Variable name").fill("  lane-test-variable  ");
  await dialog.getByLabel("Lane name (optional)").fill("Test parameter curve");
  await page.screenshot({
    path: testInfo.outputPath("parameter-lane-dialog.png"),
  });
  await dialog.getByRole("button", { name: "Add lane", exact: true }).click();
  const remove = header.getByRole("button", {
    name: "Delete parameter lane Test parameter curve",
    exact: true,
  });
  await expect(remove).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const timeline = (window as any).appStores.timelines.get()[uid];
        return timeline.tracks[0].automation_lanes.map((lane: any) => ({
          name: lane.name,
          target: lane.parameter_type,
        }));
      }, TIMELINE_UID),
    )
    .toEqual([
      {
        name: "Owned Operator Curve",
        target: { type: "GlobalVariable", data: "owned-operator-variable" },
      },
      {
        name: "Test parameter curve",
        target: { type: "GlobalVariable", data: "lane-test-variable" },
      },
    ]);
  await page.screenshot({
    path: testInfo.outputPath("parameter-lane-controls.png"),
  });

  await page.reload();
  await waitForDockviewApp(page);
  await openFirstTimeline(page);
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(remove).not.toBeVisible();
  await page.getByRole("button", { name: /Undo: Store Timeline/ }).click();
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(remove).not.toBeVisible();
  await header
    .getByRole("button", {
      name: "Delete parameter lane Owned Operator Curve",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) =>
          (window as any).appStores.timelines.get()[uid].tracks[0]
            .automation_lanes.length,
        TIMELINE_UID,
      ),
    )
    .toBe(0);
  await expect(
    header.getByRole("button", {
      name: "Collapse automation lanes",
      exact: true,
    }),
  ).not.toBeVisible();
  await add.click();
  await dialog.getByLabel("Variable name").fill("replacement-variable");
  await dialog.getByRole("button", { name: "Add lane", exact: true }).click();
  await expect(
    header.getByRole("button", {
      name: "Delete parameter lane replacement-variable",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) =>
          (window as any).appStores.timelines
            .get()
            [uid].tracks[0].automation_lanes.map((lane: any) => lane.name),
        TIMELINE_UID,
      ),
    )
    .toEqual(["replacement-variable"]);
});

/** Verifies a published clip target remains editable after adding control points. */
test("clip rate lane control points persist after backend publication", async ({
  page,
}, testInfo) => {
  await openFirstTimeline(page);
  const clipUid = "50efca4267444a0bbed89a0f69930b9e";
  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    stores.clips.set({
      ...stores.clips.get(),
      [uid]: [
        {
          identifiers: { id: 9201, uid, label: "Rate Target" },
          priority: 0,
          options: { auto_release: false, deactivate_on_sequence_end: false },
        },
        false,
      ],
    });
  }, clipUid);
  const header = page.locator(
    `[data-timeline-track-header="true"][data-track-id="${BASE_TRACK_ID}"]`,
  );
  await header
    .getByRole("button", { name: "Add parameter lane", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add parameter lane" });
  await dialog.getByLabel("Parameter type").selectOption("RateMaster");
  await dialog.getByRole("combobox", { name: /^Clip/ }).selectOption(clipUid);
  await dialog.getByRole("button", { name: "Add lane", exact: true }).click();
  /** Reads authoritative lane data delivered by the backend. */
  const readLane = () =>
    page.evaluate(
      (uid) =>
        (window as any).appStores.timelines
          .get()
          [uid].tracks[0].automation_lanes.find(
            (lane: any) => lane.parameter_type.type === "RateMaster",
          ),
      TIMELINE_UID,
    );
  await expect
    .poll(async () => (await readLane())?.parameter_type.data)
    .toBe(clipUid);
  const laneId = (await readLane()).id;
  const lane = page.locator(
    `[data-timeline-automation-lane="true"][data-automationLane-id="${laneId}"]`,
  );
  await lane.click({ position: { x: 80, y: 20 } });
  await expect.poll(async () => (await readLane()).points.length).toBe(1);
  await lane.click({ position: { x: 160, y: 40 } });
  await expect.poll(async () => (await readLane()).points.length).toBe(2);
  await expect(lane.locator(".automation-point")).toHaveCount(2);
  await page.reload();
  await waitForDockviewApp(page);
  await openFirstTimeline(page);
  await expect(lane.locator(".automation-point")).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("clip-rate-control-points.png"),
  });
});

test.describe.configure({ timeout: 180_000 });

/** Starts every operator workflow from the same exact backend graph. */
test.beforeEach(async ({ backendSlot, page }) => {
  await prepareOwnedOperatorBackend(page, backendSlot.backendPort);
});

/** Stops playback, replaces the backend, and proves operator stores are blank. */
test.afterEach(async ({ backendSlot, page }) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
    await page
      .evaluate(
        async ({ timecodeId }) => {
          const stores = (window as any).appStores;
          if (typeof stores?.sendAndAwait !== "function") return;
          await stores.sendAndAwait({
            module: "TimecodeCommand",
            command: { type: "StopTimecode", data: timecodeId },
          });
          await stores.sendAndAwait({
            module: "InstanceCommand",
            command: { type: "StopAll" },
          });
        },
        { timecodeId: TIMECODE_ID },
      )
      .catch(() => undefined);
  }

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedOperatorStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      timecodes: 0,
      timelines: 0,
    });
});

/** Reads every backend-driven store owned by the operator scenarios. */
async function ownedOperatorStoreCounts(
  page: import("@playwright/test").Page,
): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      timecodes: Object.keys(stores.timecodes.get()).length,
      timelines: Object.keys(stores.timelines.get()).length,
    };
  });
}

/** Sends one correlated backend command and rejects a failed result. */
async function sendOwnedOperatorCommand(
  page: import("@playwright/test").Page,
  data: object,
): Promise<void> {
  const result = await page.evaluate(async (message) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(message);
  }, data);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds the exact cue referenced by owned operator timeline actions. */
function ownedOperatorCue(): object {
  return {
    identifiers: {
      id: CUE_ID,
      uid: CUE_UID,
      label: "Owned Operator Cue",
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the internal timecode driving the owned operator timeline. */
function ownedOperatorTimecode(): object {
  return {
    identifiers: {
      id: TIMECODE_ID,
      uid: TIMECODE_UID,
      label: "Owned Operator Timecode",
    },
    rate: "Fps30",
    source: "Internal",
  };
}

/** Builds the expandable base track needed by marker and parameter workflows. */
function ownedOperatorBaseTrack(): object {
  return {
    id: BASE_TRACK_ID,
    label: "Owned Operator Track",
    muted: false,
    solo: false,
    expanded: true,
    actions: [
      {
        id: BASE_ITEM_ID,
        label: `Cue ${CUE_ID}`,
        position: { secs: 3, nanos: 0 },
        duration: { secs: 1, nanos: 0 },
        action: { type: "FireCue", data: CUE_UID },
      },
    ],
    automation_lanes: [
      {
        id: "owned-operator-parameter",
        name: "Owned Operator Curve",
        color: "#22c55e",
        points: [
          { position: { secs: 0, nanos: 0 }, value: 0.25 },
          { position: { secs: 5, nanos: 0 }, value: 0.75 },
        ],
        parameter_type: {
          type: "GlobalVariable",
          data: "owned-operator-variable",
        },
      },
    ],
  };
}

/** Builds the fixed audio-backed timeline shared by every operator scenario. */
function ownedOperatorTimeline(audioPath: string): object {
  return {
    identifiers: {
      id: TIMELINE_ID,
      uid: TIMELINE_UID,
      label: "Owned Operator Timeline",
    },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: audioPath,
    audio_enabled: true,
    tracks: [ownedOperatorBaseTrack()],
    markers: [],
    regions: [],
    bpm: 120,
    beats_per_bar: 4,
    use_beat_grid: false,
    lookahead: "disabled",
    scroll_mode: "free",
  };
}

/** Replaces the backend and persists the complete owned operator graph. */
async function prepareOwnedOperatorBackend(
  page: import("@playwright/test").Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.timecodes?.get) &&
      Boolean((window as any).appStores?.timelines?.get),
  );
  await expect
    .poll(() => ownedOperatorStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      timecodes: 0,
      timelines: 0,
    });

  await sendOwnedOperatorCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: ownedOperatorCue() },
  });
  await sendOwnedOperatorCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StoreTimecode", data: ownedOperatorTimecode() },
  });
  const audioResponse = await page.request.post(
    `/api/showfiles/current/timeline-audio/${TIMELINE_UID}`,
    {
      multipart: {
        file: {
          name: "operator-silence.wav",
          mimeType: "audio/wav",
          buffer: createSilentWavBuffer(240_000),
        },
      },
    },
  );
  expect(audioResponse.ok()).toBe(true);
  const audio = await audioResponse.json();
  await sendOwnedOperatorCommand(page, {
    module: "TimelineCommand",
    command: {
      type: "StoreTimeline",
      data: ownedOperatorTimeline(audio.audio_path),
    },
  });
  await expect
    .poll(() => ownedOperatorStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 1,
      timecodes: 1,
      timelines: 1,
    });
}

/** Returns a locator's current client rectangle after it is attached. */
async function locatorClientRect(locator: Locator) {
  let currentRect = { height: 0, width: 0, x: 0, y: 0 };
  await expect
    .poll(async () => {
      currentRect = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      });
      return currentRect.width > 0 && currentRect.height > 0;
    })
    .toBe(true);
  return currentRect;
}

/** Closes timeline panels created by earlier operator workflow cases. */
async function closeStaleOperatorTimelinePanels(
  page: import("@playwright/test").Page,
) {
  await page.evaluate(() => {
    const api = (window as any).appStores?.dockApi?.get?.();
    if (!api) return;

    for (const panel of [...api.panels]) {
      const panelId = String(panel.id ?? "");
      if (
        panelId.startsWith("e2e-bar-seek-timeline-") ||
        panelId.startsWith("e2e-operator-timeline-") ||
        panelId.startsWith("e2e-timeline-")
      ) {
        panel.api.close();
      }
    }
  });
}

/** Runs operator setup after the owned backend snapshot hydrates. */
async function afterOperatorStartupResync<T>(
  page: import("@playwright/test").Page,
  operation: () => Promise<T>,
): Promise<T> {
  await waitForDockviewApp(page);
  return operation();
}

/** Opens the exact owned operator timeline under the requested panel prefix. */
async function openOwnedOperatorTimeline(
  page: import("@playwright/test").Page,
  panelPrefix: string,
): Promise<string> {
  return afterOperatorStartupResync(page, async () => {
    await closeStaleOperatorTimelinePanels(page);
    return page.evaluate(
      ({ panelPrefix: prefix, timelineId, timelineUid }) => {
        const stores = (window as any).appStores;
        const entry = stores?.timelines?.get?.()[timelineUid];
        const api = stores?.dockApi?.get?.();
        if (
          entry?.identifiers?.id !== timelineId ||
          entry?.identifiers?.uid !== timelineUid ||
          !api
        ) {
          throw new Error(`Owned timeline ${timelineUid} did not hydrate`);
        }

        const panelId = `${prefix}-${timelineUid}`;
        const panel = api.getPanel(panelId);
        if (panel) {
          panel.focus();
        } else {
          api.addPanel({
            id: panelId,
            component: "Timeline",
            title: `Timeline ${timelineId}`,
            params: { initialTimelineUid: timelineUid },
            position: {
              referencePanel: "panel-FixtureGrid",
              direction: "within",
            },
          });
        }
        return timelineUid;
      },
      { panelPrefix, timelineId: TIMELINE_ID, timelineUid: TIMELINE_UID },
    );
  });
}

/** Opens the exact owned timeline for operator workflow tests. */
async function openFirstTimeline(page: import("@playwright/test").Page) {
  return openOwnedOperatorTimeline(page, "e2e-operator-timeline");
}

/** Opens the exact owned timeline after verifying its numeric ID. */
async function openTimelineById(
  page: import("@playwright/test").Page,
  timelineId: number,
) {
  if (timelineId !== TIMELINE_ID) {
    throw new Error(`Expected owned timeline ID ${TIMELINE_ID}`);
  }
  return openOwnedOperatorTimeline(page, "e2e-timeline");
}

/** Opens the owned timeline panel used by seek-only browser validation. */
async function openIsolatedTimeline(page: import("@playwright/test").Page) {
  const timelineUid = await openOwnedOperatorTimeline(
    page,
    "e2e-bar-seek-timeline",
  );
  return {
    timelineUid,
    timelineId: TIMELINE_ID,
    timecodeId: TIMECODE_ID,
  };
}

/** Returns the owned timeline's linked timecode position in milliseconds. */
async function getTimelineTimecodeMs(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const timecodeUid = timeline?.timecode_uid;
    const timecodeEntry = timecodeUid
      ? stores.timecodes.get()[timecodeUid]
      : undefined;
    const currentTime = timecodeEntry?.[1]?.current_time;
    if (!currentTime) return Number.POSITIVE_INFINITY;
    return currentTime.secs * 1000 + currentTime.nanos / 1_000_000;
  }, timelineUid);
}

/** Returns whether the timeline-linked timecode is currently running. */
async function isTimelineTimecodeActive(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const timecodeUid = timeline?.timecode_uid;
    const timecodeEntry = timecodeUid
      ? stores.timecodes.get()[timecodeUid]
      : undefined;
    return Boolean(timecodeEntry?.[1]?.is_active);
  }, timelineUid);
}

/** Seeds a single draggable timeline action for post-drag interaction tests. */
async function seedDraggableTimelineItem(
  page: import("@playwright/test").Page,
  timelineUid: string,
  label: string,
) {
  return page.evaluate(
    ({ uid, itemLabel, trackId, actionId, cueUid }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) return null;

      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: [
          {
            id: trackId,
            label: "E2E Drag Cleanup",
            muted: false,
            solo: false,
            expanded: false,
            actions: [
              {
                id: actionId,
                label: itemLabel,
                position: { secs: 1, nanos: 0 },
                duration: { secs: 0, nanos: 0 },
                action: {
                  type: "FireCue",
                  data: cueUid,
                },
              },
            ],
            automation_lanes: [],
          },
        ],
      });

      return { trackId, actionId };
    },
    {
      uid: timelineUid,
      itemLabel: label,
      trackId: DRAG_TRACK_ID,
      actionId: DRAG_ITEM_ID,
      cueUid: CUE_UID,
    },
  );
}

/** Seeds a dense timeline and cue store to reproduce item-update render latency. */
async function seedDenseTimelineItems(
  page: import("@playwright/test").Page,
  timelineUid: string,
  itemCount: number,
) {
  return page.evaluate(
    ({ uid, count, trackId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) return null;

      const cueEntries = Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
          const cueUid = `e2eDenseCue${String(index).padStart(24, "0")}`;
          return [
            cueUid,
            {
              identifiers: {
                id: 500_000 + index,
                uid: cueUid,
                label: `Dense Cue ${index}`,
              },
              parts: [],
              transitions: {},
            },
          ];
        }),
      );
      stores.cues.set({ ...stores.cues.get(), ...cueEntries });

      const items = Object.keys(cueEntries).map((cueUid, index) => ({
        id: `e2e-dense-item-${index}`,
        label: `Dense item ${index}`,
        position: { secs: index, nanos: 0 },
        duration: { secs: 0, nanos: 0 },
        action: { type: "FireCue", data: cueUid },
      }));

      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: [
          {
            id: trackId,
            label: "E2E Dense Track",
            muted: false,
            solo: false,
            expanded: false,
            items,
            automation_lanes: [],
          },
        ],
      });

      return {
        trackId,
        moveItemId: items[Math.floor(items.length / 2)]?.id,
        newCueUid: Object.keys(cueEntries)[0],
      };
    },
    { uid: timelineUid, count: itemCount, trackId: DENSE_TRACK_ID },
  );
}

/** Measures how long a timeline store item append takes to become visible. */
async function measureTimelineItemAppendRenderMs(
  page: import("@playwright/test").Page,
  timelineUid: string,
  trackId: string,
  cueUid: string,
) {
  return page.evaluate(
    async ({ uid, targetTrackId, targetCueUid, actionId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const start = performance.now();
      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: timeline.tracks.map((track: any) =>
          track.id === targetTrackId
            ? {
                ...track,
                actions: [
                  ...track.actions,
                  {
                    id: actionId,
                    label: "Dense new item",
                    position: { secs: track.actions.length + 1, nanos: 0 },
                    duration: { secs: 0, nanos: 0 },
                    action: { type: "FireCue", data: targetCueUid },
                  },
                ],
              }
            : track,
        ),
      });

      for (let frames = 0; frames < 120; frames += 1) {
        if (document.querySelector(`[data-action-id="${actionId}"]`)) {
          return performance.now() - start;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error("Timed out waiting for dense timeline append to render");
    },
    {
      uid: timelineUid,
      targetTrackId: trackId,
      targetCueUid: cueUid,
      actionId: DENSE_NEW_ITEM_ID,
    },
  );
}

/** Measures how long a timeline store item move takes to update the rendered position. */
async function measureTimelineItemMoveRenderMs(
  page: import("@playwright/test").Page,
  timelineUid: string,
  trackId: string,
  actionId: string,
) {
  return page.evaluate(
    async ({ uid, targetTrackId, targetItemId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const itemSelector = `[data-action-id="${targetItemId}"]`;
      const itemElement = document.querySelector<HTMLElement>(itemSelector);
      const initialLeft = itemElement?.style.left;
      const start = performance.now();
      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: timeline.tracks.map((track: any) =>
          track.id === targetTrackId
            ? {
                ...track,
                actions: track.actions.map((item: any) =>
                  item.id === targetItemId
                    ? { ...item, position: { secs: 42, nanos: 0 } }
                    : item,
                ),
              }
            : track,
        ),
      });

      for (let frames = 0; frames < 120; frames += 1) {
        const movedElement = document.querySelector<HTMLElement>(itemSelector);
        if (
          movedElement?.style.left &&
          movedElement.style.left !== initialLeft
        ) {
          return performance.now() - start;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error("Timed out waiting for dense timeline move to render");
    },
    { uid: timelineUid, targetTrackId: trackId, targetItemId: actionId },
  );
}

/**
 * Stops timeline playback and waits for the playhead to return to the start.
 */
async function stopTimelineAtStart(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  await page.getByRole("button", { name: "Stop timeline" }).click();
  await expect
    .poll(async () => getTimelineTimecodeMs(page, timelineUid))
    .toBeLessThanOrEqual(1);
}

/** Sets a timeline meter through the same store command used by the UI. */
async function configureTimelineMeter(
  page: import("@playwright/test").Page,
  timelineUid: string,
  bpm: number,
  beatsPerBar: number,
) {
  await page.evaluate(
    async ({ uid, nextBpm, nextBeatsPerBar }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) {
        throw new Error(`Timeline ${uid} was not available`);
      }
      await stores.send({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: {
            ...timeline,
            bpm: nextBpm,
            beats_per_bar: nextBeatsPerBar,
          },
        },
      });
    },
    { uid: timelineUid, nextBpm: bpm, nextBeatsPerBar: beatsPerBar },
  );

  await expect
    .poll(async () =>
      page.evaluate((uid) => {
        const timeline = (window as any).appStores.timelines.get()[uid];
        return {
          bpm: timeline?.bpm,
          beatsPerBar: timeline?.beats_per_bar,
        };
      }, timelineUid),
    )
    .toEqual({ bpm, beatsPerBar });
}

/** Sets whether the timeline uses beatgrid mode through the backend store. */
async function setTimelineBeatgridMode(
  page: import("@playwright/test").Page,
  timelineUid: string,
  useBeatgrid: boolean,
) {
  await page.evaluate(
    async ({ uid, nextUseBeatgrid }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) {
        throw new Error(`Timeline ${uid} was not available`);
      }
      await stores.send({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: {
            ...timeline,
            use_beat_grid: nextUseBeatgrid,
          },
        },
      });
    },
    { uid: timelineUid, nextUseBeatgrid: useBeatgrid },
  );

  await expect
    .poll(async () =>
      page.evaluate(
        (uid) =>
          (window as any).appStores.timelines.get()[uid]?.use_beat_grid ??
          false,
        timelineUid,
      ),
    )
    .toBe(useBeatgrid);
}

/** Seeks the timeline-linked timecode to a precise millisecond position. */
async function seekTimelineTimecode(
  page: import("@playwright/test").Page,
  timelineUid: string,
  positionMs: number,
) {
  await page.evaluate(
    async ({ uid, nextPositionMs }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const timecodeUid = timeline?.timecode_uid;
      const timecode = timecodeUid
        ? stores.timecodes.get()[timecodeUid]?.[0]
        : undefined;
      if (!timecode) {
        throw new Error(`Timeline ${uid} did not have a linked timecode`);
      }
      await stores.send({
        module: "TimecodeCommand",
        command: {
          type: "SeekTimecode",
          data: {
            id: timecode.identifiers.id,
            position: {
              secs: Math.floor(nextPositionMs / 1000),
              nanos: (nextPositionMs % 1000) * 1_000_000,
            },
          },
        },
      });
    },
    { uid: timelineUid, nextPositionMs: positionMs },
  );

  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(positionMs);
}

/** Verifies comma and period seek the playhead by DAW-style bar jumps. */
test("timeline comma and period shortcuts seek by bar groups", async ({
  page,
}) => {
  await page.goto("/");

  const { timelineUid, timelineId, timecodeId } =
    await openIsolatedTimeline(page);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await configureTimelineMeter(page, timelineUid, 120, 4);
  await stopTimelineAtStart(page, timelineUid);
  await page.keyboard.press("Home");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(0);

  await page.keyboard.press("Period");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(2_000);

  await page.keyboard.press("Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(0);

  await page.keyboard.press("Shift+Period");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(8_000);

  await page.keyboard.press("Control+Shift+Period");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(24_000);

  await page.keyboard.press("Control+Shift+Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(8_000);

  await setTimelineBeatgridMode(page, timelineUid, true);
  const lane = page
    .locator(
      '[data-timeline-track-row="true"][data-track-id="add-track-placeholder"]',
    )
    .locator("div")
    .first();
  const laneBox = await lane.boundingBox();
  if (!laneBox) throw new Error("Expected add-track placeholder lane bounds");
  await lane.click({ position: { x: 173, y: laneBox.height / 2 } });
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(1_730);

  const ruler = page.locator(
    `[data-timeline-ruler="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const rulerBox = await ruler.boundingBox();
  if (!rulerBox) throw new Error("Expected timeline ruler bounds");
  await ruler.click({ position: { x: 174, y: rulerBox.height / 2 } });
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(1_740);

  const operatorLane = page.locator('[data-timeline-operator-lane="true"]');
  const operatorLaneBox = await operatorLane.boundingBox();
  if (!operatorLaneBox) throw new Error("Expected operator lane bounds");
  await operatorLane.click({
    position: { x: 175, y: operatorLaneBox.height / 2 },
  });
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(1_750);

  await surface
    .locator('[data-timeline-toolbar="true"]')
    .getByRole("button", { name: "Snap" })
    .click();
  await seekTimelineTimecode(page, timelineUid, 22_500);
  await page.keyboard.press("Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(22_000);

  await seekTimelineTimecode(page, timelineUid, 23_100);
  await page.keyboard.press("Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(22_000);

  await seekTimelineTimecode(page, timelineUid, 22_500);
  await page.keyboard.press("Period");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(24_000);

  await seekTimelineTimecode(page, timelineUid, 26_500);
  await page.keyboard.press("Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(26_000);

  await seekTimelineTimecode(page, timelineUid, 26_500);
  await page.keyboard.press("Shift+Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(26_000);

  await seekTimelineTimecode(page, timelineUid, 26_000);
  await page.keyboard.press("Shift+Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(18_000);

  await seekTimelineTimecode(page, timelineUid, 26_500);
  await page.keyboard.press("Control+Shift+Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(26_000);

  await seekTimelineTimecode(page, timelineUid, 26_000);
  await page.keyboard.press("Control+Shift+Comma");
  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBe(10_000);

  const playheadLeft = await page
    .locator('[data-timeline-playhead="true"]')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).left));
  expect(playheadLeft).toBeGreaterThan(0);

  await page.evaluate(
    async ({ timelineId, timecodeId }) => {
      const stores = (window as any).appStores;
      await stores.send({
        module: "TimelineCommand",
        command: { type: "DeleteTimeline", data: timelineId },
      });
      await stores.send({
        module: "TimecodeCommand",
        command: { type: "DeleteTimecode", data: timecodeId },
      });
    },
    { timelineId, timecodeId },
  );
});

/** Verifies Space playback recovers the active timeline when DOM focus is on body. */
test("timeline Space shortcut plays after focus falls back to document body", async ({
  page,
}) => {
  await page.goto("/");

  const { timelineUid, timelineId, timecodeId } =
    await openIsolatedTimeline(page);

  try {
    const surface = page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    );
    await expect(surface).toBeVisible();
    await stopTimelineAtStart(page, timelineUid);

    await page.evaluate(() => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      document.body.focus();
    });

    const startPosition = await getTimelineTimecodeMs(page, timelineUid);
    await page.keyboard.press("Space");
    await expect
      .poll(async () => getTimelineTimecodeMs(page, timelineUid))
      .toBeGreaterThan(startPosition + 50);

    await page.getByRole("button", { name: "Pause timeline" }).click();
  } finally {
    await page.evaluate(
      async ({ timelineId, timecodeId }) => {
        const stores = (window as any).appStores;
        await stores.send({
          module: "TimelineCommand",
          command: { type: "DeleteTimeline", data: timelineId },
        });
        await stores.send({
          module: "TimecodeCommand",
          command: { type: "DeleteTimecode", data: timecodeId },
        });
      },
      { timelineId, timecodeId },
    );
  }
});

/** Verifies free-scroll seeking moves the playhead without moving the viewport. */
test("timeline free scroll mode seeking moves playhead without scrolling content", async ({
  page,
}) => {
  await page.goto("/");

  const timelineUid = await openFirstTimeline(page);
  expect(timelineUid).toBeTruthy();
  if (!timelineUid) throw new Error("Expected a timeline UID from appStores");

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await stopTimelineAtStart(page, timelineUid);

  const scrollMode = page.getByLabel("Timeline scroll mode");
  await expect(scrollMode).toBeVisible();
  await scrollMode.selectOption("free");

  const zoomInput = page.getByLabel("Timeline zoom");
  await zoomInput.fill("100");

  const scrollContainer = page.locator(
    `[data-timeline-scroll-container="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(scrollContainer).toBeVisible();
  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 900;
  });
  const freeModeScrollLeft = await scrollContainer.evaluate(
    (element) => element.scrollLeft,
  );
  expect(freeModeScrollLeft).toBeGreaterThan(100);
  const scrollContainerBox = await scrollContainer.boundingBox();
  expect(scrollContainerBox).toBeTruthy();
  if (!scrollContainerBox) {
    throw new Error("Expected timeline scroll container bounds");
  }
  const ruler = page.locator(
    `[data-timeline-ruler="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(ruler).toBeVisible();
  const rulerBox = await ruler.boundingBox();
  expect(rulerBox).toBeTruthy();
  if (!rulerBox) {
    throw new Error("Expected timeline ruler bounds");
  }
  const seekClientX = scrollContainerBox.x + 192 + 140;

  await page.mouse.click(seekClientX, rulerBox.y + 12);

  await expect
    .poll(async () => {
      const scrollLeft = await scrollContainer.evaluate(
        (element) => element.scrollLeft,
      );
      return Math.abs(scrollLeft - freeModeScrollLeft);
    })
    .toBeLessThanOrEqual(1);
  await expect
    .poll(async () => getTimelineTimecodeMs(page, timelineUid))
    .toBeGreaterThan(100);
  await expect
    .poll(async () => {
      const containerBox = await scrollContainer.boundingBox();
      const playheadBox = await page
        .locator('[data-timeline-playhead="true"]')
        .boundingBox();
      if (!containerBox || !playheadBox) return false;
      const playheadCenter = playheadBox.x + playheadBox.width / 2;
      return (
        playheadCenter >= containerBox.x &&
        playheadCenter <= containerBox.x + containerBox.width
      );
    })
    .toBe(true);

  await stopTimelineAtStart(page, timelineUid);
  await scrollMode.selectOption("center");
  await expect
    .poll(async () =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBe(0);
});

/** Verifies the owned audio asset keeps ruler width stable across display modes. */
test("timeline ruler keeps audio width when switching time and BPM modes", async ({
  page,
}) => {
  await page.goto("/");

  const timelineUid = await openTimelineById(page, TIMELINE_ID);
  expect(timelineUid).toBeTruthy();
  if (!timelineUid) throw new Error("Expected timeline 2 UID from appStores");

  await expect(
    page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    ),
  ).toBeVisible();
  const ruler = page.locator(
    `[data-timeline-ruler="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const beatgridToggle = page.locator(
    `[data-timeline-beatgrid-toggle="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(ruler).toBeVisible();
  await expect(beatgridToggle).toBeVisible();
  await page.getByLabel("Timeline zoom").fill("100");

  await expect
    .poll(async () =>
      ruler.evaluate((element: HTMLElement) => element.offsetWidth),
    )
    .toBeGreaterThan(20_000);
  const decodedRulerWidth = await ruler.evaluate(
    (element: HTMLElement) => element.offsetWidth,
  );

  for (let toggleCount = 0; toggleCount < 2; toggleCount += 1) {
    await beatgridToggle.click();
    await expect
      .poll(async () =>
        ruler.evaluate((element: HTMLElement) => element.offsetWidth),
      )
      .toBeGreaterThan(decodedRulerWidth - 10);
  }

  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const timecodeUid = timeline?.timecode_uid;
    const timecodeEntry = timecodeUid
      ? stores.timecodes.get()[timecodeUid]
      : undefined;
    if (!timecodeUid || !timecodeEntry) return;
    const [timecode, state] = timecodeEntry;
    stores.timecodes.setKey(timecodeUid, [
      timecode,
      {
        ...state,
        is_active: false,
        current_time: { secs: 0, nanos: 0 },
      },
    ]);
  }, timelineUid);

  const rulerBox = await ruler.boundingBox();
  expect(rulerBox).toBeTruthy();
  if (!rulerBox) throw new Error("Expected timeline ruler bounds");
  await page.keyboard.down("Shift");
  await page.mouse.move(rulerBox.x + 300, rulerBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(rulerBox.x + 360, rulerBox.y + 12);
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await expect
    .poll(async () => {
      const rulerBounds = await ruler.boundingBox();
      const playheadBounds = await page
        .locator('[data-timeline-playhead="true"]')
        .boundingBox();
      if (!rulerBounds || !playheadBounds) return Number.POSITIVE_INFINITY;
      return Math.abs(playheadBounds.x - rulerBounds.x);
    })
    .toBeLessThanOrEqual(4);
});

/** Verifies the compact beatgrid toolbar preserves fractional BPM edits. */
test("beatgrid controls preserve fractional BPM edits", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();

  const context = await openIsolatedTimeline(page);
  const timelineUid = context.timelineUid;
  const timelinePanel = page.locator(
    `[data-panel-id="e2e-bar-seek-timeline-${timelineUid}"]`,
  );
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );

  const beatgridToggle = page.locator(
    `[data-timeline-beatgrid-toggle="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const rulerChromeLane = surface.locator(
    '[data-timeline-chrome-lane="ruler"]',
  );
  const waveformChromeLane = surface.locator(
    '[data-timeline-chrome-lane="waveform"]',
  );
  const operatorChromeLane = surface.locator(
    '[data-timeline-chrome-lane="operator"]',
  );
  await expect(surface).toBeVisible();
  await expect(beatgridToggle).toBeVisible();
  await expect(waveformChromeLane).toBeVisible();
  await expect(operatorChromeLane).toBeVisible();
  const [rulerChromeBox, waveformChromeBox, operatorChromeBox] =
    await Promise.all([
      rulerChromeLane.boundingBox(),
      waveformChromeLane.boundingBox(),
      operatorChromeLane.boundingBox(),
    ]);
  if (!rulerChromeBox || !waveformChromeBox || !operatorChromeBox) {
    throw new Error("Expected timeline chrome lane bounds");
  }
  expect(waveformChromeBox.y).toBeGreaterThan(rulerChromeBox.y);
  expect(waveformChromeBox.y).toBeLessThan(operatorChromeBox.y);
  await expect
    .poll(() =>
      operatorChromeLane.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    )
    .toBe("rgb(26, 26, 26)");
  const scrollMode = page.getByLabel("Timeline scroll mode");
  await expect(scrollMode).toBeVisible();
  const [beatgridToggleBox, scrollModeBox] = await Promise.all([
    beatgridToggle.boundingBox(),
    scrollMode.boundingBox(),
  ]);
  if (!beatgridToggleBox || !scrollModeBox) {
    throw new Error("Expected toolbar controls to have visible bounds");
  }
  expect(scrollModeBox.height).toBeLessThanOrEqual(
    beatgridToggleBox.height + 1,
  );
  const snapButton = timelinePanel.getByRole("button", {
    name: "Snap",
    exact: true,
  });
  const nudgeUnit = timelinePanel.getByLabel("Nudge unit");
  const [snapButtonBox, nudgeUnitBox] = await Promise.all([
    snapButton.boundingBox(),
    nudgeUnit.boundingBox(),
  ]);
  if (!snapButtonBox || !nudgeUnitBox) {
    throw new Error("Expected snap controls to have visible bounds");
  }
  expect(nudgeUnitBox.x).toBeGreaterThan(snapButtonBox.x);
  expect(nudgeUnitBox.x - (snapButtonBox.x + snapButtonBox.width)).toBeLessThan(
    12,
  );
  await nudgeUnit.selectOption("bar");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("dv-render-overlay"),
      ),
    )
    .toBe(true);
  await scrollMode.selectOption("center");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("dv-render-overlay"),
      ),
    )
    .toBe(true);
  if ((await beatgridToggle.textContent())?.includes("Time")) {
    await beatgridToggle.click();
  }

  const beatgridSwitch = beatgridToggle.getByRole("switch", {
    name: "Use beatgrid",
  });
  await expect(beatgridSwitch).toBeChecked();
  await beatgridSwitch.focus();
  await expect(beatgridSwitch).toBeFocused();
  await beatgridSwitch.press("Space");
  await expect(beatgridSwitch).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(beatgridSwitch).toBeChecked();

  const zoomInput = surface.getByLabel("Timeline zoom");
  expect(
    await zoomInput.evaluate((input) => input.clientWidth),
  ).toBeGreaterThanOrEqual(48);
  await zoomInput.fill("100");
  await surface.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(zoomInput).toHaveValue("110");
  await surface.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(zoomInput).toHaveValue("100");
  await zoomInput.fill("");
  await zoomInput.blur();
  await expect(zoomInput).toHaveValue("100");

  const durationToggle = surface.getByRole("button", {
    name: "Duration",
    exact: true,
  });
  const durationState = await durationToggle.getAttribute("aria-pressed");
  await durationToggle.click();
  await expect(durationToggle).toHaveAttribute(
    "aria-pressed",
    durationState === "true" ? "false" : "true",
  );
  await durationToggle.click();

  await surface
    .getByRole("button", { name: "Enable timeline recording" })
    .click();
  const recording = surface.getByRole("button", {
    name: "Disable timeline recording",
  });
  await expect(recording).toHaveAttribute("aria-pressed", "true");
  await surface.screenshot({
    path: testInfo.outputPath("shared-timeline-controls.png"),
  });
  await recording.click();
  await surface
    .getByRole("button", { name: "Play timeline", exact: true })
    .click();
  await expect(
    surface.getByRole("button", { name: "Pause timeline", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await surface
    .getByRole("button", { name: "Stop timeline", exact: true })
    .click();
  await expect(
    surface.getByRole("button", { name: "Play timeline", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "BPM controls" }).click();
  const bpmInput = page.getByRole("textbox", { name: "Beatgrid BPM" });
  await expect(bpmInput).toBeVisible();
  await bpmInput.fill("128.5");
  await bpmInput.blur();

  await expect
    .poll(() =>
      page.evaluate((uid) => {
        return (window as any).appStores.timelines.get()[uid]?.bpm;
      }, timelineUid),
    )
    .toBe(128.5);
  await page.getByRole("button", { name: "Increase BPM rate" }).click();
  await expect(bpmInput).toHaveValue("129.5");
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.timelines.get()[uid]?.bpm,
        timelineUid,
      ),
    )
    .toBe(129.5);
  await bpmInput.press("ArrowDown");
  await expect(bpmInput).toHaveValue("128.5");
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.timelines.get()[uid]?.bpm,
        timelineUid,
      ),
    )
    .toBe(128.5);
  await bpmInput.fill("");
  await bpmInput.blur();
  await expect(bpmInput).toHaveValue("128.5");
  await page.locator('[data-menu-kind="beatgrid-controls"]').screenshot({
    path: testInfo.outputPath("shared-tempo-controls.png"),
  });
  await page.getByRole("button", { name: "BPM controls" }).click();
});

/** Verifies backend timeline refreshes preserve the owned free-scroll viewport. */
test("timeline keeps free-scroll viewport during timeline refresh", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  const context = await openIsolatedTimeline(page);
  const timelineUid = context.timelineUid;
  const scrollContainer = page.locator(
    `[data-timeline-scroll-container="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(scrollContainer).toBeVisible();

  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 900;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBeGreaterThan(800);

  await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) throw new Error(`Timeline ${uid} was not available`);
    await stores.send({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          ...timeline,
          tracks: timeline.tracks.map((track: any) => ({ ...track })),
        },
      },
    });
  }, timelineUid);

  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBeGreaterThan(800);
});

/** Verifies timeline chrome remains fixed while the track row viewport scrolls. */
test("timeline keeps chrome fixed while track rows scroll", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  const context = await openIsolatedTimeline(page);
  const timelineUid = context.timelineUid;
  await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) throw new Error(`Timeline ${uid} was not available`);
    const denseOffscreenItems = (trackIndex: number) =>
      Array.from({ length: 120 }, (_, itemIndex) => ({
        id: `scroll-action-${trackIndex + 1}-hidden-${itemIndex + 1}`,
        label: `Hidden Scroll Flag ${trackIndex + 1}.${itemIndex + 1}`,
        position: { secs: 45 + itemIndex, nanos: 0 },
        duration: { secs: 0, nanos: 0 },
        action: {
          type: "DeskEval",
          data: `echo hidden scroll flag ${trackIndex + 1}.${itemIndex + 1}`,
        },
      }));
    const visibleEdgeHintItem = (trackIndex: number) => ({
      id: `scroll-action-${trackIndex + 1}`,
      label: `Scroll Flag ${trackIndex + 1}`,
      position: { secs: 2, nanos: 0 },
      duration: { secs: 0, nanos: 0 },
      action: {
        type: "DeskEval",
        data: `echo scroll flag ${trackIndex + 1}`,
      },
    });
    const tracks = Array.from({ length: 48 }, (_, index) => {
      const shouldRenderEdgeHintItem =
        index === 0 || index === 2 || index === 45 || index === 47;
      const items = shouldRenderEdgeHintItem
        ? [
            ...(index === 0 || index === 45 ? denseOffscreenItems(index) : []),
            visibleEdgeHintItem(index),
          ]
        : [];
      return {
        id: `scroll-track-${index + 1}`,
        label: `Scroll Track ${index + 1}`,
        muted: false,
        solo: false,
        items,
        expanded: false,
        automation_lanes: [],
      };
    });
    await stores.send({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          ...timeline,
          tracks,
        },
      },
    });
  }, timelineUid);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const toolbar = surface.locator('[data-timeline-toolbar="true"]');
  const ruler = surface.locator(
    `[data-timeline-ruler="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const scrollContainer = surface.locator(
    `[data-timeline-scroll-container="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const waveform = surface.locator('[data-timeline-waveform-row="true"]');
  const waveformContent = surface.locator(
    '[data-timeline-waveform-content="true"]',
  );
  const chromeGutter = surface.locator('[data-timeline-chrome-gutter="true"]');
  const chromeLane = surface.locator("[data-timeline-chrome-lane]");
  const footer = surface.locator('[data-timeline-footer-toolbar="true"]');
  const overlayLayer = surface.locator('[data-timeline-overlay-layer="true"]');
  const playhead = surface.locator('[data-timeline-playhead="true"]');
  const labelColumn = surface.locator(
    '[data-timeline-track-label-column="true"]',
  );
  const rowViewport = surface.locator(
    '[data-timeline-track-contents-scroll-container="true"]',
  );
  const firstHeader = surface
    .locator('[data-timeline-track-header="true"]')
    .first();
  const firstRow = surface.locator('[data-timeline-track-row="true"]').first();

  await expect(firstRow).toBeVisible();
  await expect
    .poll(() => surface.locator('[data-timeline-track-row="true"]').count())
    .toBeGreaterThan(20);
  await expect
    .poll(async () => {
      const [overlayZ, labelZ, gutterZ, laneZValues] = await Promise.all([
        overlayLayer.evaluate((element) =>
          Number.parseInt(window.getComputedStyle(element).zIndex, 10),
        ),
        labelColumn.evaluate((element) =>
          Number.parseInt(window.getComputedStyle(element).zIndex, 10),
        ),
        chromeGutter
          .first()
          .evaluate((element) =>
            Number.parseInt(window.getComputedStyle(element).zIndex, 10),
          ),
        chromeLane.evaluateAll((elements) =>
          elements.map((element) =>
            Number.parseInt(window.getComputedStyle(element).zIndex, 10),
          ),
        ),
      ]);
      return (
        gutterZ > labelZ &&
        labelZ > overlayZ &&
        laneZValues.every((laneZ) => overlayZ > laneZ)
      );
    })
    .toBe(true);

  const surfaceScrollTop = await surface.evaluate((element) => {
    element.scrollTop = 240;
    return element.scrollTop;
  });
  expect(surfaceScrollTop).toBe(0);

  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 900;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBeGreaterThan(800);
  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const container = document.querySelector(
          `[data-timeline-scroll-container="true"][data-timeline-uid="${uid}"]`,
        );
        const firstTrackRow = document.querySelector(
          '[data-timeline-track-row="true"]',
        );
        if (!container || !firstTrackRow) {
          return false;
        }
        const containerBox = container.getBoundingClientRect();
        const rowBox = firstTrackRow.getBoundingClientRect();
        const target = document.elementFromPoint(
          containerBox.right - 24,
          rowBox.top + rowBox.height / 2,
        );
        return Boolean(target?.closest('[data-timeline-track-row="true"]'));
      }, timelineUid),
    )
    .toBe(true);

  const toolbarBefore = await toolbar.boundingBox();
  const rulerBefore = await ruler.boundingBox();
  const waveformBefore = await waveform.boundingBox();
  const waveformContentBefore = await waveformContent.boundingBox();
  const footerBefore = await footer.boundingBox();
  const labelColumnBefore = await labelColumn.boundingBox();
  const rowViewportBefore = await rowViewport.boundingBox();
  const firstHeaderBefore = await firstHeader.boundingBox();
  const firstRowBefore = await firstRow.boundingBox();
  expect(toolbarBefore).toBeTruthy();
  expect(rulerBefore).toBeTruthy();
  expect(waveformBefore).toBeTruthy();
  expect(waveformContentBefore).toBeTruthy();
  expect(footerBefore).toBeTruthy();
  expect(labelColumnBefore).toBeTruthy();
  expect(rowViewportBefore).toBeTruthy();
  expect(firstHeaderBefore).toBeTruthy();
  expect(firstRowBefore).toBeTruthy();
  if (
    !toolbarBefore ||
    !rulerBefore ||
    !waveformBefore ||
    !waveformContentBefore ||
    !footerBefore ||
    !labelColumnBefore ||
    !rowViewportBefore ||
    !firstHeaderBefore ||
    !firstRowBefore
  ) {
    throw new Error("Expected timeline bounds before row scroll");
  }

  expect(
    Math.abs(labelColumnBefore.x - rowViewportBefore.x),
  ).toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      overlayLayer.evaluate(
        (element) => window.getComputedStyle(element).overflowX,
      ),
    )
    .toBe("hidden");
  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBe(0);
  const waveformAfterReset = await waveform.boundingBox();
  const scrollContainerAfterReset = await scrollContainer.boundingBox();
  expect(waveformAfterReset).toBeTruthy();
  expect(scrollContainerAfterReset).toBeTruthy();
  if (!waveformAfterReset) {
    throw new Error("Expected waveform bounds after resetting scroll");
  }
  if (!scrollContainerAfterReset) {
    throw new Error("Expected scroll container bounds after resetting scroll");
  }
  await page.mouse.move(
    scrollContainerAfterReset.x + labelColumnBefore.width + 120,
    waveformAfterReset.y + waveformAfterReset.height / 2,
  );
  await page.mouse.wheel(900, 0);
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBeGreaterThan(100);
  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBe(0);
  await seekTimelineTimecode(page, timelineUid, 1200);
  await expect
    .poll(async () => {
      const [rulerBounds, waveformBounds, playheadBounds] = await Promise.all([
        ruler.boundingBox(),
        waveform.boundingBox(),
        playhead.boundingBox(),
      ]);
      if (!rulerBounds || !waveformBounds || !playheadBounds) {
        return false;
      }
      return (
        playheadBounds.y <= rulerBounds.y + 1 &&
        playheadBounds.y + playheadBounds.height >=
          waveformBounds.y + waveformBounds.height - 1 &&
        playheadBounds.x > rulerBounds.x + 40 &&
        playheadBounds.x < rulerBounds.x + rulerBounds.width - 40
      );
    })
    .toBe(true);
  expect(firstHeaderBefore.y).toBeGreaterThanOrEqual(rowViewportBefore.y - 1);
  expect(firstRowBefore.y).toBeGreaterThanOrEqual(rowViewportBefore.y - 1);

  await rowViewport.evaluate((element) => {
    element.scrollTop = 1400;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() =>
      rowViewport.evaluate((element) => Math.round(element.scrollTop)),
    )
    .toBeGreaterThan(1000);

  const toolbarAfter = await toolbar.boundingBox();
  const rulerAfter = await ruler.boundingBox();
  const waveformAfter = await waveform.boundingBox();
  const footerAfter = await footer.boundingBox();
  const labelColumnAfter = await labelColumn.boundingBox();
  const rowViewportAfter = await rowViewport.boundingBox();
  const firstHeaderAfter = await firstHeader.boundingBox();
  const firstRowAfter = await firstRow.boundingBox();
  expect(toolbarAfter).toBeTruthy();
  expect(rulerAfter).toBeTruthy();
  expect(waveformAfter).toBeTruthy();
  expect(footerAfter).toBeTruthy();
  expect(labelColumnAfter).toBeTruthy();
  expect(rowViewportAfter).toBeTruthy();
  expect(firstHeaderAfter).toBeTruthy();
  expect(firstRowAfter).toBeTruthy();
  if (
    !toolbarAfter ||
    !rulerAfter ||
    !waveformAfter ||
    !footerAfter ||
    !labelColumnAfter ||
    !rowViewportAfter ||
    !firstHeaderAfter ||
    !firstRowAfter
  ) {
    throw new Error("Expected timeline bounds after row scroll");
  }

  expect(Math.abs(toolbarAfter.y - toolbarBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(rulerAfter.y - rulerBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(waveformAfter.y - waveformBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(footerAfter.y - footerBefore.y)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(labelColumnAfter.x - labelColumnBefore.x),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(labelColumnAfter.x - rowViewportAfter.x)).toBeLessThanOrEqual(
    1,
  );
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-timeline-chrome-gutter="true"]') !== null,
      {
        x: labelColumnAfter.x + labelColumnAfter.width / 2,
        y: rulerAfter.y + rulerAfter.height + 24,
      },
    ),
  ).toBe(true);
  const topEdgeHint = surface
    .locator('[data-timeline-action-edge-hint="top"]')
    .first();
  const bottomEdgeHint = surface
    .locator('[data-timeline-action-edge-hint="bottom"]')
    .first();
  await expect(topEdgeHint).toBeVisible();
  await expect(bottomEdgeHint).toBeVisible();
  const topEdgeHintBox = await topEdgeHint.boundingBox();
  const bottomEdgeHintBox = await bottomEdgeHint.boundingBox();
  expect(topEdgeHintBox).toBeTruthy();
  expect(bottomEdgeHintBox).toBeTruthy();
  if (!topEdgeHintBox || !bottomEdgeHintBox) {
    throw new Error("Expected timeline action edge hint bounds");
  }
  expect(topEdgeHintBox.y).toBeGreaterThanOrEqual(rowViewportAfter.y + 135);
  expect(topEdgeHintBox.y).toBeLessThanOrEqual(rowViewportAfter.y + 146);
  expect(topEdgeHintBox.x).toBeGreaterThanOrEqual(
    rowViewportAfter.x + labelColumnAfter.width,
  );
  expect(topEdgeHintBox.x).toBeLessThanOrEqual(rowViewportAfter.x + 700);
  expect(bottomEdgeHintBox.y).toBeGreaterThanOrEqual(
    rowViewportAfter.y + rowViewportAfter.height - 11,
  );
  expect(bottomEdgeHintBox.y).toBeLessThanOrEqual(
    rowViewportAfter.y + rowViewportAfter.height,
  );
  expect(bottomEdgeHintBox.x).toBeGreaterThanOrEqual(
    rowViewportAfter.x + labelColumnAfter.width,
  );
  expect(bottomEdgeHintBox.x).toBeLessThanOrEqual(rowViewportAfter.x + 700);
  expect(
    await page.evaluate(
      ({ x, y }) =>
        Boolean(
          document
            .elementFromPoint(x, y)
            ?.closest('[data-timeline-track-row="true"]'),
        ),
      {
        x: rowViewportAfter.x + labelColumnAfter.width + 120,
        y: waveformAfter.y + waveformAfter.height / 2,
      },
    ),
  ).toBe(false);
  expect(firstHeaderAfter.y).toBeLessThan(firstHeaderBefore.y - 200);
  expect(firstRowAfter.y).toBeLessThan(firstRowBefore.y - 200);
  expect(Math.abs(firstHeaderAfter.y - firstRowAfter.y)).toBeLessThanOrEqual(1);
});

/** Verifies three exact owned marker selections delete as one group. */
test("shift-click selected timeline markers delete as a group", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();

  const context = await openIsolatedTimeline(page);
  const timelineUid = context.timelineUid;
  const markerUids = await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) throw new Error(`Timeline ${uid} was not available`);
    const markerIds = [
      "c7501000000000000000000000000001",
      "c7501000000000000000000000000002",
      "c7501000000000000000000000000003",
    ];
    stores.timelines.setKey(uid, {
      ...timeline,
      markers: markerIds.map((markerUid, index) => ({
        uid: markerUid,
        label: `Delete Marker ${index + 1}`,
        time: { secs: index + 1, nanos: 0 },
      })),
    });
    return markerIds;
  }, timelineUid);

  const firstMarker = page.locator(`[data-marker-id="${markerUids[0]}"]`);
  const lastMarker = page.locator(`[data-marker-id="${markerUids[2]}"]`);
  await expect(firstMarker).toBeVisible();
  await expect(lastMarker).toBeVisible();

  await firstMarker.click();
  await lastMarker.click({ modifiers: ["Shift"] });
  await expect(page.locator('[data-timeline-marker="true"]')).toHaveCount(3);

  await page.keyboard.press("Delete");
  await expect(page.locator('[data-timeline-marker="true"]')).toHaveCount(0);
});

/** Verifies marker, region, nudge, zoom, and loop controls on the owned timeline. */
test("timeline operator marker region nudge and loop overlays are usable", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  const timelineUid = await openFirstTimeline(page);
  expect(timelineUid).toBeTruthy();
  if (!timelineUid) throw new Error("Expected a timeline UID from appStores");

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();

  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) return;
    stores.timelines.setKey(uid, { ...timeline, loop_range: undefined });
  }, timelineUid);
  const loopOverlay = page.locator('[data-timeline-loop-overlay="true"]');
  await expect(loopOverlay).toHaveCount(0);

  const loopButton = page.getByRole("button", { name: "Toggle loop range" });
  await loopButton.click();
  await expect(loopOverlay).toBeVisible();
  await loopButton.click({ modifiers: ["Shift"] });
  await expect(loopOverlay).toHaveCount(0);
  await loopButton.click();
  await expect(loopOverlay).toBeVisible();
  await surface.click({ position: { x: 320, y: 120 } });
  await page.keyboard.press("Shift+l");
  await expect(loopOverlay).toHaveCount(0);

  const lane = page.locator('[data-timeline-operator-lane="true"]').first();
  await expect(lane).toBeVisible();

  const scrollMode = page.getByLabel("Timeline scroll mode");
  await expect(scrollMode).toBeVisible();
  await expect(page.getByText("Scroll:")).toHaveCount(0);
  const laneBox = await lane.boundingBox();
  const scrollModeBox = await scrollMode.boundingBox();
  expect(laneBox).toBeTruthy();
  expect(scrollModeBox).toBeTruthy();
  if (!laneBox || !scrollModeBox) {
    throw new Error("Expected timeline lane and scroll mode bounds");
  }
  expect(scrollModeBox.y).toBeGreaterThan(laneBox.y);

  const expandableHeader = page
    .locator('[data-timeline-track-header="true"]')
    .filter({
      has: page.locator(
        'button[title="Expand automation lanes"], button[title="Collapse automation lanes"]',
      ),
    })
    .first();
  await expect(expandableHeader).toBeVisible();
  const expandableTrackId =
    await expandableHeader.getAttribute("data-track-id");
  expect(expandableTrackId).toBeTruthy();
  if (!expandableTrackId) {
    throw new Error("Expected expandable track id");
  }
  const expandButton = expandableHeader.locator(
    'button[title="Expand automation lanes"], button[title="Collapse automation lanes"]',
  );
  if (
    (await expandButton.getAttribute("title")) === "Expand automation lanes"
  ) {
    await expandButton.click();
  }
  await expect(expandButton).toHaveAttribute(
    "title",
    "Collapse automation lanes",
  );
  const expandedTrackRow = page.locator(
    `[data-timeline-track-row="true"][data-track-id="${expandableTrackId}"]`,
  );
  await expect
    .poll(async () => {
      const headerBox = await expandableHeader.boundingBox();
      const rowBox = await expandedTrackRow.boundingBox();
      if (!headerBox || !rowBox) return Number.NaN;
      return Math.abs(headerBox.height - rowBox.height);
    })
    .toBeLessThanOrEqual(1);

  const zoomInput = page.getByLabel("Timeline zoom");
  await zoomInput.fill("100");
  await surface.click({ position: { x: 320, y: 120 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("=");
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await zoomInput.inputValue())).toBe(110);

  await page.keyboard.down("Control");
  await page.keyboard.press("-");
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await zoomInput.inputValue())).toBe(100);

  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).toBeTruthy();
  if (!surfaceBox) throw new Error("Expected timeline surface bounds");
  await page.mouse.move(surfaceBox.x + 320, surfaceBox.y + 120);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await zoomInput.inputValue())).toBe(110);

  const outsideWheelPrevented = await page.evaluate(() => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(outsideWheelPrevented).toBe(true);
  await expect.poll(async () => Number(await zoomInput.inputValue())).toBe(110);
  await zoomInput.fill("100");

  const nudgeUnit = page.getByLabel("Nudge unit");
  await nudgeUnit.selectOption("quarter");
  await surface.click({ position: { x: 320, y: 120 } });
  await page.keyboard.press("Alt+ArrowUp");
  await expect(nudgeUnit).toHaveValue("half");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(nudgeUnit).toHaveValue("quarter");

  const initialMarkerCount = await page
    .locator('[data-timeline-marker="true"]')
    .count();
  await lane.click({ position: { x: 100, y: 18 } });
  await page.keyboard.press("m");
  await expect(page.locator('[data-timeline-marker="true"]')).toHaveCount(
    initialMarkerCount + 1,
  );
  const markerLabelEditor = page.getByLabel("Marker label");
  await expect(markerLabelEditor).toBeVisible();
  await expect(markerLabelEditor).toHaveValue(/^Marker \d+$/);
  await expect(markerLabelEditor).toHaveClass(/nf-form-control/);
  await surface.screenshot({
    path: testInfo.outputPath("shared-marker-label.png"),
  });
  await page.waitForTimeout(500);
  await expect(markerLabelEditor).toBeVisible();
  await expect
    .poll(() =>
      markerLabelEditor.evaluate((input: HTMLInputElement) => ({
        start: input.selectionStart,
        end: input.selectionEnd,
        length: input.value.length,
      })),
    )
    .toEqual({
      start: 0,
      end: (await markerLabelEditor.inputValue()).length,
      length: (await markerLabelEditor.inputValue()).length,
    });
  const defaultEditorWidth = await markerLabelEditor.evaluate(
    (input) => input.getBoundingClientRect().width,
  );
  await page.keyboard.type("Draft");
  await expect(markerLabelEditor).toHaveValue("Draft");
  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) return;
    stores.timelines.setKey(uid, {
      ...timeline,
      markers: timeline.markers.map((marker: any) => ({ ...marker })),
    });
  }, timelineUid);
  await expect(markerLabelEditor).toHaveValue("Draft");
  await markerLabelEditor.fill("Inline Marker");
  await expect
    .poll(() =>
      markerLabelEditor.evaluate(
        (input) => input.getBoundingClientRect().width,
      ),
    )
    .toBeGreaterThan(defaultEditorWidth);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Marker label")).toHaveCount(0);

  const transientMarker = page.locator('[data-timeline-marker="true"]').last();
  await expect(transientMarker).toContainText("Inline Marker");
  const existingAction = page.locator('[data-timeline-action="true"]').first();
  await expect(existingAction).toBeVisible();
  await transientMarker.click();
  await page.keyboard.press("Enter");
  await expect(markerLabelEditor).toBeVisible();
  await markerLabelEditor.fill("Cancelled Marker");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Marker label")).toHaveCount(0);
  await expect(transientMarker).toContainText("Inline Marker");
  await transientMarker.click();
  await page.keyboard.press("Enter");
  await expect(markerLabelEditor).toBeVisible();
  await markerLabelEditor.fill("Blur Marker");
  await existingAction.click();
  await expect(page.getByLabel("Marker label")).toHaveCount(0);
  await expect(transientMarker).toContainText("Blur Marker");
  await transientMarker.click();
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-timeline-marker="true"]')).toHaveCount(
    initialMarkerCount,
  );
  await page.keyboard.press("Delete");
  await expect(existingAction).toBeVisible();

  const markerCountBeforeNavigationMarker = await page
    .locator('[data-timeline-marker="true"]')
    .count();
  await lane.click({ position: { x: 100, y: 18 } });
  await page.keyboard.press("m");
  await expect
    .poll(async () => page.locator('[data-timeline-marker="true"]').count())
    .toBeGreaterThanOrEqual(markerCountBeforeNavigationMarker + 1);
  await expect(markerLabelEditor).toBeVisible();
  await markerLabelEditor.fill("Navigation Marker");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Marker label")).toHaveCount(0);

  const marker = page
    .locator('[data-timeline-marker="true"]')
    .filter({ hasText: "Navigation Marker" })
    .last();
  await expect(marker).toBeVisible();
  await marker.click();
  await expect
    .poll(async () => {
      const laneTop = (await lane.boundingBox())?.y ?? Number.NaN;
      const markerLabelTop =
        (await marker.locator("div").last().boundingBox())?.y ?? Number.NaN;
      return Math.abs(markerLabelTop - laneTop);
    })
    .toBeLessThanOrEqual(1);
  const markerBeforeNudge = await locatorClientRect(marker);
  await surface
    .locator('[data-timeline-toolbar="true"]')
    .getByRole("button", { name: "Snap" })
    .click();
  await page.getByLabel("Nudge unit").selectOption("bar");
  await page.keyboard.press("Alt+ArrowRight");
  await expect
    .poll(async () => (await marker.boundingBox())?.x ?? 0)
    .toBeGreaterThan(markerBeforeNudge.x + 100);

  const markerLabel = (await marker.textContent())?.trim();
  expect(markerLabel).toBeTruthy();
  if (!markerLabel) throw new Error("Expected marker label");
  await page.keyboard.press("Home");
  const playhead = page.locator('[data-timeline-playhead="true"]');
  await expect
    .poll(async () => {
      const playheadBox = await playhead.boundingBox();
      const markerBox = await marker.boundingBox();
      if (!playheadBox || !markerBox) return 0;
      return Math.abs(playheadBox.x - markerBox.x);
    })
    .toBeGreaterThan(20);
  await surface.click({ position: { x: 320, y: 120 } });
  await page.keyboard.press("ControlOrMeta+G");
  const gotoPopout = page.locator('[data-timeline-popout="goto"]');
  await expect(gotoPopout).toBeVisible();
  const gotoFilter = page.getByLabel("Timeline jump target");
  await gotoFilter.fill(markerLabel);
  const gotoOption = gotoPopout
    .getByRole("option")
    .filter({ hasText: markerLabel })
    .first();
  await expect(gotoOption).toContainText("Label");
  await expect(gotoOption).toContainText(/\d+:\d{2}/);
  await expect(gotoOption).toContainText(/Beat \d+:\d{2}/);
  await page.keyboard.press("Enter");
  await expect(gotoPopout).toBeHidden();
  await expect
    .poll(async () =>
      Math.abs(
        ((await playhead.boundingBox())?.x ?? 0) -
          ((await marker.boundingBox())?.x ?? Number.POSITIVE_INFINITY),
      ),
    )
    .toBeLessThanOrEqual(4);

  await surface.click({ position: { x: 320, y: 120 } });
  await page.keyboard.press("ControlOrMeta+G");
  await expect(gotoPopout).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(gotoPopout).toBeHidden();

  await zoomInput.fill("25");
  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) return;
    stores.timelines.setKey(uid, { ...timeline, loop_range: undefined });
  }, timelineUid);
  await expect(page.locator('[data-timeline-loop-overlay="true"]')).toHaveCount(
    0,
  );

  const scrollContainer = page.locator(
    `[data-timeline-scroll-container="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect
    .poll(() =>
      scrollContainer.evaluate((element) => Math.round(element.scrollLeft)),
    )
    .toBe(0);

  const initialRegionCount = await page
    .locator('[data-timeline-region="true"]')
    .count();
  await lane.click({ button: "right", position: { x: 280, y: 34 } });
  const addRegion = page.getByRole("button", {
    name: "Add region",
    exact: true,
  });
  await expect(addRegion).toHaveClass(/nf-menu-item/);
  await page
    .locator(".nf-menu")
    .filter({ has: addRegion })
    .screenshot({
      path: testInfo.outputPath("shared-timeline-overlay-menu.png"),
    });
  await addRegion.click();
  await expect(page.locator('[data-timeline-region="true"]')).toHaveCount(
    initialRegionCount + 1,
  );

  const region = page.locator('[data-timeline-region="true"]').last();
  await expect(region).toBeVisible();
  const regionBeforeResize = await locatorClientRect(region);
  const leftHandle = region.locator("button").first();
  const leftHandleBox = await locatorClientRect(leftHandle);
  await expect
    .poll(async () =>
      leftHandle.evaluate((element) => getComputedStyle(element).cursor),
    )
    .toBe("ew-resize");
  await page.mouse.move(
    leftHandleBox.x + leftHandleBox.width / 2,
    leftHandleBox.y + leftHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    leftHandleBox.x + leftHandleBox.width / 2 + 40,
    leftHandleBox.y + leftHandleBox.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await region.boundingBox())?.width ?? 0)
    .toBeLessThan(regionBeforeResize.width - 20);

  await region.click();
  await region.click({ button: "right" });
  await expect(loopOverlay).toBeVisible();
  const loopBeforeResize = await locatorClientRect(loopOverlay);
  const loopStartHandle = page.getByLabel("Resize loop range start");
  await expect
    .poll(async () =>
      loopStartHandle.evaluate((element) => getComputedStyle(element).cursor),
    )
    .toBe("ew-resize");
  const loopStartHandleBox = await locatorClientRect(loopStartHandle);
  await page.mouse.move(
    loopStartHandleBox.x + loopStartHandleBox.width / 2,
    loopStartHandleBox.y + loopStartHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    loopStartHandleBox.x + loopStartHandleBox.width / 2 + 40,
    loopStartHandleBox.y + loopStartHandleBox.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await loopOverlay.boundingBox())?.width ?? 0)
    .toBeLessThan(loopBeforeResize.width - 20);

  await expect(marker).toBeVisible();
  await expect(region).toBeVisible();
  const screenshotPath = testInfo.outputPath(
    "owned-marker-region-loop-overlays.png",
  );
  await surface.screenshot({ path: screenshotPath });
  await testInfo.attach("owned-marker-region-loop-overlays", {
    path: screenshotPath,
    contentType: "image/png",
  });
});

/** Verifies deterministic item flags support additive and range selection. */
test("shift-click multi-selects timeline action flags", async ({ page }) => {
  await page.goto("/");

  const { timelineUid } = await openIsolatedTimeline(page);
  expect(timelineUid).toBeTruthy();

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("100");

  const selectedActions = await page.evaluate(
    ({ uid, cueUid }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) return null;

      const trackId = "owned-operator-shift-select-track";
      const actionIds = [1, 2, 3, 4, 5].map(
        (index) => `owned-operator-shift-select-${index}`,
      );
      const items = actionIds.map((id, index) => {
        const positionMs = (index + 1) * 2000;
        return {
          id,
          label: `Shift-select ${index + 1}`,
          position: {
            secs: Math.floor(positionMs / 1000),
            nanos: (positionMs % 1000) * 1_000_000,
          },
          duration: { secs: 0, nanos: 0 },
          action: {
            type: "FireCue",
            data: cueUid,
          },
        };
      });

      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: [
          {
            id: trackId,
            label: "E2E Shift Selection",
            muted: false,
            solo: false,
            expanded: false,
            items,
            automation_lanes: [],
          },
        ],
      });

      return {
        trackId,
        firstItemId: actionIds[0],
        secondItemId: actionIds[1],
        thirdItemId: actionIds[2],
        fourthItemId: actionIds[3],
        fifthItemId: actionIds[4],
      };
    },
    { uid: timelineUid, cueUid: CUE_UID },
  );
  expect(selectedActions).toBeTruthy();
  if (!selectedActions) throw new Error("Expected fixture actions");

  const firstItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${selectedActions.trackId}"][data-action-id="${selectedActions.firstItemId}"]`,
  );
  const secondItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${selectedActions.trackId}"][data-action-id="${selectedActions.secondItemId}"]`,
  );
  const thirdItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${selectedActions.trackId}"][data-action-id="${selectedActions.thirdItemId}"]`,
  );
  const fourthItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${selectedActions.trackId}"][data-action-id="${selectedActions.fourthItemId}"]`,
  );
  const fifthItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${selectedActions.trackId}"][data-action-id="${selectedActions.fifthItemId}"]`,
  );
  await expect(firstItem).toBeVisible();
  await expect(secondItem).toBeVisible();
  await expect(thirdItem).toBeVisible();
  await expect(fourthItem).toBeVisible();
  await expect(fifthItem).toBeVisible();

  await firstItem.click();
  await expect(firstItem).toHaveAttribute("data-selected", "true");
  await expect(secondItem).toHaveAttribute("data-selected", "false");
  await expect(thirdItem).toHaveAttribute("data-selected", "false");
  await expect(fourthItem).toHaveAttribute("data-selected", "false");
  await expect(fifthItem).toHaveAttribute("data-selected", "false");

  await thirdItem.click({ modifiers: ["ControlOrMeta"] });
  await expect(firstItem).toHaveAttribute("data-selected", "true");
  await expect(secondItem).toHaveAttribute("data-selected", "false");
  await expect(thirdItem).toHaveAttribute("data-selected", "true");
  await expect(fourthItem).toHaveAttribute("data-selected", "false");
  await expect(fifthItem).toHaveAttribute("data-selected", "false");

  await fifthItem.click({ modifiers: ["Shift"] });
  await expect(firstItem).toHaveAttribute("data-selected", "true");
  await expect(secondItem).toHaveAttribute("data-selected", "false");
  await expect(thirdItem).toHaveAttribute("data-selected", "true");
  await expect(fourthItem).toHaveAttribute("data-selected", "true");
  await expect(fifthItem).toHaveAttribute("data-selected", "true");

  const firstBeforeNudge = await firstItem.boundingBox();
  const secondBeforeNudge = await secondItem.boundingBox();
  const thirdBeforeNudge = await thirdItem.boundingBox();
  const fourthBeforeNudge = await fourthItem.boundingBox();
  const fifthBeforeNudge = await fifthItem.boundingBox();
  expect(firstBeforeNudge).toBeTruthy();
  expect(secondBeforeNudge).toBeTruthy();
  expect(thirdBeforeNudge).toBeTruthy();
  expect(fourthBeforeNudge).toBeTruthy();
  expect(fifthBeforeNudge).toBeTruthy();

  const snapButton = surface
    .locator('[data-timeline-toolbar="true"]')
    .getByRole("button", { name: "Snap" });
  if ((await snapButton.getAttribute("aria-pressed")) !== "true") {
    await snapButton.click();
  }
  await page.getByLabel("Nudge unit").selectOption("bar");
  await page.keyboard.press("Alt+ArrowRight");

  await expect
    .poll(async () => {
      const firstAfterNudge = await firstItem.boundingBox();
      return (firstAfterNudge?.x ?? 0) - (firstBeforeNudge?.x ?? 0);
    })
    .toBeGreaterThan(100);
  await expect
    .poll(async () => {
      const secondAfterNudge = await secondItem.boundingBox();
      return Math.abs((secondAfterNudge?.x ?? 0) - (secondBeforeNudge?.x ?? 0));
    })
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => {
      const thirdAfterNudge = await thirdItem.boundingBox();
      return (thirdAfterNudge?.x ?? 0) - (thirdBeforeNudge?.x ?? 0);
    })
    .toBeGreaterThan(100);
  await expect
    .poll(async () => {
      const fourthAfterNudge = await fourthItem.boundingBox();
      return (fourthAfterNudge?.x ?? 0) - (fourthBeforeNudge?.x ?? 0);
    })
    .toBeGreaterThan(100);
  await expect
    .poll(async () => {
      const fifthAfterNudge = await fifthItem.boundingBox();
      return (fifthAfterNudge?.x ?? 0) - (fifthBeforeNudge?.x ?? 0);
    })
    .toBeGreaterThan(100);
});

/** Verifies dense timeline action appends render without a multi-frame delay. */
test("dense timeline action appends render within one interaction frame", async ({
  page,
}) => {
  await page.goto("/");

  const isolated = await openIsolatedTimeline(page);
  const seeded = await seedDenseTimelineItems(page, isolated.timelineUid, 300);
  if (!seeded?.moveItemId) throw new Error("Expected dense timeline fixture");

  await expect(
    page.locator(
      `[data-timeline-action="true"][data-track-id="${seeded.trackId}"]`,
    ),
  ).toHaveCount(300);
  await page.waitForTimeout(500);

  const appendElapsedMs = await measureTimelineItemAppendRenderMs(
    page,
    isolated.timelineUid,
    seeded.trackId,
    seeded.newCueUid,
  );
  const moveElapsedMs = await measureTimelineItemMoveRenderMs(
    page,
    isolated.timelineUid,
    seeded.trackId,
    seeded.moveItemId,
  );

  expect(appendElapsedMs).toBeLessThan(50);
  expect(moveElapsedMs).toBeLessThan(50);
});

/** Verifies vertical action drags move a selected action to another track at the pointer time. */
test("timeline actions can be dragged between tracks", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  const { timelineUid } = await openIsolatedTimeline(page);
  expect(timelineUid).toBeTruthy();

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("100");
  const snapButton = surface.getByRole("button", { name: "Snap" });
  if ((await snapButton.getAttribute("aria-pressed")) === "true") {
    await snapButton.click();
  }

  const seededItems = await page.evaluate(
    ({ uid, cueUid }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) return null;

      const sourceTrackId = "owned-operator-drag-source";
      const targetTrackId = "owned-operator-drag-target";
      const actionId = "owned-operator-cross-action";
      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: [
          {
            id: sourceTrackId,
            label: "E2E Drag Source",
            muted: false,
            solo: false,
            expanded: false,
            actions: [
              {
                id: actionId,
                label: "Cross-action",
                position: { secs: 1, nanos: 0 },
                duration: { secs: 0, nanos: 0 },
                action: {
                  type: "FireCue",
                  data: cueUid,
                },
              },
            ],
            automation_lanes: [],
          },
          {
            id: targetTrackId,
            label: "E2E Drag Target",
            muted: false,
            solo: false,
            expanded: false,
            actions: [],
            automation_lanes: [],
          },
        ],
      });

      return { sourceTrackId, targetTrackId, actionId };
    },
    { uid: timelineUid, cueUid: CUE_UID },
  );
  expect(seededItems).toBeTruthy();
  if (!seededItems) throw new Error("Expected fixture actions");

  const sourceItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${seededItems.sourceTrackId}"][data-action-id="${seededItems.actionId}"]`,
  );
  const sourceChip = sourceItem.locator('[data-timeline-action-chip="true"]');
  const sourceLane = page.locator(
    `[data-timeline-track-lane="true"][data-track-id="${seededItems.sourceTrackId}"]`,
  );
  const targetLane = page.locator(
    `[data-timeline-track-lane="true"][data-track-id="${seededItems.targetTrackId}"]`,
  );
  await expect(sourceItem).toBeVisible();
  await expect(sourceChip).toBeVisible();
  await expect(sourceLane).toBeVisible();
  await expect(targetLane).toBeVisible();
  await expect(
    page.locator(
      '[data-action-drop-target="true"][data-track-id="add-track-placeholder"]',
    ),
  ).toHaveCount(0);

  await sourceChip.click();
  await expect(sourceItem).toHaveAttribute("data-selected", "true");

  const chipBox = await sourceChip.boundingBox();
  const sourceLaneBox = await sourceLane.boundingBox();
  const targetLaneBox = await targetLane.boundingBox();
  expect(chipBox).toBeTruthy();
  expect(sourceLaneBox).toBeTruthy();
  expect(targetLaneBox).toBeTruthy();
  if (!chipBox || !sourceLaneBox || !targetLaneBox) {
    throw new Error("Expected action chip and lane bounds");
  }

  const dragX = chipBox.x + chipBox.width / 2;
  const dragStartY = chipBox.y + chipBox.height / 2;
  const dragEndY = targetLaneBox.y + targetLaneBox.height / 2;
  const expectedPositionMs = Math.round(
    ((dragX - sourceLaneBox.x) * 1000) / 100,
  );
  await expect
    .poll(async () =>
      page.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return Boolean(element?.closest("[data-timeline-action='true']"));
        },
        { x: dragX, y: dragStartY },
      ),
    )
    .toBe(true);
  await page.mouse.move(dragX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragX + 8, dragStartY + 4);
  await page.mouse.move(dragX, dragEndY, { steps: 12 });
  await page.mouse.up();

  const movedItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${seededItems.targetTrackId}"][data-action-id="${seededItems.actionId}"]`,
  );
  await expect(movedItem).toBeVisible();
  await expect(movedItem).toHaveAttribute("data-selected", "true");
  await expect(sourceItem).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(
        ({ uid, sourceTrackId, targetTrackId }) => {
          const timeline = (window as any).appStores.timelines.get()[uid];
          const sourceTrack = timeline?.tracks.find(
            (track: any) => track.id === sourceTrackId,
          );
          const targetTrack = timeline?.tracks.find(
            (track: any) => track.id === targetTrackId,
          );
          return {
            sourceCount: sourceTrack?.items.length,
            targetCount: targetTrack?.items.length,
          };
        },
        {
          uid: timelineUid,
          sourceTrackId: seededItems.sourceTrackId,
          targetTrackId: seededItems.targetTrackId,
        },
      ),
    )
    .toEqual({ sourceCount: 0, targetCount: 1 });
  await expect
    .poll(async () =>
      page.evaluate(
        ({ uid, targetTrackId, actionId, expectedPositionMs }) => {
          const timeline = (window as any).appStores.timelines.get()[uid];
          const targetTrack = timeline?.tracks.find(
            (track: any) => track.id === targetTrackId,
          );
          const moved = targetTrack?.items.find(
            (item: any) => item.id === actionId,
          );
          return moved
            ? Math.abs(
                moved.position.secs * 1000 +
                  moved.position.nanos / 1_000_000 -
                  expectedPositionMs,
              )
            : Number.POSITIVE_INFINITY;
        },
        {
          uid: timelineUid,
          targetTrackId: seededItems.targetTrackId,
          actionId: seededItems.actionId,
          expectedPositionMs,
        },
      ),
    )
    .toBeLessThanOrEqual(10);

  const screenshotPath = testInfo.outputPath(
    "owned-cross-track-drag-result.png",
  );
  await surface.screenshot({ path: screenshotPath });
  await testInfo.attach("owned-cross-track-drag-result", {
    path: screenshotPath,
    contentType: "image/png",
  });

  await page.keyboard.press("Delete");
  await expect(movedItem).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(
        ({ uid, sourceTrackId, targetTrackId }) => {
          const timeline = (window as any).appStores.timelines.get()[uid];
          const sourceTrack = timeline?.tracks.find(
            (track: any) => track.id === sourceTrackId,
          );
          const targetTrack = timeline?.tracks.find(
            (track: any) => track.id === targetTrackId,
          );
          return {
            sourceCount: sourceTrack?.items.length,
            targetCount: targetTrack?.items.length,
          };
        },
        {
          uid: timelineUid,
          sourceTrackId: seededItems.sourceTrackId,
          targetTrackId: seededItems.targetTrackId,
        },
      ),
    )
    .toEqual({ sourceCount: 0, targetCount: 0 });
});

/** Verifies track row guideline clicks seek and select the clicked track. */
test("timeline track row borders seek and select the track", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  const { timelineUid } = await openIsolatedTimeline(page);
  expect(timelineUid).toBeTruthy();

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("100");
  await stopTimelineAtStart(page, timelineUid);

  const row = page.locator(
    `[data-timeline-track-row="true"][data-track-id="${BASE_TRACK_ID}"]`,
  );
  await expect(row).toBeVisible();

  await row.click({ position: { x: 160, y: 1 } });

  await expect
    .poll(async () =>
      Math.round(await getTimelineTimecodeMs(page, timelineUid)),
    )
    .toBeGreaterThan(1_000);
  await expect(row).toHaveAttribute("data-record-target", "true");
});

/** Verifies Space still targets timeline playback after action drag cleanup. */
test("timeline spacebar shortcut works after dragging a action", async ({
  page,
}) => {
  await page.goto("/");

  const { timelineUid } = await openIsolatedTimeline(page);
  expect(timelineUid).toBeTruthy();

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("100");
  await stopTimelineAtStart(page, timelineUid);

  const seededItem = await seedDraggableTimelineItem(
    page,
    timelineUid,
    "Space drag item",
  );
  expect(seededItem).toBeTruthy();
  if (!seededItem) throw new Error("Expected fixture action");

  const action = page.locator(
    `[data-timeline-action="true"][data-track-id="${seededItem.trackId}"][data-action-id="${seededItem.actionId}"]`,
  );
  const chip = action.locator('[data-timeline-action-chip="true"]');
  await expect(action).toBeVisible();
  await expect(chip).toBeVisible();

  const chipBox = await chip.boundingBox();
  expect(chipBox).toBeTruthy();
  if (!chipBox) throw new Error("Expected action chip bounds");

  const dragStartX = chipBox.x + chipBox.width / 2;
  const dragStartY = chipBox.y + chipBox.height / 2;
  await page.mouse.move(dragStartX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragStartX + 48, dragStartY, { steps: 8 });
  await page.mouse.up();

  await page.keyboard.press("Space");
  await expect
    .poll(() => isTimelineTimecodeActive(page, timelineUid))
    .toBe(true);

  await page.keyboard.press("Space");
  await expect
    .poll(() => isTimelineTimecodeActive(page, timelineUid))
    .toBe(false);
});

/** Verifies horizontal shift-wheel scrolling is restored immediately after item drags. */
test("timeline shift-wheel scroll works after dragging a action", async ({
  page,
}) => {
  await page.goto("/");

  const { timelineUid } = await openIsolatedTimeline(page);
  expect(timelineUid).toBeTruthy();

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("100");

  const seededItem = await seedDraggableTimelineItem(
    page,
    timelineUid,
    "Shift wheel drag item",
  );
  expect(seededItem).toBeTruthy();
  if (!seededItem) throw new Error("Expected fixture action");

  const scrollContainer = page.locator(
    `[data-timeline-scroll-container="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const action = page.locator(
    `[data-timeline-action="true"][data-track-id="${seededItem.trackId}"][data-action-id="${seededItem.actionId}"]`,
  );
  const chip = action.locator('[data-timeline-action-chip="true"]');
  await expect(scrollContainer).toBeVisible();
  await expect(chip).toBeVisible();

  const chipBox = await chip.boundingBox();
  expect(chipBox).toBeTruthy();
  if (!chipBox) throw new Error("Expected action chip bounds");

  const dragStartX = chipBox.x + chipBox.width / 2;
  const dragStartY = chipBox.y + chipBox.height / 2;
  await page.mouse.move(dragStartX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragStartX + 48, dragStartY, { steps: 8 });
  await page.mouse.up();

  await scrollContainer.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const scrollBox = await scrollContainer.boundingBox();
  expect(scrollBox).toBeTruthy();
  if (!scrollBox) throw new Error("Expected timeline scroll container bounds");

  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + 120);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(600, 0);
  await page.keyboard.up("Shift");

  await expect
    .poll(() => scrollContainer.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});
