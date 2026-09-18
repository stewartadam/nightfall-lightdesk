// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const SEQUENCE_EDITOR_PANEL_ID = "panel-SequenceEditor-bulk-trigger-after";

type BulkTriggerContext = {
  cueIds: number[];
  firstCueRowIndex: number;
  firstCueUid: string;
  secondCueRowIndex: number;
  secondCueUid: string;
  sequenceId: number;
  sequenceUid: string;
};

/** Opens the bulk trigger scenario against a blank backend showfile. */
async function openOwnedBulkTriggerApp(
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

/** Stores the three cues and sequence used by bulk Trigger After edits. */
async function storeOwnedBulkTriggerSequence(
  page: Page,
): Promise<BulkTriggerContext> {
  const context = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sequenceId = Math.floor(900_000 + Math.random() * 50_000);
    const firstCueId = Math.floor(1_000 + Math.random() * 8_000);
    const cueIds = [firstCueId, firstCueId + 1, firstCueId + 2];
    const cueUids = cueIds.map(() => crypto.randomUUID().replaceAll("-", ""));
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const fixedZero = {
      type: "Fixed",
      data: { secs: 0, nanos: 0 },
    };

    /** Builds a complete empty cue for one sequence row. */
    const cue = (id: number, uid: string, label: string): object => ({
      identifiers: { id, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      references: {},
      tracking_flags: "HTP",
    });

    /** Builds an empty sequence metadata cue. */
    const metaCue = (uid: string, label: string): object => cue(0, uid, label);

    /** Sends one store command and rejects failed backend outcomes. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store owned bulk trigger data: ${JSON.stringify(result)}`,
        );
      }
    };

    for (const [index, cueUid] of cueUids.entries()) {
      await store({
        module: "CueCommand",
        command: {
          type: "StoreCue",
          data: cue(
            cueIds[index],
            cueUid,
            `Owned Bulk Trigger Cue ${index + 1}`,
          ),
        },
      });
    }
    await store({
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: {
          identifiers: {
            id: sequenceId,
            uid: sequenceUid,
            label: "Owned Bulk Trigger Sequence",
          },
          steps: cueUids,
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Owned Bulk Trigger Setup"),
          release_cue: metaCue(releaseCueUid, "Owned Bulk Trigger Release"),
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
      cueIds,
      firstCueRowIndex: 2,
      firstCueUid: cueUids[1],
      secondCueRowIndex: 3,
      secondCueUid: cueUids[2],
      sequenceId,
      sequenceUid,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(({ sequenceUid }) => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          sequence: stores.sequences.get()[sequenceUid]?.identifiers.uid,
        };
      }, context),
    )
    .toEqual({ cues: 3, sequence: context.sequenceUid });

  return context;
}

/** Opens the owned sequence in the dedicated bulk-edit panel. */
async function openOwnedBulkTriggerEditor(
  page: Page,
  context: BulkTriggerContext,
): Promise<void> {
  await page.evaluate(
    ({ panelId, sequenceUid }) => {
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
        title: "Sequence Bulk Trigger After",
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
    },
    { panelId: SEQUENCE_EDITOR_PANEL_ID, sequenceUid: context.sequenceUid },
  );
}

/** Deletes every cue and sequence record owned by the bulk-trigger test. */
async function cleanupOwnedBulkTriggerData(
  page: Page,
  context: BulkTriggerContext,
): Promise<void> {
  await page.evaluate(async ({ cueIds, sequenceId }) => {
    const stores = (window as any).appStores;

    /** Sends one delete command and rejects failed backend outcomes. */
    const remove = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to delete owned bulk trigger data: ${JSON.stringify(result)}`,
        );
      }
    };

    for (const cueId of cueIds) {
      await remove({
        module: "CueCommand",
        command: {
          type: "DeleteCue",
          data: { sequence_id: sequenceId, cue_id: cueId },
        },
      });
    }
    await remove({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: sequenceId },
    });
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

/** Returns the bulk-trigger spec's dedicated sequence editor grid. */
function sequenceEditorGrid(page: Page) {
  return page
    .locator(
      `[data-component="SequenceEditor"][data-panel-id="${SEQUENCE_EDITOR_PANEL_ID}"]`,
    )
    .locator('[data-grid-owner="sequence-editor"]');
}

/** Finds the visible sequence editor cell under one column header and row. */
async function sequenceEditorCellForHeader(
  page: Page,
  headerSuffix: string,
  rowIndex: number,
) {
  const cellId = await page.evaluate(
    ({ headerSuffix, panelId, rowIndex }) => {
      const grid = document.querySelector(
        `[data-component="SequenceEditor"][data-panel-id="${panelId}"] [data-grid-owner="sequence-editor"]`,
      );
      if (!grid) throw new Error("sequence editor grid not found");
      const headers = Array.from(
        grid.querySelectorAll<HTMLElement>("[data-grid-header-id]"),
      );
      const header = headers.find((candidate) =>
        candidate.dataset.gridHeaderId?.endsWith(headerSuffix),
      );
      if (!header) throw new Error(`header ${headerSuffix} not found`);
      const headerRect = header.getBoundingClientRect();
      const headerCenter = headerRect.left + headerRect.width / 2;
      const cells = Array.from(
        grid.querySelectorAll<HTMLElement>(`[id$="-${rowIndex}"]`),
      ).filter((candidate) => candidate.id.startsWith("tanstack-cell-"));
      const cell = cells.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return headerCenter >= rect.left && headerCenter <= rect.right;
      });
      if (!cell) throw new Error(`cell for ${headerSuffix} row ${rowIndex}`);
      return cell.id;
    },
    { headerSuffix, panelId: SEQUENCE_EDITOR_PANEL_ID, rowIndex },
  );
  return sequenceEditorGrid(page).locator(`#${cellId}`);
}

/** Selects one item from the currently open grid dropdown menu. */
async function clickOpenedGridDropdownOption(page: Page, label: string) {
  const dropdown = page.locator("[data-hs-select-dropdown].opened").last();
  await expect(dropdown).toBeVisible();
  await dropdown.locator("[data-value]", { hasText: label }).first().click();
}

/** Sends an undo-stack command through the websocket command path. */
async function sendUndoCommandAndAwait(
  page: Page,
  type: "Undo" | "Redo" | "ClearHistory",
): Promise<void> {
  const result = await page.evaluate(
    async (commandData) => {
      const stores = (window as any).appStores;
      if (!stores?.sendAndAwait) {
        throw new Error("sendAndAwait store helper was not available");
      }
      return stores.sendAndAwait(commandData);
    },
    {
      module: "UndoCommand",
      command: { type, data: {} },
    },
  );
  expect(result.outcome.type, JSON.stringify(result.outcome)).toBe("Succeeded");
}

/** Verifies the sequence editor applies Trigger After edits to selected cue rows. */
test("sequence editor bulk-edits Trigger After values", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await openOwnedBulkTriggerApp(page, backendSlot.backendPort);
  const context = await storeOwnedBulkTriggerSequence(page);
  await openOwnedBulkTriggerEditor(page, context);

  const grid = sequenceEditorGrid(page).locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const afterHeader = grid.locator(
    '[data-grid-header-id="tanstack-header-after_delay"]',
  );
  const firstAfterCell = await sequenceEditorCellForHeader(
    page,
    "after_delay",
    context.firstCueRowIndex,
  );
  const secondAfterCell = await sequenceEditorCellForHeader(
    page,
    "after_delay",
    context.secondCueRowIndex,
  );
  const firstTriggerCell = grid.locator(
    `[data-grid-row-index="${context.firstCueRowIndex}"][data-grid-column-key="trigger"]`,
  );
  const secondTriggerCell = grid.locator(
    `[data-grid-row-index="${context.secondCueRowIndex}"][data-grid-column-key="trigger"]`,
  );
  await expect(firstAfterCell).toBeVisible();
  await expect(secondAfterCell).toBeVisible();

  await grid
    .getByRole("checkbox", {
      name: `Select row ${context.firstCueRowIndex + 1}`,
    })
    .check();
  await grid
    .getByRole("checkbox", {
      name: `Select row ${context.secondCueRowIndex + 1}`,
    })
    .check();
  await firstAfterCell.dblclick();

  const editor = firstAfterCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("250ms");
  await editor.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid, secondCueUid }) => {
          const cues = (window as any).appStores.cues.get();
          return [firstCueUid, secondCueUid].map((cueUid) => {
            const trigger = cues[cueUid]?.trigger;
            return trigger?.type === "AfterDelay" ? trigger.data : null;
          });
        }, context),
      { timeout: 10_000 },
    )
    .toEqual([
      { secs: 0, nanos: 250_000_000 },
      { secs: 0, nanos: 250_000_000 },
    ]);

  await page.evaluate(({ firstCueUid }) => {
    const cues = (window as any).appStores.cues.get();
    (window as any).appStores.cues.set({
      ...cues,
      [firstCueUid]: {
        ...cues[firstCueUid],
        trigger: {
          type: "At",
          data: { secs: 1, nanos: 0 },
        },
      },
    });
  }, context);
  await expect(firstTriggerCell).toContainText("At");

  await firstAfterCell.dblclick();
  const atEditor = firstAfterCell.locator("input");
  await expect(atEditor).toBeVisible();
  await atEditor.fill("1250ms");
  await atEditor.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid }) => {
          const trigger = (window as any).appStores.cues.get()[firstCueUid]
            ?.trigger;
          return trigger?.type === "At" ? trigger.data : null;
        }, context),
      { timeout: 10_000 },
    )
    .toEqual({ secs: 1, nanos: 250_000_000 });

  await page.evaluate(({ firstCueUid, secondCueUid }) => {
    const cues = (window as any).appStores.cues.get();
    (window as any).appStores.cues.set({
      ...cues,
      [firstCueUid]: {
        ...cues[firstCueUid],
        trigger: { type: "Manual" },
      },
      [secondCueUid]: {
        ...cues[secondCueUid],
        trigger: { type: "Manual" },
      },
    });
  }, context);
  await expect(firstTriggerCell).toContainText("Manual");
  await expect(secondTriggerCell).toContainText("Manual");

  await afterHeader.click();
  await expect(afterHeader).toHaveAttribute("data-selected", "true");
  await firstAfterCell.focus();
  await page.keyboard.press("2");
  const columnEditor = firstAfterCell.locator('input:not([type="checkbox"])');
  await expect(columnEditor).toBeVisible();
  await expect(columnEditor).toHaveValue("2");
  await columnEditor.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid, secondCueUid }) => {
          const cues = (window as any).appStores.cues.get();
          return [firstCueUid, secondCueUid].map((cueUid) => {
            const trigger = cues[cueUid]?.trigger;
            return trigger?.type === "AfterDelay" ? trigger.data : null;
          });
        }, context),
      { timeout: 10_000 },
    )
    .toEqual([
      { secs: 2, nanos: 0 },
      { secs: 2, nanos: 0 },
    ]);

  await page.evaluate(async ({ firstCueUid, secondCueUid }) => {
    const stores = (window as any).appStores;
    const cues = (window as any).appStores.cues.get();
    for (const cueUid of [firstCueUid, secondCueUid]) {
      const cue = cues[cueUid];
      if (!cue) throw new Error(`cue ${cueUid} was not found`);
      const result = await stores.sendAndAwait({
        module: "CueCommand",
        command: {
          type: "StoreCue",
          data: {
            ...cue,
            trigger: { type: "Manual" },
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to reset owned bulk trigger cue: ${JSON.stringify(result)}`,
        );
      }
    }
  }, context);
  await expect(firstTriggerCell).toContainText("Manual");
  await expect(secondTriggerCell).toContainText("Manual");
  await sendUndoCommandAndAwait(page, "ClearHistory");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const undoState = (window as any).appStores.undoState.get();
        return undoState.undo_depth;
      }),
    )
    .toBe(0);
  await firstTriggerCell.click();
  await secondTriggerCell.click({ modifiers: ["Shift"] });
  const selectedRangeBeforeDoubleClick = await grid.getAttribute(
    "data-selection-range",
  );
  await firstTriggerCell.dblclick();
  await expect(firstTriggerCell.getByRole("button")).toBeVisible();
  await expect
    .poll(() => grid.getAttribute("data-selection-range"))
    .toBe(selectedRangeBeforeDoubleClick);
  await clickOpenedGridDropdownOption(page, "Follow Previous");

  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid, secondCueUid }) => {
          const cues = (window as any).appStores.cues.get();
          return [firstCueUid, secondCueUid].map(
            (cueUid) => cues[cueUid]?.trigger?.type,
          );
        }, context),
      { timeout: 10_000 },
    )
    .toEqual(["FollowPrevious", "FollowPrevious"]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const undoState = (window as any).appStores.undoState.get();
        return {
          entryCount: undoState.undo_stack?.[0]?.entry_count,
          undoDepth: undoState.undo_depth,
        };
      }),
    )
    .toEqual({ entryCount: 2, undoDepth: 1 });

  await sendUndoCommandAndAwait(page, "Undo");
  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid, secondCueUid }) => {
          const cues = (window as any).appStores.cues.get();
          return [firstCueUid, secondCueUid].map(
            (cueUid) => cues[cueUid]?.trigger?.type,
          );
        }, context),
      { timeout: 10_000 },
    )
    .toEqual(["Manual", "Manual"]);

  const firstFadeInCell = await sequenceEditorCellForHeader(
    page,
    "fade_in",
    context.firstCueRowIndex,
  );
  const secondDelayInCell = await sequenceEditorCellForHeader(
    page,
    "delay_in",
    context.secondCueRowIndex,
  );
  await firstFadeInCell.click();
  await secondDelayInCell.click({ modifiers: ["Shift"] });
  await page.keyboard.type("750ms");
  const cueTimingEditor = secondDelayInCell.locator("input");
  await expect(cueTimingEditor).toBeVisible();
  await cueTimingEditor.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid, secondCueUid }) => {
          const cues = (window as any).appStores.cues.get();
          return [firstCueUid, secondCueUid].map((cueUid) => {
            const transitions = cues[cueUid]?.transitions ?? {};
            return [transitions.fade_in?.data, transitions.delay_in?.data];
          });
        }, context),
      { timeout: 10_000 },
    )
    .toEqual([
      [
        { secs: 0, nanos: 750_000_000 },
        { secs: 0, nanos: 750_000_000 },
      ],
      [
        { secs: 0, nanos: 750_000_000 },
        { secs: 0, nanos: 750_000_000 },
      ],
    ]);

  await page.evaluate(({ firstCueUid }) => {
    const cues = (window as any).appStores.cues.get();
    (window as any).appStores.cues.set({
      ...cues,
      [firstCueUid]: {
        ...cues[firstCueUid],
        parts: [
          {
            identifiers: {
              id: 1,
              uid: crypto.randomUUID(),
              label: "Bulk Part One",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [],
            tracking_flags: "HTP",
          },
          {
            identifiers: {
              id: 2,
              uid: crypto.randomUUID(),
              label: "Bulk Part Two",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [],
            tracking_flags: "HTP",
          },
        ],
      },
    });
  }, context);

  const firstCueIdCell = await sequenceEditorCellForHeader(
    page,
    "cue_id",
    context.firstCueRowIndex,
  );
  await firstCueIdCell.click();
  const firstPartRow = context.firstCueRowIndex + 2;
  const secondPartRow = context.firstCueRowIndex + 3;
  const firstPartFadeInCell = await sequenceEditorCellForHeader(
    page,
    "fade_in",
    firstPartRow,
  );
  const secondPartDelayInCell = await sequenceEditorCellForHeader(
    page,
    "delay_in",
    secondPartRow,
  );
  await expect(firstPartFadeInCell).toBeVisible();
  await expect(secondPartDelayInCell).toBeVisible();
  await firstPartFadeInCell.click();
  await secondPartDelayInCell.click({ modifiers: ["Shift"] });
  await page.keyboard.type("500ms");
  const partTimingEditor = secondPartDelayInCell.locator("input");
  await expect(partTimingEditor).toBeVisible();
  await partTimingEditor.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(({ firstCueUid }) => {
          const cues = (window as any).appStores.cues.get();
          const parts = cues[firstCueUid]?.parts ?? [];
          return parts
            .slice(0, 2)
            .map((part: any) => [
              part.transitions?.fade_in?.data,
              part.transitions?.delay_in?.data,
            ]);
        }, context),
      { timeout: 10_000 },
    )
    .toEqual([
      [
        { secs: 0, nanos: 500_000_000 },
        { secs: 0, nanos: 500_000_000 },
      ],
      [
        { secs: 0, nanos: 500_000_000 },
        { secs: 0, nanos: 500_000_000 },
      ],
    ]);

  await cleanupOwnedBulkTriggerData(page, context);
});
