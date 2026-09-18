// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type CreatedTimeline = {
  timelineId: number;
  timelineUid: string;
  timecodeId: number;
};

/** Opens a unique blank showfile for the empty-tracks scenario. */
async function openOwnedEmptyTracksApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-empty-tracks-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
}

/** Opens the timeline list panel so the test can create a timeline through UI code. */
async function openTimelineListPanel(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel("panel-TimelinesPanel-empty-tracks")?.api.close();
    api.addPanel({
      id: "panel-TimelinesPanel-empty-tracks",
      component: "TimelinesPanel",
      title: "Timelines",
      params: {},
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
  });
}

/** Creates a timeline with the list panel's modal and returns its canonical store identity. */
async function createTimelineThroughUi(page: Page): Promise<CreatedTimeline> {
  await openTimelineListPanel(page);
  const panel = page.locator(
    '[data-panel-kind="timeline-list"][data-panel-id="panel-TimelinesPanel-empty-tracks"]',
  );
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Add timeline" }).click();
  await expect(
    page.getByRole("dialog", { name: "Create timeline" }),
  ).toBeVisible();
  const timelineId = Number(await page.getByLabel("Timeline ID").inputValue());
  const label = `Empty Tracks ${timelineId}-${Date.now()}`;
  await page.getByLabel("Timeline label").fill(label);
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate((createdLabel) => {
        const stores = (window as any).appStores;
        const timeline = Object.values(stores.timelines.get()).find(
          (candidate: any) => candidate?.identifiers?.label === createdLabel,
        ) as any;
        if (!timeline) return undefined;
        const timecode = stores.timecodes.get()[timeline.timecode_uid]?.[0];
        if (!timecode) return undefined;
        return {
          timelineId: timeline.identifiers.id,
          timelineUid: timeline.identifiers.uid,
          timecodeId: timecode.identifiers.id,
        };
      }, label),
    )
    .toBeDefined();

  return await page.evaluate((createdLabel) => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (candidate: any) => candidate?.identifiers?.label === createdLabel,
    ) as any;
    const timecode = stores.timecodes.get()[timeline.timecode_uid]?.[0];
    return {
      timelineId: timeline.identifiers.id,
      timelineUid: timeline.identifiers.uid,
      timecodeId: timecode.identifiers.id,
    };
  }, label);
}

/** Verifies empty tracks and a marker from a newly-created timeline reach backend state. */
test("new timeline empty tracks and marker persist to timeline definitions", async ({
  page,
}) => {
  await openOwnedEmptyTracksApp(page);
  const timeline = await createTimelineThroughUi(page);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timeline.timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByRole("button", { name: "+ Add Track" }).click();
  await surface.getByRole("button", { name: "+ Add Track" }).click();
  await surface.getByRole("button", { name: "+ Add Track" }).click();

  await page.evaluate(async ({ timecodeId }) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "TimecodeCommand",
      command: {
        type: "SeekTimecode",
        data: { id: timecodeId, position: { secs: 3, nanos: 0 } },
      },
    });
  }, timeline);
  await surface.click();
  await page.keyboard.press("m");

  await expect(surface.getByText("Track 1", { exact: true })).toBeVisible();
  await expect(surface.getByText("Track 2", { exact: true })).toBeVisible();
  await expect(surface.getByText("Track 3", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((timelineUid) => {
        const timeline = (window as any).appStores.timelines.get()[timelineUid];
        return {
          tracks: timeline?.tracks?.map((track: any) => ({
            label: track.label,
            itemCount: track.actions.length,
          })),
          markerCount: timeline?.markers?.length,
        };
      }, timeline.timelineUid),
    )
    .toEqual({
      tracks: [
        { label: "Track 1", itemCount: 0 },
        { label: "Track 2", itemCount: 0 },
        { label: "Track 3", itemCount: 0 },
      ],
      markerCount: 1,
    });
});
