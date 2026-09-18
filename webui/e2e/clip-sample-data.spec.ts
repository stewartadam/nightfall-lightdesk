// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ experimentalFlows: true });

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const CLIP_VIEW_MODE_KEY = "nightfall-crud-panel-view-mode:clips-list";
const CLIPS_PANEL_TITLE = "Clips";

/** Replaces the backend and proves clip playback definitions are blank. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedClipStoreCounts(page))
    .toEqual({
      clips: 0,
      flows: 0,
      instances: 0,
      stepFx: 0,
    });
});

/** Reads the backend-owned stores exercised by this clip scenario. */
async function ownedClipStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      clips: Object.keys(stores.clips.get()).length,
      flows: Object.keys(stores.flows.get()).length,
      instances: Object.keys(stores.activeInstances.get()).length,
      stepFx: Object.keys(stores.stepFx.get()).length,
    };
  });
}

/** Opens the clip scenario against a fresh blank backend showfile. */
async function openOwnedClipApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(
    ([storageKey, storageValue]) => {
      window.localStorage.clear();
      window.localStorage.setItem("nightfall.currentShowfileName", "default");
      window.localStorage.setItem(storageKey, storageValue);
    },
    [CLIP_VIEW_MODE_KEY, "grid"],
  );
  await page.setViewportSize({ width: 2200, height: 1400 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.flows?.get) &&
      Boolean((window as any).appStores?.stepFx?.get),
  );
  await expect
    .poll(() => ownedClipStoreCounts(page))
    .toEqual({
      clips: 0,
      flows: 0,
      instances: 0,
      stepFx: 0,
    });
}

/** Stores the exact Flow, Step FX, and clip cards asserted by the test. */
async function storeOwnedClipData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sources = [
      {
        clipId: 24,
        clipLabel: "Flow: Metronome Alternator",
        sourceId: 924,
        sourceLabel: "Metronome Alternator",
        sourceType: "Flow",
      },
      {
        clipId: 25,
        clipLabel: "Flow: Modulated Chase",
        sourceId: 925,
        sourceLabel: "Modulated Chase",
        sourceType: "Flow",
      },
      {
        clipId: 26,
        clipLabel: "Rainbow Cycle",
        sourceId: 926,
        sourceLabel: "Rainbow Cycle",
        sourceType: "StepFx",
      },
      {
        clipId: 27,
        clipLabel: "Circle Motion",
        sourceId: 927,
        sourceLabel: "Circle Motion",
        sourceType: "StepFx",
      },
      {
        clipId: 28,
        clipLabel: "White Bounce",
        sourceId: 928,
        sourceLabel: "White Bounce",
        sourceType: "StepFx",
      },
    ];

    /** Sends one setup command and rejects a failed terminal outcome. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store clip sample data: ${JSON.stringify(result)}`,
        );
      }
    };

    for (const source of sources) {
      const sourceUid = crypto.randomUUID().replaceAll("-", "");
      if (source.sourceType === "Flow") {
        await store({
          module: "FlowCommand",
          command: {
            type: "StoreFlow",
            data: {
              identifiers: {
                uid: sourceUid,
                id: source.sourceId,
                label: source.sourceLabel,
              },
              flow_version: 0,
              nodes: [],
              edges: [],
            },
          },
        });
      } else {
        await store({
          module: "StepFxCommand",
          command: {
            type: "Store",
            data: {
              identifiers: {
                uid: sourceUid,
                id: source.sourceId,
                label: source.sourceLabel,
              },
              selection: {
                source: { type: "Resolved", data: [] },
                clauses: [],
              },
              timing: { beat_duration: { secs: 1, nanos: 0 } },
              phase: { waypoints: [0, 1] },
              direction: "Forward",
              cycle_scale: { type: "Auto" },
              lanes: [
                {
                  attribute: { type: "Intensity" },
                  absolute: {
                    steps: [1, 0].map((value) => ({
                      uid: crypto.randomUUID(),
                      target: { type: "AbsolutePercent", data: { value } },
                      width_beats: 1,
                      transition: { start: 0, end: 1 },
                      curve: { type: "Snap", data: {} },
                    })),
                  },
                },
              ],
            },
          },
        });
      }
      await store({
        module: "ClipCommand",
        command: {
          type: "StoreClip",
          data: {
            identifiers: {
              uid: crypto.randomUUID().replaceAll("-", ""),
              id: source.clipId,
              label: source.clipLabel,
            },
            source: { type: source.sourceType, data: sourceUid },
            priority: 0,
            options: {
              auto_release: false,
              deactivate_on_sequence_end: false,
            },
          },
        },
      });
    }
  });

  await expect
    .poll(() => ownedClipStoreCounts(page))
    .toEqual({
      clips: 5,
      flows: 2,
      instances: 0,
      stepFx: 3,
    });
}

/**
 * Opens a panel used by clip sample data tests.
 */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Opens the Clips panel and activates its dock tab before card assertions.
 */
async function activateClipsPanel(page: Page): Promise<void> {
  await openPanel(page, CLIPS_PANEL_TITLE);

  const clipsTab = page
    .locator(".dv-tab")
    .filter({ hasText: CLIPS_PANEL_TITLE })
    .first();
  await expect(clipsTab).toBeVisible();
  await clipsTab.click();
}

test("owned StepFx and Flow clips are visible and StepFx clips start instances", async ({
  backendSlot,
  page,
}) => {
  await openOwnedClipApp(page, backendSlot.backendPort);
  await storeOwnedClipData(page);

  await activateClipsPanel(page);

  await expect(
    page.getByRole("button", { name: /24: Flow: Metronome Alternator/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /25: Flow: Modulated Chase/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /26: Rainbow Cycle/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /27: Circle Motion/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /28: White Bounce/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /26: Rainbow Cycle/ }).click();
  await openPanel(page, "Status Display");

  const playbackRow = page.getByRole("row", {
    name: /Step FX Rainbow Cycle/,
  });
  await expect(playbackRow).toBeVisible();
  await expect(playbackRow.getByText("Step FX")).toBeVisible();

  await page.evaluate(async () => {
    await (window as any).appStores.send({
      module: "ClipCommand",
      command: {
        type: "StopClip",
        data: { type: "Single", data: 26 },
      },
    });
  });
  await expect
    .poll(() => ownedClipStoreCounts(page))
    .toMatchObject({ instances: 0 });
});
