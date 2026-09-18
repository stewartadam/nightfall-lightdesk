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

test.use({ experimentalFlows: true });

const FIXTURE_ID = 96_200;
const CUE_ID = 96_200;
const SEQUENCE_ID = 96_200;
const FLOW_ID = 96_201;
const SEQUENCE_CLIP_ID = 96_202;
const FLOW_CLIP_ID = 96_203;
const TIMECODE_ID = 96_200;
const TIMELINE_ID = 96_200;
const FIXTURE_UID = "c7300000000000000000000000000001";
const CUE_UID = "c7300000000000000000000000000002";
const SETUP_CUE_UID = "c7300000000000000000000000000003";
const RELEASE_CUE_UID = "c7300000000000000000000000000004";
const SEQUENCE_UID = "c7300000000000000000000000000005";
const FLOW_UID = "c7300000000000000000000000000006";
const SEQUENCE_CLIP_UID = "c7300000000000000000000000000007";
const FLOW_CLIP_UID = "c7300000000000000000000000000008";
const TIMECODE_UID = "c7300000000000000000000000000009";
const TIMELINE_UID = "c730000000000000000000000000000a";
const CUE_TRACK_ID = "owned-context-cue-track";
const CUE_ITEM_ID = "owned-context-cue-item";
const SEQUENCE_TRACK_ID = "owned-context-sequence-track";
const SEQUENCE_START_ITEM_ID = "owned-context-sequence-start";
const SEQUENCE_GO_ITEM_ID = "owned-context-sequence-go";
const FLOW_TRACK_ID = "owned-context-flow-track";
const FLOW_START_ITEM_ID = "owned-context-flow-start";

test.describe.configure({ timeout: 120_000 });

/** Stops owned playback, replaces the backend, and proves all graph stores are blank. */
test.afterEach(async ({ backendSlot, page }) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
    await page
      .evaluate(async () => {
        const stores = (window as any).appStores;
        if (typeof stores?.sendAndAwait !== "function") return;
        await stores.sendAndAwait({
          module: "InstanceCommand",
          command: { type: "StopAll" },
        });
      })
      .catch(() => undefined);
  }

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedContextMenuStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      flows: 0,
      sequences: 0,
      timecodes: 0,
      timelines: 0,
    });
});

/** Reads every browser store owned by the context-menu graph. */
async function ownedContextMenuStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      clips: Object.keys(stores.clips.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      flows: Object.keys(stores.flows.get()).length,
      sequences: Object.keys(stores.sequences.get()).length,
      timecodes: Object.keys(stores.timecodes.get()).length,
      timelines: Object.keys(stores.timelines.get()).length,
    };
  });
}

/** Sends one correlated backend command and rejects a failed outcome. */
async function sendOwnedCommand(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(async (message) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(message);
  }, data);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Loads the saved default showfile and waits for the replacement world to resync. */
async function loadOwnedDefaultShowfile(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const websocket = await import("/lib/engine-runtime.ts");
      const { waitForStartupWorldSwapCommand } = await import(
        "/components/shell/startup/readiness.ts"
      );
      websocket.markResyncPending();
      await waitForStartupWorldSwapCommand(
        (window as any).appStores.sendAndAwait({
          module: "DeskCommand",
          command: { type: "LoadNamedShowfile", data: "default" },
        }),
        15_000,
        "default",
      );
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Execution context was destroyed")
    ) {
      throw error;
    }
  }
  await waitForDockviewApp(page, { timeoutMs: 30_000 });
}

/** Builds the single-element intensity fixture referenced by the owned cue. */
function ownedFixture(): object {
  return {
    identifiers: {
      id: FIXTURE_ID,
      uid: FIXTURE_UID,
      label: "Owned Context Fixture",
    },
    make: "E2E",
    model: "Context Menu Intensity",
    mode: "Single Element",
    elements: [
      {
        label: "Cell 1",
        parameters: [
          {
            resolution: "Coarse",
            attribute: { type: "Intensity" },
            value_polarity: "Unsigned",
            min: 0,
            max: 255,
            offset: { type: "Absolute", data: { value: 0 } },
            is_inverted: false,
            is_snap: false,
            merge_type: "HTP",
            use_grandmaster: true,
          },
        ],
      },
    ],
  };
}

/** Builds one complete empty sequence metadata cue. */
function ownedMetaCue(uid: string, label: string): object {
  return {
    identifiers: { id: 0, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the cue targeted by the owned timeline FireCue item. */
function ownedCue(): object {
  return {
    identifiers: { id: CUE_ID, uid: CUE_UID, label: "Owned Context Cue" },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [
      {
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: FIXTURE_UID, index: null }],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            Intensity: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 128 } },
            },
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the sequence targeted by clip and advance item menus. */
function ownedSequence(): object {
  const zero = { type: "Fixed", data: { secs: 0, nanos: 0 } };
  return {
    identifiers: {
      id: SEQUENCE_ID,
      uid: SEQUENCE_UID,
      label: "Owned Context Sequence",
    },
    steps: [CUE_UID],
    wrap: false,
    release_on_start: false,
    setup_cue: ownedMetaCue(SETUP_CUE_UID, "Owned Setup"),
    release_cue: ownedMetaCue(RELEASE_CUE_UID, "Owned Release"),
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

/** Builds the empty Flow targeted by the source-clip menu. */
function ownedFlow(): object {
  return {
    identifiers: { id: FLOW_ID, uid: FLOW_UID, label: "Owned Context Flow" },
    flow_version: 0,
    nodes: [],
    edges: [],
  };
}

/** Builds one clip with an exact sequence or Flow source. */
function ownedClip(
  id: number,
  uid: string,
  label: string,
  source: object,
): object {
  return {
    identifiers: { id, uid, label },
    source,
    priority: 0,
    options: {
      auto_release: false,
      deactivate_on_sequence_end: false,
    },
  };
}

/** Builds the internal timecode used by the owned context timeline. */
function ownedTimecode(): object {
  return {
    identifiers: {
      id: TIMECODE_ID,
      uid: TIMECODE_UID,
      label: "Owned Context Timecode",
    },
    rate: "Fps30",
    source: "Internal",
  };
}

/** Builds one fixed timeline action at the requested second. */
function ownedTimelineItem(
  id: string,
  label: string,
  second: number,
  action: object,
): object {
  return {
    id,
    label,
    position: { secs: second, nanos: 0 },
    duration: { secs: 1, nanos: 0 },
    action,
  };
}

/** Builds one exact track for a context-menu target family. */
function ownedTrack(id: string, label: string, actions: object[]): object {
  return {
    id,
    label,
    muted: false,
    solo: false,
    expanded: false,
    automation_lanes: [],
    actions,
  };
}

/** Builds the fixed four-item timeline shared by all menu scenarios. */
function ownedTimeline(): object {
  return {
    identifiers: {
      id: TIMELINE_ID,
      uid: TIMELINE_UID,
      label: "Owned Context Timeline",
    },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: "",
    audio_enabled: true,
    nondeterministic_seek_behavior: "Ignore",
    lookahead: "inherit",
    tracks: [
      ownedTrack(CUE_TRACK_ID, "FX Track", [
        ownedTimelineItem(CUE_ITEM_ID, `Cue ${CUE_ID}`, 1, {
          type: "FireCue",
          data: CUE_UID,
        }),
      ]),
      ownedTrack(SEQUENCE_TRACK_ID, "Sequence Track", [
        ownedTimelineItem(
          SEQUENCE_START_ITEM_ID,
          `Exec ${SEQUENCE_CLIP_ID}`,
          3,
          { type: "StartClip", data: SEQUENCE_CLIP_UID },
        ),
        ownedTimelineItem(
          SEQUENCE_GO_ITEM_ID,
          `Go ${SEQUENCE_ID}.${CUE_ID}`,
          5,
          {
            type: "AdvanceSequence",
            data: SEQUENCE_CLIP_UID,
          },
        ),
      ]),
      ownedTrack(FLOW_TRACK_ID, "Flow Track", [
        ownedTimelineItem(FLOW_START_ITEM_ID, `Exec ${FLOW_CLIP_ID}`, 7, {
          type: "StartClip",
          data: FLOW_CLIP_UID,
        }),
      ]),
    ],
    markers: [],
    regions: [],
    bpm: 120,
    beats_per_bar: 4,
    use_beat_grid: false,
    scroll_mode: "free",
  };
}

/** Opens a blank backend and stores the exact context-menu graph. */
async function openOwnedContextMenuApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.flows?.get) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      Boolean((window as any).appStores?.timecodes?.get) &&
      Boolean((window as any).appStores?.timelines?.get),
  );
  await expect
    .poll(() => ownedContextMenuStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      flows: 0,
      sequences: 0,
      timecodes: 0,
      timelines: 0,
    });

  for (const data of [
    {
      module: "FixtureCommand",
      command: { type: "StoreFixture", data: ownedFixture() },
    },
    {
      module: "FlowCommand",
      command: { type: "StoreFlow", data: ownedFlow() },
    },
    {
      module: "CueCommand",
      command: { type: "StoreCue", data: ownedCue() },
    },
    {
      module: "CueCommand",
      command: { type: "StoreSequence", data: ownedSequence() },
    },
    {
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: ownedClip(
          SEQUENCE_CLIP_ID,
          SEQUENCE_CLIP_UID,
          "Owned Sequence Clip",
          { type: "Sequence", data: SEQUENCE_UID },
        ),
      },
    },
    {
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: ownedClip(FLOW_CLIP_ID, FLOW_CLIP_UID, "Owned Flow Clip", {
          type: "Flow",
          data: FLOW_UID,
        }),
      },
    },
    {
      module: "TimecodeCommand",
      command: { type: "StoreTimecode", data: ownedTimecode() },
    },
    {
      module: "TimelineCommand",
      command: { type: "StoreTimeline", data: ownedTimeline() },
    },
  ]) {
    await sendOwnedCommand(page, data);
  }
  await expect
    .poll(() => ownedContextMenuStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 1,
      clips: 2,
      fixtures: 1,
      flows: 1,
      sequences: 1,
      timecodes: 1,
      timelines: 1,
    });
}

/**
 * Opens the exact owned timeline for context-menu workflow tests.
 */
async function openFirstTimeline(page: Page) {
  return (await openTimeline(page, TIMELINE_UID)) ? TIMELINE_UID : null;
}

/**
 * Opens a specific timeline panel for context-menu workflow tests.
 */
async function openTimeline(page: Page, timelineUid: string) {
  return page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    if (!stores?.dockApi?.get || !stores?.timelines?.get) {
      return false;
    }

    for (let attempts = 0; attempts < 200; attempts += 1) {
      const timeline = stores.timelines.get()[uid];
      const api = stores.dockApi.get();
      if (timeline?.identifiers?.uid && api) {
        const panelId = `e2e-context-menu-timeline-${timeline.identifiers.uid}`;
        const existingPanel = api.getPanel(panelId);
        if (existingPanel) {
          existingPanel.api.setActive();
          existingPanel.focus();
        } else {
          const referencePanel = api.getPanel("panel-FixtureGrid");
          const panel = api.addPanel({
            id: panelId,
            component: "Timeline",
            title: `Timeline ${timeline.identifiers.id ?? ""}`.trim(),
            params: { initialTimelineUid: timeline.identifiers.uid },
            ...(referencePanel
              ? {
                  position: {
                    referencePanel: referencePanel.id,
                    direction: "within",
                  },
                }
              : {}),
          });
          panel.api.setActive();
          panel.focus();
        }
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return false;
  }, timelineUid);
}

/**
 * Opens a timeline panel and waits until its rendered surface is mounted.
 */
async function openTimelineSurface(page: Page, timelineUid: string) {
  expect(await openTimeline(page, timelineUid)).toBe(true);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible({ timeout: 20_000 });
  return surface;
}

/** Dispatches a context-menu event at a visible point inside an item. */
async function dispatchItemContextMenu(item: Locator): Promise<void> {
  await item.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + Math.min(12, bounds.width / 2),
        clientY: bounds.top + Math.min(12, bounds.height / 2),
        button: 2,
      }),
    );
  });
}

/** Dispatches a double-click without relying on pointer actionability. */
async function dispatchDoubleClick(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        button: 0,
        cancelable: true,
        detail: 2,
      }),
    );
  });
}

/**
 * Waits for timeline command side effects to appear in the timeline store.
 */
async function waitForTimelineStoreItems(
  page: Page,
  timelineUid: string,
  itemIds: string[],
): Promise<void> {
  await page.waitForFunction(
    ({ uid, ids }) => {
      const stores = (window as any).appStores;
      const timeline = stores?.timelines?.get?.()[uid];
      const renderedItemIds = new Set(
        (timeline?.tracks ?? []).flatMap((track: any) =>
          (track.actions ?? []).map((item: any) => item.id),
        ),
      );
      return ids.every((id) => renderedItemIds.has(id));
    },
    { uid: timelineUid, ids: itemIds },
    { timeout: 20_000 },
  );
}

/** Waits until a renamed track label reaches the canonical timeline store. */
async function waitForTimelineTrackLabel(
  page: Page,
  timelineUid: string,
  trackId: string,
  label: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ uid, renamedTrackId }) => {
            const stores = (window as any).appStores;
            const timeline = stores.timelines.get()[uid];
            return timeline.tracks.find(
              (track: any) => track.id === renamedTrackId,
            )?.label;
          },
          { uid: timelineUid, renamedTrackId: trackId },
        ),
      { message: `Track ${trackId} should persist label ${label}` },
    )
    .toBe(label);
}

/**
 * Returns the exact cue-backed timeline action context.
 */
function ownedCueTimelineItem() {
  return {
    timelineUid: TIMELINE_UID,
    cueId: CUE_ID,
    itemId: CUE_ITEM_ID,
  };
}

/**
 * Returns the exact sequence-backed timeline actions for target-editor tests.
 */
function ownedSequenceTimelineItems() {
  return {
    timelineUid: TIMELINE_UID,
    clipUid: SEQUENCE_CLIP_UID,
    clipId: SEQUENCE_CLIP_ID,
    sequenceId: SEQUENCE_ID,
    startTrackId: SEQUENCE_TRACK_ID,
    startItemId: SEQUENCE_START_ITEM_ID,
    goTrackId: SEQUENCE_TRACK_ID,
    goItemId: SEQUENCE_GO_ITEM_ID,
  };
}

/**
 * Returns the exact start-clip item for the owned Flow source.
 */
function ownedSourceClipTimelineItem() {
  return {
    timelineUid: TIMELINE_UID,
    trackId: FLOW_TRACK_ID,
    itemId: FLOW_START_ITEM_ID,
    clipId: FLOW_CLIP_ID,
    clipUid: FLOW_CLIP_UID,
    expectedMenuPattern: `Open Flow ${FLOW_ID} Editor`,
  };
}

/**
 * Returns the exact clip-properties timeline action context.
 */
function ownedClipPropertiesTimelineItem() {
  return {
    timelineUid: TIMELINE_UID,
    clipUid: FLOW_CLIP_UID,
    clipId: FLOW_CLIP_ID,
    itemId: FLOW_START_ITEM_ID,
  };
}

/** Verifies Dockview tabs and the visualizer expose their owned context menus. */
test("dock tabs and visualizer canvas open custom context menus", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedContextMenuApp(page, backendSlot.backendPort);
  await page.waitForTimeout(3_000);

  const dockTab = page.locator(".dv-default-tab").first();
  await expect(dockTab).toBeVisible();
  await dockTab.click({ button: "right" });

  const tabMenu = page.locator('[data-menu-kind="context"]');
  await expect(tabMenu).toBeVisible();
  await expect(
    tabMenu.getByRole("menuitem", { name: "Close", exact: true }),
  ).toBeVisible();
  await expect(
    tabMenu.getByRole("menuitem", { name: "Close Others in Group" }),
  ).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(tabMenu).not.toBeVisible();

  const visualizerTab = page
    .locator(".dv-default-tab")
    .filter({ hasText: "3D Visualizer" });
  await expect(visualizerTab.first()).toBeVisible();
  await visualizerTab.first().click();

  const canvas = page.locator("canvas:visible").first();
  await expect(canvas).toBeVisible();
  await canvas.click({ button: "right", position: { x: 80, y: 80 } });

  const visualizerMenu = page.locator('[data-menu-kind="context"]');
  await expect(visualizerMenu).toBeVisible();
  await expect(
    visualizerMenu.getByRole("menuitem", { name: "New Fixture" }),
  ).toBeVisible();
  await expect(
    visualizerMenu.getByRole("menuitem", { name: "New Object" }),
  ).toBeVisible();
  await expect(
    visualizerMenu.getByRole("menuitem", { name: "Camera Tool" }),
  ).toBeVisible();
  await expect(
    visualizerMenu.getByRole("menuitem", { name: "Select Tool" }),
  ).toBeVisible();
  const screenshotPath = testInfo.outputPath(
    "owned-visualizer-context-menu.png",
  );
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach("owned-visualizer-context-menu", {
    path: screenshotPath,
    contentType: "image/png",
  });
});

/** Verifies a timeline action menu anchors to right-click and control-click positions. */
test("timeline action context menu opens at the click site", async ({
  backendSlot,
  page,
}) => {
  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const timelineUid = await openFirstTimeline(page);
  expect(timelineUid).toBeTruthy();
  if (!timelineUid) throw new Error("Expected a timeline UID from appStores");

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();

  const viewport = page.viewportSize();
  const targetItem = surface.locator(
    `[data-timeline-action="true"][data-track-id="${CUE_TRACK_ID}"][data-action-id="${CUE_ITEM_ID}"]`,
  );
  await expect(targetItem).toBeVisible();
  const itemBox = await targetItem.boundingBox();
  expect(itemBox).toBeTruthy();
  if (!itemBox) {
    throw new Error("Expected owned cue timeline action bounds");
  }

  const clickPoint = {
    x: itemBox.x + Math.max(0, Math.min(itemBox.width / 2, 1)),
    y: itemBox.y + Math.min(12, itemBox.height / 2),
  };

  await targetItem.evaluate((element, point) => {
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        button: 2,
      }),
    );
  }, clickPoint);

  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete Timeline Action" }),
  ).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).not.toBeVisible();

  await targetItem.evaluate((element, point) => {
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        ctrlKey: true,
        button: 0,
      }),
    );
  }, clickPoint);
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete Timeline Action" }),
  ).toBeVisible();

  const menuBox = await menu.boundingBox();
  expect(menuBox).toBeTruthy();
  if (!menuBox) throw new Error("Expected context menu bounds");

  const expectedMenuX = Math.max(
    8,
    Math.min(clickPoint.x, (viewport?.width ?? 0) - menuBox.width - 8),
  );
  expect(Math.abs(menuBox.x - expectedMenuX)).toBeLessThanOrEqual(1);
  expect(Math.abs(menuBox.y - clickPoint.y)).toBeLessThanOrEqual(1);
});

/** Verifies the exact FireCue item can open its owned cue editor. */
test("timeline action context menu opens cue target editor", async ({
  backendSlot,
  page,
}) => {
  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const seeded = ownedCueTimelineItem();
  await waitForTimelineStoreItems(page, seeded.timelineUid, [seeded.itemId]);
  const surface = await openTimelineSurface(page, seeded.timelineUid);

  const item = surface.locator(
    `[data-timeline-action="true"][data-action-id="${seeded.itemId}"]`,
  );
  await expect(item).toBeVisible();
  await item.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + Math.min(12, bounds.width / 2),
        clientY: bounds.top + Math.min(12, bounds.height / 2),
        button: 2,
      }),
    );
  });

  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", { name: `Open Cue ${seeded.cueId} Editor` })
    .click();

  await expect(
    page.locator(".dv-default-tab").filter({
      hasText: new RegExp(`^Cue (?:\\d+\\.)?${seeded.cueId}(?:p0)?$`),
    }),
  ).toBeVisible();
});

/** Verifies a default-showfile world swap mounts timeline items under app providers. */
test("default showfile reload renders timeline track items", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedContextMenuApp(page, backendSlot.backendPort);
  await sendOwnedCommand(page, {
    module: "DeskCommand",
    command: { type: "SaveShowfile", data: {} },
  });

  await loadOwnedDefaultShowfile(page);
  const seeded = ownedCueTimelineItem();
  await waitForTimelineStoreItems(page, seeded.timelineUid, [seeded.itemId]);
  const surface = await openTimelineSurface(page, seeded.timelineUid);
  await expect(
    surface.locator(
      `[data-timeline-track-item="true"][data-item-id="${seeded.itemId}"]`,
    ),
  ).toBeVisible();
  await expect(page.getByText("Error rendering component")).toHaveCount(0);

  const screenshotPath = testInfo.outputPath(
    "default-showfile-timeline-items.png",
  );
  await surface.screenshot({ path: screenshotPath });
  await testInfo.attach("default-showfile-timeline-items", {
    path: screenshotPath,
    contentType: "image/png",
  });
});

/** Verifies sequence clip actions open cue and sequence target editors. */
test("timeline sequence action context menu opens target editor", async ({
  backendSlot,
  page,
}) => {
  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const seeded = ownedSequenceTimelineItems();
  await waitForTimelineStoreItems(page, seeded.timelineUid, [
    seeded.goItemId,
    seeded.startItemId,
  ]);
  const surface = await openTimelineSurface(page, seeded.timelineUid);

  const goItem = surface.locator(
    `[data-timeline-action="true"][data-track-id="${seeded.goTrackId}"][data-action-id="${seeded.goItemId}"]`,
  );
  await expect(goItem).toBeVisible();
  await dispatchItemContextMenu(goItem);

  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", {
      name: /Open Cue \d+ Editor/,
    }),
  ).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).not.toBeVisible();

  const startItem = surface.locator(
    `[data-timeline-action="true"][data-track-id="${seeded.startTrackId}"][data-action-id="${seeded.startItemId}"]`,
  );
  await expect(startItem).toBeVisible();
  await dispatchItemContextMenu(startItem);

  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", {
      name: `Open Sequence ${seeded.sequenceId} Editor`,
    })
    .click();
  await expect(
    page
      .locator(".dv-default-tab")
      .filter({ hasText: `Sequence ${seeded.sequenceId}` }),
  ).toBeVisible();
});

/** Verifies an exact clip action opens and selects its properties. */
test("timeline clip item context menu opens clip properties", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(90_000);

  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const seeded = ownedClipPropertiesTimelineItem();
  const surface = await openTimelineSurface(page, seeded.timelineUid);

  const startItem = surface.locator(`[data-action-id="${seeded.itemId}"]`);
  await expect(startItem).toBeVisible();
  await dispatchItemContextMenu(startItem);

  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", {
      name: `Edit Clip ${seeded.clipId} Properties`,
    })
    .click();

  await expect(
    page.locator(".dv-default-tab").filter({ hasText: "Clips" }),
  ).toBeVisible();
  const clipIdCell = page.getByRole("gridcell", {
    name: String(seeded.clipId),
    exact: true,
  });
  await expect(clipIdCell).toBeVisible();
  await expect(clipIdCell).toHaveAttribute("data-selected", "true");
  await expect(
    page.locator(".dv-default-tab").filter({ hasText: "Properties" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `Clip ${seeded.clipId}` }),
  ).toBeVisible();
});

/** Verifies the owned Flow clip action exposes its source editor target. */
test("timeline source clip context menu opens source target editor", async ({
  backendSlot,
  page,
}) => {
  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const seeded = ownedSourceClipTimelineItem();
  const surface = await openTimelineSurface(page, seeded.timelineUid);
  await waitForTimelineStoreItems(page, seeded.timelineUid, [seeded.itemId]);

  const item = surface.locator(
    `[data-timeline-action="true"][data-track-id="${seeded.trackId}"][data-action-id="${seeded.itemId}"]`,
  );
  await expect(item).toBeVisible();
  await item.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + Math.min(12, bounds.width / 2),
        clientY: bounds.top + Math.min(12, bounds.height / 2),
        button: 2,
      }),
    );
  });

  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", {
      name: new RegExp(seeded.expectedMenuPattern),
    }),
  ).toBeVisible();
});

/** Verifies exact track headers can toggle mute/solo and remove a temporary track. */
test("timeline track header context menu can mute, solo, and remove tracks", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(60_000);

  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const timelineUid = await openFirstTimeline(page);
  expect(timelineUid).toBeTruthy();
  if (!timelineUid) throw new Error("Expected a timeline UID from appStores");

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();

  const fxHeader = surface
    .locator('[data-timeline-track-header="true"]')
    .filter({ hasText: "FX Track" })
    .first();
  await expect(fxHeader).toBeVisible();
  const fxTrackId = await fxHeader.getAttribute("data-track-id");
  expect(fxTrackId).toBeTruthy();
  if (!fxTrackId) throw new Error("Expected FX track id");

  await page.evaluate(
    async ({ uid, trackId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      await stores.send({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: {
            ...timeline,
            tracks: timeline.tracks.map((track: any) =>
              track.id === trackId
                ? { ...track, muted: false, solo: false }
                : { ...track, solo: false },
            ),
          },
        },
      });
    },
    { uid: timelineUid, trackId: fxTrackId },
  );

  await dispatchItemContextMenu(fxHeader.locator("[data-track-header-handle]"));
  let menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Mute Track M" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Solo Track S" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Rename Track" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Remove Track" }),
  ).toBeVisible();

  await menu.getByRole("menuitem", { name: "Mute Track M" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ uid: innerUid, trackId: innerTrackId }) => {
            const stores = (window as any).appStores;
            const timeline = stores.timelines.get()[innerUid];
            return timeline.tracks.find(
              (track: any) => track.id === innerTrackId,
            )?.muted;
          },
          { uid: timelineUid, trackId: fxTrackId },
        ),
      { message: "FX track should be muted after menu action" },
    )
    .toBe(true);
  await dispatchItemContextMenu(fxHeader.locator("[data-track-header-handle]"));
  menu = page.locator('[data-menu-kind="context"]');
  await expect(
    menu.getByRole("menuitem", { name: "Mute Track M" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Unmute Track M" }),
  ).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Mute Track M" }).click();

  await dispatchItemContextMenu(fxHeader.locator("[data-track-header-handle]"));
  menu = page.locator('[data-menu-kind="context"]');
  await menu.getByRole("menuitem", { name: "Solo Track S" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ uid: innerUid, trackId: innerTrackId }) => {
            const stores = (window as any).appStores;
            const timeline = stores.timelines.get()[innerUid];
            return timeline.tracks.find(
              (track: any) => track.id === innerTrackId,
            )?.solo;
          },
          { uid: timelineUid, trackId: fxTrackId },
        ),
      { message: "FX track should be soloed after menu action" },
    )
    .toBe(true);
  await dispatchItemContextMenu(fxHeader.locator("[data-track-header-handle]"));
  menu = page.locator('[data-menu-kind="context"]');
  await expect(
    menu.getByRole("menuitem", { name: "Solo Track S" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Unsolo Track S" }),
  ).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Solo Track S" }).click();

  await fxHeader.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    fxHeader.getByRole("button", { name: "Unmute", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await fxHeader.getByRole("button", { name: "Solo", exact: true }).click();
  await expect(
    fxHeader.getByRole("button", { name: "Unsolo", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await surface.screenshot({
    path: testInfo.outputPath("shared-track-toggle-states.png"),
  });
  await fxHeader.getByRole("button", { name: "Unmute", exact: true }).click();
  await expect(
    fxHeader.getByRole("button", { name: "Mute", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await fxHeader.getByRole("button", { name: "Unsolo", exact: true }).click();
  await expect(
    fxHeader.getByRole("button", { name: "Solo", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");

  const temporaryTrackId = await page.evaluate(
    async ({ timelineUid, trackId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[timelineUid];
      await stores.send({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: {
            ...timeline,
            tracks: [
              ...timeline.tracks,
              {
                id: trackId,
                label: "E2E Remove Track",
                muted: false,
                solo: false,
                expanded: false,
                actions: [],
                automation_lanes: [],
              },
            ],
          },
        },
      });
      return trackId;
    },
    { timelineUid, trackId: "owned-context-remove-track" },
  );

  const temporaryHeader = surface.locator(
    `[data-timeline-track-header="true"][data-track-id="${temporaryTrackId}"]`,
  );
  await expect(temporaryHeader).toBeVisible();
  await dispatchItemContextMenu(
    temporaryHeader.locator("[data-track-header-handle]"),
  );
  await page
    .locator('[data-menu-kind="context"]')
    .getByRole("menuitem", { name: "Remove Track" })
    .click();
  await expect(temporaryHeader).toHaveCount(0);
});

/** Verifies timeline track names can be edited from the context menu and by double-clicking the label. */
test("timeline track header can rename tracks inline", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(60_000);

  await openOwnedContextMenuApp(page, backendSlot.backendPort);

  const timelineUid = await openFirstTimeline(page);
  expect(timelineUid).toBeTruthy();
  if (!timelineUid) throw new Error("Expected a timeline UID from appStores");

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();

  const { trackId, initialLabel } = await page.evaluate(
    ({ timelineUid: uid, ownedTrackId }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const track = timeline.tracks.find(
        (entry: any) => entry.id === ownedTrackId,
      );
      if (!track) {
        throw new Error(`Expected owned timeline track ${ownedTrackId}`);
      }
      return { trackId: track.id, initialLabel: track.label };
    },
    { timelineUid, ownedTrackId: CUE_TRACK_ID },
  );

  const header = surface.locator(
    `[data-timeline-track-header="true"][data-track-id="${trackId}"]`,
  );
  await expect(header).toBeVisible();
  await dispatchItemContextMenu(header.locator("[data-track-header-handle]"));
  await page
    .locator('[data-menu-kind="context"]')
    .getByRole("menuitem", { name: "Rename Track" })
    .click();

  const contextMenuInput = header.locator('input[type="text"]');
  await expect(contextMenuInput).toBeFocused();
  await expect(contextMenuInput).toHaveClass(/nf-form-control/);
  await contextMenuInput.fill("E2E Context Renamed Track");
  await page.keyboard.press("Enter");
  await expect(header).toContainText("E2E Context Renamed Track");
  await waitForTimelineTrackLabel(
    page,
    timelineUid,
    trackId,
    "E2E Context Renamed Track",
  );

  await dispatchDoubleClick(header.getByText("E2E Context Renamed Track"));
  const doubleClickInput = header.locator('input[type="text"]');
  await expect(doubleClickInput).toBeFocused();
  await doubleClickInput.fill("E2E Double Click Renamed Track");
  await page.keyboard.press("Enter");
  await expect(header).toContainText("E2E Double Click Renamed Track");
  await waitForTimelineTrackLabel(
    page,
    timelineUid,
    trackId,
    "E2E Double Click Renamed Track",
  );

  await dispatchDoubleClick(header.getByText("E2E Double Click Renamed Track"));
  const blurInput = header.locator('input[type="text"]');
  await expect(blurInput).toBeFocused();
  await blurInput.fill("E2E Blur Renamed Track");
  await blurInput.evaluate((input) => input.blur());
  await expect(header).toContainText("E2E Blur Renamed Track");
  await waitForTimelineTrackLabel(
    page,
    timelineUid,
    trackId,
    "E2E Blur Renamed Track",
  );

  await dispatchDoubleClick(header.getByText("E2E Blur Renamed Track"));
  const escapeInput = header.locator('input[type="text"]');
  await expect(escapeInput).toBeFocused();
  await escapeInput.fill("E2E Escape Cancelled Track");
  await page.keyboard.press("Escape");
  await expect(header).toContainText("E2E Blur Renamed Track");
  await expect(header).not.toContainText("E2E Escape Cancelled Track");

  await waitForTimelineTrackLabel(
    page,
    timelineUid,
    trackId,
    "E2E Blur Renamed Track",
  );
  const screenshotPath = testInfo.outputPath("owned-inline-track-rename.png");
  await surface.screenshot({ path: screenshotPath });
  await testInfo.attach("owned-inline-track-rename", {
    path: screenshotPath,
    contentType: "image/png",
  });

  await page.evaluate(
    ({ uid, trackId: renamedTrackId, label }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: timeline.tracks.map((track: any) =>
          track.id === renamedTrackId ? { ...track, label } : track,
        ),
      });
    },
    { uid: timelineUid, trackId, label: initialLabel },
  );
});
