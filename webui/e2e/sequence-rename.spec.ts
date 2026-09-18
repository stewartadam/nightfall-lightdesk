// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type SequenceState = {
  defaultTiming: unknown;
  id: number;
  releaseCueUid: string;
  releaseOnStart: boolean;
  setupCueUid: string;
  steps: string[];
  trackingMode: unknown;
  wrap: boolean;
};

type SequenceRenameContext = {
  editorPanelId: string;
  expectedState: SequenceState;
  initialLabel: string;
  renamedLabel: string;
  sequenceId: number;
  sequenceUid: string;
};

/** Opens the sequence rename scenario against a blank backend showfile. */
async function openOwnedSequenceRenameApp(
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

/** Stores the complete sequence whose label is renamed by the test. */
async function storeOwnedRenameSequence(
  page: Page,
): Promise<SequenceRenameContext> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const sequenceId = Math.floor(900_000 + Math.random() * 50_000);
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const initialLabel = `Owned Rename Original ${sequenceId}`;
    const renamedLabel = `Owned Rename Updated ${sequenceId}`;
    const fixedZero = {
      type: "Fixed",
      data: { secs: 0, nanos: 0 },
    };
    const defaultTiming = {
      delay_in: fixedZero,
      fade_in: fixedZero,
      curve_in: "Linear",
      delay_out: fixedZero,
      fade_out: fixedZero,
      curve_out: "Linear",
    };
    const trackingMode = { type: "Flags", data: "HTP" };

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

    const result = await stores.sendAndAwait({
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: {
          identifiers: {
            uid: sequenceUid,
            id: sequenceId,
            label: initialLabel,
          },
          steps: [],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Owned Rename Setup"),
          release_cue: metaCue(releaseCueUid, "Owned Rename Release"),
          default_timing: defaultTiming,
          tracking_mode: trackingMode,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to store owned rename sequence: ${JSON.stringify(result)}`,
      );
    }

    return {
      editorPanelId: "panel-SequenceEditor-rename-e2e",
      expectedState: {
        defaultTiming,
        id: sequenceId,
        releaseCueUid,
        releaseOnStart: false,
        setupCueUid,
        steps: [],
        trackingMode,
        wrap: false,
      },
      initialLabel,
      renamedLabel,
      sequenceId,
      sequenceUid,
    };
  });
}

/** Waits for the owned sequence label and structural fields to match. */
async function expectOwnedSequence(
  page: Page,
  context: SequenceRenameContext,
  label: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((sequenceUid) => {
          const sequence = (window as any).appStores.sequences.get()[
            sequenceUid
          ];
          if (!sequence) return null;
          return {
            defaultTiming: sequence.default_timing,
            id: sequence.identifiers.id,
            label: sequence.identifiers.label,
            releaseCueUid: sequence.release_cue.identifiers.uid,
            releaseOnStart: sequence.release_on_start,
            setupCueUid: sequence.setup_cue.identifiers.uid,
            steps: sequence.steps,
            trackingMode: sequence.tracking_mode,
            wrap: sequence.wrap,
          };
        }, context.sequenceUid),
      { timeout: 15_000 },
    )
    .toEqual({ ...context.expectedState, label });
}

/** Opens the owned sequence editor and the Properties panel. */
async function openSequenceEditorPanels(
  page: Page,
  context: SequenceRenameContext,
  label: string,
): Promise<void> {
  await page.evaluate(
    ({ editorPanelId, sequenceId, sequenceUid, sequenceLabel }) => {
      const api = (window as any).appStores.dockApi.get();
      if (!api.getPanel(editorPanelId)) {
        api.addPanel({
          id: editorPanelId,
          component: "SequenceEditor",
          title: `Sequence ${sequenceId}: ${sequenceLabel}`,
          params: {
            initialPanelId: editorPanelId,
            initialSequenceUid: sequenceUid,
          },
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
    },
    {
      editorPanelId: context.editorPanelId,
      sequenceId: context.sequenceId,
      sequenceLabel: label,
      sequenceUid: context.sequenceUid,
    },
  );
}

/** Waits for the sequence provider to mount, then reveals its Properties panel. */
async function revealSequenceProperties(
  page: Page,
  editorPanelId: string,
): Promise<void> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const editorPanel = api.getPanel(panelId);
    editorPanel?.api.setActive();
    editorPanel?.focus();
  }, editorPanelId);
  await page.getByLabel("Sequence label").waitFor({ state: "attached" });

  await page.evaluate(async (panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const editorPanel = api.getPanel(panelId);
    const propertiesPanel = api.getPanel("panel-PropertiesInspector");
    propertiesPanel?.api.setActive();
    if (propertiesPanel?.api.location.type === "edge") {
      api.getEdgeGroup(propertiesPanel.api.location.position)?.expand();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      editorPanel?.api.setActive();
      return;
    }
    propertiesPanel?.focus();
  }, editorPanelId);
}

/** Verifies an owned sequence rename and its structure persist after reload. */
test("sequence rename persists after refresh", async ({
  backendSlot,
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await openOwnedSequenceRenameApp(page, backendSlot.backendPort);
  const context = await storeOwnedRenameSequence(page);
  await expectOwnedSequence(page, context, context.initialLabel);
  await openSequenceEditorPanels(page, context, context.initialLabel);
  await revealSequenceProperties(page, context.editorPanelId);

  const labelInput = page.getByLabel("Sequence label");
  await expect(labelInput).toBeVisible();
  await expect(labelInput).toHaveValue(context.initialLabel);

  await labelInput.fill(context.renamedLabel);
  await expect(labelInput).toHaveValue(context.renamedLabel);
  await expect(labelInput).toBeFocused();
  await labelInput.press("Enter");
  await expect(
    page
      .getByText(`Sequence ${context.sequenceId}: ${context.renamedLabel}`, {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expectOwnedSequence(page, context, context.renamedLabel);

  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function",
  );
  await expectOwnedSequence(page, context, context.renamedLabel);
  await openSequenceEditorPanels(page, context, context.renamedLabel);
  await revealSequenceProperties(page, context.editorPanelId);
  await expect(page.getByLabel("Sequence label")).toHaveValue(
    context.renamedLabel,
  );

  const deleteResult = await page.evaluate(async (sequenceId) => {
    return (window as any).appStores.sendAndAwait({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: sequenceId },
    });
  }, context.sequenceId);
  expect(deleteResult.outcome.type).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate(
        (sequenceUid) =>
          (window as any).appStores.sequences.get()[sequenceUid] ?? null,
        context.sequenceUid,
      ),
    )
    .toBeNull();

  expect(runtimeErrors).toEqual([]);
});
