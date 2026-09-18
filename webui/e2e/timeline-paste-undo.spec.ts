// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type TimelinePasteFixture = {
  timelineUid: string;
  trackId: string;
  actionId: string;
};

/** Reads the backend-owned timeline stores that must remain blank between tests. */
async function ownedTimelineStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      timecodes: Object.keys(stores.timecodes.get()).length,
      timelines: Object.keys(stores.timelines.get()).length,
    };
  });
}

/** Opens the application against a verified blank backend showfile. */
async function openOwnedTimelinePasteApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.timecodes?.get) &&
      Boolean((window as any).appStores?.timelines?.get),
  );
  await expect
    .poll(() => ownedTimelineStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      timecodes: 0,
      timelines: 0,
    });
}

/** Replaces the scenario showfile and proves timeline state is fully blank. */
async function resetOwnedTimelinePasteApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedTimelineStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      timecodes: 0,
      timelines: 0,
    });
}

/** Opens an isolated timeline containing one action for paste undo validation. */
async function openTimelinePasteFixture(
  page: Page,
): Promise<TimelinePasteFixture> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (let attempts = 0; attempts < 200; attempts += 1) {
      if (
        stores?.dockApi?.get?.() &&
        typeof stores?.sendAndAwait === "function"
      ) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }

    const api = stores?.dockApi?.get?.();
    if (!api || typeof stores?.sendAndAwait !== "function") {
      throw new Error("App stores were not ready");
    }

    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const disconnectedClipUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(940_000 + Math.random() * 20_000);
    const timelineId = idBase;
    const timecodeId = idBase + 1;
    const trackId = `e2e-paste-track-${Date.now()}`;
    const actionId = `e2e-paste-item-${Date.now()}`;

    const outcomes = [
      await stores.sendAndAwait({
        module: "TimecodeCommand",
        command: {
          type: "StoreTimecode",
          data: {
            identifiers: {
              id: timecodeId,
              uid: timecodeUid,
              label: "E2E Paste Undo Timecode",
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
              label: "E2E Paste Undo Timeline",
            },
            timecode_uid: timecodeUid,
            timecode_start: { secs: 0, nanos: 0 },
            audio_path: "",
            tracks: [
              {
                id: trackId,
                label: "Paste Undo Track",
                muted: false,
                solo: false,
                expanded: true,
                actions: [
                  {
                    id: actionId,
                    label: "Paste Undo Item",
                    position: { secs: 1, nanos: 0 },
                    duration: { secs: 1, nanos: 0 },
                    action: {
                      type: "StartClip",
                      data: disconnectedClipUid,
                    },
                  },
                ],
                automation_lanes: [],
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
    for (const outcome of outcomes) {
      if (outcome.outcome.type !== "Succeeded") {
        throw new Error(
          `owned timeline setup failed: ${JSON.stringify(outcome)}`,
        );
      }
    }

    for (let attempts = 0; attempts < 200; attempts += 1) {
      const timelineReady = Boolean(stores.timelines.get()[timelineUid]);
      const timecodeReady = Boolean(stores.timecodes.get()[timecodeUid]);
      if (timelineReady && timecodeReady) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (!stores.timelines.get()[timelineUid]) {
      throw new Error("Created timeline did not reach the frontend store");
    }

    api.addPanel({
      id: `e2e-paste-undo-${timelineUid}`,
      component: "Timeline",
      title: "Paste Undo",
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });

    const clearHistoryResult = await stores.sendAndAwait({
      module: "UndoCommand",
      command: { type: "ClearHistory", data: {} },
    });
    if (clearHistoryResult.outcome.type !== "Succeeded") {
      throw new Error(
        `undo history reset failed: ${JSON.stringify(clearHistoryResult)}`,
      );
    }

    return { timelineUid, trackId, actionId };
  });
}

/** Reads the number of persisted items on a fixture track. */
async function actionCount(
  page: Page,
  fixture: TimelinePasteFixture,
): Promise<number> {
  return page.evaluate(({ timelineUid, trackId }) => {
    const timeline = (window as any).appStores.timelines.get()[timelineUid];
    const track = timeline?.tracks?.find((entry: any) => entry.id === trackId);
    return track?.actions?.length ?? 0;
  }, fixture);
}

/** Resets and verifies the backend after a timeline paste scenario. */
async function cleanupTimelinePasteFixture(
  page: Page,
  backendPort: number,
): Promise<void> {
  await resetOwnedTimelinePasteApp(page, backendPort);
}

/** Presses a platform shortcut using separate modifier down/up events. */
async function pressShortcut(page: Page, modifier: string, key: string) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

/** Verifies pasted timeline actions can be undone with the global shortcut. */
test("timeline action paste creates an undoable command", async ({
  backendSlot,
  page,
}) => {
  await openOwnedTimelinePasteApp(page, backendSlot.backendPort);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  const fixture = await openTimelinePasteFixture(page);
  try {
    const surface = page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
    );
    await expect(surface).toBeVisible();
    await surface.getByLabel("Timeline zoom").fill("300");

    const originalItem = page.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.trackId}"][data-action-id="${fixture.actionId}"]`,
    );
    await expect(originalItem).toBeVisible();
    await originalItem.click();
    await expect(originalItem).toHaveAttribute("data-selected", "true");

    await pressShortcut(page, modifier, "c");
    await expect(page.getByText("Copied 1 timeline action.")).toBeVisible();
    await pressShortcut(page, modifier, "v");

    await expect(page.getByText("Pasted 1 timeline action.")).toBeVisible();
    await expect(
      page.locator(
        `[data-timeline-action="true"][data-track-id="${fixture.trackId}"]`,
      ),
    ).toHaveCount(2);
    await expect.poll(() => actionCount(page, fixture)).toBe(2);

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await originalItem.click({ modifiers: ["Shift"] });
    const selectedTextAfterRangeClick = await page.evaluate(
      () => window.getSelection()?.toString() ?? "",
    );
    expect(selectedTextAfterRangeClick).toBe("");
    await expect(
      page.getByRole("button", { name: /Undo: Store Timeline/ }),
    ).toBeEnabled();

    await pressShortcut(page, modifier, "z");
    await expect.poll(() => actionCount(page, fixture)).toBe(1);
    await expect(
      page.locator(
        `[data-timeline-action="true"][data-track-id="${fixture.trackId}"]`,
      ),
    ).toHaveCount(1);
  } finally {
    await cleanupTimelinePasteFixture(page, backendSlot.backendPort);
  }
});

/** Verifies timeline clipboard shortcuts do not override native text input shortcuts. */
test("timeline copy paste shortcuts ignore text editing controls", async ({
  backendSlot,
  page,
}) => {
  await openOwnedTimelinePasteApp(page, backendSlot.backendPort);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  const fixture = await openTimelinePasteFixture(page);
  try {
    const surface = page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
    );
    await expect(surface).toBeVisible();
    await surface.getByLabel("Timeline zoom").fill("300");

    const originalItem = page.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.trackId}"][data-action-id="${fixture.actionId}"]`,
    );
    await expect(originalItem).toBeVisible();
    await originalItem.click();
    await expect(originalItem).toHaveAttribute("data-selected", "true");
    await pressShortcut(page, modifier, "c");
    await expect(page.getByText("Copied 1 timeline action.")).toBeVisible();

    const header = page.locator(
      `[data-timeline-track-header="true"][data-track-id="${fixture.trackId}"]`,
    );
    await expect(header).toBeVisible();
    await header.getByText("Paste Undo Track").dblclick();
    const renameInput = header.getByRole("textbox", {
      name: "Rename track Paste Undo Track",
    });
    await expect(renameInput).toBeFocused();

    await page.evaluate(() => navigator.clipboard.writeText("Native Paste"));
    await renameInput.fill("Replace Me");
    await renameInput.evaluate((node) => {
      if (node instanceof HTMLInputElement) node.select();
    });
    await pressShortcut(page, modifier, "v");
    await expect(renameInput).toHaveValue("Native Paste");
    await expect(page.getByText("Pasted 1 timeline action.")).toHaveCount(0);
    await expect.poll(() => actionCount(page, fixture)).toBe(1);
    await expect(
      page.locator(
        `[data-timeline-action="true"][data-track-id="${fixture.trackId}"]`,
      ),
    ).toHaveCount(1);

    await renameInput.fill("Native Copy Source");
    await renameInput.evaluate((node) => {
      if (node instanceof HTMLInputElement) node.select();
    });
    await pressShortcut(page, modifier, "c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Native Copy Source");

    await renameInput.press("Escape");
  } finally {
    await cleanupTimelinePasteFixture(page, backendSlot.backendPort);
  }
});
