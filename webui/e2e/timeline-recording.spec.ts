// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ experimentalFlows: true });

const TIMELINE_ID = 98_401;
const TIMECODE_ID = 98_401;
const FLOW_ID = 98_402;
const CLIP_ID = 98_403;
const TIMELINE_UID = "b8410000000000000000000000000001";
const TIMECODE_UID = "b8410000000000000000000000000002";
const FLOW_UID = "b8410000000000000000000000000003";
const CLIP_UID = "b8410000000000000000000000000004";
const BASE_TRACK_ID = "owned-recording-track";
const BASE_TRACK_LABEL = "Owned Recording Track";

type CommandResultSummary = {
  outcome:
    | { type: "Succeeded"; data: { output?: unknown } }
    | { type: "Failed"; data: { message: string } };
};

/** Stops owned playback, replaces the backend, and proves recording stores are blank. */
test.afterEach(async ({ backendSlot, page }) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
    await page
      .evaluate(async (timecodeId) => {
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
      }, TIMECODE_ID)
      .catch(() => undefined);
  }

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedRecordingStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      clips: 0,
      flows: 0,
      timecodes: 0,
      timelines: 0,
    });
});

/** Reads every backend store owned by the recording scenarios. */
async function ownedRecordingStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      clips: Object.keys(stores.clips.get()).length,
      flows: Object.keys(stores.flows.get()).length,
      timecodes: Object.keys(stores.timecodes.get()).length,
      timelines: Object.keys(stores.timelines.get()).length,
    };
  });
}

/** Builds the empty Flow used as a valid recording action source. */
function ownedFlow(): object {
  return {
    identifiers: {
      uid: FLOW_UID,
      id: FLOW_ID,
      label: "Owned Recording Flow",
    },
    flow_version: 0,
    nodes: [],
    edges: [],
  };
}

/** Builds the clip whose start actions are captured by timeline recording. */
function ownedClip(): object {
  return {
    identifiers: {
      uid: CLIP_UID,
      id: CLIP_ID,
      label: "Owned Recording Clip",
    },
    source: { type: "Flow", data: FLOW_UID },
    priority: 0,
    options: {
      auto_release: false,
      deactivate_on_sequence_end: false,
    },
  };
}

/** Builds the internal timecode that drives the owned timeline. */
function ownedTimecode(): object {
  return {
    identifiers: {
      uid: TIMECODE_UID,
      id: TIMECODE_ID,
      label: "Owned Recording Timecode",
    },
    rate: "Fps30",
    source: "Internal",
  };
}

/** Builds the exact expanded track needed by targeting and parameter UI checks. */
function ownedBaseTrack(): object {
  return {
    id: BASE_TRACK_ID,
    label: BASE_TRACK_LABEL,
    muted: false,
    solo: false,
    expanded: true,
    actions: [],
    automation_lanes: [
      {
        id: "owned-recording-parameter",
        name: "Owned Recording Curve",
        color: "#22c55e",
        points: [
          { position: { secs: 0, nanos: 0 }, value: 0.25 },
          { position: { secs: 5, nanos: 0 }, value: 0.75 },
        ],
        parameter_type: {
          type: "GlobalVariable",
          data: "owned-recording-variable",
        },
      },
    ],
  };
}

/** Builds the fixed timeline used by all recording workflow scenarios. */
function ownedTimeline(): object {
  return {
    identifiers: {
      uid: TIMELINE_UID,
      id: TIMELINE_ID,
      label: "Owned Recording Timeline",
    },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: "",
    tracks: [ownedBaseTrack()],
    markers: [],
    regions: [],
    bpm: 120,
    beats_per_bar: 4,
    use_beat_grid: false,
    lookahead: "disabled",
    scroll_mode: "free",
  };
}

/** Sends one backend command and returns its correlated terminal result. */
async function sendCommandAndAwait(
  page: Page,
  data: object,
): Promise<CommandResultSummary> {
  return page.evaluate(async (message) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(message);
  }, data);
}

/** Sends one backend command and rejects any failed terminal result. */
async function sendOwnedCommand(page: Page, data: object): Promise<void> {
  const result = await sendCommandAndAwait(page, data);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Sends a command family that intentionally publishes no correlated result. */
async function sendUncorrelatedCommand(
  page: Page,
  data: object,
): Promise<void> {
  await page.evaluate(async (message) => {
    const stores = (window as any).appStores;
    if (typeof stores?.send !== "function") {
      throw new Error("appStores.send did not initialize");
    }
    await stores.send(message);
  }, data);
}

/** Opens the exact owned timeline panel after its backend snapshot hydrates. */
async function openOwnedTimeline(page: Page): Promise<void> {
  await page.evaluate((timelineUid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[timelineUid];
    const api = stores.dockApi.get();
    if (!timeline || !api) {
      throw new Error(`Owned timeline ${timelineUid} did not hydrate`);
    }
    const panelId = `e2e-recording-timeline-${timelineUid}`;
    api.addPanel({
      id: panelId,
      component: "Timeline",
      title: `Timeline ${timeline.identifiers.id}`,
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    api.getPanel(panelId)?.focus();
  }, TIMELINE_UID);
}

/** Starts a fresh app, stores the complete recording graph, and opens its timeline. */
async function openOwnedRecordingApp(
  page: Page,
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
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.flows?.get) &&
      Boolean((window as any).appStores?.timecodes?.get) &&
      Boolean((window as any).appStores?.timelines?.get),
  );
  await expect
    .poll(() => ownedRecordingStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      clips: 0,
      flows: 0,
      timecodes: 0,
      timelines: 0,
    });

  await sendOwnedCommand(page, {
    module: "FlowCommand",
    command: { type: "StoreFlow", data: ownedFlow() },
  });
  await sendOwnedCommand(page, {
    module: "ClipCommand",
    command: { type: "StoreClip", data: ownedClip() },
  });
  await sendOwnedCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StoreTimecode", data: ownedTimecode() },
  });
  await sendOwnedCommand(page, {
    module: "TimelineCommand",
    command: { type: "StoreTimeline", data: ownedTimeline() },
  });
  await expect
    .poll(() => ownedRecordingStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      clips: 1,
      flows: 1,
      timecodes: 1,
      timelines: 1,
    });
  await openOwnedTimeline(page);
}

/** Clears the owned timeline loop range through a correlated backend command. */
async function clearTimelineLoopRange(page: Page): Promise<void> {
  await sendOwnedCommand(page, {
    module: "TimelineCommand",
    command: {
      type: "SetTimelineLoopRange",
      data: { timeline_id: TIMELINE_ID, loop_range: undefined },
    },
  });
}

/**
 * Reads the current timeline playhead position in milliseconds.
 */
async function timelinePositionMs(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const state = timeline
      ? stores.timecodes.get()[timeline.timecode_uid]?.[1]
      : undefined;
    const currentTime = state?.current_time;
    if (!currentTime) return null;
    return currentTime.secs * 1000 + currentTime.nanos / 1_000_000;
  }, timelineUid);
}

/**
 * Reads timeline track IDs grouped by expansion state.
 */
async function trackIdsByExpansion(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const tracks = timeline?.tracks as
      | Array<{ id: string; label: string; automation_lanes?: unknown[] }>
      | undefined;
    const expanded = tracks?.find((track) => track.automation_lanes?.length);
    const compact = tracks?.find((track) => track.label === "Recorded Actions");
    return {
      expandedTrackId: expanded?.id,
      expandedTrackLabel: expanded?.label,
      compactTrackId: compact?.id,
      compactTrackLabel: compact?.label,
    };
  }, timelineUid);
}

/**
 * Asserts that rendered track edges align across the timeline layout.
 */
async function expectTrackEdgesToAlign(
  page: import("@playwright/test").Page,
  trackId: string,
) {
  const edges = await page.evaluate((id) => {
    const header = document.querySelector(
      `[data-timeline-track-header="true"][data-track-id="${id}"]`,
    );
    const row = document.querySelector(
      `[data-timeline-track-row="true"][data-track-id="${id}"]`,
    );
    if (!header || !row) return null;
    const headerRect = header.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      topDelta: Math.abs(headerRect.top - rowRect.top),
      bottomDelta: Math.abs(headerRect.bottom - rowRect.bottom),
    };
  }, trackId);

  expect(edges).toBeTruthy();
  if (!edges) {
    throw new Error(`Expected track edges for ${trackId}`);
  }
  expect(edges.topDelta).toBeLessThanOrEqual(0.5);
  expect(edges.bottomDelta).toBeLessThanOrEqual(0.5);
}

/**
 * Counts recorded automation points on a timeline track.
 */
async function automationPointCount(
  page: import("@playwright/test").Page,
  trackId: string,
) {
  return page
    .locator(
      `[data-timeline-automation-lane="true"][data-track-id="${trackId}"]`,
    )
    .locator(".automation-point")
    .count();
}

/**
 * Reads the selected recording target state from the browser.
 */
async function recordingTargetState(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) return null;
    const state =
      stores.timelineRecordingStates.get()[String(timeline.identifiers.id)];
    if (!state) return null;
    return {
      enabled: state.enabled,
      hasTargetTrack: timeline.tracks.some(
        (track: { id: string }) => track.id === state.target_track_id,
      ),
    };
  }, timelineUid);
}

/**
 * Reads recording target details from the active timeline context.
 */
async function recordingTargetDetails(
  page: import("@playwright/test").Page,
  timelineUid: string,
) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) return null;
    const state =
      stores.timelineRecordingStates.get()[String(timeline.identifiers.id)];
    if (!state) return null;
    return {
      enabled: state.enabled,
      targetTrackId: state.target_track_id as string | undefined,
      hasTargetTrack: timeline.tracks.some(
        (track: { id: string }) => track.id === state.target_track_id,
      ),
    };
  }, timelineUid);
}

/**
 * Counts recorded timeline actions in browser state.
 */
async function recordedItemCount(
  page: import("@playwright/test").Page,
  timelineUid: string,
  trackId: string,
) {
  return page.evaluate(
    ({ uid, targetTrackId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const track = timeline?.tracks.find(
        (candidate: { id: string }) => candidate.id === targetTrackId,
      );
      return track?.actions?.length ?? 0;
    },
    { uid: timelineUid, targetTrackId: trackId },
  );
}

/**
 * Counts rendered timeline action elements in the track lane.
 */
async function renderedActionCount(
  page: import("@playwright/test").Page,
  trackId: string,
) {
  return page
    .locator(`[data-timeline-action="true"][data-track-id="${trackId}"]`)
    .count();
}

/** Verifies stopping timecode playback flushes buffered clip actions. */
test("timeline recording flushes captured clip actions when playback stops", async ({
  backendSlot,
  page,
}) => {
  await openOwnedRecordingApp(page, backendSlot.backendPort);

  await expect(
    page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${TIMELINE_UID}"]`,
    ),
  ).toBeVisible();

  await expect
    .poll(() => recordedItemCount(page, TIMELINE_UID, BASE_TRACK_ID))
    .not.toBeNull();

  const countBefore = await recordedItemCount(
    page,
    TIMELINE_UID,
    BASE_TRACK_ID,
  );
  const renderedBefore = await renderedActionCount(page, BASE_TRACK_ID);

  await sendOwnedCommand(page, {
    module: "TimelineCommand",
    command: {
      type: "SetTimelineRecording",
      data: {
        timeline_id: TIMELINE_ID,
        enabled: true,
        target_track_id: BASE_TRACK_ID,
      },
    },
  });
  await sendOwnedCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StartTimecode", data: TIMECODE_ID },
  });
  await page.waitForTimeout(250);
  await sendUncorrelatedCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StartClip",
      data: { type: "Single", data: CLIP_ID },
    },
  });
  await expect
    .poll(() => renderedActionCount(page, BASE_TRACK_ID), {
      timeout: 10_000,
    })
    .toBeGreaterThan(renderedBefore);
  expect(await recordedItemCount(page, TIMELINE_UID, BASE_TRACK_ID)).toBe(
    countBefore,
  );
  await sendOwnedCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StopTimecode", data: TIMECODE_ID },
  });

  await expect
    .poll(() => recordedItemCount(page, TIMELINE_UID, BASE_TRACK_ID), {
      timeout: 10_000,
    })
    .toBeGreaterThan(countBefore);
  await expect
    .poll(() => renderedActionCount(page, BASE_TRACK_ID), {
      timeout: 10_000,
    })
    .toBeGreaterThan(renderedBefore);

  await sendOwnedCommand(page, {
    module: "TimelineCommand",
    command: {
      type: "SetTimelineRecording",
      data: {
        timeline_id: TIMELINE_ID,
        enabled: false,
        target_track_id: undefined,
      },
    },
  });
});

/** Verifies the timeline pause control flushes buffered clip actions. */
test("timeline recording UI flushes captured clip actions when playback pauses", async ({
  backendSlot,
  page,
}) => {
  await openOwnedRecordingApp(page, backendSlot.backendPort);

  const timelineUid = TIMELINE_UID;
  await expect(
    page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    ),
  ).toBeVisible();

  const disableRecording = page.getByRole("button", {
    name: "Disable timeline recording",
  });
  if (await disableRecording.isVisible()) {
    await disableRecording.click();
    await expect(
      page.getByRole("button", { name: "Enable timeline recording" }),
    ).toBeVisible();
  }

  await page.getByRole("button", { name: "Enable timeline recording" }).click();

  await expect
    .poll(() => recordingTargetDetails(page, timelineUid))
    .toMatchObject({ enabled: true, hasTargetTrack: true });

  const armedState = await recordingTargetDetails(page, timelineUid);
  expect(armedState?.targetTrackId).toBeTruthy();
  if (!armedState?.targetTrackId) {
    throw new Error("Expected a recording target track");
  }
  const targetTrackId = armedState.targetTrackId;

  const countBefore = await recordedItemCount(page, timelineUid, targetTrackId);
  const renderedBefore = await renderedActionCount(page, targetTrackId);

  await page.getByRole("button", { name: "Play timeline" }).click();
  await expect(
    page.getByRole("button", { name: "Pause timeline" }),
  ).toBeVisible();
  await page.waitForTimeout(250);

  await sendUncorrelatedCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StartClip",
      data: { type: "Single", data: CLIP_ID },
    },
  });

  await expect
    .poll(() => renderedActionCount(page, targetTrackId), {
      timeout: 10_000,
    })
    .toBeGreaterThan(renderedBefore);
  expect(await recordedItemCount(page, timelineUid, targetTrackId)).toBe(
    countBefore,
  );

  await page.getByRole("button", { name: "Pause timeline" }).click();

  await expect
    .poll(() => recordingTargetDetails(page, timelineUid), { timeout: 10_000 })
    .toMatchObject({ enabled: false, hasTargetTrack: true });
  await expect
    .poll(() => recordedItemCount(page, timelineUid, targetTrackId), {
      timeout: 10_000,
    })
    .toBeGreaterThan(countBefore);
  await expect
    .poll(() => renderedActionCount(page, targetTrackId), {
      timeout: 10_000,
    })
    .toBeGreaterThan(renderedBefore);
});

/** Verifies disabling recording flushes buffered clip actions before pausing. */
test("timeline recording UI flushes captured clip actions when recording is disabled", async ({
  backendSlot,
  page,
}) => {
  await openOwnedRecordingApp(page, backendSlot.backendPort);

  const timelineUid = TIMELINE_UID;

  await expect(
    page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    ),
  ).toBeVisible();

  const disableRecording = page.getByRole("button", {
    name: "Disable timeline recording",
  });
  if (await disableRecording.isVisible()) {
    await disableRecording.click();
    await expect(
      page.getByRole("button", { name: "Enable timeline recording" }),
    ).toBeVisible();
  }

  await page.getByRole("button", { name: "Enable timeline recording" }).click();

  await expect
    .poll(() => recordingTargetDetails(page, timelineUid))
    .toMatchObject({ enabled: true, hasTargetTrack: true });

  const armedState = await recordingTargetDetails(page, timelineUid);
  expect(armedState?.targetTrackId).toBeTruthy();
  if (!armedState?.targetTrackId) {
    throw new Error("Expected a recording target track");
  }
  const targetTrackId = armedState.targetTrackId;

  const countBefore = await recordedItemCount(page, timelineUid, targetTrackId);
  const renderedBefore = await renderedActionCount(page, targetTrackId);

  await page.getByRole("button", { name: "Play timeline" }).click();
  await expect(
    page.getByRole("button", { name: "Pause timeline" }),
  ).toBeVisible();
  await page.waitForTimeout(250);

  await sendUncorrelatedCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StartClip",
      data: { type: "Single", data: CLIP_ID },
    },
  });
  await page.waitForTimeout(250);

  await page
    .getByRole("button", { name: "Disable timeline recording" })
    .click();

  await expect
    .poll(() => recordingTargetDetails(page, timelineUid), { timeout: 10_000 })
    .toMatchObject({ enabled: false, hasTargetTrack: true });
  await expect
    .poll(() => recordedItemCount(page, timelineUid, targetTrackId), {
      timeout: 10_000,
    })
    .toBeGreaterThan(countBefore);
  await expect
    .poll(() => renderedActionCount(page, targetTrackId), {
      timeout: 10_000,
    })
    .toBeGreaterThan(renderedBefore);

  await page.getByRole("button", { name: "Pause timeline" }).click();
});

/** Verifies recording can target compact tracks without stealing parameter input. */
test("timeline recording can arm and target a track", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedRecordingApp(page, backendSlot.backendPort);

  const timelineUid = TIMELINE_UID;

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await clearTimelineLoopRange(page);
  await expect(page.locator('[data-timeline-loop-overlay="true"]')).toHaveCount(
    0,
  );

  const disableRecording = page.getByRole("button", {
    name: "Disable timeline recording",
  });
  if (await disableRecording.isVisible()) {
    await disableRecording.click();
    await expect(
      page.getByRole("button", { name: "Enable timeline recording" }),
    ).toBeVisible();
  }

  const enableRecording = page.getByRole("button", {
    name: "Enable timeline recording",
  });
  await expect(enableRecording).toBeVisible();
  await enableRecording.click();

  await expect(
    page.getByRole("button", { name: "Disable timeline recording" }),
  ).toBeVisible();
  await expect
    .poll(() => recordingTargetState(page, timelineUid))
    .toEqual({ enabled: true, hasTargetTrack: true });

  const recordedHeader = page
    .locator('[data-timeline-track-header="true"]')
    .filter({ hasText: /^Recorded Actions/ })
    .first();
  await expect(recordedHeader).toBeVisible();
  await expect(page.getByRole("button", { name: /^Record to / })).toHaveCount(
    0,
  );
  await recordedHeader
    .getByRole("button", { name: "Recorded Actions" })
    .click();
  await expect(recordedHeader).toHaveAttribute("data-record-target", "true");

  const recordedTrackId = await recordedHeader.getAttribute("data-track-id");
  expect(recordedTrackId).toBeTruthy();
  if (!recordedTrackId) {
    throw new Error("Expected Recorded Actions track id");
  }
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${recordedTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");

  const otherTrack = { id: BASE_TRACK_ID, label: BASE_TRACK_LABEL };

  const otherTrackRow = page.locator(
    `[data-timeline-track-row="true"][data-track-id="${otherTrack.id}"]`,
  );
  const otherTrackHeader = page.locator(
    `[data-timeline-track-header="true"][data-track-id="${otherTrack.id}"]`,
  );
  await expect(otherTrackRow).toBeVisible();
  await expect(otherTrackHeader).toBeVisible();
  await otherTrackRow.click({ position: { x: 320, y: 12 } });
  await expect
    .poll(() => timelinePositionMs(page, timelineUid))
    .toBeGreaterThan(100);
  await expect(recordedHeader).not.toHaveAttribute(
    "data-record-target",
    "true",
  );
  await expect(otherTrackRow).toHaveAttribute("data-record-target", "true");

  await otherTrackHeader
    .getByRole("button", { name: otherTrack.label })
    .click();
  await expect(otherTrackRow).toHaveAttribute("data-record-target", "true");

  const {
    expandedTrackId,
    expandedTrackLabel,
    compactTrackId,
    compactTrackLabel,
  } = await trackIdsByExpansion(page, timelineUid);
  expect(expandedTrackId).toBeTruthy();
  expect(expandedTrackLabel).toBeTruthy();
  expect(compactTrackId).toBeTruthy();
  expect(compactTrackLabel).toBeTruthy();
  if (
    !expandedTrackId ||
    !expandedTrackLabel ||
    !compactTrackId ||
    !compactTrackLabel
  ) {
    throw new Error("Expected expanded and compact tracks");
  }
  expect(expandedTrackId).toBe(BASE_TRACK_ID);
  expect(expandedTrackLabel).toBe(BASE_TRACK_LABEL);

  await page
    .locator(
      `[data-timeline-track-header="true"][data-track-id="${compactTrackId}"]`,
    )
    .getByRole("button", { name: compactTrackLabel })
    .click();

  await page
    .locator(
      `[data-timeline-track-header="true"][data-track-id="${expandedTrackId}"]`,
    )
    .getByRole("button", { name: expandedTrackLabel })
    .click();
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${expandedTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");

  await page
    .locator(
      `[data-timeline-track-header="true"][data-track-id="${compactTrackId}"]`,
    )
    .getByRole("button", { name: compactTrackLabel })
    .click();
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${compactTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");
  const expandedAutomationLane = page
    .locator(
      `[data-timeline-automation-lane="true"][data-track-id="${expandedTrackId}"]`,
    )
    .first();
  await expect(expandedAutomationLane).toBeVisible();

  const firstAutomationPoint = expandedAutomationLane
    .locator(".automation-point")
    .first();
  await expect(firstAutomationPoint).toBeVisible();
  const pointBoxBeforeDrag = await firstAutomationPoint.boundingBox();
  expect(pointBoxBeforeDrag).toBeTruthy();
  if (!pointBoxBeforeDrag) {
    throw new Error("Expected first automation point bounds");
  }
  const pointCenter = {
    x: pointBoxBeforeDrag.x + pointBoxBeforeDrag.width / 2,
    y: pointBoxBeforeDrag.y + pointBoxBeforeDrag.height / 2,
  };
  await firstAutomationPoint.dispatchEvent("mousedown", {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: pointCenter.x,
    clientY: pointCenter.y,
  });
  await page.mouse.move(pointCenter.x + 80, pointCenter.y + 8);
  await page.mouse.up();
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${expandedTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");
  const pointBoxAfterDrag = await firstAutomationPoint.boundingBox();
  expect(pointBoxAfterDrag).toBeTruthy();
  if (!pointBoxAfterDrag) {
    throw new Error("Expected first automation point bounds after drag");
  }
  expect(
    Math.abs(pointBoxAfterDrag.x - pointBoxBeforeDrag.x),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(pointBoxAfterDrag.y - pointBoxBeforeDrag.y),
  ).toBeLessThanOrEqual(1);

  await page
    .locator(
      `[data-timeline-track-header="true"][data-track-id="${compactTrackId}"]`,
    )
    .getByRole("button", { name: compactTrackLabel })
    .click();
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${compactTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");
  const pointCountBeforeParameterClick = await automationPointCount(
    page,
    expandedTrackId,
  );
  await expandedAutomationLane.click({ position: { x: 320, y: 24 } });
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${expandedTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");
  await expect
    .poll(() => automationPointCount(page, expandedTrackId))
    .toBe(pointCountBeforeParameterClick + 1);
  await expectTrackEdgesToAlign(page, expandedTrackId);
  await surface.screenshot({
    path: testInfo.outputPath("timeline-recording-expanded-target.png"),
  });

  await page
    .locator(
      `[data-timeline-track-header="true"][data-track-id="${compactTrackId}"]`,
    )
    .getByRole("button", { name: compactTrackLabel })
    .click();
  await expect(
    page.locator(
      `[data-timeline-track-row="true"][data-track-id="${compactTrackId}"]`,
    ),
  ).toHaveAttribute("data-record-target", "true");
  await expectTrackEdgesToAlign(page, compactTrackId);

  await expect
    .poll(() => recordingTargetState(page, timelineUid))
    .toEqual({ enabled: true, hasTargetTrack: true });

  await surface.screenshot({
    path: testInfo.outputPath("timeline-recording-armed.png"),
  });
});
