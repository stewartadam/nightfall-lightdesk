// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import {
  prepareStoreSeededTestApp,
  waitForDockviewApp,
} from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

type OwnedStatusInstanceScenario = {
  cueId: number;
  clipId: number;
  sequenceId: number;
};

test.setTimeout(60_000);

/** Opens the Status Display scenarios against a fresh blank backend showfile. */
async function openFreshStatusDisplayApp(
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
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          instances: Object.keys(stores.activeInstances.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({
      cues: 0,
      clips: 0,
      fixtures: 0,
      instances: 0,
      sequences: 0,
    });
}

/** Opens a disconnected fresh app with empty stores for synthetic rows. */
async function openStoreSeededStatusDisplayApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await openFreshStatusDisplayApp(page, backendPort);
  await prepareStoreSeededTestApp(page);
}

/** Stores the cue, sequence, and clip that drive one live status row. */
async function storeOwnedStatusInstance(
  page: Page,
): Promise<OwnedStatusInstanceScenario> {
  const scenario = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const baseId = Math.floor(900_000 + Math.random() * 30_000);
    const cueId = baseId;
    const sequenceId = baseId + 1;
    const clipId = baseId + 2;
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const clipUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const fixedZero = {
      type: "Fixed",
      data: { secs: 0, nanos: 0 },
    };

    /** Builds an empty sequence metadata cue. */
    const metaCue = (uid: string, label: string): object => ({
      identifiers: { uid, id: 0, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      references: {},
      tracking_flags: "HTP",
    });

    /** Sends one store command and rejects failed backend outcomes. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store status display data: ${JSON.stringify(result)}`,
        );
      }
    };

    await store({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          identifiers: {
            uid: cueUid,
            id: cueId,
            label: "Owned Status Cue",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: [],
          tracking_flags: "HTP",
        },
      },
    });
    await store({
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: {
          identifiers: {
            uid: sequenceUid,
            id: sequenceId,
            label: "Owned Status Instance",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Setup"),
          release_cue: metaCue(releaseCueUid, "Release"),
          default_timing: {
            delay_in: fixedZero,
            fade_in: fixedZero,
            curve_in: "Linear",
            delay_out: fixedZero,
            fade_out: fixedZero,
            curve_out: "Linear",
          },
          tracking_mode: { type: "Flags", data: "HTP" },
        },
      },
    });
    await store({
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: {
          identifiers: {
            uid: clipUid,
            id: clipId,
            label: "Owned Status Clip",
          },
          source: { type: "Sequence", data: sequenceUid },
          priority: 0,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
      },
    });

    return { cueId, clipId, sequenceId };
  });

  await expect
    .poll(() =>
      page.evaluate(({ cueId, clipId, sequenceId }) => {
        const stores = (window as any).appStores;
        /** Reports whether a definition collection contains a numeric ID. */
        const hasId = (
          entries: Array<{ identifiers: { id: number } }>,
          id: number,
        ) => entries.some((entry) => entry.identifiers.id === id);
        return {
          cue: hasId(Object.values(stores.cues.get()), cueId),
          clip: hasId(
            Object.values(stores.clips.get()).map((entry: any) => entry[0]),
            clipId,
          ),
          sequence: hasId(Object.values(stores.sequences.get()), sequenceId),
        };
      }, scenario),
    )
    .toEqual({ cue: true, clip: true, sequence: true });

  return scenario;
}

/** Stops and deletes every backend object owned by the live-row scenario. */
async function cleanupOwnedStatusInstance(
  page: Page,
  scenario: OwnedStatusInstanceScenario,
): Promise<void> {
  await page.evaluate(async (clipId) => {
    const stores = (window as any).appStores;
    const clip = Object.values(stores.clips.get()).find(
      (entry: any) => entry[0].identifiers.id === clipId,
    ) as [{ identifiers: { id: number } }, boolean] | undefined;
    const hasBoundInstance = Object.values(stores.activeInstances.get()).some(
      (instance: any) => instance.bound_clip_id === clipId,
    );
    if (clip?.[1] !== true && !hasBoundInstance) return;

    await stores.send({
      module: "ClipCommand",
      command: {
        type: "StopClip",
        data: { type: "Single", data: clipId },
      },
    });
  }, scenario.clipId);
  await expect
    .poll(() =>
      page.evaluate((clipId) => {
        const stores = (window as any).appStores;
        const clip = Object.values(stores.clips.get()).find(
          (entry: any) => entry[0].identifiers.id === clipId,
        ) as [{ identifiers: { id: number } }, boolean] | undefined;
        return {
          active: clip?.[1] ?? null,
          instances: Object.keys(stores.activeInstances.get()).length,
        };
      }, scenario.clipId),
    )
    .toEqual({ active: false, instances: 0 });

  await page.evaluate(async ({ cueId, clipId, sequenceId }) => {
    const stores = (window as any).appStores;

    /** Sends one delete command and rejects failed backend outcomes. */
    const remove = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to delete status display data: ${JSON.stringify(result)}`,
        );
      }
    };

    await remove({
      module: "ClipCommand",
      command: { type: "DeleteClip", data: clipId },
    });
    await remove({
      module: "CueCommand",
      command: {
        type: "DeleteCue",
        data: { sequence_id: sequenceId, cue_id: cueId },
      },
    });
    await remove({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: sequenceId },
    });
  }, scenario);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          instances: Object.keys(stores.activeInstances.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({
      cues: 0,
      clips: 0,
      fixtures: 0,
      instances: 0,
      sequences: 0,
    });
}

/**
 * Opens a panel used by status display assertions.
 */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

for (const refreshDuringPress of [false, true]) {
  /** Verifies stopping owned playback, including a snapshot arriving during the press. */
  test(`status display opens from the palette and shows runtime rows${refreshDuringPress ? " across a snapshot during Stop" : ""}`, async ({
    backendSlot,
    page,
  }) => {
    await page.setViewportSize({ width: 1800, height: 1100 });
    await openFreshStatusDisplayApp(page, backendSlot.backendPort);
    const scenario = await storeOwnedStatusInstance(page);

    try {
      await openPanel(page, "Status Display");
      await expect(
        page.getByRole("region", { name: "Status display content" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Active Instances" }),
      ).toBeVisible();

      await openPanel(page, "Clips");
      await page.getByRole("button", { name: /Owned Status Clip/ }).click();
      await openPanel(page, "Status Display");

      const instanceRow = page.getByRole("row", {
        name: /Owned Status Instance/,
      });
      await expect(instanceRow).toBeVisible();
      const instanceCells = instanceRow.getByRole("cell");
      await expect(instanceCells.nth(2)).toHaveText("Running");
      await expect(instanceCells.nth(3)).toHaveText("Owned Status Clip");
      await expect(instanceCells.nth(6)).toHaveText("1/1 Owned Status Cue");
      await expect(instanceCells.nth(7)).toHaveText("100%");
      await expect(instanceCells.nth(8)).toHaveText("1.00x");
      await page.screenshot({
        path: test.info().outputPath("status-before-stop.png"),
        fullPage: true,
      });
      const stopButton = instanceRow.getByRole("button", {
        name: "Stop instance",
      });
      await expect(stopButton).toBeVisible();
      if (refreshDuringPress) {
        await stopButton.hover();
        await page.mouse.down();
        // Deliver a replacement snapshot while the operator holds Stop down.
        await page.evaluate(() => {
          const store = (window as any).appStores.activeInstances;
          store.set(structuredClone(store.get()));
        });
        await page.mouse.up();
      } else {
        await stopButton.click();
      }
      await expect
        .poll(() =>
          page.evaluate((clipId) => {
            const stores = (window as any).appStores;
            const clip = Object.values(stores.clips.get()).find(
              (entry: any) => entry[0].identifiers.id === clipId,
            ) as [unknown, boolean] | undefined;
            return {
              instances: Object.keys(stores.activeInstances.get()).length,
              clipActive: clip?.[1],
            };
          }, scenario.clipId),
        )
        .toEqual({ instances: 0, clipActive: false });
      await expect(instanceRow).toHaveCount(0);
      await expect(
        page.getByText("No active instances", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("status-after-stop.png"),
        fullPage: true,
      });
    } finally {
      await cleanupOwnedStatusInstance(page, scenario);
    }
  });
}

/** Verifies native timecode tables preserve selection and react to live snapshots without offering cell editors. */
test("shared timecode tables preserve selection across snapshot updates", async ({
  backendSlot,
  page,
}) => {
  await openStoreSeededStatusDisplayApp(page, backendSlot.backendPort);
  await page.evaluate(() => {
    (window as any).appStores.timecodes.set({
      "table-timecode": [
        {
          identifiers: { id: 81, uid: "table-timecode", label: "Table clock" },
          rate: "Fps30",
          source: "Internal",
        },
        { is_active: false, current_time: { secs: 0, nanos: 0 } },
      ],
    });
  });
  await openPanel(page, "Timecodes");
  const table = page.getByRole("table", { name: "Timecodes", exact: true });
  await expect(table).toHaveClass(/nf-table/);
  const row = table.getByRole("row", { name: /81/ });
  await row.click();
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.evaluate(() => {
    const store = (window as any).appStores.timecodes;
    const [timecode] = store.get()["table-timecode"];
    store.set({
      "table-timecode": [
        timecode,
        { is_active: true, current_time: { secs: 2, nanos: 0 } },
      ],
    });
  });
  await expect(row).toContainText("00:00:02:00");
  await expect(row).toContainText("Running");
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(
    table.locator("input, textarea, [contenteditable=true]"),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("shared-timecodes.png"),
    fullPage: true,
  });
  await openPanel(page, "Status Display");
  const controls = page.getByRole("table", {
    name: "Timecode controls",
    exact: true,
  });
  await expect(
    controls.getByRole("row", { name: /Table clock/ }),
  ).toContainText("00:00:02:00");
  await expect(
    controls.getByRole("button", { name: "Pause timecode" }),
  ).toBeVisible();
});

/** Verifies explicitly seeded owners and cue-part counts render correctly. */
test("status display shows byte-array owners and sequence cue part counts", async ({
  backendSlot,
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStoreSeededStatusDisplayApp(page, backendSlot.backendPort);

  await openPanel(page, "Status Display");
  await expect(
    page.getByRole("region", { name: "Status display content" }),
  ).toBeVisible();

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const instanceId = "11111111111141118111111111111111";
          (window as any).appStores.activeInstances.set({
            [instanceId]: {
              instance_id: instanceId,
              kind: "Sequence",
              display_kind: "Sequence",
              name: "Parted Sequence",
              tags: [],
              is_preview: false,
              is_releasing: false,
              is_paused: true,
              owner_uids: [new Uint8Array(16).fill(0xaa)],
              priority: 42,
              activation_epoch_ms: 2000,
              transition_elapsed: { secs: 0, nanos: 500_000_000 },
              bound_clip_id: 1,
              intensity_scale: 1,
              rate: 1,
              rate_master_scale: 1,
              effective_rate: 1,
              status: {
                position: {
                  type: "Sequence",
                  data: {
                    current_position: 1,
                    cue_count: 5,
                    current_label: "Build",
                    current_part_count: 2,
                    next_position: 2,
                    next_label: "Look",
                    next_part_count: 1,
                    retained_cues: [],
                  },
                },
              },
            },
          });
          const text = document.body.textContent ?? "";
          return (
            text.includes("Parted Sequence") &&
            text.includes("Paused") &&
            text.includes("aaaaaaaa") &&
            text.includes("42") &&
            text.includes("1/5 Build (2 parts)") &&
            text.includes("Next 2 Look (1 part)")
          );
        }),
      { timeout: 8_000 },
    )
    .toBe(true);
});

/** Verifies instance rate masters affect the visible value and rate sort order. */
test("status display renders and sorts effective instance rates", async ({
  backendSlot,
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openStoreSeededStatusDisplayApp(page, backendSlot.backendPort);

  await openPanel(page, "Status Display");
  await expect(
    page.getByRole("region", { name: "Status display content" }),
  ).toBeVisible();

  await page.evaluate(() => {
    /** Builds one minimal instance snapshot with a distinct effective rate. */
    const instance = (
      instanceId: string,
      name: string,
      rate: number,
      rateMasterScale: number,
    ) => ({
      instance_id: instanceId,
      kind: "Fx",
      display_kind: "Fx",
      name,
      tags: [],
      is_preview: false,
      is_releasing: false,
      is_paused: false,
      owner_uids: [],
      intensity_scale: 1,
      rate,
      rate_master_scale: rateMasterScale,
      effective_rate: rate * rateMasterScale,
      status: { position: { type: "None" } },
    });
    const authoredRateId = "11111111111141118111111111111111";
    const masteredRateId = "22222222222242228222222222222222";
    (window as any).appStores.activeInstances.set({
      [authoredRateId]: instance(authoredRateId, "Authored Fast", 1.5, 1),
      [masteredRateId]: instance(masteredRateId, "Master Slowed", 1, 0.5),
    });
  });

  const activeInstanceTable = page
    .getByRole("region", { name: "Status display content" })
    .locator("table")
    .first();
  const masteredRow = activeInstanceTable.getByRole("row", {
    name: /Master Slowed/,
  });
  await activeInstanceTable.evaluate((table) => {
    const scroller = table.parentElement;
    if (!scroller) throw new Error("Expected instance table scroll container");
    scroller.scrollLeft = scroller.scrollWidth;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await activeInstanceTable.getByRole("button", { name: "Rate" }).click();
  await expect(masteredRow.getByText("0.50x", { exact: true })).toBeVisible();
  await expect(
    masteredRow.getByText("1.00x", { exact: true }),
  ).not.toBeVisible();

  const instanceRows = activeInstanceTable.locator("tbody tr");
  await expect(instanceRows.first()).toContainText("Master Slowed");
  await expect(instanceRows.nth(1)).toContainText("Authored Fast");

  const originalRow = await masteredRow.elementHandle();
  if (!originalRow) throw new Error("Expected the mastered instance row");
  await page.evaluate(() => {
    const store = (window as any).appStores.activeInstances;
    const instanceId = "22222222222242228222222222222222";
    const snapshot = structuredClone(store.get());
    snapshot[instanceId].rate_master_scale = 2;
    snapshot[instanceId].effective_rate = 2;
    store.set(snapshot);
  });
  await expect(masteredRow.getByText("2.00x", { exact: true })).toBeVisible();
  await expect(instanceRows.first()).toContainText("Authored Fast");
  await expect(instanceRows.nth(1)).toContainText("Master Slowed");
  expect(await originalRow.evaluate((row) => row.isConnected)).toBe(true);
});

/** Ensures constrained panel heights scroll instead of letting sections overlap. */
test("status display scrolls without overlapping sections at constrained heights", async ({
  backendSlot,
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 340 });
  await openStoreSeededStatusDisplayApp(page, backendSlot.backendPort);

  await openPanel(page, "Status Display");
  await expect(
    page.getByRole("region", { name: "Status display content" }),
  ).toBeVisible();

  const scrollRegion = page.getByRole("region", {
    name: "Status display content",
  });
  await expect(scrollRegion).toBeVisible();
  await expect
    .poll(() =>
      scrollRegion.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);

  const activeInstanceTable = scrollRegion.locator("table").first();
  const timecodesHeading = scrollRegion.getByRole("heading", {
    name: "Timecodes",
  });
  const [activeTableBox, timecodesHeadingBox] = await Promise.all([
    activeInstanceTable.boundingBox(),
    timecodesHeading.boundingBox(),
  ]);
  if (!activeTableBox || !timecodesHeadingBox) {
    throw new Error("Status display sections were not rendered");
  }

  expect(timecodesHeadingBox.y).toBeGreaterThanOrEqual(
    activeTableBox.y + activeTableBox.height,
  );
});
