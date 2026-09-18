// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

interface DuplicateSequenceSeed {
  sourceCueId: number;
  sourceCueLabel: string;
  sourceCueUid: string;
  sourcePartUid: string;
  sourceReleaseUid: string;
  sourceSequenceId: number;
  sourceSequenceLabel: string;
  sourceSequenceUid: string;
  sourceSetupUid: string;
}

interface DuplicateSequenceState {
  copiedCueId: number;
  copiedCueUid: string;
  copiedPartUid: string;
  duplicateReleaseUid: string;
  duplicateSequenceId: number;
  duplicateSequenceUid: string;
  duplicateSetupUid: string;
}

/** Opens the sequence duplicate scenario against a blank backend showfile. */
async function openOwnedSequenceDuplicateApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        cues: Object.keys((window as any).appStores.cues.get()).length,
        sequences: Object.keys((window as any).appStores.sequences.get())
          .length,
      })),
    )
    .toEqual({ cues: 0, sequences: 0 });
}

/** Stores the complete cue and sequence used by the duplicate action. */
async function storeOwnedDuplicateSequence(
  page: Page,
): Promise<DuplicateSequenceSeed> {
  const seed = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sourceSequenceId = Math.floor(900_000 + Math.random() * 50_000);
    const sourceCueId = Math.floor(100 + Math.random() * 800);
    const sourceSequenceUid = crypto.randomUUID().replaceAll("-", "");
    const sourceCueUid = crypto.randomUUID().replaceAll("-", "");
    const sourcePartUid = crypto.randomUUID().replaceAll("-", "");
    const sourceSetupUid = crypto.randomUUID().replaceAll("-", "");
    const sourceReleaseUid = crypto.randomUUID().replaceAll("-", "");
    const sourceSequenceLabel = `Owned Duplicate Sequence ${sourceSequenceId}`;
    const sourceCueLabel = `Owned Duplicate Cue ${sourceSequenceId}`;
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
          `failed to store owned duplicate data: ${JSON.stringify(result)}`,
        );
      }
    };

    await store({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          identifiers: {
            uid: sourceCueUid,
            id: sourceCueId,
            label: sourceCueLabel,
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: [
            {
              identifiers: {
                id: 1,
                uid: sourcePartUid,
                label: "Owned Duplicate Part",
              },
              transitions: {},
              transitions_by_attribute: {},
              instructions: [],
              tracking_flags: "HTP",
            },
          ],
          references: {},
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
            uid: sourceSequenceUid,
            id: sourceSequenceId,
            label: sourceSequenceLabel,
          },
          steps: [sourceCueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(sourceSetupUid, "Owned Duplicate Setup"),
          release_cue: metaCue(sourceReleaseUid, "Owned Duplicate Release"),
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

    return {
      sourceCueId,
      sourceCueLabel,
      sourceCueUid,
      sourcePartUid,
      sourceReleaseUid,
      sourceSequenceId,
      sourceSequenceLabel,
      sourceSequenceUid,
      sourceSetupUid,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(({ sourceCueUid, sourceSequenceUid }) => {
        const stores = (window as any).appStores;
        return {
          cue: stores.cues.get()[sourceCueUid]?.identifiers.uid,
          sequence: stores.sequences.get()[sourceSequenceUid]?.identifiers.uid,
        };
      }, seed),
    )
    .toEqual({
      cue: seed.sourceCueUid,
      sequence: seed.sourceSequenceUid,
    });

  return seed;
}

/** Opens an isolated Sequence List panel for the owned source sequence. */
async function openOwnedSequenceList(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-SequenceList-duplicate-e2e";
    api.getPanel("panel-SequenceList")?.api.close();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    if (!api.getPanel(panelId)) {
      api.addPanel({
        id: panelId,
        component: "SequenceList",
        title: "Sequences",
        params: { initialPanelId: panelId },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
    }
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
  });
}

/** Reads the duplicated sequence and its copied cue from browser stores. */
async function readDuplicateState(
  page: Page,
  seed: DuplicateSequenceSeed,
): Promise<(DuplicateSequenceState & { contentMatches: boolean }) | null> {
  return page.evaluate((seedContext) => {
    const stores = (window as any).appStores;
    const sequences = Object.values(stores.sequences.get()) as any[];
    const cues = stores.cues.get();
    const sourceSequence =
      stores.sequences.get()[seedContext.sourceSequenceUid];
    const sourceCue = cues[seedContext.sourceCueUid];
    const duplicate = sequences.find(
      (sequence) =>
        sequence.identifiers.label ===
        `${seedContext.sourceSequenceLabel} Copy`,
    );
    const copiedCueUid = duplicate?.steps?.[0];
    const copiedCue = copiedCueUid ? cues[copiedCueUid] : undefined;
    if (!sourceSequence || !sourceCue || !duplicate || !copiedCue) return null;

    const sourceContent = {
      defaultTiming: sourceSequence.default_timing,
      releaseOnStart: sourceSequence.release_on_start,
      trackingMode: sourceSequence.tracking_mode,
      wrap: sourceSequence.wrap,
    };
    const duplicateContent = {
      defaultTiming: duplicate.default_timing,
      releaseOnStart: duplicate.release_on_start,
      trackingMode: duplicate.tracking_mode,
      wrap: duplicate.wrap,
    };

    return {
      copiedCueId: copiedCue.identifiers.id,
      copiedCueUid,
      copiedPartUid: copiedCue.parts?.[0]?.identifiers.uid,
      duplicateReleaseUid: duplicate.release_cue.identifiers.uid,
      duplicateSequenceId: duplicate.identifiers.id,
      duplicateSequenceUid: duplicate.identifiers.uid,
      duplicateSetupUid: duplicate.setup_cue.identifiers.uid,
      contentMatches:
        copiedCue.identifiers.label === seedContext.sourceCueLabel &&
        copiedCue.parts?.[0]?.identifiers.label === "Owned Duplicate Part" &&
        copiedCue.tracking_flags === sourceCue.tracking_flags &&
        copiedCue.parts?.[0]?.tracking_flags ===
          sourceCue.parts?.[0]?.tracking_flags &&
        JSON.stringify(duplicateContent) === JSON.stringify(sourceContent),
    };
  }, seed);
}

/** Deletes the copied and source sequence records owned by this test. */
async function cleanupOwnedDuplicateData(
  page: Page,
  seed: DuplicateSequenceSeed,
  duplicate: DuplicateSequenceState,
): Promise<void> {
  await page.evaluate(
    async ({ duplicateState, seedContext }) => {
      const stores = (window as any).appStores;

      /** Sends one delete command and rejects failed backend outcomes. */
      const remove = async (message: object): Promise<void> => {
        const result = await stores.sendAndAwait(message);
        if (result.outcome.type !== "Succeeded") {
          throw new Error(
            `failed to delete owned duplicate data: ${JSON.stringify(result)}`,
          );
        }
      };

      for (const [sequenceId, cueId] of [
        [duplicateState.duplicateSequenceId, duplicateState.copiedCueId],
        [seedContext.sourceSequenceId, seedContext.sourceCueId],
      ]) {
        await remove({
          module: "CueCommand",
          command: {
            type: "DeleteCue",
            data: {
              sequence_id: sequenceId,
              cue_id: cueId,
            },
          },
        });
        await remove({
          module: "CueCommand",
          command: {
            type: "DeleteSequence",
            data: sequenceId,
          },
        });
      }
    },
    { duplicateState: duplicate, seedContext: seed },
  );

  await expect
    .poll(() =>
      page.evaluate(() => ({
        cues: Object.keys((window as any).appStores.cues.get()).length,
        sequences: Object.keys((window as any).appStores.sequences.get())
          .length,
      })),
    )
    .toEqual({ cues: 0, sequences: 0 });
}

/** Verifies Sequence List duplication creates independent owned records. */
test("sequence list duplicates a selected sequence", async ({
  backendSlot,
  page,
}) => {
  await openOwnedSequenceDuplicateApp(page, backendSlot.backendPort);
  const seed = await storeOwnedDuplicateSequence(page);
  await openOwnedSequenceList(page);

  const sequenceCard = page.locator(
    `[data-crud-select-id="${seed.sourceSequenceUid.toLowerCase()}"]`,
  );
  await expect(sequenceCard).toBeVisible();
  const sequencePanel = sequenceCard.locator(
    "xpath=ancestor::div[.//button[@aria-label='Duplicate selected sequence']][1]",
  );

  await sequencePanel
    .getByRole("button", { name: "Toggle selection mode" })
    .click();
  await sequenceCard.click();
  const duplicateButton = sequencePanel.getByRole("button", {
    name: "Duplicate selected sequence",
  });
  await expect(duplicateButton).toBeEnabled();
  await duplicateButton.click();

  await expect(
    sequencePanel
      .locator("button[data-crud-select-id]")
      .filter({ hasText: `${seed.sourceSequenceLabel} Copy` }),
  ).toBeVisible();
  await expect
    .poll(() => readDuplicateState(page, seed), { timeout: 15_000 })
    .toMatchObject({ contentMatches: true });

  const duplicate = await readDuplicateState(page, seed);
  expect(duplicate).not.toBeNull();
  if (!duplicate) {
    throw new Error("duplicated sequence disappeared before assertions");
  }
  expect(duplicate.duplicateSequenceId).not.toBe(seed.sourceSequenceId);
  expect(duplicate.duplicateSequenceUid).not.toBe(seed.sourceSequenceUid);
  expect(duplicate.copiedCueId).toBe(seed.sourceCueId);
  expect(duplicate.copiedCueUid).not.toBe(seed.sourceCueUid);
  expect(duplicate.copiedPartUid).not.toBe(seed.sourcePartUid);
  expect(duplicate.duplicateSetupUid).not.toBe(seed.sourceSetupUid);
  expect(duplicate.duplicateReleaseUid).not.toBe(seed.sourceReleaseUid);

  await cleanupOwnedDuplicateData(page, seed, duplicate);
});
