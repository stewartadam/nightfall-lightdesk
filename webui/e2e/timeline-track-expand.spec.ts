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

/** Browser storage key holding the tracks this device shows expanded. */
const EXPANDED_TRACKS_KEY = "nightfall-timeline-expanded-tracks";

/** IDs of the timeline the scenario expands. */
type ExpandFixture = {
  timelineUid: string;
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

/** Creates a timeline whose one track has a parameter lane and opens it in a timeline panel. */
async function openTimelineFixture(page: Page): Promise<ExpandFixture> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const timelineId = Math.floor(980_000 + Math.random() * 10_000);
    const trackId = `e2e-expand-track-${Date.now()}`;

    const results = [
      await stores.sendAndAwait({
        module: "TimecodeCommand",
        command: {
          type: "StoreTimecode",
          data: {
            identifiers: {
              id: timelineId,
              uid: timecodeUid,
              label: "E2E Track Expand Timecode",
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
              label: "E2E Track Expand",
            },
            timecode_uid: timecodeUid,
            timecode_start: { secs: 0, nanos: 0 },
            audio_path: "",
            tracks: [
              {
                id: trackId,
                label: "Expand Track",
                muted: false,
                solo: false,
                actions: [],
                automation_lanes: [
                  {
                    id: `${trackId}-lane`,
                    name: "Dimmer Curve",
                    color: "#22c55e",
                    parameter_type: {
                      type: "GlobalVariable",
                      data: "e2e-expand-variable",
                    },
                    points: [
                      { position: { secs: 0, nanos: 0 }, value: 0.25 },
                      { position: { secs: 4, nanos: 0 }, value: 0.75 },
                    ],
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

    const panelId = `e2e-track-expand-${timelineUid}`;
    stores.dockApi.get().addPanel({
      id: panelId,
      component: "Timeline",
      title: "Track Expand",
      params: { initialPanelId: panelId, initialTimelineUid: timelineUid },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
    return { timelineUid, trackId };
  });
}

/** Reads the tracks this device shows expanded from browser storage. */
async function storedExpandedTracks(page: Page): Promise<unknown> {
  return page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? "[]"),
    EXPANDED_TRACKS_KEY,
  );
}

/** Reads the keys the engine stores on the fixture's track. */
async function engineTrackKeys(page: Page, timelineUid: string) {
  return page.evaluate((uid) => {
    const track = (window as any).appStores.timelines.get()[uid]?.tracks?.[0];
    return Object.keys(track ?? {}).sort();
  }, timelineUid);
}

/**
 * Expanding and collapsing a track's parameter lanes is a view choice kept on this device: it
 * shows and hides the lanes, is remembered in browser storage, and sends nothing to the engine,
 * so it adds no undo step and leaves the stored track as it was.
 */
test("expanding a track stays on this device", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openApp(page, backendSlot.backendPort);
  const fixture = await openTimelineFixture(page);
  const header = page.locator(
    `[data-timeline-track-header="true"][data-track-id="${fixture.trackId}"]`,
  );
  const expand = header.getByRole("button", {
    name: "Expand automation lanes",
  });
  const laneHeader = page.getByRole("button", {
    name: "Delete parameter lane Dimmer Curve",
  });
  await expect(expand).toBeVisible();
  await expect(laneHeader).toBeHidden();
  const keysBefore = await engineTrackKeys(page, fixture.timelineUid);
  expect(keysBefore).not.toContain("expanded");
  await page.screenshot({ path: testInfo.outputPath("1-collapsed.png") });

  await expand.click();
  await expect(laneHeader).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Collapse automation lanes" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => storedExpandedTracks(page))
    .toEqual([fixture.trackId]);
  await page.screenshot({ path: testInfo.outputPath("2-expanded.png") });

  // Nothing reached the engine: the stored track is unchanged and no track edit can be undone.
  expect(await engineTrackKeys(page, fixture.timelineUid)).toEqual(keysBefore);
  await expect(
    page.getByRole("button", { name: /Undo: Edit Track/ }),
  ).toHaveCount(0);

  await header
    .getByRole("button", { name: "Collapse automation lanes" })
    .click();
  await expect(laneHeader).toBeHidden();
  await expect.poll(() => storedExpandedTracks(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("3-collapsed-again.png") });
});
