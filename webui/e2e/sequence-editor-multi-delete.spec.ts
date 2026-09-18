// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type OwnedSequenceDeleteContext = {
  cueId: number;
  cueUid: string;
  panelId: string;
  sequenceId: number;
  sequenceUid: string;
};

test.setTimeout(120_000);

/** Opens the sequence multi-delete scenarios against a blank backend showfile. */
async function openOwnedSequenceEditorApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1300, height: 720 });
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

/** Stores an exact cue and sequence, then opens their sequence editor panel. */
async function storeOwnedCuePartsForDelete(
  page: Page,
  options: {
    panelId: string;
    parts: Array<{ id: number; label: string }>;
  },
): Promise<OwnedSequenceDeleteContext> {
  const context = await page.evaluate(async (seedOptions) => {
    const stores = (window as any).appStores;
    const cueId = Math.floor(10_000 + Math.random() * 80_000);
    const sequenceId = Math.floor(900_000 + Math.random() * 50_000);
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const fixedZero = {
      type: "Fixed",
      data: { secs: 0, nanos: 0 },
    };

    /** Builds an empty cue part for sequence editor deletion tests. */
    const part = (id: number, label: string) => ({
      identifiers: {
        id,
        uid: crypto.randomUUID().replaceAll("-", ""),
        label,
      },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      tracking_flags: "HTP",
    });

    /** Builds a complete empty sequence metadata cue. */
    const metaCue = (uid: string, label: string): object => ({
      identifiers: { id: 0, uid, label },
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
          `failed to store owned sequence delete data: ${JSON.stringify(result)}`,
        );
      }
    };

    await store({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          identifiers: {
            id: cueId,
            uid: cueUid,
            label: "Owned Multi Delete Cue",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: seedOptions.parts.map(({ id, label }) => part(id, label)),
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
            id: sequenceId,
            uid: sequenceUid,
            label: "Owned Multi Delete Sequence",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Owned Multi Delete Setup"),
          release_cue: metaCue(releaseCueUid, "Owned Multi Delete Release"),
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
      cueId,
      cueUid,
      panelId: seedOptions.panelId,
      sequenceId,
      sequenceUid,
    };
  }, options);

  await expect
    .poll(() =>
      page.evaluate(({ cueUid, sequenceUid }) => {
        const stores = (window as any).appStores;
        const cue = stores.cues.get()[cueUid];
        const sequence = stores.sequences.get()[sequenceUid];
        return {
          cueCount: Object.keys(stores.cues.get()).length,
          cueId: cue?.identifiers.id,
          partIds: cue?.parts?.map((part: any) => part.identifiers.id) ?? null,
          sequenceCount: Object.keys(stores.sequences.get()).length,
          sequenceSteps: sequence?.steps ?? null,
        };
      }, context),
    )
    .toEqual({
      cueCount: 1,
      cueId: context.cueId,
      partIds: options.parts.map(({ id }) => id),
      sequenceCount: 1,
      sequenceSteps: [context.cueUid],
    });

  await page.evaluate(({ panelId, sequenceUid }) => {
    const api = (window as any).appStores.dockApi.get();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    api.getPanel(panelId)?.api.close();
    const panel = api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Multi Delete",
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequenceUid,
      },
    });
    panel.api.setActive();
    panel.focus();
  }, context);

  return context;
}

/** Deletes the exact cue and sequence owned by one multi-delete scenario. */
async function cleanupOwnedSequenceDeleteData(
  page: Page,
  context: OwnedSequenceDeleteContext,
): Promise<void> {
  await page.evaluate(async (owned) => {
    const stores = (window as any).appStores;

    /** Sends one delete command, optionally accepting an already-missing record. */
    const remove = async (
      message: object,
      allowMissing = false,
    ): Promise<boolean> => {
      const result = await stores.sendAndAwait(message);
      const missingRecord =
        allowMissing &&
        result.outcome.type === "Failed" &&
        String(result.outcome.data?.message).endsWith(": not found");
      if (result.outcome.type !== "Succeeded" && !missingRecord) {
        throw new Error(
          `failed to delete owned sequence delete data: ${JSON.stringify(result)}`,
        );
      }
      return missingRecord;
    };

    if (stores.cues.get()[owned.cueUid]) {
      const cueAlreadyMissing = await remove(
        {
          module: "CueCommand",
          command: {
            type: "DeleteCue",
            data: {
              sequence_id: owned.sequenceId,
              cue_id: owned.cueId,
            },
          },
        },
        true,
      );
      if (cueAlreadyMissing) {
        const remainingCues = { ...stores.cues.get() };
        delete remainingCues[owned.cueUid];
        stores.cues.set(remainingCues);
      }
    }
    if (stores.sequences.get()[owned.sequenceUid]) {
      await remove({
        module: "CueCommand",
        command: { type: "DeleteSequence", data: owned.sequenceId },
      });
    }
  }, context);

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

/** Returns the visible sequence editor panel created for one delete scenario. */
function sequenceEditorPanel(page: Page, panelId: string) {
  return page.locator(`[data-panel-id="${panelId}"]`);
}

/** Verifies row-marker multi-selection deletes every selected cue part row. */
test("sequence editor deletes all selected cue part rows", async ({
  backendSlot,
  page,
}) => {
  await openOwnedSequenceEditorApp(page, backendSlot.backendPort);

  const seeded = await storeOwnedCuePartsForDelete(page, {
    panelId: "panel-SequenceEditor-multi-delete-checkbox",
    parts: [
      { id: 101, label: "Delete First Part" },
      { id: 102, label: "Delete Second Part" },
    ],
  });

  try {
    const grid = page
      .locator(`[data-panel-id="${seeded.panelId}"]`)
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();

    const cueIdCell = grid.locator("#tanstack-cell-0-1");
    await expect(cueIdCell).toContainText("▶");
    await cueIdCell.click();

    await expect(grid.locator("#tanstack-cell-1-3")).toContainText(
      "Delete First Part",
    );
    await expect(grid.locator("#tanstack-cell-1-4")).toContainText(
      "Delete Second Part",
    );

    await grid.getByRole("checkbox", { name: "Select row 4" }).check();
    await grid.getByRole("checkbox", { name: "Select row 5" }).check();
    await page.keyboard.press("Delete");

    await expect
      .poll(
        async () =>
          page.evaluate(({ cueUid, sequenceUid }) => {
            const stores = (window as any).appStores;
            const cue = stores.cues.get()[cueUid];
            const sequence = stores.sequences.get()[sequenceUid];
            return {
              partIds:
                cue?.parts?.map((part: any) => part.identifiers.id) ?? [],
              sequenceSteps: sequence?.steps ?? [],
            };
          }, seeded),
        { timeout: 10_000 },
      )
      .toEqual({
        partIds: [101, 102],
        sequenceSteps: [seeded.cueUid],
      });

    await sequenceEditorPanel(page, seeded.panelId)
      .getByRole("button", { name: "Delete Selected Rows" })
      .click();

    await expect
      .poll(
        async () =>
          page.evaluate(({ cueUid, sequenceUid }) => {
            const stores = (window as any).appStores;
            const cue = stores.cues.get()[cueUid];
            const sequence = stores.sequences.get()[sequenceUid];
            return {
              partIds:
                cue?.parts?.map((part: any) => part.identifiers.id) ?? [],
              sequenceSteps: sequence?.steps ?? [],
            };
          }, seeded),
        { timeout: 10_000 },
      )
      .toEqual({
        partIds: [],
        sequenceSteps: [seeded.cueUid],
      });

    await expect(
      sequenceEditorPanel(page, seeded.panelId).getByRole("button", {
        name: "Delete Cue",
      }),
    ).toBeDisabled();
  } finally {
    await cleanupOwnedSequenceDeleteData(page, seeded);
  }
});

/** Verifies selecting the synthetic p0 row does not permit partial part deletion. */
test("sequence editor disables delete for base part range selections", async ({
  backendSlot,
  page,
}) => {
  await openOwnedSequenceEditorApp(page, backendSlot.backendPort);

  const seeded = await storeOwnedCuePartsForDelete(page, {
    panelId: "panel-SequenceEditor-base-part-delete",
    parts: [
      { id: 201, label: "Keep First Part" },
      { id: 202, label: "Keep Second Part" },
    ],
  });

  try {
    const grid = page
      .locator(`[data-panel-id="${seeded.panelId}"]`)
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();

    const cueIdCell = grid.locator("#tanstack-cell-0-1");
    await expect(cueIdCell).toContainText("▶");
    await cueIdCell.click();

    await expect(grid.locator("#tanstack-cell-0-2")).toContainText("p0");
    await expect(grid.locator("#tanstack-cell-1-3")).toContainText(
      "Keep First Part",
    );
    await expect(grid.locator("#tanstack-cell-1-4")).toContainText(
      "Keep Second Part",
    );

    await grid.locator("#tanstack-cell-1-2").click();
    await grid.locator("#tanstack-cell-1-4").click({ modifiers: ["Shift"] });

    await expect(
      sequenceEditorPanel(page, seeded.panelId).getByRole("button", {
        name: "Delete Selected Rows",
      }),
    ).toBeDisabled();
  } finally {
    await cleanupOwnedSequenceDeleteData(page, seeded);
  }
});

/** Verifies deleting the only sequence cue does not leave meta cue rows selected. */
test("sequence editor clears delete selection after deleting the only cue", async ({
  backendSlot,
  page,
}) => {
  await openOwnedSequenceEditorApp(page, backendSlot.backendPort);

  const seeded = await storeOwnedCuePartsForDelete(page, {
    panelId: "panel-SequenceEditor-delete-only-cue",
    parts: [],
  });

  try {
    const grid = page
      .locator(`[data-panel-id="${seeded.panelId}"]`)
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();

    await grid.getByRole("checkbox", { name: "Select row 2" }).check();
    const panel = sequenceEditorPanel(page, seeded.panelId);
    await panel.getByRole("button", { name: "Delete Cue" }).click();

    await expect
      .poll(
        async () =>
          page.evaluate((sequenceUid) => {
            const stores = (window as any).appStores;
            const sequence = stores.sequences.get()[sequenceUid];
            return sequence?.steps ?? [];
          }, seeded.sequenceUid),
        { timeout: 10_000 },
      )
      .toEqual([]);

    await expect(
      panel.getByRole("button", { name: "Delete Cue" }),
    ).toBeDisabled();
  } finally {
    await cleanupOwnedSequenceDeleteData(page, seeded);
  }
});
