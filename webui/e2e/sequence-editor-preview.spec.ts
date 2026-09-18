// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type SequencePreviewPanelContext = {
  panelId: string;
  sequenceUid: string;
};

type OwnedSequencePreviewData = {
  cueId: number;
  sequenceId: number;
};

/** Verifies sequence defaults define the scrub span and backward steps retain paused time. */
test("sequence transition slider scrubs inherited timing", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await openOwnedSequencePreviewApp(page, backendSlot.backendPort);
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sequence = Object.values(stores.sequences.get())[0] as any;
    const result = await stores.sendAndAwait({
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: {
          ...sequence,
          default_timing: {
            ...sequence.default_timing,
            fade_in: { type: "Fixed", data: { secs: 4, nanos: 0 } },
          },
        },
      },
    });
    if (result.outcome.type !== "Succeeded")
      throw new Error(JSON.stringify(result));
  });
  const preview = await openSequencePreviewPanel(page);
  const panel = page.locator(`[data-panel-id="${preview.panelId}"]`);
  await panel.getByRole("button", { name: "Start preview" }).click();
  const slider = panel.getByRole("slider", { name: "Transition progress" });
  await expect(slider).toHaveAttribute("max", "4");
  await slider.fill("3");
  await expect(
    panel.getByRole("button", { name: "Resume transition" }),
  ).toBeVisible();
  await slider.fill("1");
  await expect(slider).toHaveValue("1");
  await panel.getByRole("button", { name: "Step transition forward" }).click();
  await expect(slider).toHaveValue("1.1");
  await page.screenshot({
    path: testInfo.outputPath("sequence-transition-scrubber.png"),
  });
  await slider.fill("4");
  const restart = panel.getByRole("button", { name: "Restart transition" });
  await expect(restart).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("completed-transition-restart.png"),
  });
  await restart.click();
  await expect(
    panel.getByRole("button", { name: "Pause transition" }),
  ).toBeVisible();
  await expect
    .poll(async () => Number(await slider.inputValue()))
    .toBeLessThan(1);
  await expect(restart).toBeVisible({ timeout: 8_000 });
  await panel.getByRole("button", { name: "Stop preview" }).click();
  await expect(slider).toBeHidden();
});

/** Opens a blank backend and stores the cue and sequence used by previews. */
async function openOwnedSequencePreviewApp(
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
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          instances: Object.keys(stores.activeInstances.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, instances: 0, sequences: 0 });

  const owned = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const cueId = Math.floor(900_000 + Math.random() * 30_000);
    const sequenceId = cueId + 1;
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
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
          `failed to store sequence preview data: ${JSON.stringify(result)}`,
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
            label: "Owned Preview Cue",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: [],
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
            uid: sequenceUid,
            id: sequenceId,
            label: "Owned Preview Sequence",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Owned Preview Setup"),
          release_cue: metaCue(releaseCueUid, "Owned Preview Release"),
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

    const data = { cueId, sequenceId };
    (window as any).__ownedSequencePreviewData = data;
    return data;
  });

  await expect
    .poll(() =>
      page.evaluate(({ cueId, sequenceId }) => {
        const stores = (window as any).appStores;
        const cues = Object.values(stores.cues.get()) as Array<{
          identifiers: { id: number };
        }>;
        const sequences = Object.values(stores.sequences.get()) as Array<{
          identifiers: { id: number };
        }>;
        return {
          cue: cues.some((cue) => cue.identifiers.id === cueId),
          sequence: sequences.some(
            (sequence) => sequence.identifiers.id === sequenceId,
          ),
        };
      }, owned),
    )
    .toEqual({ cue: true, sequence: true });
}

/** Stops previews, closes editor panels, and deletes owned definitions. */
async function cleanupOwnedSequencePreviewApp(page: Page): Promise<void> {
  const owned = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores?.dockApi?.get?.();
    for (const panel of [...(api?.panels ?? [])]) {
      if (panel.id.includes("SequenceEditor")) {
        panel.api.close();
      }
    }
    const data = (window as any)
      .__ownedSequencePreviewData as OwnedSequencePreviewData | null;
    return data ?? null;
  });
  if (!owned) return;

  await page.evaluate(async () => {
    await (window as any).appStores.send({
      module: "InstanceCommand",
      command: { type: "StopAll" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores.activeInstances.get()).length,
      ),
    )
    .toBe(0);

  await page.evaluate(async ({ cueId, sequenceId }) => {
    const stores = (window as any).appStores;

    /** Sends one delete command and rejects failed backend outcomes. */
    const remove = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to delete sequence preview data: ${JSON.stringify(result)}`,
        );
      }
    };

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
    (window as any).__ownedSequencePreviewData = null;
  }, owned);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          instances: Object.keys(stores.activeInstances.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, instances: 0, sequences: 0 });
}

/** Restores a blank backend after every sequence preview scenario. */
test.afterEach(async ({ page }) => {
  await cleanupOwnedSequencePreviewApp(page);
});

/** Finds the painted sequence-editor cell beneath a column header and row. */
async function sequencePreviewCellForHeader(
  panel: Locator,
  headerSuffix: string,
  rowIndex: number,
): Promise<Locator> {
  const cellId = await panel.evaluate(
    (element, options) => {
      const grid = element.querySelector('[data-grid-owner="sequence-editor"]');
      if (!grid) throw new Error("sequence editor grid not found");
      const headers = Array.from(
        grid.querySelectorAll<HTMLElement>("[data-grid-header-id]"),
      );
      const header = headers.find((candidate) =>
        candidate.dataset.gridHeaderId?.endsWith(options.headerSuffix),
      );
      if (!header) throw new Error(`header ${options.headerSuffix} not found`);
      const headerRect = header.getBoundingClientRect();
      const headerCenter = headerRect.left + headerRect.width / 2;
      const cells = Array.from(
        grid.querySelectorAll<HTMLElement>(`[id$="-${options.rowIndex}"]`),
      ).filter((candidate) => candidate.id.startsWith("tanstack-cell-"));
      const cell = cells.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return headerCenter >= rect.left && headerCenter <= rect.right;
      });
      if (!cell) {
        throw new Error(
          `cell for ${options.headerSuffix} row ${options.rowIndex} not found`,
        );
      }
      return cell.id;
    },
    { headerSuffix, rowIndex },
  );
  return panel.locator(`#${cellId}`);
}

/**
 * Counts red active-cue outline pixels rendered into sequence-editor grid canvases.
 */
async function countActiveCueOutlinePixels(grid: Locator): Promise<number> {
  return await grid.locator("canvas").evaluateAll((canvases) => {
    let count = 0;
    for (const canvas of canvases) {
      const canvasElement = canvas as HTMLCanvasElement;
      if (canvasElement.width === 0 || canvasElement.height === 0) continue;
      const context = canvasElement.getContext("2d");
      if (!context) continue;
      const image = context.getImageData(
        0,
        0,
        canvasElement.width,
        canvasElement.height,
      );
      for (let index = 0; index < image.data.length; index += 4) {
        const red = image.data[index] ?? 0;
        const green = image.data[index + 1] ?? 0;
        const blue = image.data[index + 2] ?? 0;
        const alpha = image.data[index + 3] ?? 0;
        if (
          red > 190 &&
          green >= 35 &&
          green < 115 &&
          blue >= 35 &&
          blue < 115 &&
          alpha > 120
        ) {
          count += 1;
        }
      }
    }
    return count;
  });
}

/**
 * Opens a sequence editor panel against a seeded sequence and returns its UID.
 */
async function openSequencePreviewPanel(
  page: Page,
  options: { panelId?: string; sequenceUid?: string } = {},
): Promise<SequencePreviewPanelContext> {
  return await page.evaluate(async (options) => {
    type AppStoresWindow = Window & {
      appStores?: {
        dockApi?: { get: () => any };
        cues?: { get: () => Record<string, any> };
        sequences?: { get: () => Record<string, any> };
      };
    };

    /** Waits for stores needed by the sequence preview panel. */
    const waitForStores = () =>
      new Promise<NonNullable<AppStoresWindow["appStores"]>>(
        (resolve, reject) => {
          const started = Date.now();

          /** Polls app stores until the seeded sequence data is available. */
          const tick = () => {
            const stores = (window as AppStoresWindow).appStores;
            const api = stores?.dockApi?.get?.();
            const cues = stores?.cues?.get?.() ?? {};
            const sequences = stores?.sequences?.get?.() ?? {};
            const sequence = Object.values(sequences).find((candidate) =>
              candidate.steps?.some((cueUid: string) => cues[cueUid]),
            );
            if (api && stores?.cues && stores.sequences && sequence) {
              resolve(stores);
              return;
            }
            if (Date.now() - started > 15_000) {
              reject(new Error("app stores did not initialize"));
              return;
            }
            window.setTimeout(tick, 100);
          };
          tick();
        },
      );

    const stores = await waitForStores();
    const api = stores.dockApi?.get();
    const cues = stores.cues?.get?.() ?? {};
    const sequences = stores.sequences?.get?.() ?? {};
    const sequence = options.sequenceUid
      ? sequences[options.sequenceUid]
      : Object.values(sequences).find((candidate) =>
          candidate.steps?.some((cueUid: string) => cues[cueUid]),
        );
    if (!api || !sequence) {
      throw new Error("sequence editor stores did not initialize");
    }

    const sequenceUid = sequence.identifiers.uid;
    const panelId =
      options.panelId ?? `panel-SequenceEditor-preview-restart-${Date.now()}`;
    api.getPanel(panelId)?.api.close();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const panel = api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Preview Restart E2E",
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

    return { panelId, sequenceUid };
  }, options);
}

/**
 * Counts active, non-releasing sequence preview instances for the source sequence.
 */
async function countActiveSequencePreviewInstances(
  page: Page,
  sequenceUid: string,
): Promise<number> {
  return await page.evaluate((sequenceUid) => {
    /** Normalizes UUID strings for store comparisons. */
    const normalizeUid = (uid: unknown) =>
      String(uid).replaceAll("-", "").toLowerCase();
    const stores = (window as any).appStores;
    const sequence = stores?.sequences?.get?.()?.[sequenceUid];
    const expectedName = sequence
      ? `Sequence Preview: ${sequence.identifiers.label}`
      : undefined;
    const instances = stores?.activeInstances?.get?.() ?? {};
    return Object.values(instances).filter(
      (playback: any) =>
        playback.is_preview &&
        !playback.is_releasing &&
        ((playback.object_ref?.type === "ByUid" &&
          playback.object_ref.data?.object_type === "Sequence" &&
          normalizeUid(playback.object_ref.data?.uid) ===
            normalizeUid(sequenceUid)) ||
          (expectedName !== undefined && playback.name === expectedName)),
    ).length;
  }, sequenceUid);
}

/**
 * Exercises sequence-preview grid editing while preview refreshes are active.
 */
test("sequence editor preview mode keeps grid interactions usable", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });

  await openOwnedSequencePreviewApp(page, backendSlot.backendPort);

  const panelId = await page.evaluate(async () => {
    type Duration = { secs: number; nanos: number };
    type TransitionMode = { type: "Fixed"; data: Duration };
    type CuePart = {
      identifiers: { id: number; uid: string; label: string };
      transitions: {
        delay_in?: TransitionMode;
        fade_in?: TransitionMode;
        delay_out?: TransitionMode;
        fade_out?: TransitionMode;
      };
      transitions_by_attribute: Record<string, never>;
      instructions: unknown[];
      tracking_flags: "HTP";
    };
    type Cue = {
      identifiers: { id: number; uid: string; label: string };
      trigger:
        | { type: "Manual" }
        | { type: "FollowPrevious" }
        | { type: "AfterDelay"; data: Duration };
      transitions: {
        delay_in?: TransitionMode;
        fade_in?: TransitionMode;
        delay_out?: TransitionMode;
        fade_out?: TransitionMode;
      };
      transitions_by_attribute: Record<string, never>;
      instructions: unknown[];
      parts?: CuePart[];
      tracking_flags: "HTP";
    };
    type Sequence = {
      identifiers: { id: number; uid: string; label: string };
      steps: string[];
      wrap: boolean;
      release_on_start: boolean;
      default_timing: {
        delay_in: TransitionMode;
        fade_in: TransitionMode;
        curve_in: "Linear";
        delay_out: TransitionMode;
        fade_out: TransitionMode;
        curve_out: "Linear";
      };
    };
    type AppStoresWindow = Window & {
      appStores?: {
        dockApi?: { get: () => any };
        cues?: {
          get: () => Record<string, Cue>;
          set: (value: Record<string, Cue>) => void;
        };
        sequences?: {
          get: () => Record<string, Sequence>;
          set: (value: Record<string, Sequence>) => void;
        };
      };
    };

    /** Waits for cue, sequence, and dock stores used by preview tests. */
    const waitForStores = () =>
      new Promise<NonNullable<AppStoresWindow["appStores"]>>(
        (resolve, reject) => {
          const started = Date.now();

          /** Polls browser state until the awaited test condition is satisfied. */
          const tick = () => {
            const stores = (window as AppStoresWindow).appStores;
            const api = stores?.dockApi?.get?.();
            const cues = stores?.cues?.get?.() ?? {};
            const sequences = stores?.sequences?.get?.() ?? {};
            const sequence = Object.values(sequences).find((candidate) =>
              candidate.steps.some((cueUid) => cues[cueUid]),
            );
            if (api && stores?.cues && stores.sequences && sequence) {
              resolve(stores);
              return;
            }
            if (Date.now() - started > 15_000) {
              reject(new Error("app stores did not initialize"));
              return;
            }
            window.setTimeout(tick, 100);
          };
          tick();
        },
      );

    const stores = await waitForStores();
    const api = stores.dockApi?.get();
    if (!api || !stores.cues || !stores.sequences) {
      throw new Error("sequence editor stores did not initialize");
    }

    const testId = `sequence-preview-${Date.now()}`;
    const cues = stores.cues.get();
    const sequences = stores.sequences.get();
    const sequence = Object.values(sequences).find((candidate) =>
      candidate.steps.some((cueUid) => cues[cueUid]),
    );
    const firstCueUid = sequence?.steps.find((cueUid) => cues[cueUid]);
    const firstCue = firstCueUid ? cues[firstCueUid] : undefined;
    if (!sequence || !firstCueUid || !firstCue) {
      throw new Error("no cue available for sequence editor test");
    }
    stores.cues.set({
      ...cues,
      [firstCueUid]: {
        ...firstCue,
        trigger: { type: "Manual" },
        parts: [
          {
            identifiers: {
              id: 1,
              uid: crypto.randomUUID().replaceAll("-", ""),
              label: "Preview Part",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [],
            tracking_flags: "HTP",
          },
        ],
      },
    });
    const sequenceUid = sequence.identifiers.uid;

    const panelId = `panel-SequenceEditor-e2e-${testId}`;
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const panel = api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence E2E",
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

    return panelId;
  });

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const grid = panel.locator('[data-grid-owner="sequence-editor"]');
  const tanstackGrid = grid.locator('[data-grid-kind="tanstack"]');
  await expect(tanstackGrid).toBeVisible();
  await expect(
    tanstackGrid.locator('[data-grid-header-id="tanstack-header-tracking"]'),
  ).toBeVisible();
  await expect(
    tanstackGrid.locator(
      '[data-grid-column-key="label"][data-grid-row-index="0"]',
    ),
  ).toContainText("Setup");

  await expect(panel.getByRole("button", { name: "Preview go" })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Preview back" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Jump preview to selected cue" }),
  ).toBeVisible();

  await panel
    .getByRole("button", { name: "Jump preview to selected cue" })
    .click();
  await expect(
    panel.getByRole("button", { name: "Toggle preview transitions" }),
  ).toBeEnabled();
  await expect(
    panel.getByRole("button", { name: "Toggle preview tracking" }),
  ).toBeEnabled();

  const cueCell = tanstackGrid
    .locator('[id^="tanstack-cell-0-"]')
    .filter({ hasText: "▶" })
    .first();
  const cueCellId = await cueCell.getAttribute("id");
  const cueRowIndex = Number(cueCellId?.split("-").at(-1));
  if (!Number.isFinite(cueRowIndex)) {
    throw new Error("Expected an expandable cue row");
  }
  await tanstackGrid.locator(`#${cueCellId}`).click({ force: true });
  await expect(
    tanstackGrid.locator(`#tanstack-cell-0-${cueRowIndex + 1}`),
  ).toContainText("p0");
  await expect(
    tanstackGrid.locator(`#tanstack-cell-0-${cueRowIndex + 2}`),
  ).toContainText("p1");
  await tanstackGrid.locator(`#${cueCellId}`).click({ force: true });
  await expect(
    tanstackGrid.locator(`#tanstack-cell-0-${cueRowIndex + 1}`),
  ).not.toContainText("p0");

  const timeCell = await sequencePreviewCellForHeader(
    panel,
    "fade_in",
    cueRowIndex,
  );
  await timeCell.click();
  await page.keyboard.type("250ms");
  const timeEditor = timeCell.locator("input");
  await expect(timeEditor).toBeVisible();
  await expect(timeEditor).toHaveValue("250ms");
  await page.waitForTimeout(500);
  await expect(timeEditor).toHaveValue("250ms");
  await timeEditor.press("Escape");

  await panel.getByRole("button", { name: "Preview go" }).click();
  await panel.getByRole("button", { name: "Preview back" }).click();
});

/**
 * Verifies stopping sequence preview clears the active cue outline and permits restart.
 */
test("sequence editor preview stop clears active cue cells and restarts", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openOwnedSequencePreviewApp(page, backendSlot.backendPort);

  const preview = await openSequencePreviewPanel(page);
  const panel = page.locator(`[data-panel-id="${preview.panelId}"]`);
  const grid = panel.locator('[data-grid-owner="sequence-editor"]');
  const tanstackGrid = grid.locator('[data-grid-kind="tanstack"]');
  await expect(tanstackGrid).toBeVisible();

  await panel.getByRole("button", { name: "Start preview" }).click();
  await expect(
    panel.getByRole("button", { name: "Stop preview" }),
  ).toBeVisible();
  await expect
    .poll(() => countActiveCueOutlinePixels(tanstackGrid))
    .toBeGreaterThan(10);

  await panel.getByRole("button", { name: "Preview go" }).click();
  await expect(
    panel.getByRole("button", { name: "Stop preview" }),
  ).toBeVisible();
  await expect
    .poll(() => countActiveCueOutlinePixels(tanstackGrid))
    .toBeGreaterThan(10);

  await panel.getByRole("button", { name: "Stop preview" }).click();
  await expect(
    panel.getByRole("button", { name: "Start preview" }),
  ).toBeVisible();
  await expect
    .poll(() => countActiveCueOutlinePixels(tanstackGrid))
    .toBeLessThan(3);

  await panel.getByRole("button", { name: "Start preview" }).click();
  await expect(
    panel.getByRole("button", { name: "Stop preview" }),
  ).toBeVisible();
  await expect
    .poll(() => countActiveCueOutlinePixels(tanstackGrid))
    .toBeGreaterThan(10);
});

/**
 * Verifies closing a passive same-sequence editor does not stop another editor's preview.
 */
test("sequence editor preview is owned by the editor playback", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openOwnedSequencePreviewApp(page, backendSlot.backendPort);
  const first = await openSequencePreviewPanel(page, {
    panelId: "panel-SequenceEditor-preview-owner-a",
  });
  await page.evaluate(() =>
    (window as any).appStores.send({
      module: "InstanceCommand",
      command: { type: "StopAll" },
    }),
  );
  await expect
    .poll(() => countActiveSequencePreviewInstances(page, first.sequenceUid))
    .toBe(0);
  const firstPanel = page.locator(`[data-panel-id="${first.panelId}"]`);
  await expect(
    firstPanel.locator('[data-grid-owner="sequence-editor"]'),
  ).toBeVisible();
  await firstPanel.getByRole("button", { name: "Start preview" }).click();
  await expect
    .poll(() => countActiveSequencePreviewInstances(page, first.sequenceUid))
    .toBe(1);

  const second = await openSequencePreviewPanel(page, {
    panelId: "panel-SequenceEditor-preview-owner-b",
    sequenceUid: first.sequenceUid,
  });
  await expect
    .poll(() => countActiveSequencePreviewInstances(page, first.sequenceUid))
    .toBe(1);

  await page.evaluate((panelId) => {
    (window as any).appStores.dockApi.get().getPanel(panelId)?.api.close();
  }, second.panelId);
  await expect
    .poll(() => countActiveSequencePreviewInstances(page, first.sequenceUid))
    .toBe(1);
});
