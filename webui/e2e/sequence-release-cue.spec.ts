// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  cueGridAttributeTimingColumnKey,
  gridCellByIdentifier,
  gridCellByKey,
  gridCellByRowIndex,
} from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CUE_UID = "dddddddddddddddddddddddddddddddd";
const SECOND_CUE_UID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SEQUENCE_UID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SETUP_CUE_UID = "cccccccccccccccccccccccccccccccc";
const RELEASE_CUE_UID = "ffffffffffffffffffffffffffffffff";
const PRIMARY_FIXTURE_ID = 50_501;
const ADDED_FIXTURE_ID = 50_601;
const PRIMARY_FIXTURE_UID = "c5510000000000000000000000000001";
const ADDED_FIXTURE_UID = "c5510000000000000000000000000002";
const BACKEND_CUE_ID = 4;
const BACKEND_CUE_UID = "c5510000000000000000000000000003";
const BACKEND_SEQUENCE_ID = 95_005;
const BACKEND_SEQUENCE_UID = "c5510000000000000000000000000004";
const BACKEND_SETUP_CUE_UID = "c5510000000000000000000000000005";
const BACKEND_RELEASE_CUE_UID = "c5510000000000000000000000000006";
const BACKEND_SEQUENCE_PANEL_ID = "panel-SequenceEditor-release-cue-owned";
const SEEDED_SEQUENCE_PANEL_ID = "panel-SequenceEditor-release-cue-e2e";
const SETUP_CUE_EDITOR_PANEL_ID = `setup-cue-editor-${SEQUENCE_UID}-p0`;
const RELEASE_CUE_EDITOR_PANEL_ID = `release-cue-editor-${SEQUENCE_UID}-p0`;

test.describe.configure({ timeout: 120_000 });

/** Stops backend playback, replaces the showfile, and proves owned stores are blank. */
test.afterEach(async ({ backendSlot, page }) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
    const usesMockWorker = await page
      .evaluate(
        () =>
          typeof (window as any).__releaseCueStoreSequenceCount === "number",
      )
      .catch(() => false);
    if (!usesMockWorker) {
      await page
        .evaluate(async () => {
          const stores = (window as any).appStores;
          if (typeof stores?.sendAndAwait !== "function") return;
          await stores.sendAndAwait({
            module: "InstanceCommand",
            command: { type: "StopAll" },
          });
        })
        .catch(() => undefined);
    }
  }

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedReleaseCueStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0, sequences: 0 });
});

/** Reads every backend store owned by the release-cue scenarios. */
async function ownedReleaseCueStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      sequences: Object.keys(stores.sequences.get()).length,
    };
  });
}

/** Sends one backend command and rejects a failed terminal outcome. */
async function sendCommand(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(async (commandData) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(commandData);
  }, data);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds one RGBI parameter for an owned fixture element. */
function ownedParameter(
  attribute: "Intensity" | "Red" | "Green" | "Blue",
): object {
  return {
    resolution: "Coarse",
    attribute: { type: attribute },
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: "HTP",
    use_grandmaster: attribute === "Intensity",
  };
}

/** Builds one exact single-element RGBI fixture for release-cue coverage. */
function ownedFixture(id: number, uid: string, label: string): object {
  return {
    identifiers: { id, uid, label },
    make: "E2E",
    model: "Release Cue RGBI",
    mode: "Single Element",
    elements: [
      {
        label: "Main",
        parameters: [
          ownedParameter("Intensity"),
          ownedParameter("Red"),
          ownedParameter("Green"),
          ownedParameter("Blue"),
        ],
      },
    ],
  };
}

/** Builds a fixed transition mode from whole seconds. */
function fixed(secs: number): object {
  return { type: "Fixed", data: { secs, nanos: 0 } };
}

/** Builds one resolved RGBI cue instruction for an owned fixture. */
function ownedRedInstruction(fixtureUid: string, value: number): object {
  return {
    selection: {
      source: {
        type: "Resolved",
        data: [{ fixture_uid: fixtureUid, index: null }],
      },
      clauses: [],
    },
    cue_instruction: {
      values: {
        Red: {
          type: "Inline",
          data: { type: "Absolute", data: { value } },
        },
      },
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Builds the regular cue stored for the real command-merge scenario. */
function ownedBackendCue(): object {
  return {
    identifiers: {
      id: BACKEND_CUE_ID,
      uid: BACKEND_CUE_UID,
      label: "Owned Release Source",
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [ownedRedInstruction(PRIMARY_FIXTURE_UID, 255)],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds one sequence metadata cue, optionally with a fixture instruction. */
function ownedMetaCue(
  uid: string,
  label: string,
  instructions: object[],
  trigger: "Manual" | "FollowPrevious",
): object {
  return {
    identifiers: { id: 0, uid, label },
    trigger: { type: trigger },
    transitions: {},
    transitions_by_attribute: {},
    instructions,
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the complete sequence graph used by the real command-merge scenario. */
function ownedBackendSequence(): object {
  return {
    identifiers: {
      id: BACKEND_SEQUENCE_ID,
      uid: BACKEND_SEQUENCE_UID,
      label: "Owned Release Command Merge",
    },
    steps: [BACKEND_CUE_UID],
    wrap: false,
    release_on_start: false,
    setup_cue: ownedMetaCue(BACKEND_SETUP_CUE_UID, "Owned Setup", [], "Manual"),
    release_cue: ownedMetaCue(
      BACKEND_RELEASE_CUE_UID,
      "Owned Release",
      [ownedRedInstruction(PRIMARY_FIXTURE_UID, 255)],
      "FollowPrevious",
    ),
    default_timing: {
      delay_in: fixed(0),
      fade_in: fixed(0),
      curve_in: "Linear",
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: "Linear",
    },
    tracking_mode: { type: "Flags", data: "HTP" },
  };
}

/** Opens a blank showfile and stores only the exact graph requested by a scenario. */
async function openOwnedReleaseCueApp(
  page: Page,
  backendPort: number,
  options: { withBackendGraph?: boolean } = {},
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() => ownedReleaseCueStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0, sequences: 0 });

  await sendCommand(page, {
    module: "FixtureCommand",
    command: {
      type: "StoreFixture",
      data: ownedFixture(
        PRIMARY_FIXTURE_ID,
        PRIMARY_FIXTURE_UID,
        "Owned Release Primary",
      ),
    },
  });
  await sendCommand(page, {
    module: "FixtureCommand",
    command: {
      type: "StoreFixture",
      data: ownedFixture(
        ADDED_FIXTURE_ID,
        ADDED_FIXTURE_UID,
        "Owned Release Added",
      ),
    },
  });

  if (options.withBackendGraph) {
    await sendCommand(page, {
      module: "CueCommand",
      command: { type: "StoreCue", data: ownedBackendCue() },
    });
    await sendCommand(page, {
      module: "CueCommand",
      command: { type: "StoreSequence", data: ownedBackendSequence() },
    });
  }

  await expect
    .poll(() => ownedReleaseCueStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: options.withBackendGraph ? 1 : 0,
      fixtures: 2,
      sequences: options.withBackendGraph ? 1 : 0,
    });
}

/** Returns one sequence editor panel wrapper by its Dockview identity. */
function sequenceEditorPanel(page: Page, panelId: string) {
  return page.locator(
    `[data-component="SequenceEditor"][data-panel-id="${panelId}"]`,
  );
}

/** Returns the grid root owned by one dedicated sequence editor panel. */
function sequenceEditorGrid(page: Page, panelId: string) {
  return sequenceEditorPanel(page, panelId).locator(
    '[data-grid-owner="sequence-editor"]',
  );
}

/** Returns the TanStack grid owned by one dedicated sequence editor panel. */
function sequenceEditorTable(page: Page, panelId: string) {
  return sequenceEditorGrid(page, panelId).locator(
    '[data-grid-kind="tanstack"]',
  );
}

/** Returns the TanStack grid owned by one dedicated cue editor panel. */
function cueEditorGrid(page: Page, panelId: string) {
  return page
    .locator(`[data-component="CueEditor"][data-panel-id="${panelId}"]`)
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
}

/** Returns how many StoreSequence messages the release cue test websocket has seen. */
async function storeSequenceCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as any).__releaseCueStoreSequenceCount ?? 0,
  );
}

/** Verifies release cue projection commits stop after the stored cue catches up. */
async function expectStoreSequenceCommitsToSettle(page: Page) {
  let previous = await storeSequenceCount(page);
  await expect
    .poll(async () => {
      await page.waitForTimeout(100);
      const current = await storeSequenceCount(page);
      const isStable = current === previous;
      previous = current;
      return isStable;
    })
    .toBe(true);

  const stableCount = await storeSequenceCount(page);
  await page.waitForTimeout(250);
  expect(await storeSequenceCount(page)).toBe(stableCount);
}

/** Waits until core stores used by backend-backed release cue tests are ready. */
async function waitForReleaseCueStores(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
}

/** Evaluates an operator command string through the backend command pipeline. */
async function evalCommand(page: Page, command: string) {
  const result = await page.evaluate(async (commandText) => {
    const stores = (window as any).appStores;
    return stores.sendAndAwait({
      module: "DeskCommand",
      command: { type: "Eval", data: commandText },
    });
  }, command);
  expect(result.outcome.type, JSON.stringify(result.outcome)).toBe("Succeeded");
}

/** Opens the release cue editor for the exact backend-owned sequence. */
async function openOwnedBackendReleaseCueEditor(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(
        (sequenceUid) =>
          (window as any).appStores.sequences.get()[sequenceUid]?.identifiers
            ?.id,
        BACKEND_SEQUENCE_UID,
      ),
    )
    .toBe(BACKEND_SEQUENCE_ID);

  const sequenceContext = await page.evaluate((sequenceUid) => {
    const sequence = (window as any).appStores.sequences.get()[sequenceUid];
    if (!sequence) throw new Error(`sequence ${sequenceUid} not found`);
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-SequenceEditor-release-cue-owned";
    api.getPanel(panelId)?.api.close();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: `Sequence ${sequence.identifiers.id}: ${sequence.identifiers.label}`,
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
        initialSequenceUid: sequence.identifiers.uid,
      },
    });
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
    return {
      releaseCueUid: sequence.release_cue.identifiers.uid,
      sequenceUid: sequence.identifiers.uid,
    };
  }, BACKEND_SEQUENCE_UID);

  const sequenceGrid = sequenceEditorGrid(page, BACKEND_SEQUENCE_PANEL_ID);
  const sequenceTable = sequenceEditorTable(page, BACKEND_SEQUENCE_PANEL_ID);
  await expect(sequenceTable).toBeVisible();
  await gridCellByKey(sequenceGrid, {
    columnKey: "cue_id",
    rowKey: `${sequenceContext.releaseCueUid}:cue`,
  }).click();
  await sequenceEditorPanel(page, BACKEND_SEQUENCE_PANEL_ID)
    .getByRole("button", { name: "Open cue part editor" })
    .click();
  const cueEditorPanelId = `release-cue-editor-${sequenceContext.sequenceUid}-p0`;
  await expect(
    page
      .locator(
        `[data-component="CueEditor"][data-panel-id="${cueEditorPanelId}"]`,
      )
      .getByRole("button", { name: "Switch to values display mode" }),
  ).toBeDisabled();
  return {
    cueEditorPanelId,
    sequenceUid: sequenceContext.sequenceUid,
  };
}

/** Seeds an isolated sequence editor state with a normal cue and built-in release cue. */
async function seedReleaseCueEditor(page: Page) {
  await page.evaluate(
    async ({ cueUid, fixtureUid, setupCueUid, releaseCueUid, sequenceUid }) => {
      const stores = (window as any).appStores;
      const { engineRuntime } = await import("/lib/engine-runtime.ts");

      /** Builds a fixed transition mode for seeded sequence timing. */
      const fixed = (secs: number) => ({
        type: "Fixed",
        data: { secs, nanos: 0 },
      });

      const setupCue = {
        identifiers: {
          id: 0,
          uid: setupCueUid,
          label: "Setup Look",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixtureUid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Intensity: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 42 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
        parts: [],
        tracking_flags: "HTP",
      };

      const releaseCue = {
        identifiers: {
          id: 0,
          uid: releaseCueUid,
          label: "Release Fade",
        },
        trigger: { type: "FollowPrevious" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        tracking_flags: "HTP",
      };

      stores.cues.set({
        [cueUid]: {
          identifiers: {
            id: 1,
            uid: cueUid,
            label: "Cue One",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [
            {
              selection: {
                source: {
                  type: "Resolved",
                  data: [{ fixture_uid: fixtureUid, index: null }],
                },
                clauses: [],
              },
              cue_instruction: {
                values: {
                  Intensity: {
                    type: "Inline",
                    data: { type: "Absolute", data: { value: 255 } },
                  },
                },
                transitions: {
                  fade_out: fixed(2),
                },
                transitions_by_attribute: {},
                transitions_by_fixture_attribute: [],
              },
            },
          ],
          parts: [],
          tracking_flags: "HTP",
        },
      });
      stores.sequences.set({
        [sequenceUid]: {
          identifiers: {
            id: 900,
            uid: sequenceUid,
            label: "Release Cue UI",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: setupCue,
          release_cue: releaseCue,
          default_timing: {
            delay_in: fixed(1),
            fade_in: fixed(2),
            curve_in: "Linear",
            delay_out: fixed(3),
            fade_out: fixed(4),
            curve_out: "Linear",
          },
        },
      });

      engineRuntime.isRunning = true;
      (window as any).__releaseCueStoreSequenceCount = 0;
      engineRuntime.worker = {
        postMessage(payload: { data?: any }) {
          const message = payload.data;
          if (
            message?.module === "CueCommand" &&
            message.command?.type === "StoreSequence"
          ) {
            (window as any).__releaseCueStoreSequenceCount += 1;
            const sequence = message.command.data;
            stores.sequences.set({
              ...stores.sequences.get(),
              [sequence.identifiers.uid]: sequence,
            });
          }
        },
      } as unknown as Worker;
    },
    {
      cueUid: CUE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
      setupCueUid: SETUP_CUE_UID,
      releaseCueUid: RELEASE_CUE_UID,
      sequenceUid: SEQUENCE_UID,
    },
  );
}

/** Opens the sequence editor for the seeded sequence. */
async function openReleaseCueEditor(page: Page) {
  await page.evaluate((sequenceUid) => {
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-SequenceEditor-release-cue-e2e";
    api.getPanel(panelId)?.api.close();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence 900: Release Cue UI",
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
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
  }, SEQUENCE_UID);
}

/** Verifies setup and release cue editor panel titles include the sequence cue number. */
test("sequence setup and release cue editor titles include sequence cue number", async ({
  backendSlot,
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await openOwnedReleaseCueApp(page, backendSlot.backendPort);
  await seedReleaseCueEditor(page);
  await openReleaseCueEditor(page);

  const sequenceTable = sequenceEditorTable(page, SEEDED_SEQUENCE_PANEL_ID);
  await expect(sequenceTable).toBeVisible();

  await sequenceTable.locator("#tanstack-cell-0-0").click();
  await sequenceEditorPanel(page, SEEDED_SEQUENCE_PANEL_ID)
    .getByRole("button", { name: "Open cue part editor" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Cue 900.0 (Setup)" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Sequence 900: Release Cue UI" }).click();
  await sequenceTable.locator("#tanstack-cell-0-2").click();
  await sequenceEditorPanel(page, SEEDED_SEQUENCE_PANEL_ID)
    .getByRole("button", { name: "Open cue part editor" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Cue 900.0 (Release)" }),
  ).toBeVisible();

  expect(runtimeErrors).toEqual([]);
});

/** Verifies the setup cue opens as a value-capable sequence-backed cue editor. */
test("sequence setup cue row opens value-capable cue editor", async ({
  backendSlot,
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await openOwnedReleaseCueApp(page, backendSlot.backendPort);
  await seedReleaseCueEditor(page);
  await openReleaseCueEditor(page);

  const sequenceTable = sequenceEditorTable(page, SEEDED_SEQUENCE_PANEL_ID);
  await expect(sequenceTable).toBeVisible();
  await expect(sequenceTable.locator("#tanstack-cell-0-0")).toContainText("0");
  await expect(sequenceTable.locator("#tanstack-cell-1-0")).toContainText(
    "Setup Look",
  );

  await sequenceTable.locator("#tanstack-cell-0-0").click();
  await sequenceEditorPanel(page, SEEDED_SEQUENCE_PANEL_ID)
    .getByRole("button", { name: "Open cue part editor" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Cue 900.0 (Setup)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch to values display mode" }),
  ).toBeEnabled();

  const cueGrid = cueEditorGrid(page, SETUP_CUE_EDITOR_PANEL_ID);
  await expect(cueGrid).toBeVisible();
  await expect(cueGrid.getByText("Intensity")).toBeVisible();
  await expect(cueGrid.getByText("42")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const setupInstruction = (window as any).appStores.sequences.get()[
          sequenceUid
        ]?.setup_cue?.instructions?.[0]?.cue_instruction;
        return setupInstruction?.values?.Intensity?.data?.data?.value;
      }, SEQUENCE_UID),
    )
    .toBe(42);

  expect(runtimeErrors).toEqual([]);
});

/** Verifies sequence setup cue store replacements refresh an already-open cue editor. */
test("sequence setup cue editor refreshes when setup cue attributes change", async ({
  backendSlot,
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await openOwnedReleaseCueApp(page, backendSlot.backendPort);
  await seedReleaseCueEditor(page);
  await openReleaseCueEditor(page);

  const sequenceTable = sequenceEditorTable(page, SEEDED_SEQUENCE_PANEL_ID);
  await expect(sequenceTable).toBeVisible();
  await sequenceTable.locator("#tanstack-cell-0-0").click();
  await sequenceEditorPanel(page, SEEDED_SEQUENCE_PANEL_ID)
    .getByRole("button", { name: "Open cue part editor" })
    .click();

  const cueGrid = cueEditorGrid(page, SETUP_CUE_EDITOR_PANEL_ID);
  await expect(cueGrid).toBeVisible();
  await expect(cueGrid.getByText("Intensity")).toBeVisible();
  await expect(cueGrid.getByText("Red", { exact: true })).toHaveCount(0);

  await page.evaluate((sequenceUid) => {
    const stores = (window as any).appStores;
    const sequence = stores.sequences.get()[sequenceUid];
    const setupCue = JSON.parse(JSON.stringify(sequence.setup_cue));
    setupCue.instructions[0].cue_instruction.values = {
      ...setupCue.instructions[0].cue_instruction.values,
      Red: {
        type: "Inline",
        data: { type: "Absolute", data: { value: 100 } },
      },
    };
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        ...sequence,
        setup_cue: setupCue,
      },
    });
  }, SEQUENCE_UID);

  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const setupInstruction = (window as any).appStores.sequences.get()[
          sequenceUid
        ]?.setup_cue?.instructions?.[0]?.cue_instruction;
        return setupInstruction?.values?.Red?.data?.data?.value;
      }, SEQUENCE_UID),
    )
    .toBe(100);
  await expect(cueGrid.getByText("Red", { exact: true })).toBeVisible();

  expect(runtimeErrors).toEqual([]);
});

/** Verifies moving a regular cue keeps selection on that cue when setup row is present. */
test("sequence editor preserves moved cue selection with setup row", async ({
  backendSlot,
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await openOwnedReleaseCueApp(page, backendSlot.backendPort);
  await seedReleaseCueEditor(page);
  await page.evaluate(
    ({ cueUid, secondCueUid, sequenceUid }) => {
      const stores = (window as any).appStores;
      const cue = stores.cues.get()[cueUid];
      stores.cues.set({
        ...stores.cues.get(),
        [secondCueUid]: {
          ...cue,
          identifiers: {
            id: 2,
            uid: secondCueUid,
            label: "Cue Two",
          },
        },
      });
      const sequence = stores.sequences.get()[sequenceUid];
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequenceUid]: {
          ...sequence,
          steps: [cueUid, secondCueUid],
        },
      });
    },
    {
      cueUid: CUE_UID,
      secondCueUid: SECOND_CUE_UID,
      sequenceUid: SEQUENCE_UID,
    },
  );
  await openReleaseCueEditor(page);

  const sequenceTable = sequenceEditorTable(page, SEEDED_SEQUENCE_PANEL_ID);
  await expect(sequenceTable).toBeVisible();
  await expect(sequenceTable.locator("#tanstack-cell-0-0")).toContainText("0");
  await expect(sequenceTable.locator("#tanstack-cell-0-1")).toContainText("1");
  await expect(sequenceTable.locator("#tanstack-cell-0-2")).toContainText("2");

  await sequenceTable.locator("#tanstack-cell-0-2").click();
  await page.getByRole("button", { name: "Move cue up" }).click();

  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const sequence = (window as any).appStores.sequences.get()[sequenceUid];
        return sequence?.steps ?? [];
      }, SEQUENCE_UID),
    )
    .toEqual([SECOND_CUE_UID, CUE_UID]);
  await expect(sequenceTable.locator("#tanstack-cell-0-1")).toContainText("2");
  await expect(sequenceTable.locator("#tanstack-cell-0-2")).toContainText("1");
  await expect(sequenceTable.locator("#tanstack-cell-0-1")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(sequenceTable.locator("#tanstack-cell-0-2")).toHaveAttribute(
    "data-selected",
    "false",
  );

  expect(runtimeErrors).toEqual([]);
});

/** Verifies the release cue appears in the sequence list and edits through Cue Editor. */
test("sequence release cue row opens sequence-backed cue editor", async ({
  backendSlot,
  page,
}, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await openOwnedReleaseCueApp(page, backendSlot.backendPort);
  await seedReleaseCueEditor(page);
  await openReleaseCueEditor(page);

  const sequenceTable = sequenceEditorTable(page, SEEDED_SEQUENCE_PANEL_ID);
  const sequenceGrid = sequenceEditorGrid(page, SEEDED_SEQUENCE_PANEL_ID);
  await expect(sequenceTable).toBeVisible();
  await expect(sequenceTable.locator("#tanstack-cell-0-0")).toContainText("0");
  await expect(sequenceTable.locator("#tanstack-cell-1-0")).toContainText(
    "Setup Look",
  );
  await expect(sequenceTable.locator("#tanstack-cell-0-1")).toContainText("1");
  await expect(sequenceTable.locator("#tanstack-cell-0-2")).toHaveText("");
  await expect(sequenceTable.locator("#tanstack-cell-1-2")).toContainText(
    "Release Fade",
  );
  const releaseRowKey = `${RELEASE_CUE_UID}:cue`;
  const releaseTriggerCell = gridCellByKey(sequenceGrid, {
    columnKey: "trigger",
    rowKey: releaseRowKey,
  });
  await expect(releaseTriggerCell).toContainText("Follow Previous");
  const cueRowKey = `${CUE_UID}:cue`;
  await expect(
    gridCellByKey(sequenceGrid, { columnKey: "delay_in", rowKey: cueRowKey }),
  ).toContainText("1s");
  await expect(
    gridCellByKey(sequenceGrid, { columnKey: "fade_in", rowKey: cueRowKey }),
  ).toContainText("2s");
  await expect(
    gridCellByKey(sequenceGrid, {
      columnKey: "delay_in",
      rowKey: releaseRowKey,
    }),
  ).toContainText("0s");
  await expect(
    gridCellByKey(sequenceGrid, {
      columnKey: "fade_in",
      rowKey: releaseRowKey,
    }),
  ).toContainText("0s");

  await sequenceTable.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(
    gridCellByKey(sequenceGrid, { columnKey: "delay_out", rowKey: cueRowKey }),
  ).toContainText("3s");
  await expect(
    gridCellByKey(sequenceGrid, { columnKey: "fade_out", rowKey: cueRowKey }),
  ).toContainText("4s");
  await expect(
    gridCellByKey(sequenceGrid, {
      columnKey: "delay_out",
      rowKey: releaseRowKey,
    }),
  ).toContainText("0s");
  await expect(
    gridCellByKey(sequenceGrid, {
      columnKey: "fade_out",
      rowKey: releaseRowKey,
    }),
  ).toContainText("0s");

  const releaseAfterCell = gridCellByKey(sequenceGrid, {
    columnKey: "after_delay",
    rowKey: releaseRowKey,
  });
  await releaseAfterCell.dblclick();
  const releaseAfterEditor = releaseAfterCell.locator("input");
  await expect(releaseAfterEditor).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const trigger = (window as any).appStores.sequences.get()[sequenceUid]
          ?.release_cue?.trigger;
        return trigger?.type;
      }, SEQUENCE_UID),
    )
    .toBe("FollowPrevious");
  await expect(releaseAfterCell).toContainText("0s");

  await page.evaluate((sequenceUid) => {
    const stores = (window as any).appStores;
    const sequence = stores.sequences.get()[sequenceUid];
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        ...sequence,
        wrap: true,
      },
    });
  }, SEQUENCE_UID);
  await expect(releaseTriggerCell).toContainText("Manual");

  await page.evaluate((sequenceUid) => {
    const stores = (window as any).appStores;
    const sequence = stores.sequences.get()[sequenceUid];
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        ...sequence,
        wrap: false,
      },
    });
  }, SEQUENCE_UID);
  await expect(releaseTriggerCell).toContainText("Follow Previous");

  await sequenceTable.locator("#tanstack-cell-0-2").click();
  await sequenceEditorPanel(page, SEEDED_SEQUENCE_PANEL_ID)
    .getByRole("button", { name: "Open cue part editor" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Cue 900.0 (Release)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch to values display mode" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Switch to timings display mode" }),
  ).toBeVisible();

  const cueGrid = cueEditorGrid(page, RELEASE_CUE_EDITOR_PANEL_ID);
  await expect(cueGrid).toBeVisible();
  await expect(
    cueGrid.locator('[data-grid-header-id$="group:Intensity"]'),
  ).toContainText("Intensity");
  await expectStoreSequenceCommitsToSettle(page);

  await page.evaluate((sequenceUid) => {
    const stores = (window as any).appStores;
    const sequence = stores.sequences.get()[sequenceUid];
    const releaseCue = JSON.parse(JSON.stringify(sequence.release_cue));
    releaseCue.instructions[0].cue_instruction.transitions = {
      fade_out: {
        type: "Fixed",
        data: { secs: 7, nanos: 0 },
      },
    };
    releaseCue.instructions[0].cue_instruction.transitions_by_attribute = {
      Intensity: {
        fade_out: {
          type: "Fixed",
          data: { secs: 8, nanos: 0 },
        },
      },
    };
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        ...sequence,
        release_cue: releaseCue,
      },
    });
  }, SEQUENCE_UID);
  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const instruction = (window as any).appStores.sequences.get()[
          sequenceUid
        ]?.release_cue?.instructions?.[0]?.cue_instruction;
        return {
          copiedCueFadeOut: instruction?.transitions?.fade_out?.data?.secs,
          copiedAttributeFadeOut:
            instruction?.transitions_by_attribute?.Intensity?.fade_out?.data
              ?.secs,
        };
      }, SEQUENCE_UID),
    )
    .toEqual({
      copiedCueFadeOut: undefined,
      copiedAttributeFadeOut: undefined,
    });

  const fixtureIdCell = gridCellByRowIndex(cueGrid, {
    columnKey: "id",
    rowIndex: 0,
  });
  await expect(fixtureIdCell).toContainText(/\d+/);

  const fixtureFadeOutCell = gridCellByRowIndex(cueGrid, {
    columnKey: cueGridAttributeTimingColumnKey("Intensity", "fade_out"),
    rowIndex: 0,
  });
  await fixtureFadeOutCell.dblclick();
  const editor = fixtureFadeOutCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("3s");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const sequence = (window as any).appStores.sequences.get()[sequenceUid];
        const transition =
          sequence?.release_cue?.instructions?.[0]?.cue_instruction
            ?.transitions_by_fixture_attribute?.[0];
        const scaffoldedValue =
          sequence?.release_cue?.instructions?.[0]?.cue_instruction?.values
            ?.Intensity?.data?.data?.value;
        const copiedCueFadeOut =
          sequence?.release_cue?.instructions?.[0]?.cue_instruction?.transitions
            ?.fade_out?.data?.secs;
        const copiedAttributeFadeOut =
          sequence?.release_cue?.instructions?.[0]?.cue_instruction
            ?.transitions_by_attribute?.Intensity?.fade_out?.data?.secs;
        return {
          hasFixtureUid: typeof transition?.fixture?.fixture_uid === "string",
          fadeOut:
            transition?.transitions_by_attribute?.Intensity?.fade_out?.data
              ?.secs,
          scaffoldedValue,
          copiedCueFadeOut,
          copiedAttributeFadeOut,
        };
      }, SEQUENCE_UID),
    )
    .toEqual({
      hasFixtureUid: true,
      fadeOut: 3,
      scaffoldedValue: 255,
      copiedCueFadeOut: undefined,
      copiedAttributeFadeOut: undefined,
    });

  const addedFixture = await page.evaluate(
    ({ cueUid, fixtureId, fixtureUid, sequenceUid }) => {
      const stores = (window as any).appStores;
      const cue = stores.cues.get()[cueUid];

      const updatedCue = JSON.parse(JSON.stringify(cue));
      updatedCue.instructions[0].selection.source.data.push({
        fixture_uid: fixtureUid,
        index: null,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: updatedCue,
      });
      return {
        id: fixtureId,
        uid: fixtureUid,
        releaseRows:
          stores.sequences.get()[sequenceUid]?.release_cue?.instructions
            ?.length ?? 0,
      };
    },
    {
      cueUid: CUE_UID,
      fixtureId: ADDED_FIXTURE_ID,
      fixtureUid: ADDED_FIXTURE_UID,
      sequenceUid: SEQUENCE_UID,
    },
  );

  await expect
    .poll(async () =>
      page.evaluate((sequenceUid) => {
        const sequence = (window as any).appStores.sequences.get()[sequenceUid];
        return {
          releaseRows:
            sequence?.release_cue?.instructions?.[0]?.selection?.source?.data
              ?.length,
          projectedFixture:
            sequence?.release_cue?.instructions?.[0]?.selection?.source
              ?.data?.[1]?.fixture_uid,
          copiedValue:
            sequence?.release_cue?.instructions?.[0]?.cue_instruction?.values
              ?.Intensity?.data?.data?.value,
          sourceFadeOut:
            sequence?.release_cue?.instructions?.[0]?.cue_instruction
              ?.transitions?.fade_out?.data?.secs,
        };
      }, SEQUENCE_UID),
    )
    .toEqual({
      releaseRows: 2,
      projectedFixture: addedFixture.uid,
      copiedValue: 255,
      sourceFadeOut: undefined,
    });
  await expect(
    await gridCellByIdentifier(cueGrid, {
      columnKey: "id",
      identifierColumnKey: "id",
      identifierText: String(addedFixture.id),
    }),
  ).toContainText(String(addedFixture.id));

  const addedFixtureFadeOutCell = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeTimingColumnKey("Intensity", "fade_out"),
    identifierColumnKey: "id",
    identifierText: String(addedFixture.id),
  });
  await addedFixtureFadeOutCell.dblclick();
  const addedFixtureEditor = addedFixtureFadeOutCell.locator("input");
  await expect(addedFixtureEditor).toBeVisible();
  await addedFixtureEditor.fill("4s");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(
        ({ sequenceUid, fixtureUid }) => {
          const sequence = (window as any).appStores.sequences.get()[
            sequenceUid
          ];
          const transition =
            sequence?.release_cue?.instructions?.[0]?.cue_instruction?.transitions_by_fixture_attribute?.find(
              (entry: any) => entry.fixture?.fixture_uid === fixtureUid,
            );
          return {
            releaseRows:
              sequence?.release_cue?.instructions?.[0]?.selection?.source?.data
                ?.length,
            fadeOut:
              transition?.transitions_by_attribute?.Intensity?.fade_out?.data
                ?.secs,
          };
        },
        { sequenceUid: SEQUENCE_UID, fixtureUid: addedFixture.uid },
      ),
    )
    .toEqual({
      releaseRows: 2,
      fadeOut: 4,
    });
  await page.screenshot({
    path: testInfo.outputPath("owned-projected-release-cue.png"),
  });

  expect(runtimeErrors).toEqual([]);
});

/** Verifies a command merge preserves fixture timing in an owned release cue. */
test("sequence release cue keeps timing edits for command-merged fixtures", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedReleaseCueApp(page, backendSlot.backendPort, {
    withBackendGraph: true,
  });
  await waitForReleaseCueStores(page);

  const { cueEditorPanelId, sequenceUid } =
    await openOwnedBackendReleaseCueEditor(page);
  const cueGrid = cueEditorGrid(page, cueEditorPanelId);

  await evalCommand(page, `fix ${ADDED_FIXTURE_ID} red @ 100`);
  await evalCommand(page, "sleep 1");
  await evalCommand(
    page,
    `store cue ${BACKEND_SEQUENCE_ID}.${BACKEND_CUE_ID} /merge`,
  );

  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ cueId, fixtureUid, sequenceUid }) => {
            const stores = (window as any).appStores;
            const sequence = stores.sequences.get()[sequenceUid];
            const cues = stores.cues.get();
            const sourceCue = sequence.steps
              .map((cueUid: string) => cues[cueUid])
              .find((item: any) => item.identifiers.id === cueId);
            const sourceCueHasFixture = sourceCue?.instructions?.some(
              (instruction: any) =>
                instruction.selection?.source?.data?.some(
                  (ref: any) => ref.fixture_uid === fixtureUid,
                ),
            );
            const releaseCueHasFixture = sequence.release_cue.instructions.some(
              (instruction: any) =>
                instruction.selection?.source?.data?.some(
                  (ref: any) => ref.fixture_uid === fixtureUid,
                ),
            );
            return { releaseCueHasFixture, sourceCueHasFixture };
          },
          {
            cueId: BACKEND_CUE_ID,
            fixtureUid: ADDED_FIXTURE_UID,
            sequenceUid,
          },
        ),
      { timeout: 15_000 },
    )
    .toEqual({ releaseCueHasFixture: true, sourceCueHasFixture: true });

  await expect(
    cueEditorGrid(page, cueEditorPanelId)
      .getByText(String(ADDED_FIXTURE_ID))
      .first(),
  ).toBeVisible();

  const existingRedFadeOutCell = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeTimingColumnKey("Red", "fade_out"),
    identifierColumnKey: "id",
    identifierText: String(PRIMARY_FIXTURE_ID),
  });
  await existingRedFadeOutCell.dblclick();
  const existingEditor = existingRedFadeOutCell.locator("input");
  await expect(existingEditor).toBeVisible();
  await existingEditor.fill("5s");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(
        ({ sequenceUid, fixtureUid }) => {
          const sequence = (window as any).appStores.sequences.get()[
            sequenceUid
          ];
          const transition = sequence.release_cue.instructions
            .flatMap(
              (instruction: any) =>
                instruction.cue_instruction.transitions_by_fixture_attribute ??
                [],
            )
            .find((entry: any) => entry.fixture?.fixture_uid === fixtureUid);
          return transition?.transitions_by_attribute?.Red?.fade_out?.data
            ?.secs;
        },
        { sequenceUid, fixtureUid: PRIMARY_FIXTURE_UID },
      ),
    )
    .toBe(5);
  await expect(existingRedFadeOutCell).toContainText("5s");

  const redFadeOutCell = await gridCellByIdentifier(cueGrid, {
    columnKey: cueGridAttributeTimingColumnKey("Red", "fade_out"),
    identifierColumnKey: "id",
    identifierText: String(ADDED_FIXTURE_ID),
  });
  await redFadeOutCell.dblclick();
  const editor = redFadeOutCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("4s");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(
        ({ sequenceUid, fixtureUid }) => {
          const sequence = (window as any).appStores.sequences.get()[
            sequenceUid
          ];
          const redInstruction = sequence.release_cue.instructions.find(
            (instruction: any) =>
              instruction.selection?.source?.data?.some(
                (ref: any) => ref.fixture_uid === fixtureUid,
              ),
          );
          const transition =
            redInstruction?.cue_instruction?.transitions_by_fixture_attribute?.find(
              (entry: any) => entry.fixture?.fixture_uid === fixtureUid,
            );
          return transition?.transitions_by_attribute?.Red?.fade_out?.data
            ?.secs;
        },
        { sequenceUid, fixtureUid: ADDED_FIXTURE_UID },
      ),
    )
    .toBe(4);
  await expect(redFadeOutCell).toContainText("4s");

  await evalCommand(page, `fix ${ADDED_FIXTURE_ID} red @ 50`);
  await evalCommand(page, "sleep 1");
  await evalCommand(
    page,
    `store cue ${BACKEND_SEQUENCE_ID}.${BACKEND_CUE_ID} /merge`,
  );

  await expect
    .poll(async () =>
      page.evaluate(
        ({ sequenceUid, fixtureUid }) => {
          const sequence = (window as any).appStores.sequences.get()[
            sequenceUid
          ];
          const redInstruction = sequence.release_cue.instructions.find(
            (instruction: any) =>
              instruction.selection?.source?.data?.some(
                (ref: any) => ref.fixture_uid === fixtureUid,
              ),
          );
          const transition =
            redInstruction?.cue_instruction?.transitions_by_fixture_attribute?.find(
              (entry: any) => entry.fixture?.fixture_uid === fixtureUid,
            );
          return transition?.transitions_by_attribute?.Red?.fade_out?.data
            ?.secs;
        },
        { sequenceUid, fixtureUid: ADDED_FIXTURE_UID },
      ),
    )
    .toBe(4);
  await page.screenshot({
    path: testInfo.outputPath("owned-command-merged-release-cue.png"),
  });
});
