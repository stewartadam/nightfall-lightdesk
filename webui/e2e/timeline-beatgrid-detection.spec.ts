// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const TIMELINE_ID = 97_301;
const TIMECODE_ID = 97_301;
const TIMELINE_UID = "b7310000000000000000000000000001";
const TIMECODE_UID = "b7310000000000000000000000000002";

type TimelineContext = {
  timelineId: number;
  timelineUid: string;
  originalTimeline: unknown;
};

type BeatgridProposalSummary = {
  bpm: number;
  markers: number;
  requestId: string;
};

type AppliedBeatgridSummary = {
  beatDurationMs: number;
  beatsPerBar: number;
  bpm: number;
  firstMarkerMs: number;
  markers: number;
  timecodeUid: string;
};

type CommandResultSummary = {
  outcome:
    | { type: "Succeeded"; data: { output?: unknown } }
    | { type: "Failed"; data: { message: string } };
};

type TimelineStateExpectation = {
  audioPath?: string;
  audioPathEndsWith?: string;
  audioPathStartsWith?: string;
  beatgridMarkers: number;
  useBeatGrid: boolean;
};

/** Replaces each backend and proves timeline, timecode, and playback state is blank. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedBeatgridStoreState(page))
    .toEqual({
      activeInstances: 0,
      timecodes: 0,
      timelines: 0,
    });
});

/** Reads the backend stores owned by the beatgrid scenarios. */
async function ownedBeatgridStoreState(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      timecodes: Object.keys(stores.timecodes.get()).length,
      timelines: Object.keys(stores.timelines.get()).length,
    };
  });
}

/** Builds the internal timecode linked to the owned beatgrid timeline. */
function ownedTimecode(): object {
  return {
    identifiers: {
      id: TIMECODE_ID,
      uid: TIMECODE_UID,
      label: "Owned Beatgrid Timecode",
    },
    rate: "Fps30",
    source: "Internal",
  };
}

/** Builds the blank timeline used for snapshot, audio, and ruler coverage. */
function ownedTimeline(): object {
  return {
    identifiers: {
      id: TIMELINE_ID,
      uid: TIMELINE_UID,
      label: "Owned Beatgrid Timeline",
    },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: "",
    tracks: [],
    markers: [],
    regions: [],
    bpm: 120,
    beats_per_bar: 4,
    use_beat_grid: false,
    lookahead: "disabled",
    scroll_mode: "free",
  };
}

/** Opens a fresh app, stores the exact timeline graph, and opens its panel. */
async function openOwnedBeatgridApp(
  page: Page,
  backendPort: number,
): Promise<TimelineContext> {
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
      Boolean((window as any).appStores?.timecodes?.get) &&
      Boolean((window as any).appStores?.timelines?.get),
  );
  await expect
    .poll(() => ownedBeatgridStoreState(page))
    .toEqual({
      activeInstances: 0,
      timecodes: 0,
      timelines: 0,
    });

  const timecodeResult = await sendCommandAndAwait(page, {
    module: "TimecodeCommand",
    command: { type: "StoreTimecode", data: ownedTimecode() },
  });
  expect(timecodeResult.outcome.type, JSON.stringify(timecodeResult)).toBe(
    "Succeeded",
  );
  await storeTimelineAndAwait(page, ownedTimeline());
  await waitForTimelineState(page, TIMELINE_UID, {
    audioPath: "",
    beatgridMarkers: 0,
    useBeatGrid: false,
  });
  await expect
    .poll(() => ownedBeatgridStoreState(page))
    .toEqual({
      activeInstances: 0,
      timecodes: 1,
      timelines: 1,
    });
  return openOwnedTimeline(page);
}

/** Opens the exact owned timeline and preserves its initial blank snapshot. */
async function openOwnedTimeline(page: Page): Promise<TimelineContext> {
  return page.evaluate(async (timelineUid) => {
    const stores = (window as any).appStores;
    if (
      !stores?.dockApi?.get ||
      !stores?.timelines?.get ||
      !stores?.sendAndAwait
    ) {
      throw new Error("appStores did not initialize");
    }

    for (let attempts = 0; attempts < 200; attempts += 1) {
      const timeline = stores.timelines.get()[timelineUid];
      const api = stores.dockApi.get();
      if (timeline && api) {
        const panelId = `e2e-beatgrid-${timeline.identifiers.uid}`;
        const existingPanel = api.getPanel(panelId);
        if (existingPanel) {
          existingPanel.focus();
        } else {
          api.addPanel({
            id: panelId,
            component: "Timeline",
            title: `Timeline ${timeline.identifiers.id}`,
            params: { initialTimelineUid: timeline.identifiers.uid },
            position: {
              referencePanel: "panel-FixtureGrid",
              direction: "within",
            },
          });
        }
        return {
          timelineId: timeline.identifiers.id,
          timelineUid: timeline.identifiers.uid,
          originalTimeline: JSON.parse(JSON.stringify(timeline)),
        };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }

    throw new Error(`Expected owned timeline ${timelineUid} from appStores`);
  }, TIMELINE_UID);
}

/** Sends a command to the backend and waits for its correlated CommandResult. */
async function sendCommandAndAwait(
  page: Page,
  data: object,
): Promise<CommandResultSummary> {
  return page.evaluate(async (data) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(data);
  }, data);
}

/** Sends a timeline snapshot to the backend and asserts command completion. */
async function storeTimelineAndAwait(page: Page, timeline: unknown) {
  const result = await sendCommandAndAwait(page, {
    module: "TimelineCommand",
    command: { type: "StoreTimeline", data: timeline },
  });
  expect(result.outcome.type).toBe("Succeeded");
}

/** Waits for the frontend store to receive the expected backend timeline snapshot. */
async function waitForTimelineState(
  page: Page,
  timelineUid: string,
  expected: TimelineStateExpectation,
) {
  await page.waitForFunction(
    ({ expected, timelineUid }) => {
      const timeline = (window as any).appStores.timelines.get()[timelineUid];
      const audioPath = timeline?.audio_path ?? "";
      return (
        (!expected.audioPath || audioPath === expected.audioPath) &&
        (!expected.audioPathStartsWith ||
          audioPath.startsWith(expected.audioPathStartsWith)) &&
        (!expected.audioPathEndsWith ||
          audioPath.endsWith(expected.audioPathEndsWith)) &&
        (timeline.use_beat_grid ?? false) === expected.useBeatGrid &&
        (timeline.beatgrid?.markers?.length ?? 0) === expected.beatgridMarkers
      );
    },
    { expected, timelineUid },
  );
}

/** Builds the expected state summary for a stored timeline snapshot. */
function timelineStateExpectation(timeline: any): TimelineStateExpectation {
  return {
    audioPath: timeline.audio_path ?? "",
    beatgridMarkers: timeline.beatgrid?.markers?.length ?? 0,
    useBeatGrid: timeline.use_beat_grid ?? false,
  };
}

/** Restores the timeline snapshot captured before the beatgrid validation. */
async function restoreTimeline(page: Page, context: TimelineContext) {
  await storeTimelineAndAwait(page, context.originalTimeline);
  await waitForTimelineState(
    page,
    (context.originalTimeline as any).identifiers.uid,
    timelineStateExpectation(context.originalTimeline),
  );
}

/** Clears beatgrid state so the proposal and apply checks start from a known timeline snapshot. */
async function clearBeatgridState(page: Page, context: TimelineContext) {
  const nextTimeline = await page.evaluate(({ timelineUid }) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[timelineUid];
    if (!timeline) throw new Error("Expected timeline to clear beatgrid state");
    return {
      ...timeline,
      audio_path: "",
      beatgrid: undefined,
      use_beat_grid: false,
    };
  }, context);
  await storeTimelineAndAwait(page, nextTimeline);
  await waitForTimelineState(page, context.timelineUid, {
    audioPath: "",
    beatgridMarkers: 0,
    useBeatGrid: false,
  });
  await page.evaluate(({ timelineUid }) => {
    const stores = (window as any).appStores;
    stores.timelineBeatgridProposals.setKey(timelineUid, undefined);
    stores.timelineBeatgridDetectionStatus.setKey(timelineUid, {
      phase: "idle",
    });
    stores.timelineBeatgridPreview.setKey(timelineUid, undefined);
  }, context);
}

/** Drops the bundled demo MP3 onto the visible timeline surface. */
async function dropDemoAudio(page: Page, timelineUid: string) {
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();

  const dataTransfer = await page.evaluateHandle(async () => {
    const response = await fetch("/assets/demo-audio.mp3");
    if (!response.ok) {
      throw new Error(`Failed to fetch demo audio: ${response.status}`);
    }
    const transfer = new DataTransfer();
    const file = new File([await response.arrayBuffer()], "beatgrid-demo.mp3", {
      type: "audio/mpeg",
    });
    transfer.items.add(file);
    return transfer;
  });

  await surface.dispatchEvent("dragenter", { dataTransfer });
  await surface.dispatchEvent("dragover", { dataTransfer });
  await surface.dispatchEvent("drop", { dataTransfer });
  await expect(
    page.getByText("Updated timeline audio to beatgrid-demo.mp3"),
  ).toBeVisible();
}

/** Waits for the backend to publish a beatgrid proposal for the target timeline. */
async function waitForBeatgridProposal(
  page: Page,
  timelineUid: string,
): Promise<BeatgridProposalSummary> {
  const proposal = await page.waitForFunction(
    (uid) => {
      const stores = (window as any).appStores;
      const proposal = stores?.timelineBeatgridProposals?.get?.()[uid];
      const status = stores?.timelineBeatgridDetectionStatus?.get?.()[uid];
      if (
        status?.phase === "ready" &&
        proposal?.request_id &&
        proposal?.markers?.length > 8
      ) {
        return {
          bpm: proposal.bpm,
          markers: proposal.markers.length,
          requestId: proposal.request_id,
        };
      }
      if (status?.phase === "failed") {
        throw new Error(status.error ?? "Beatgrid detection failed");
      }
      return false;
    },
    timelineUid,
    { timeout: 90_000 },
  );
  return proposal.jsonValue() as Promise<BeatgridProposalSummary>;
}

/** Sends a beatgrid proposal command through the frontend websocket. */
async function sendBeatgridProposalCommand(
  page: Page,
  commandType: "ApplyBeatgridProposal" | "RejectBeatgridProposal",
  context: TimelineContext,
  requestId: string,
): Promise<CommandResultSummary> {
  const data =
    commandType === "ApplyBeatgridProposal"
      ? {
          timeline_id: context.timelineId,
          request_id: requestId,
          beats_per_bar: 4,
          downbeat_offset: 0,
        }
      : { timeline_id: context.timelineId, request_id: requestId };

  return sendCommandAndAwait(page, {
    module: "TimelineCommand",
    command: { type: commandType, data },
  });
}

/** Waits for an applied beatgrid and returns the values used by visual snapping checks. */
async function waitForAppliedBeatgrid(
  page: Page,
  timelineUid: string,
): Promise<AppliedBeatgridSummary> {
  const applied = await page.waitForFunction(
    (uid) => {
      const stores = (window as any).appStores;
      const timeline = stores?.timelines?.get?.()[uid];
      const marker = timeline?.beatgrid?.markers?.[0];
      if (!timeline?.use_beat_grid || !marker || !timeline?.timecode_uid) {
        return false;
      }
      return {
        beatDurationMs: 60_000 / timeline.beatgrid.bpm,
        beatsPerBar: timeline.beatgrid.beats_per_bar,
        bpm: timeline.beatgrid.bpm,
        firstMarkerMs: marker.time.secs * 1000 + marker.time.nanos / 1_000_000,
        markers: timeline.beatgrid.markers.length,
        timecodeUid: timeline.timecode_uid,
      };
    },
    timelineUid,
    { timeout: 90_000 },
  );
  return applied.jsonValue() as Promise<AppliedBeatgridSummary>;
}

/** Returns the current linked timeline timecode position in milliseconds. */
async function timelinePositionMs(page: Page, timecodeUid: string) {
  return page.evaluate((uid) => {
    const state = (window as any).appStores.timecodes.get()[uid]?.[1];
    return state?.current_time
      ? state.current_time.secs * 1000 + state.current_time.nanos / 1_000_000
      : Number.NaN;
  }, timecodeUid);
}

/** Verifies backend beatgrid snapshots hydrate without being overwritten by stale UI state. */
test("backend beatgrid snapshots hydrate without stale timeline persistence", async ({
  backendSlot,
  page,
}) => {
  const context = await openOwnedBeatgridApp(page, backendSlot.backendPort);
  try {
    await clearBeatgridState(page, context);
    const appliedTimeline = await page.evaluate((timelineUid) => {
      const timeline = (window as any).appStores.timelines.get()[timelineUid];
      if (!timeline)
        throw new Error("Expected timeline to apply beatgrid state");
      return {
        ...timeline,
        use_beat_grid: true,
        bpm: 123,
        beats_per_bar: 4,
        beatgrid: {
          source: "manual",
          audio_fingerprint: "e2e-beatgrid-snapshot",
          bpm: 123,
          beats_per_bar: 4,
          markers: [
            {
              time: { secs: 0, nanos: 0 },
              beat_index: 0,
              is_downbeat: true,
              confidence: 1,
            },
          ],
          confidence: 1,
        },
      };
    }, context.timelineUid);

    await storeTimelineAndAwait(page, appliedTimeline);
    await waitForTimelineState(page, context.timelineUid, {
      beatgridMarkers: 1,
      useBeatGrid: true,
    });
    await page.waitForTimeout(500);
    await expect
      .poll(() =>
        page.evaluate((timelineUid) => {
          const timeline = (window as any).appStores.timelines.get()[
            timelineUid
          ];
          return {
            beatgridMarkers: timeline?.beatgrid?.markers?.length ?? 0,
            useBeatGrid: timeline?.use_beat_grid ?? false,
          };
        }, context.timelineUid),
      )
      .toEqual({ beatgridMarkers: 1, useBeatGrid: true });
  } finally {
    await restoreTimeline(page, context);
  }
});

/** Validates proposal reject, manual apply, ruler rendering, and beatgrid-snapped seeking. */
test("beatgrid detection proposal can be rejected, applied, and used for ruler snapping", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  const context = await openOwnedBeatgridApp(page, backendSlot.backendPort);
  try {
    await clearBeatgridState(page, context);
    await dropDemoAudio(page, context.timelineUid);

    const rejectedProposal = await waitForBeatgridProposal(
      page,
      context.timelineUid,
    );
    expect(rejectedProposal.bpm).toBeGreaterThan(80);
    expect(rejectedProposal.markers).toBeGreaterThan(8);

    const rejectResult = await sendBeatgridProposalCommand(
      page,
      "RejectBeatgridProposal",
      context,
      rejectedProposal.requestId,
    );
    expect(rejectResult.outcome.type).toBe("Succeeded");

    const staleApplyResult = await sendBeatgridProposalCommand(
      page,
      "ApplyBeatgridProposal",
      context,
      rejectedProposal.requestId,
    );
    expect(staleApplyResult.outcome.type).toBe("Failed");
    if (staleApplyResult.outcome.type === "Failed") {
      expect(staleApplyResult.outcome.data.message).toContain(
        "No beatgrid proposal",
      );
    }
    await waitForTimelineState(page, context.timelineUid, {
      audioPathEndsWith: "beatgrid-demo.mp3",
      audioPathStartsWith: `timeline-audio/${context.timelineUid}/`,
      beatgridMarkers: 0,
      useBeatGrid: false,
    });

    await page.getByRole("button", { name: "BPM controls" }).click();
    await page
      .locator('[data-menu-kind="beatgrid-controls"]')
      .getByRole("button", { name: "Detect" })
      .click();
    const appliedBeatgrid = await waitForAppliedBeatgrid(
      page,
      context.timelineUid,
    );
    expect(appliedBeatgrid.bpm).toBeCloseTo(120, 0);
    expect(appliedBeatgrid.markers).toBeGreaterThanOrEqual(1);

    const ruler = page.locator(
      `[data-timeline-ruler="true"][data-timeline-uid="${context.timelineUid}"]:visible`,
    );
    await expect(ruler).toBeVisible();
    await expect(ruler.locator("span.text-blue-400").first()).toBeVisible();

    const snapButton = page
      .locator(
        `[data-timeline-surface="true"][data-timeline-uid="${context.timelineUid}"]:visible [data-timeline-toolbar="true"]`,
      )
      .getByRole("button", { name: "Snap" });
    if ((await snapButton.getAttribute("aria-pressed")) !== "true") {
      await snapButton.click();
    }
    await expect(snapButton).toHaveAttribute("aria-pressed", "true");
    const rulerBox = await ruler.boundingBox();
    if (!rulerBox) throw new Error("Expected timeline ruler bounds");
    const barMarkerLefts = await ruler
      .locator("span.text-blue-400")
      .evaluateAll((spans) =>
        spans
          .slice(0, 2)
          .map((span) =>
            Number.parseFloat((span.parentElement as HTMLElement).style.left),
          ),
      );
    expect(barMarkerLefts.length).toBeGreaterThanOrEqual(2);
    const pixelsPerMs =
      (barMarkerLefts[1] - barMarkerLefts[0]) /
      (appliedBeatgrid.beatDurationMs * appliedBeatgrid.beatsPerBar);
    const unsnappedMs =
      appliedBeatgrid.firstMarkerMs + appliedBeatgrid.beatDurationMs * 0.55;
    const expectedSnappedBeatIndex = Math.round(
      (unsnappedMs - appliedBeatgrid.firstMarkerMs) /
        appliedBeatgrid.beatDurationMs,
    );
    const expectedSnappedMs =
      appliedBeatgrid.firstMarkerMs +
      expectedSnappedBeatIndex * appliedBeatgrid.beatDurationMs;
    await ruler.click({
      position: {
        x: Math.max(
          1,
          barMarkerLefts[0] +
            (unsnappedMs - appliedBeatgrid.firstMarkerMs) * pixelsPerMs,
        ),
        y: rulerBox.height / 2,
      },
    });
    await expect
      .poll(() => timelinePositionMs(page, appliedBeatgrid.timecodeUid))
      .toBeCloseTo(expectedSnappedMs, 0);
    const snappedPositionMs = await timelinePositionMs(
      page,
      appliedBeatgrid.timecodeUid,
    );
    expect(Math.abs(snappedPositionMs - unsnappedMs)).toBeGreaterThan(100);

    await page.screenshot({
      path: testInfo.outputPath("beatgrid-applied-ruler.png"),
    });
  } finally {
    await restoreTimeline(page, context);
  }
});
