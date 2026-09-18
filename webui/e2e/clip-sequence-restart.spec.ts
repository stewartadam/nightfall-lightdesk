// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type SequenceClipContext = {
  id: number;
  uid: string;
};

/** Opens the clip scenarios against a blank backend showfile. */
async function openOwnedSequenceClipApp(
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
      Boolean((window as any).appStores?.clips?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, clips: 0, sequences: 0 });
}

/** Stores the cue, sequence, and clip used by restart scenarios. */
async function storeOwnedSequenceClip(
  page: Page,
): Promise<SequenceClipContext> {
  const context = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const objectId = Math.floor(900_000 + Math.random() * 50_000);
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
          `failed to store owned clip data: ${JSON.stringify(result)}`,
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
            id: objectId,
            label: "Clip Restart Cue",
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
            id: objectId,
            label: "Clip Restart Sequence",
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
            id: objectId,
            label: "Clip Restart E2E",
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

    return { id: objectId, uid: clipUid };
  });

  await expect
    .poll(() =>
      page.evaluate(({ id, uid }) => {
        const entry = (window as any).appStores.clips.get()[uid];
        return entry?.[0]?.identifiers.id === id && entry[1] === false;
      }, context),
    )
    .toBe(true);

  return context;
}

/**
 * Reads the active flag for a clip from the browser clip store.
 */
async function clipActiveState(page: Page, clipId: number) {
  return page.evaluate((id) => {
    const entries = Object.values(
      (window as any).appStores.clips.get(),
    ) as Array<[{ identifiers: { id: number } }, boolean]>;
    return entries.find(([clip]) => clip.identifiers.id === id)?.[1];
  }, clipId);
}

/**
 * Verifies clicking a clip card toggles the clip through the backend.
 */
test("clicking a sequence clip card toggles playback", async ({
  backendSlot,
  page,
}) => {
  await openOwnedSequenceClipApp(page, backendSlot.backendPort);
  const clip = await storeOwnedSequenceClip(page);
  await page.evaluate(() => {
    (window as any).appStores.dockApi
      .get()
      .getPanel("panel-ClipList")
      ?.api.setActive();
  });

  const card = page.locator(`[data-crud-select-id="${clip.uid}"]`);
  await expect(card).toBeVisible();

  await card.click({ position: { x: 12, y: 12 } });
  await expect
    .poll(() => clipActiveState(page, clip.id), { timeout: 10_000 })
    .toBe(true);

  await card.click({ position: { x: 12, y: 12 } });
  await expect
    .poll(() => clipActiveState(page, clip.id), { timeout: 10_000 })
    .toBe(false);
});

/**
 * Verifies a sequence-backed clip can be repeatedly started and stopped without crashing the backend.
 */
test("sequence clip survives repeated start stop cycles", async ({
  backendSlot,
  page,
}) => {
  await openOwnedSequenceClipApp(page, backendSlot.backendPort);
  const clip = await storeOwnedSequenceClip(page);

  for (let index = 0; index < 8; index += 1) {
    await page.evaluate(async (id) => {
      await (window as any).appStores.send({
        module: "ClipCommand",
        command: {
          type: "StartClip",
          data: { type: "Single", data: id },
        },
      });
    }, clip.id);

    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const entries = Object.values(
              (window as any).appStores.clips.get(),
            ) as Array<[{ identifiers: { id: number } }, boolean]>;
            return entries.find(([clip]) => clip.identifiers.id === id)?.[1];
          }, clip.id),
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.evaluate(async (id) => {
      await (window as any).appStores.send({
        module: "ClipCommand",
        command: {
          type: "StopClip",
          data: { type: "Single", data: id },
        },
      });
    }, clip.id);

    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const entries = Object.values(
              (window as any).appStores.clips.get(),
            ) as Array<[{ identifiers: { id: number } }, boolean]>;
            return entries.find(([clip]) => clip.identifiers.id === id)?.[1];
          }, clip.id),
        { timeout: 10_000 },
      )
      .toBe(false);
  }
});
