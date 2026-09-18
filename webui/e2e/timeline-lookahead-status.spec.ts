// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

type TimelinePreactivationFixture = {
  timelineUid: string;
  timecodeUid: string;
  clipUid: string;
  panelId: string;
  trackId: string;
  actionId: string;
};

/** Opens an empty disconnected app ready for owned lookahead-status data. */
async function openTimelineLookaheadStatusApp(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
}

/** Opens an isolated timeline with one item for lookahead status rendering. */
async function openTimelinePreactivationFixture(
  page: Page,
): Promise<TimelinePreactivationFixture> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores?.dockApi?.get?.();
    if (!api) {
      throw new Error("App stores were not ready");
    }

    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const clipUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(960_000 + Math.random() * 20_000);
    const timelineId = idBase;
    const timecodeId = idBase + 1;
    const trackId = `e2e-lookahead-track-${Date.now()}`;
    const actionId = `e2e-lookahead-item-${Date.now()}`;

    stores.clips.set({
      [clipUid]: [
        {
          identifiers: {
            id: idBase + 2,
            uid: clipUid,
            label: "E2E Preactivation Clip",
          },
          priority: 0,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
        false,
      ],
    });
    stores.timecodes.set({
      [timecodeUid]: [
        {
          identifiers: {
            id: timecodeId,
            uid: timecodeUid,
            label: "E2E Preactivation Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
        {
          timecode_id: timecodeId,
          is_active: false,
          current_time: { secs: 0, nanos: 0 },
          start_time: null,
          end_time: null,
        },
      ],
    });
    stores.timelines.set({
      [timelineUid]: {
        identifiers: {
          id: timelineId,
          uid: timelineUid,
          label: "E2E Preactivation Timeline",
        },
        timecode_uid: timecodeUid,
        timecode_start: { secs: 0, nanos: 0 },
        audio_path: "",
        audio_enabled: true,
        end_time: null,
        trigger_mode: "FollowTimecode",
        seek_behavior: "ReconstructState",
        nondeterministic_seek_behavior: "Ignore",
        stop_behavior: "ResetAndReleaseOwnedActions",
        lookahead: "enabled",
        tracks: [
          {
            id: trackId,
            label: "Preactivation Track",
            muted: false,
            solo: false,
            expanded: true,
            actions: [
              {
                id: actionId,
                label: "Preactivation Item",
                position: { secs: 1, nanos: 0 },
                duration: { secs: 1, nanos: 0 },
                action: { type: "StartClip", data: clipUid },
              },
            ],
            automation_lanes: [],
          },
        ],
        markers: [],
        regions: [],
        loop_range: null,
        bpm: 120,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: null,
        scroll_mode: "free",
      },
    });
    stores.timelineDefinitionsLoaded.set(true);

    const panelId = `e2e-lookahead-${timelineUid}`;
    const panel = api.addPanel({
      id: panelId,
      component: "Timeline",
      title: "Preactivation",
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    panel.api.setActive();
    panel.focus();

    return {
      timelineUid,
      timecodeUid,
      clipUid,
      panelId,
      trackId,
      actionId,
    };
  });
}

/** Seeds a runtime lookahead status for one rendered timeline action. */
async function setPreactivationStatus(
  page: Page,
  fixture: TimelinePreactivationFixture,
  kind: "ready" | "asserted" | "blocked_by_intervening_fixture_assertions",
  blockingItems: Array<{ track_id: string; action_id: string }> = [],
) {
  await page.evaluate(
    ({ fixture, kind, blockingItems }) => {
      const stores = (window as any).appStores;
      stores.timelineLookaheadActionStatuses.set({
        [fixture.timelineUid]: {
          [JSON.stringify([fixture.trackId, fixture.actionId])]: {
            timeline_uid: fixture.timelineUid,
            track_id: fixture.trackId,
            action_id: fixture.actionId,
            kind,
            blocking_items: blockingItems,
          },
        },
      });
    },
    { fixture, kind, blockingItems },
  );
}

/** Removes all owned stores and the panel created for lookahead rendering. */
async function cleanupTimelinePreactivationFixture(
  page: Page,
  fixture: TimelinePreactivationFixture,
) {
  await page.evaluate(({ clipUid, panelId, timecodeUid, timelineUid }) => {
    const stores = (window as any).appStores;
    stores.dockApi?.get?.()?.getPanel(panelId)?.api.close();
    stores.timelineLookaheadActionStatuses.set({});

    const timelines = { ...stores.timelines.get() };
    delete timelines[timelineUid];
    stores.timelines.set(timelines);

    const timecodes = { ...stores.timecodes.get() };
    delete timecodes[timecodeUid];
    stores.timecodes.set(timecodes);

    const clips = { ...stores.clips.get() };
    delete clips[clipUid];
    stores.clips.set(clips);
  }, fixture);
}

/** Verifies timeline actions visually render ready and blocked lookahead states. */
test("timeline action renders lookahead status indicators", async ({
  page,
}) => {
  await openTimelineLookaheadStatusApp(page);

  const fixture = await openTimelinePreactivationFixture(page);
  try {
    const surface = page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
    );
    await expect(surface).toBeVisible();
    await page.getByLabel("Timeline zoom").fill("300");

    const item = page.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.trackId}"][data-action-id="${fixture.actionId}"]`,
    );
    await expect(item).toBeVisible();

    await setPreactivationStatus(page, fixture, "ready");
    const readyIndicator = item.locator(
      '[data-timeline-lookahead-status="ready"]',
    );
    await expect(readyIndicator).toBeVisible();
    await expect(readyIndicator).toHaveClass(/bg-teal-300/);
    const itemBox = await item.boundingBox();
    const indicatorBox = await readyIndicator.boundingBox();
    expect(itemBox).not.toBeNull();
    expect(indicatorBox).not.toBeNull();
    expect(indicatorBox!.x).toBeLessThanOrEqual(itemBox!.x);
    expect(indicatorBox!.y).toBeLessThanOrEqual(itemBox!.y);

    await setPreactivationStatus(
      page,
      fixture,
      "blocked_by_intervening_fixture_assertions",
    );
    const blockedIndicator = item.locator(
      '[data-timeline-lookahead-status="blocked_by_intervening_fixture_assertions"]',
    );
    await expect(blockedIndicator).toBeVisible();
    await expect(blockedIndicator).toHaveClass(/bg-amber-300/);
  } finally {
    await cleanupTimelinePreactivationFixture(page, fixture);
  }
});
