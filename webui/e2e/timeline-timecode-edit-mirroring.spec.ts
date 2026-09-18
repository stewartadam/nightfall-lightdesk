// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type TimelineFixture = {
  label: string;
  timelineId: number;
  timelineUid: string;
  timecodeId: number;
  timecodeUid: string;
};

/** Opens a unique blank showfile for linked timecode mirroring fixtures. */
async function openOwnedTimecodeMirroringApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timecode-mirroring-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
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

/**
 * Waits until app stores are exposed to the browser test page.
 */
async function waitForAppStores(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Boolean(
          (window as any).appStores?.dockApi?.get?.() &&
            (window as any).appStores?.send,
        ),
      ),
    )
    .toBe(true);
}

async function createLinkedTimeline(
  page: Page,
  options: {
    label: string;
    idBase: number;
    source?: "Internal" | "MidiMtc" | "SmpteLtc" | "ArtNet";
    timecodeUid?: string;
    timecodeId?: number;
  },
): Promise<TimelineFixture> {
  return page.evaluate(async (config) => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid =
      config.timecodeUid ?? crypto.randomUUID().replace(/-/g, "");
    const timelineId = config.idBase;
    const timecodeId = config.timecodeId ?? config.idBase + 1;

    if (!stores.timecodes.get()[timecodeUid]) {
      await stores.send({
        module: "TimecodeCommand",
        command: {
          type: "StoreTimecode",
          data: {
            identifiers: {
              id: timecodeId,
              uid: timecodeUid,
              label: `${config.label} Timecode`,
            },
            rate: "Fps30",
            source: config.source ?? "Internal",
          },
        },
      });
    }

    await stores.send({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: {
            id: timelineId,
            uid: timelineUid,
            label: config.label,
          },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          tracks: [],
          markers: [],
          regions: [],
          bpm: 120,
          beats_per_bar: 4,
          use_beat_grid: false,
          scroll_mode: "free",
        },
      },
    });

    return { ...config, timelineUid, timecodeUid, timelineId, timecodeId };
  }, options);
}

/**
 * Opens the timeline list panel for timecode mirroring tests.
 */
async function openTimelineListPanel(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel("panel-TimelinesPanel-edit-mirror");
    if (panel) {
      panel.focus();
    } else {
      api.addPanel({
        id: "panel-TimelinesPanel-edit-mirror",
        component: "TimelinesPanel",
        title: "Timelines",
        params: {},
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
      });
    }
  });
}

/**
 * Waits for timeline and timecode records to load in browser stores.
 */
async function waitForTimelineAndTimecode(
  page: Page,
  fixture: TimelineFixture,
) {
  await expect
    .poll(async () =>
      page.evaluate(
        ({ timelineUid, timecodeUid }) => {
          const stores = (window as any).appStores;
          return Boolean(
            stores.timelines.get()[timelineUid] &&
              stores.timecodes.get()[timecodeUid],
          );
        },
        {
          timelineUid: fixture.timelineUid,
          timecodeUid: fixture.timecodeUid,
        },
      ),
    )
    .toBe(true);
}

/**
 * Edits a timeline field through the UI and waits for mirrored state.
 */
async function editTimeline(
  page: Page,
  fixture: TimelineFixture,
  nextId: number,
  nextLabel: string,
) {
  await openTimelineListPanel(page);
  const panel = page.locator(
    '[data-panel-kind="timeline-list"][data-panel-id="panel-TimelinesPanel-edit-mirror"]',
  );
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Toggle selection mode" }).click();
  await panel
    .getByRole("button", {
      name: new RegExp(`Timeline ${fixture.timelineId}: ${fixture.label}`),
    })
    .click();
  await panel.getByRole("button", { name: "Edit selected timeline" }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit timeline" }),
  ).toBeVisible();
  await page.getByLabel("Timeline ID").fill(String(nextId));
  await page.getByLabel("Timeline label").fill(nextLabel);
  await page.getByRole("button", { name: "Save" }).click();
}

/**
 * Reads a timecode snapshot from browser stores for mirror assertions.
 */
async function timecodeSnapshot(page: Page, timecodeUid: string) {
  return page.evaluate((uid) => {
    const timecode = (window as any).appStores.timecodes.get()[uid]?.[0];
    return timecode?.identifiers;
  }, timecodeUid);
}

async function deleteFixtureData(page: Page, fixtures: TimelineFixture[]) {
  await page.evaluate(async (items) => {
    const stores = (window as any).appStores;
    const deletedTimecodes = new Set<string>();
    for (const item of items) {
      const timeline = stores.timelines.get()[item.timelineUid];
      if (timeline) {
        await stores.send({
          module: "TimelineCommand",
          command: { type: "DeleteTimeline", data: timeline.identifiers.id },
        });
      }
      if (!deletedTimecodes.has(item.timecodeUid)) {
        const timecode = stores.timecodes.get()[item.timecodeUid]?.[0];
        if (timecode) {
          await stores.send({
            module: "TimecodeCommand",
            command: { type: "DeleteTimecode", data: timecode.identifiers.id },
          });
        }
        deletedTimecodes.add(item.timecodeUid);
      }
    }
  }, fixtures);
}

test("timeline edits mirror internal one-to-one timecodes only", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openOwnedTimecodeMirroringApp(page);
  await waitForAppStores(page);

  const idBase = Math.floor(900_000 + Math.random() * 50_000);
  const internal = await createLinkedTimeline(page, {
    label: "Internal Mirror",
    idBase,
  });
  const external = await createLinkedTimeline(page, {
    label: "External Mirror",
    idBase: idBase + 10,
    source: "MidiMtc",
  });
  const sharedTimecodeUid = crypto.randomUUID().replace(/-/g, "");
  const sharedPrimary = await createLinkedTimeline(page, {
    label: "Shared Primary",
    idBase: idBase + 20,
    timecodeUid: sharedTimecodeUid,
    timecodeId: idBase + 21,
  });
  const sharedSecondary = await createLinkedTimeline(page, {
    label: "Shared Secondary",
    idBase: idBase + 30,
    timecodeUid: sharedTimecodeUid,
    timecodeId: idBase + 21,
  });
  const fixtures = [internal, external, sharedPrimary, sharedSecondary];

  try {
    for (const fixture of fixtures) {
      await waitForTimelineAndTimecode(page, fixture);
    }

    await editTimeline(page, internal, idBase + 100, "Internal Renamed");
    await expect
      .poll(async () => timecodeSnapshot(page, internal.timecodeUid))
      .toMatchObject({ id: idBase + 100, label: "Internal Renamed" });

    const externalBefore = await timecodeSnapshot(page, external.timecodeUid);
    await editTimeline(page, external, idBase + 110, "External Renamed");
    await expect
      .poll(async () => timecodeSnapshot(page, external.timecodeUid))
      .toEqual(externalBefore);

    const sharedBefore = await timecodeSnapshot(
      page,
      sharedPrimary.timecodeUid,
    );
    await editTimeline(page, sharedPrimary, idBase + 120, "Shared Renamed");
    await expect
      .poll(async () => timecodeSnapshot(page, sharedPrimary.timecodeUid))
      .toEqual(sharedBefore);
  } finally {
    await deleteFixtureData(page, fixtures);
  }
});
