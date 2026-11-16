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
  panelId: string;
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

    const panelId = `e2e-concurrent-edits-${timelineUid}`;
    stores.dockApi.get().addPanel({
      id: panelId,
      component: "Timeline",
      title: "Concurrent Edits",
      params: { initialPanelId: panelId, initialTimelineUid: timelineUid },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
    return { timelineUid, timelineId, trackId, panelId };
  });
}

/** Opens the Properties inspector beside the fixture timeline panel and focuses the timeline. */
async function openTimelineProperties(page: Page, panelId: string) {
  await page.evaluate(async (timelinePanelId) => {
    const api = (window as any).appStores.dockApi.get();
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const timelinePanel = api.getPanel(timelinePanelId);
        timelinePanel?.api.setActive();
        timelinePanel?.focus();
        resolve();
      });
    });
  }, panelId);
}

/** Reads what the engine stores for the fixture timeline's first track, markers, loop and tempo. */
async function storedState(page: Page, timelineUid: string) {
  return page.evaluate((uid) => {
    const timeline = (window as any).appStores.timelines.get()[uid];
    return {
      muted: timeline?.tracks?.[0]?.muted,
      markers: (timeline?.markers ?? []).map((marker: any) => marker.label),
      loopEnabled: timeline?.loop_range?.enabled ?? false,
      bpm: timeline?.bpm,
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
    .toEqual({ muted: true, markers: ["Drop"], loopEnabled: true, bpm: 120 });
  await expect(
    header.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-timeline-marker="true"]', { hasText: "Drop" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("2-after-mute.png") });

  // Unmuting and undoing it is one "Edit Track" undo step that restores only the mute.
  await header.getByRole("button", { name: "Unmute", exact: true }).click();
  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: false, markers: ["Drop"], loopEnabled: true, bpm: 120 });
  await page.getByRole("button", { name: /Undo: Edit Track/ }).click();
  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: true, markers: ["Drop"], loopEnabled: true, bpm: 120 });
  await expect(
    header.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await expect(mute).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("3-after-undo.png") });
});

/**
 * Changing the tempo in the Properties panel right after another client's marker reaches the
 * engine keeps the marker. The panel used to send the whole timeline from its local copy, so
 * the tempo change erased the marker.
 */
test("a timeline settings edit keeps a marker set elsewhere", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openApp(page, backendSlot.backendPort);
  const fixture = await openTimelineFixture(page);
  await openTimelineProperties(page, fixture.panelId);
  const bpmInput = page.getByLabel("Timeline BPM");
  await expect(bpmInput).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-before.png") });

  // Send the marker as another client would, then change the tempo in the same task.
  await page.evaluate(({ timelineId }) => {
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
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Timeline BPM"]',
    );
    if (!input) throw new Error("BPM input not found");
    input.value = "128";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, fixture);

  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: false, markers: ["Drop"], loopEnabled: false, bpm: 128 });
  await expect(bpmInput).toHaveValue("128");
  await page.screenshot({ path: testInfo.outputPath("2-after-bpm.png") });

  // A second tempo change is one "Edit Timeline Settings" undo step that restores only the tempo.
  await bpmInput.fill("130");
  await bpmInput.dispatchEvent("change");
  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: false, markers: ["Drop"], loopEnabled: false, bpm: 130 });
  await page
    .getByRole("button", { name: /Undo: Edit Timeline Settings/ })
    .click();
  await expect
    .poll(() => storedState(page, fixture.timelineUid))
    .toEqual({ muted: false, markers: ["Drop"], loopEnabled: false, bpm: 128 });
  await expect(bpmInput).toHaveValue("128");
  await page.screenshot({ path: testInfo.outputPath("3-after-undo.png") });
});
