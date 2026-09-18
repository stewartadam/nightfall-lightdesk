// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type TimelineConfigurationSnapshot = {
  scrollMode?: string;
  loopStartMs?: number;
  loopEndMs?: number;
  loopEnabled?: boolean;
  useBeatGrid?: boolean;
  audioEnabled?: boolean;
  nondeterministicSeekBehavior?: string;
  lookahead?: string;
  bpm?: number;
  beatsPerBar?: number;
};

/**
 * Opens a unique blank showfile for the timeline configuration scenario.
 */
async function openOwnedTimelineConfigurationApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `timeline-configuration-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

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

test("timeline properties expose and persist timeline configuration", async ({
  page,
}) => {
  await openOwnedTimelineConfigurationApp(page);

  const ownedIds = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const idBase = Math.floor(700_000 + Math.random() * 100_000);
    const initialTimecodeId = idBase;
    const alternateTimecodeId = idBase + 1;
    const timelineId = idBase + 2;
    const initialTimecodeUid = crypto.randomUUID().replace(/-/g, "");
    const alternateTimecodeUid = crypto.randomUUID().replace(/-/g, "");
    const timelineUid = crypto.randomUUID().replace(/-/g, "");

    for (const timecode of [
      {
        identifiers: {
          id: initialTimecodeId,
          uid: initialTimecodeUid,
          label: "Configuration Timecode",
        },
        rate: "Fps30",
        source: "Internal",
      },
      {
        identifiers: {
          id: alternateTimecodeId,
          uid: alternateTimecodeUid,
          label: "Alternate Configuration Timecode",
        },
        rate: "Fps30",
        source: "Internal",
      },
    ]) {
      await stores.send({
        module: "TimecodeCommand",
        command: { type: "StoreTimecode", data: timecode },
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
            label: "Configuration Timeline",
          },
          timecode_uid: initialTimecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          audio_enabled: true,
          trigger_mode: "FollowTimecode",
          nondeterministic_seek_behavior: "Ignore",
          lookahead: "inherit",
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

    return {
      initialTimecodeId,
      initialTimecodeUid,
      alternateTimecodeId,
      alternateTimecodeUid,
      timelineId,
      timelineUid,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(
        ({ initialTimecodeUid, alternateTimecodeUid, timelineUid }) => {
          const stores = (window as any).appStores;
          return Boolean(
            stores.timelines.get()[timelineUid] &&
              stores.timecodes.get()[initialTimecodeUid] &&
              stores.timecodes.get()[alternateTimecodeUid],
          );
        },
        ownedIds,
      ),
    )
    .toBe(true);

  const context = await page.evaluate(async (ids) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const timelinePanelId = `e2e-config-timeline-${ids.timelineUid}`;
    if (!api.getPanel(timelinePanelId)) {
      api.addPanel({
        id: timelinePanelId,
        component: "Timeline",
        title: `Timeline ${ids.timelineId}`,
        params: {
          initialPanelId: timelinePanelId,
          initialTimelineUid: ids.timelineUid,
        },
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
      });
    }
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    const timelinePanel = api.getPanel(timelinePanelId);
    timelinePanel?.api.setActive();
    timelinePanel?.focus();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        timelinePanel?.api.setActive();
        timelinePanel?.focus();
        resolve();
      });
    });

    return {
      timelinePanelId,
      ...ids,
    };
  }, ownedIds);

  const linkedTimecode = page.getByLabel("Linked timecode");

  /** Reads persisted timeline fields that are edited by the properties form. */
  const readTimelineConfiguration = async () =>
    page.evaluate((timelineUid): TimelineConfigurationSnapshot => {
      const timeline = (window as any).appStores.timelines.get()[timelineUid];
      const loopStart = timeline?.loop_range?.start;
      const loopEnd = timeline?.loop_range?.end;
      return {
        scrollMode: timeline?.scroll_mode,
        loopStartMs: loopStart
          ? loopStart.secs * 1000 + Math.trunc(loopStart.nanos / 1_000_000)
          : undefined,
        loopEndMs: loopEnd
          ? loopEnd.secs * 1000 + Math.trunc(loopEnd.nanos / 1_000_000)
          : undefined,
        loopEnabled: timeline?.loop_range?.enabled,
        useBeatGrid: timeline?.use_beat_grid,
        audioEnabled: timeline?.audio_enabled,
        nondeterministicSeekBehavior: timeline?.nondeterministic_seek_behavior,
        lookahead: timeline?.lookahead,
        bpm: timeline?.bpm,
        beatsPerBar: timeline?.beats_per_bar,
      };
    }, context.timelineUid);

  /** Waits for selected timeline fields to reach their persisted values. */
  const waitForTimelineConfiguration = async (
    expected: TimelineConfigurationSnapshot,
  ): Promise<void> => {
    /** Reads only the persisted fields relevant to the current edit. */
    const readExpectedFields =
      async (): Promise<TimelineConfigurationSnapshot> => {
        const current = await readTimelineConfiguration();
        return Object.fromEntries(
          Object.keys(expected).map((key) => [
            key,
            current[key as keyof TimelineConfigurationSnapshot],
          ]),
        );
      };

    await expect
      .poll(
        async () => {
          const firstSnapshot = await readExpectedFields();
          await page.waitForTimeout(250);
          const secondSnapshot = await readExpectedFields();
          return { firstSnapshot, secondSnapshot };
        },
        { timeout: 15_000 },
      )
      .toEqual({
        firstSnapshot: expected,
        secondSnapshot: expected,
      });
  };

  /** Sets a labeled checkbox only when its current state differs. */
  const setCheckbox = async (label: string, checked: boolean) => {
    const checkbox = page.getByLabel(label);
    if ((await checkbox.isChecked()) !== checked) {
      await checkbox.evaluate((element, nextChecked) => {
        const input = element as HTMLInputElement;
        input.checked = nextChecked;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, checked);
    }
  };

  /** Commits a numeric properties input without relying on a later blur event. */
  const setNumberInput = async (label: string, value: number) => {
    await page.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };

  await expect(linkedTimecode).toBeVisible();
  await expect(page.getByLabel("Timecode start (ms)")).toBeVisible();
  await expect(page.getByLabel("Use end time")).toBeVisible();
  await expect(page.getByLabel("Audio enabled")).toBeVisible();
  await expect(page.getByLabel("Trigger mode")).toBeVisible();
  await expect(page.getByLabel("Seek behavior")).toBeVisible();
  await expect(page.getByLabel("Nondeterministic seek actions")).toBeVisible();
  await expect(page.getByLabel("Stop behavior")).toBeVisible();
  await expect(page.getByLabel("Lookahead")).toBeVisible();
  await expect(
    page.getByLabel("Timeline properties scroll mode"),
  ).toBeVisible();
  await expect(page.getByLabel("Loop enabled")).toBeVisible();
  await expect(page.getByLabel("Loop start (ms)")).toBeVisible();
  await expect(page.getByLabel("Loop end (ms)")).toBeVisible();
  await expect(page.getByLabel("Beat grid enabled")).toBeVisible();
  await expect(page.getByLabel("Timeline BPM")).toBeVisible();
  await expect(page.getByLabel("Timeline beats per bar")).toBeVisible();
  await expect(page.getByText("Markers", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Regions", { exact: true })).toHaveCount(1);

  await linkedTimecode.selectOption(context.alternateTimecodeUid);
  await expect
    .poll(() =>
      page.evaluate(
        (timelineUid) =>
          (window as any).appStores.timelines.get()[timelineUid]?.timecode_uid,
        context.timelineUid,
      ),
    )
    .toBe(context.alternateTimecodeUid);

  await linkedTimecode.selectOption(context.initialTimecodeUid);
  await expect
    .poll(() =>
      page.evaluate(
        (timelineUid) =>
          (window as any).appStores.timelines.get()[timelineUid]?.timecode_uid,
        context.timelineUid,
      ),
    )
    .toBe(context.initialTimecodeUid);

  await page.getByLabel("Trigger mode").selectOption("Manual");
  await expect
    .poll(() =>
      page.evaluate(
        (timelineUid) =>
          (window as any).appStores.timelines.get()[timelineUid]?.trigger_mode,
        context.timelineUid,
      ),
    )
    .toBe("Manual");

  await page.evaluate(
    async ({ panelId, timecodeId }) => {
      const stores = (window as any).appStores;
      await stores.send({
        module: "TimecodeCommand",
        command: { type: "StopTimecode", data: timecodeId },
      });
      stores.dockApi.get().getPanel(panelId)?.focus();
    },
    { panelId: context.timelinePanelId, timecodeId: context.initialTimecodeId },
  );

  const playhead = page
    .locator(
      `[data-timeline-surface="true"][data-timeline-uid="${context.timelineUid}"]`,
    )
    .locator('[data-timeline-playhead="true"]');
  await expect(playhead).toBeVisible();
  const playheadLeftBeforeTimecodeStart = await playhead.evaluate(
    (element) => getComputedStyle(element).left,
  );

  await page.evaluate(async (timecodeId) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "TimecodeCommand",
      command: { type: "StartTimecode", data: timecodeId },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  }, context.initialTimecodeId);

  await expect
    .poll(() => playhead.evaluate((element) => getComputedStyle(element).left))
    .toBe(playheadLeftBeforeTimecodeStart);

  await page.evaluate(
    async ({ panelId, timecodeId }) => {
      const stores = (window as any).appStores;
      await stores.send({
        module: "TimecodeCommand",
        command: { type: "StopTimecode", data: timecodeId },
      });
      const api = stores.dockApi.get();
      api.setEdgeGroupVisible("right", true);
      api.getEdgeGroup("right")?.expand();
      const timelinePanel = api.getPanel(panelId);
      timelinePanel?.api.setActive();
      timelinePanel?.focus();
    },
    { panelId: context.timelinePanelId, timecodeId: context.initialTimecodeId },
  );

  await page
    .getByLabel("Timeline properties scroll mode")
    .selectOption("follow");
  await waitForTimelineConfiguration({ scrollMode: "follow" });
  await page.getByLabel("Lookahead").selectOption("disabled");
  await waitForTimelineConfiguration({ lookahead: "disabled" });
  await setCheckbox("Loop enabled", true);
  await waitForTimelineConfiguration({ loopEnabled: true });
  await setNumberInput("Loop start (ms)", 1000);
  await waitForTimelineConfiguration({ loopStartMs: 1000 });
  await setNumberInput("Loop end (ms)", 4000);
  await waitForTimelineConfiguration({ loopEndMs: 4000 });
  await setCheckbox("Beat grid enabled", true);
  await waitForTimelineConfiguration({ useBeatGrid: true });
  await setCheckbox("Audio enabled", false);
  await waitForTimelineConfiguration({ audioEnabled: false });
  await setNumberInput("Timeline BPM", 128.5);
  await waitForTimelineConfiguration({ bpm: 128.5 });
  await setNumberInput("Timeline beats per bar", 3);
  await waitForTimelineConfiguration({ beatsPerBar: 3 });
  await page
    .getByLabel("Nondeterministic seek actions")
    .selectOption("Dispatch");
  await waitForTimelineConfiguration({
    nondeterministicSeekBehavior: "Dispatch",
  });

  await waitForTimelineConfiguration({
    scrollMode: "follow",
    loopStartMs: 1000,
    loopEndMs: 4000,
    loopEnabled: true,
    useBeatGrid: true,
    audioEnabled: false,
    nondeterministicSeekBehavior: "Dispatch",
    lookahead: "disabled",
    bpm: 128.5,
    beatsPerBar: 3,
  });

  const markersHeading = page.getByText("Markers", { exact: true });
  const regionsHeading = page.getByText("Regions", { exact: true });
  await expect(markersHeading).toBeAttached();
  await expect(regionsHeading).toBeAttached();

  await page.evaluate(async (ids) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "TimelineCommand",
      command: { type: "DeleteTimeline", data: ids.timelineId },
    });
    for (const timecodeId of [ids.initialTimecodeId, ids.alternateTimecodeId]) {
      await stores.send({
        module: "TimecodeCommand",
        command: { type: "DeleteTimecode", data: timecodeId },
      });
    }
  }, context);

  await expect
    .poll(() =>
      page.evaluate(
        ({ initialTimecodeUid, alternateTimecodeUid, timelineUid }) => {
          const stores = (window as any).appStores;
          return Boolean(
            stores.timelines.get()[timelineUid] ||
              stores.timecodes.get()[initialTimecodeUid] ||
              stores.timecodes.get()[alternateTimecodeUid],
          );
        },
        context,
      ),
    )
    .toBe(false);
});
