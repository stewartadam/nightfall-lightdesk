// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type JumpTimelineFixture = {
  timelineId: number;
  timelineUid: string;
  timecodeId: number;
  timecodeUid: string;
};

/** Opens a unique blank showfile for a timeline jump scenario. */
async function openOwnedTimelineJumpApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-jump-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
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

/** Creates and opens a deterministic timeline for jump popout browser checks. */
async function createJumpTimeline(page: Page): Promise<JumpTimelineFixture> {
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
            label: "E2E Jump Popout Timecode",
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
            label: "E2E Jump Popout Timeline",
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
            audio_fingerprint: "e2e-jump-popout",
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
      id: `e2e-jump-popout-timeline-${timelineUid}`,
      component: "Timeline",
      title: `Timeline ${timelineId}`,
      params: { initialTimelineUid: timelineUid },
    });
    panel.api.setActive();

    return { timelineId, timelineUid, timecodeId, timecodeUid };
  });
}

/** Removes the timeline and timecode created by this spec. */
async function deleteJumpTimeline(
  page: Page,
  fixture: JumpTimelineFixture,
): Promise<void> {
  await page.evaluate(async ({ timelineId, timecodeId }) => {
    const stores = (window as any).appStores;
    if (!stores?.send) return;
    await stores.send({
      module: "TimelineCommand",
      command: { type: "DeleteTimeline", data: timelineId },
    });
    await stores.send({
      module: "TimecodeCommand",
      command: { type: "DeleteTimecode", data: timecodeId },
    });
  }, fixture);
}

/** Toggles the seeded timeline mode while preserving stored beatgrid marker data. */
async function setJumpTimelineBeatgridMode(
  page: Page,
  fixture: JumpTimelineFixture,
  useBeatgrid: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ timelineUid, useBeatgrid }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[timelineUid];
      if (!timeline || !stores?.send) {
        throw new Error(`Timeline ${timelineUid} was not ready`);
      }

      await stores.send({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: { ...timeline, use_beat_grid: useBeatgrid },
        },
      });

      for (let attempts = 0; attempts < 200; attempts += 1) {
        if (
          stores.timelines.get()[timelineUid]?.use_beat_grid === useBeatgrid
        ) {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      throw new Error(`Timeline ${timelineUid} did not update beatgrid mode`);
    },
    { timelineUid: fixture.timelineUid, useBeatgrid },
  );
}

/** Reads the current position of the timecode linked to the seeded timeline. */
async function currentTimecodeMs(
  page: Page,
  fixture: JumpTimelineFixture,
): Promise<number> {
  return page.evaluate(({ timecodeUid }) => {
    const currentTime = (window as any).appStores.timecodes.get()[
      timecodeUid
    ]?.[1]?.current_time;
    if (!currentTime) return Number.POSITIVE_INFINITY;
    return currentTime.secs * 1000 + currentTime.nanos / 1_000_000;
  }, fixture);
}

/** Focuses the seeded timeline so the panel-scoped jump shortcut can open. */
async function focusTimeline(page: Page, fixture: JumpTimelineFixture) {
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.click({ force: true, position: { x: 320, y: 120 } });
}

/** Opens the jump popout through the operator shortcut and returns its input. */
async function openJumpPopout(page: Page, fixture: JumpTimelineFixture) {
  await focusTimeline(page, fixture);
  await page.keyboard.press("ControlOrMeta+G");
  const popout = page.locator('[data-timeline-popout="goto"]');
  await expect(popout).toBeVisible();
  return popout.getByLabel("Timeline jump target");
}

/** Opens the global command palette and returns its search input. */
async function openCommandPalette(page: Page) {
  await page.keyboard.press("Meta+Shift+P");
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  return commandInput;
}

/** Verifies timeline markers are only exposed through the dedicated jump popout. */
test("timeline markers do not register global command palette seek entries", async ({
  page,
}) => {
  await openOwnedTimelineJumpApp(page);
  const fixture = await createJumpTimeline(page);

  try {
    const commandInput = await openCommandPalette(page);
    await commandInput.fill("seek");
    await expect(
      page.locator('[data-command-id*="timeline.seek-marker"]'),
    ).toHaveCount(0);

    await commandInput.fill("Duplicate Label");
    await expect(
      page.locator('[data-command-id*="timeline.seek-marker"]'),
    ).toHaveCount(0);
  } finally {
    await deleteJumpTimeline(page, fixture);
  }
});

/** Verifies Cmd/Ctrl+G jumps by duplicate label rows, timestamp, and beatgrid input. */
test("timeline jump popout searches labels and jumps to time or beat targets", async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  await openOwnedTimelineJumpApp(page);
  const fixture = await createJumpTimeline(page);

  try {
    const input = await openJumpPopout(page, fixture);
    await input.fill("Duplicate Label");
    const popout = page.locator('[data-timeline-popout="goto"]');
    await expect(popout.getByRole("option")).toHaveCount(2);
    await expect(popout.getByRole("option").first()).toContainText("0:05");
    await expect(popout.getByRole("option").first()).toContainText("Label");
    await expect(popout.getByRole("option").first()).toContainText("Beat 3:01");
    await expect(popout.getByRole("option").nth(1)).toContainText("0:15");
    await expect(popout.getByRole("option").nth(1)).toContainText("Beat 8:01");
    await expect(popout).toHaveClass(/nf-search-picker/);
    await popout.screenshot({
      path: testInfo.outputPath("shared-jump-picker.png"),
    });

    await input.fill("t 1:05:05");
    await expect(popout.getByRole("option").first()).toContainText(
      "Jump to time 1:05:05",
    );
    await expect(popout.getByRole("option").first()).toContainText("Timestamp");
    await page.keyboard.press("Enter");
    await expect.poll(() => currentTimecodeMs(page, fixture)).toBe(3_905_000);

    const beatInput = await openJumpPopout(page, fixture);
    await beatInput.fill("3:02");
    const ambiguousRows = page
      .locator('[data-timeline-popout="goto"]')
      .getByRole("option");
    await expect(ambiguousRows).toHaveCount(2);
    await expect(ambiguousRows.first()).toContainText("Timestamp");
    await expect(ambiguousRows.nth(1)).toContainText("Jump to Beat 3:02");
    await expect(ambiguousRows.nth(1)).toContainText("Beat");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => currentTimecodeMs(page, fixture)).toBe(5_500);

    const prefixedBeatInput = await openJumpPopout(page, fixture);
    await prefixedBeatInput.fill("b 64");
    const prefixedBeatRows = page
      .locator('[data-timeline-popout="goto"]')
      .getByRole("option");
    await expect(prefixedBeatRows).toHaveCount(1);
    await expect(prefixedBeatRows.first()).toContainText("Jump to Beat 64");
    await expect(prefixedBeatRows.first()).toContainText("Beat 16:04");
    await page.keyboard.press("Enter");
    await expect.poll(() => currentTimecodeMs(page, fixture)).toBe(32_500);

    const flatMarkerInput = await openJumpPopout(page, fixture);
    await flatMarkerInput.fill("5");
    const flatMarkerRows = page
      .locator('[data-timeline-popout="goto"]')
      .getByRole("option");
    await expect(flatMarkerRows).toHaveCount(2);
    await expect(flatMarkerRows.first()).toContainText("Duplicate Label");
    await expect(flatMarkerRows.first()).not.toContainText("Jump to Beat 5");

    await flatMarkerInput.fill("64");
    const flatBeatRows = page
      .locator('[data-timeline-popout="goto"]')
      .getByRole("option");
    await expect(flatBeatRows).toHaveCount(1);
    await expect(flatBeatRows.first()).toContainText("Jump to Beat 64");
    await page.keyboard.press("Enter");
    await expect.poll(() => currentTimecodeMs(page, fixture)).toBe(32_500);

    await setJumpTimelineBeatgridMode(page, fixture, false);
    const timeModeInput = await openJumpPopout(page, fixture);
    await timeModeInput.fill("Duplicate Label");
    const timeModeRows = page
      .locator('[data-timeline-popout="goto"]')
      .getByRole("option");
    await expect(timeModeRows.first()).toContainText("Beat 3:03");
    await expect(timeModeRows.first()).not.toContainText("Beat 3:01");

    await timeModeInput.fill("b 1:01");
    await expect(timeModeRows.first()).toContainText("Jump to Beat 1:01");
    await page.keyboard.press("Enter");
    await expect.poll(() => currentTimecodeMs(page, fixture)).toBe(0);
  } finally {
    await deleteJumpTimeline(page, fixture);
  }
});
