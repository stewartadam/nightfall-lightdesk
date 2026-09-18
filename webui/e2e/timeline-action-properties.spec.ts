// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type ActionPropertiesFixture = {
  timelineUid: string;
  timelineId: number;
  timecodeId: number;
  trackId: string;
  rateActionId: string;
  evalActionId: string;
};

/** Opens the action properties scenario against an empty backend showfile. */
async function openOwnedActionPropertiesApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.timelines?.get) &&
      Boolean((window as any).appStores?.timecodes?.get),
    undefined,
    { timeout: 20_000 },
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          timelines: Object.keys(stores.timelines.get()).length,
          timecodes: Object.keys(stores.timecodes.get()).length,
        };
      }),
    )
    .toEqual({ timelines: 0, timecodes: 0 });
}

/** Creates and opens a temporary timeline with editable action-kind variants. */
async function openActionPropertiesFixture(
  page: Page,
): Promise<ActionPropertiesFixture> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const api = stores?.dockApi?.get?.();
    if (!api || typeof stores?.sendAndAwait !== "function") {
      throw new Error("App stores were not ready");
    }

    /** Sends one setup command and rejects failed backend outcomes. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store action properties data: ${JSON.stringify(result)}`,
        );
      }
    };

    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const clipUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(960_000 + Math.random() * 20_000);
    const timelineId = idBase;
    const timecodeId = idBase + 1;
    const trackId = `e2e-properties-track-${Date.now()}`;
    const rateActionId = `e2e-rate-item-${Date.now()}`;
    const evalActionId = `e2e-eval-item-${Date.now()}`;

    await store({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: {
            id: timecodeId,
            uid: timecodeUid,
            label: "E2E Action Properties Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });

    await store({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: {
            id: timelineId,
            uid: timelineUid,
            label: "E2E Action Properties Timeline",
          },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          tracks: [
            {
              id: trackId,
              label: "Action Properties",
              muted: false,
              solo: false,
              expanded: true,
              actions: [
                {
                  id: rateActionId,
                  label: "Rate Action",
                  position: { secs: 1, nanos: 0 },
                  duration: { secs: 1, nanos: 0 },
                  action: {
                    type: "SetClipRate",
                    data: { uid: clipUid, rate: 1.25 },
                  },
                },
                {
                  id: evalActionId,
                  label: "Eval Action",
                  position: { secs: 2, nanos: 0 },
                  duration: { secs: 1, nanos: 0 },
                  action: { type: "DeskEval", data: "group 1 at 10" },
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
      throw new Error("Created timeline did not reach the frontend store");
    }

    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }

    api.addPanel({
      id: `e2e-action-properties-${timelineUid}`,
      component: "Timeline",
      title: "Action Properties",
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });

    return {
      timelineUid,
      timelineId,
      timecodeId,
      trackId,
      rateActionId,
      evalActionId,
    };
  });
}

/** Deletes the temporary timeline and timecode created for this spec. */
async function cleanupActionPropertiesFixture(
  page: Page,
  fixture: ActionPropertiesFixture,
): Promise<void> {
  await page.evaluate(async ({ timelineId, timecodeId }) => {
    const stores = (window as any).appStores;
    const timelineResult = await stores.sendAndAwait({
      module: "TimelineCommand",
      command: { type: "DeleteTimeline", data: timelineId },
    });
    if (timelineResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to delete owned timeline: ${JSON.stringify(timelineResult)}`,
      );
    }
    const timecodeResult = await stores.sendAndAwait({
      module: "TimecodeCommand",
      command: { type: "DeleteTimecode", data: timecodeId },
    });
    if (timecodeResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to delete owned timecode: ${JSON.stringify(timecodeResult)}`,
      );
    }
  }, fixture);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          timelines: Object.keys(stores.timelines.get()).length,
          timecodes: Object.keys(stores.timecodes.get()).length,
        };
      }),
    )
    .toEqual({ timelines: 0, timecodes: 0 });
}

/** Reads one timeline action kind from the browser store. */
async function actionKind(
  page: Page,
  fixture: ActionPropertiesFixture,
  actionId: string,
) {
  return page.evaluate(
    ({ timelineUid, trackId, actionId }) => {
      const timeline = (window as any).appStores.timelines.get()[timelineUid];
      const track = timeline?.tracks.find((entry: any) => entry.id === trackId);
      return track?.actions.find((entry: any) => entry.id === actionId)?.action;
    },
    { ...fixture, actionId },
  );
}

/** Verifies selected timeline actions expose editable action properties. */
test("timeline action properties edit rate and eval actions", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openOwnedActionPropertiesApp(page, backendSlot.backendPort);

  let fixture: ActionPropertiesFixture | undefined;
  try {
    fixture = await openActionPropertiesFixture(page);
    const surface = page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]:visible`,
    );
    await expect(surface).toBeVisible();
    await surface.getByLabel("Timeline zoom").fill("250");

    const rateAction = page.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.trackId}"][data-action-id="${fixture.rateActionId}"]`,
    );
    await expect(rateAction).toBeVisible();
    await rateAction.click();
    await page.getByRole("tab", { name: "Properties", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: "Action", level: 3 }),
    ).toBeVisible();
    const rateInput = page.getByLabel("Action clip rate");
    await expect(rateInput).toHaveValue("1.25");
    await expect(rateInput).toHaveCSS("height", "28px");
    await rateInput.fill("1.75");
    await rateInput.blur();
    await expect
      .poll(() =>
        actionKind(
          page,
          fixture as ActionPropertiesFixture,
          fixture!.rateActionId,
        ),
      )
      .toMatchObject({
        type: "SetClipRate",
        data: { rate: 1.75 },
      });

    const evalAction = page.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.trackId}"][data-action-id="${fixture.evalActionId}"]`,
    );
    await expect(evalAction).toBeVisible();
    await evalAction.click();

    const evalInput = page.getByLabel("Action eval string");
    await expect(evalInput).toHaveValue("group 1 at 10");
    await evalInput.fill("clip 1 go");
    await evalInput.blur();
    await expect
      .poll(() =>
        actionKind(
          page,
          fixture as ActionPropertiesFixture,
          fixture!.evalActionId,
        ),
      )
      .toMatchObject({
        type: "DeskEval",
        data: "clip 1 go",
      });
    await page.setViewportSize({ width: 900, height: 700 });
    const properties = page.locator(
      '[data-panel-id="panel-PropertiesInspector"]',
    );
    expect(
      await properties.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await properties.screenshot({
      path: testInfo.outputPath("timeline-action-properties.png"),
    });
  } finally {
    if (fixture) {
      await cleanupActionPropertiesFixture(page, fixture);
    }
  }
});
