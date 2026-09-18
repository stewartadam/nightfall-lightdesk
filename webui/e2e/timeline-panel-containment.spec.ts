// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type ContainmentTimelineFixture = {
  timelineId: number;
  timelineUid: string;
  timecodeId: number;
  timecodeUid: string;
};

/** Opens a unique blank showfile for a panel containment scenario. */
async function openContainmentApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-containment-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
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

/** Creates and opens a deterministic timeline for panel containment checks. */
async function createContainmentTimeline(
  page: Page,
): Promise<ContainmentTimelineFixture> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    if (!api || !stores.send) {
      throw new Error("App stores were not ready");
    }

    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(960_000 + Math.random() * 20_000);
    const timelineId = idBase;
    const timecodeId = idBase + 1;

    await stores.send({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: {
            id: timecodeId,
            uid: timecodeUid,
            label: "E2E Containment Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });

    await stores.send({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: {
            id: timelineId,
            uid: timelineUid,
            label: "E2E Containment Timeline",
          },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          tracks: [],
          markers: [
            {
              uid: crypto.randomUUID().replace(/-/g, ""),
              label: "Duplicate Label",
              time: { secs: 5, nanos: 0 },
            },
            {
              uid: crypto.randomUUID().replace(/-/g, ""),
              label: "Duplicate Label",
              time: { secs: 15, nanos: 0 },
            },
          ],
          regions: [],
          bpm: 120,
          beats_per_bar: 4,
          use_beat_grid: true,
          beatgrid: {
            source: "manual",
            audio_fingerprint: "e2e-containment",
            bpm: 120,
            beats_per_bar: 4,
            confidence: 1,
            markers: [
              {
                time: { secs: 1, nanos: 0 },
                beat_index: 0,
                is_downbeat: true,
                confidence: 1,
              },
            ],
          },
          scroll_mode: "free",
        },
      },
    });

    for (let attempts = 0; attempts < 200; attempts += 1) {
      const timelineReady = Boolean(stores.timelines.get()[timelineUid]);
      const timecodeReady = Boolean(stores.timecodes.get()[timecodeUid]);
      if (timelineReady && timecodeReady) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (!stores.timelines.get()[timelineUid]) {
      throw new Error(`Timeline ${timelineUid} was not stored`);
    }
    if (!stores.timecodes.get()[timecodeUid]) {
      throw new Error(`Timecode ${timecodeUid} was not stored`);
    }

    const panel = api.addPanel({
      id: `e2e-containment-timeline-${timelineUid}`,
      component: "Timeline",
      title: `Timeline ${timelineId}`,
      params: { initialTimelineUid: timelineUid },
      position: { referencePanel: "panel-FixtureGrid", direction: "below" },
    });
    panel.api.setActive();

    return { timelineId, timelineUid, timecodeId, timecodeUid };
  });
}

/** Checks timeline paint and hit targets remain inside a short dock above Clips. */
test("timeline stays inside its panel above the expanded Clips edge", async ({
  page,
}, testInfo) => {
  await openContainmentApp(page);
  const fixture = await createContainmentTimeline(page);
  await expect(
    page.locator(
      `[data-timeline-surface][data-timeline-uid="${fixture.timelineUid}"]`,
    ),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const clips = api.panels.find((panel: any) => panel.title === "Clips");
    if (!clips) throw new Error("Clips panel missing");
    const edge = api.getEdgeGroup("bottom");
    clips.api.moveTo({
      group: api.panels.find((panel: any) => panel.title === "Console").api
        .group,
      position: "center",
    });
    clips.api.setActive();
    edge.expand();
    edge.setSize({ height: 500 });
    edge.collapse();
  });
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("timeline-clips.png") });
  const leaks = await surface.evaluate((element) => {
    const grid = element
      .closest(".dv-shell")!
      .querySelector(".dv-dockview")!
      .getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + 50;
    const y = Math.max(grid.bottom + 5, bounds.top + 5);
    return document
      .elementsFromPoint(x, y)
      .some((node) => element.contains(node));
  });
  expect(leaks).toBe(false);
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().getEdgeGroup("bottom").collapse(),
  );
  await expect
    .poll(() =>
      surface.evaluate(
        (element) =>
          getComputedStyle(element.closest("[data-panel-active]")!).clipPath,
      ),
    )
    .toBe("none");
  await expect(
    surface.locator("[data-timeline-footer-toolbar]"),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("timeline-restored.png") });
});
