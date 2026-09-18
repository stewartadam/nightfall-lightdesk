// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type TargetChangeContext = {
  clipId: number;
  clipUid: string;
  fxLabel: string;
  fxUid: string;
};

/** Opens the clip target-change scenario against a blank backend. */
async function openOwnedClipTargetChangeApp(
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
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fx?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fx: Object.keys(stores.fx.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, clips: 0, fx: 0, sequences: 0 });
}

/** Stores the sequence clip and FX used by the target-change scenario. */
async function storeOwnedClipTargetChangeData(
  page: Page,
): Promise<TargetChangeContext> {
  const context = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const clipId = Math.floor(900_000 + Math.random() * 40_000);
    const fxId = clipId + 1;
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const clipUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const fxUid = crypto.randomUUID().replaceAll("-", "");
    const fxName = "Clip Target Change FX";
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
          `failed to store clip target-change data: ${JSON.stringify(result)}`,
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
            id: clipId,
            label: "Clip Target Change Cue",
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
            id: clipId,
            label: "Clip Target Change Sequence",
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
            label: "Clip Target Change E2E",
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
    await store({
      module: "FxCommand",
      command: {
        type: "StoreFx",
        data: {
          identifiers: {
            uid: fxUid,
            id: fxId,
            label: fxName,
          },
          selection: {
            source: { type: "Resolved", data: [] },
            clauses: [],
          },
          attributes: {},
        },
      },
    });

    return {
      clipId,
      clipUid,
      fxLabel: `${fxId}: ${fxName}`,
      fxUid,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(({ clipUid, fxUid }) => {
        const stores = (window as any).appStores;
        const clipEntry = stores.clips.get()[clipUid];
        return {
          clipInactive: clipEntry?.[1] === false,
          fxStored: Boolean(stores.fx.get()[fxUid]),
        };
      }, context),
    )
    .toEqual({ clipInactive: true, fxStored: true });

  return context;
}

/** Reads whether the owned clip is active. */
async function clipActiveState(page: Page, clipUid: string): Promise<boolean> {
  return page.evaluate(
    (uid) => (window as any).appStores.clips.get()[uid]?.[1] ?? false,
    clipUid,
  );
}

/** Reads the owned clip source as a stable type and UID key. */
async function clipSourceKey(page: Page, clipUid: string): Promise<string> {
  return page.evaluate((uid) => {
    const source = (window as any).appStores.clips.get()[uid]?.[0].source;
    return source ? `${source.type}:${source.data}` : "none";
  }, clipUid);
}

/** Counts active instances still bound to the owned clip. */
async function boundPlaybackCount(page: Page, clipId: number): Promise<number> {
  return page.evaluate((id) => {
    const instances = Object.values(
      (window as any).appStores.activeInstances.get(),
    ) as Array<{ bound_clip_id?: number }>;
    return instances.filter((playback) => playback.bound_clip_id === id).length;
  }, clipId);
}

/** Verifies an active clip can stop after its source changes to an FX. */
test("running clip can stop after changing its target", async ({
  backendSlot,
  page,
}) => {
  await openOwnedClipTargetChangeApp(page, backendSlot.backendPort);
  const context = await storeOwnedClipTargetChangeData(page);
  await page.evaluate(() => {
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-ClipList")
      ?.api.setActive();
  });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    if (!api.getPanel("panel-ClipList-e2e")) {
      api.addPanel({
        id: "panel-ClipList-e2e",
        component: "ClipList",
        title: "Clips",
        params: { initialPanelId: "panel-ClipList-e2e" },
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
  });

  const clipPanel = page.locator('[data-panel-kind="clips"]:visible');
  const inspectButton = clipPanel.getByRole("button", {
    name: `Inspect clip ${context.clipId}`,
    exact: true,
  });
  const clipCard = inspectButton
    .locator("xpath=ancestor::*[@data-crud-select-id][1]")
    .first();

  await expect(clipCard).toBeVisible();
  await clipCard.hover();
  await expect(inspectButton).toBeVisible();
  await inspectButton.click();
  await expect(
    page.getByRole("heading", {
      name: `Clip ${context.clipId}`,
      exact: true,
    }),
  ).toBeVisible();

  await clipCard.click();
  await expect
    .poll(() => clipActiveState(page, context.clipUid), {
      timeout: 10_000,
    })
    .toBe(true);

  await page.getByRole("button", { name: "FX", exact: true }).click();
  await page
    .getByRole("button", { name: context.fxLabel, exact: true })
    .click();

  await expect
    .poll(() => clipSourceKey(page, context.clipUid), {
      timeout: 10_000,
    })
    .toBe(`Fx:${context.fxUid}`);

  await clipCard.click();

  await expect
    .poll(() => clipActiveState(page, context.clipUid), {
      timeout: 10_000,
    })
    .toBe(false);

  await expect
    .poll(() => boundPlaybackCount(page, context.clipId), {
      timeout: 10_000,
    })
    .toBe(0);
});
