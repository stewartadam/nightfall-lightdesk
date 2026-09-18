// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CUE_EDITOR_PANEL_ID = "panel-CueEditor-store-mode-row-regression";

/** Reads the backend-owned stores that must be blank outside each scenario. */
async function ownedStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      clips: Object.keys(stores.clips.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      programmer: stores.programmerState.get().length,
      sequences: Object.keys(stores.sequences.get()).length,
    };
  });
}

/**
 * Waits until the application stores required by store-cue regression tests exist.
 */
async function waitForAppStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.programmerState?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
}

/** Opens the UI against a fresh blank backend for one Store Cue scenario. */
async function openOwnedStoreCueApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await waitForAppStores(page);
  await expect
    .poll(() => ownedStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      programmer: 0,
      sequences: 0,
    });
}

/** Resets one backend after a scenario and proves all relevant stores are blank. */
async function resetOwnedStoreCueApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.reload();
  await waitForDockviewApp(page);
  await waitForAppStores(page);
  await expect
    .poll(() => ownedStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      programmer: 0,
      sequences: 0,
    });
}

/**
 * Sends a websocket command and verifies its correlated backend result.
 */
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

/**
 * Builds an attribute parameter for a synthetic multi-element fixture.
 */
function parameter(attribute: "Intensity" | "Red" | "Green" | "Blue"): object {
  return {
    resolution: "Coarse",
    attribute: { type: attribute },
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: "HTP",
    use_grandmaster: false,
  };
}

/**
 * Builds a synthetic RGBI fixture with three controllable elements.
 */
function fixture(fixtureId: number, fixtureUid: string): object {
  return {
    identifiers: {
      id: fixtureId,
      uid: fixtureUid,
      label: `Store Mode Fixture ${fixtureId}`,
    },
    make: "E2E",
    model: "Store Mode Pixel Bar",
    mode: "3 cell RGB",
    elements: [1, 2, 3].map((index) => ({
      label: `Cell ${index}`,
      parameters: [
        parameter("Intensity"),
        parameter("Red"),
        parameter("Green"),
        parameter("Blue"),
      ],
    })),
  };
}

/**
 * Builds an inline absolute-percent cue value.
 */
function inlinePercent(value: number): object {
  return {
    type: "Inline",
    data: { type: "AbsolutePercent", data: { value } },
  };
}

/**
 * Builds a fixed transition mode for sequence defaults.
 */
function fixed(secs: number, nanos = 0): object {
  return {
    type: "Fixed",
    data: { secs, nanos },
  };
}

/**
 * Builds a deterministic metadata cue UID from a sequence UID and suffix.
 */
function sequenceMetaCueUid(sequenceUid: string, suffix: string): string {
  return sequenceUid.replace(/[0-9a-f]{12}$/i, suffix);
}

/**
 * Builds an empty setup or release meta-cue for a sequence definition.
 */
function metaCue(cueUid: string, label: string): object {
  return {
    identifiers: {
      id: 0,
      uid: cueUid,
      label,
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/**
 * Builds a legacy dirty cue instruction that stores a whole fixture as all elements.
 */
function legacyAllElementInstruction(fixtureUid: string): object {
  return {
    selection: {
      source: {
        type: "Resolved",
        data: [1, 2, 3].map((index) => ({
          fixture_uid: fixtureUid,
          index,
        })),
      },
      clauses: [],
    },
    cue_instruction: {
      values: {
        Red: inlinePercent(0.7),
        Green: inlinePercent(0.7),
        Blue: inlinePercent(0.7),
      },
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/**
 * Builds a cue whose visible rows are fixture-wide but whose selections are element-expanded.
 */
function legacyElementExpandedCue(
  cueId: number,
  cueUid: string,
  fixtureUids: string[],
): object {
  return {
    identifiers: {
      id: cueId,
      uid: cueUid,
      label: `Cue ${cueId}`,
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: fixtureUids.map(legacyAllElementInstruction),
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds a cue with one whole-fixture row and explicit attribute values. */
function cueWithFixtureValues(
  cueId: number,
  cueUid: string,
  fixtureUid: string,
  values: Record<string, object>,
): object {
  return {
    identifiers: {
      id: cueId,
      uid: cueUid,
      label: `Cue ${cueId}`,
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
          values,
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/**
 * Builds a sequence containing one cue step.
 */
function sequence(
  sequenceId: number,
  sequenceUid: string,
  cueUid: string,
): object {
  return {
    identifiers: {
      id: sequenceId,
      uid: sequenceUid,
      label: `Sequence ${sequenceId}`,
    },
    steps: [cueUid],
    references: {},
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue(
      sequenceMetaCueUid(sequenceUid, "000000000000"),
      "Setup",
    ),
    release_cue: metaCue(
      sequenceMetaCueUid(sequenceUid, "000000000002"),
      "Release",
    ),
    default_timing: {
      delay_in: fixed(0),
      fade_in: fixed(0),
      curve_in: "Linear",
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: "Linear",
    },
    tracking_mode: { type: "Inherit" },
  };
}

/**
 * Evaluates a command string through the same path as the header command input.
 */
async function evalCommand(page: Page, command: string): Promise<void> {
  const result = await page.evaluate(async (commandText) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait({
      module: "DeskCommand",
      command: { type: "Eval", data: commandText },
    });
  }, command);
  expect(result.outcome.type, JSON.stringify(result.outcome)).toBe("Succeeded");
}

/**
 * Waits long enough for the 5 FPS backend frame loop to process prior commands.
 */
async function waitForBackendFrame(page: Page): Promise<void> {
  await page.waitForTimeout(500);
}

/**
 * Waits for all requested fixture IDs to appear in the fixture store.
 */
async function waitForFixtureIds(
  page: Page,
  expectedFixtureIds: number[],
): Promise<void> {
  await page.waitForFunction(
    (expectedFixtureIds) => {
      const fixtures = (window as any).appStores.fixtures.get();
      return expectedFixtureIds.every((fixtureId) =>
        Object.values(fixtures).some(
          (item: any) => item.identifiers.id === fixtureId,
        ),
      );
    },
    expectedFixtureIds,
    { timeout: 5_000 },
  );
}

/**
 * Waits for the stored cue to reach the expected instruction count.
 */
async function waitForStoredCueRows(
  page: Page,
  sequenceId: number,
  cueId: number,
  expectedRows: number,
): Promise<void> {
  await page.waitForFunction(
    ({ sequenceId: targetSequenceId, cueId: targetCueId, expectedRows }) => {
      const stores = (window as any).appStores;
      const sequences = stores.sequences.get();
      const cues = stores.cues.get();
      const sequence = Object.values(sequences).find(
        (item: any) => item.identifiers.id === targetSequenceId,
      ) as any;
      const cueUid = sequence?.steps?.find(
        (uid: string) => cues[uid]?.identifiers?.id === targetCueId,
      );
      return cues[cueUid]?.instructions?.length === expectedRows;
    },
    { sequenceId, cueId, expectedRows },
    { timeout: 5_000 },
  );
}

/**
 * Returns the stored cue matching the requested sequence and cue IDs.
 */
async function storedCueContext(
  page: Page,
  sequenceId: number,
  cueId: number,
): Promise<{ cueUid: string }> {
  return page.evaluate(
    ({ sequenceId: targetSequenceId, cueId: targetCueId }) => {
      const stores = (window as any).appStores;
      const sequences = stores.sequences.get();
      const cues = stores.cues.get();
      const sequence = Object.values(sequences).find(
        (item: any) => item.identifiers.id === targetSequenceId,
      ) as any;
      if (!sequence) throw new Error(`sequence ${targetSequenceId} not found`);
      const cueUid = sequence.steps.find(
        (uid: string) => cues[uid]?.identifiers?.id === targetCueId,
      );
      if (!cueUid) throw new Error(`cue ${targetCueId} not found`);
      return { cueUid };
    },
    { sequenceId, cueId },
  );
}

/**
 * Opens the cue editor for the stored test cue.
 */
async function openCueEditor(page: Page, cueUid: string): Promise<void> {
  await page.evaluate(
    ({ panelId, targetCueUid }) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      let panel = api.getPanel(panelId);
      if (!panel) {
        panel = api.addPanel({
          id: panelId,
          component: "CueEditor",
          title: "Store Mode Row Regression",
          position: {
            referencePanel: "panel-FixtureGrid",
            direction: "within",
          },
          params: {
            initialPanelId: panelId,
            initialCueUid: targetCueUid,
          },
        });
      }
      panel.api.setActive();
      panel.focus();
    },
    { panelId: CUE_EDITOR_PANEL_ID, targetCueUid: cueUid },
  );
}

/**
 * Verifies the cue editor grid shows only the expected whole-fixture rows.
 */
async function expectWholeFixtureRows(
  page: Page,
  expectedFixtureIds: string[],
): Promise<void> {
  const grid = page
    .locator(`[data-panel-id="${CUE_EDITOR_PANEL_ID}"]`)
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await expect
    .poll(async () => grid.locator('[id^="tanstack-cell-0-"]').count())
    .toBe(expectedFixtureIds.length);

  for (const [index, fixtureId] of expectedFixtureIds.entries()) {
    await expect(grid.locator(`#tanstack-cell-0-${index}`)).toContainText(
      fixtureId,
    );
  }
}

/**
 * Verifies store cue merge/remove keep fixture-wide rows for multi-element fixture ranges.
 */
test("store cue modes keep fixture range rows fixture-wide in cue editor", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  const sequenceId = 991;
  const cueId = 1;
  const startFixtureId = 9911;
  const endFixtureId = 9912;
  const startFixtureUid = "99110000-0000-0000-0000-000000000001";
  const endFixtureUid = "99120000-0000-0000-0000-000000000002";
  const seededCueUid = "99100000-0000-0000-0000-000000000001";
  const sequenceUid = "99100000-0000-0000-0000-000000000099";
  const fixtureIds = [String(startFixtureId), String(endFixtureId)];

  await openOwnedStoreCueApp(page, backendSlot.backendPort);

  try {
    await sendCommand(page, {
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: fixture(startFixtureId, startFixtureUid),
      },
    });
    await waitForFixtureIds(page, [startFixtureId]);
    await sendCommand(page, {
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: fixture(endFixtureId, endFixtureUid),
      },
    });
    await waitForFixtureIds(page, [startFixtureId, endFixtureId]);

    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: legacyElementExpandedCue(cueId, seededCueUid, [
          startFixtureUid,
          endFixtureUid,
        ]),
      },
    });
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: sequence(sequenceId, sequenceUid, seededCueUid),
      },
    });
    await waitForStoredCueRows(page, sequenceId, cueId, 2);

    await sendCommand(page, {
      module: "ProgrammerCommand",
      command: { type: "ClearProgrammer" },
    });
    await waitForBackendFrame(page);
    await evalCommand(page, `fix ${startFixtureId}>${endFixtureId} red @ 10`);
    await waitForBackendFrame(page);
    await evalCommand(page, `store cue ${sequenceId}.${cueId} /merge`);
    await waitForStoredCueRows(page, sequenceId, cueId, 2);

    const { cueUid } = await storedCueContext(page, sequenceId, cueId);
    await openCueEditor(page, cueUid);
    await expectWholeFixtureRows(page, fixtureIds);

    await sendCommand(page, {
      module: "ProgrammerCommand",
      command: { type: "ClearProgrammer" },
    });
    await waitForBackendFrame(page);
    await evalCommand(page, `fix ${startFixtureId}>${endFixtureId} red @ 10`);
    await waitForBackendFrame(page);
    await evalCommand(page, `store cue ${sequenceId}.${cueId} /remove`);
    await waitForStoredCueRows(page, sequenceId, cueId, 2);

    await expectWholeFixtureRows(page, fixtureIds);
    const cueGrid = page
      .locator(`[data-panel-id="${CUE_EDITOR_PANEL_ID}"]`)
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(cueGrid.getByText("Red", { exact: true })).toHaveCount(0);
    await expect(cueGrid.getByText("Green", { exact: true })).toBeVisible();
    await expect(cueGrid.getByText("Blue", { exact: true })).toBeVisible();
  } finally {
    await resetOwnedStoreCueApp(page, backendSlot.backendPort);
  }
});

/** Verifies storing into an open cue editor coalesces fixture rows and refreshes columns. */
test("store cue replace updates an open cue editor with merged fixture attributes", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  const sequenceId = 993;
  const cueId = 1;
  const fixtureId = 311;
  const fixtureUid = "99300000-0000-0000-0000-000000000311";
  const seededCueUid = "99300000-0000-0000-0000-000000000001";
  const sequenceUid = "99300000-0000-0000-0000-000000000099";

  await openOwnedStoreCueApp(page, backendSlot.backendPort);

  try {
    await sendCommand(page, {
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: fixture(fixtureId, fixtureUid),
      },
    });
    await waitForFixtureIds(page, [fixtureId]);
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: cueWithFixtureValues(cueId, seededCueUid, fixtureUid, {
          Red: inlinePercent(1),
        }),
      },
    });
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: sequence(sequenceId, sequenceUid, seededCueUid),
      },
    });
    await waitForStoredCueRows(page, sequenceId, cueId, 1);

    const { cueUid } = await storedCueContext(page, sequenceId, cueId);
    await openCueEditor(page, cueUid);
    await expectWholeFixtureRows(page, [String(fixtureId)]);
    const cueGrid = page
      .locator(`[data-panel-id="${CUE_EDITOR_PANEL_ID}"]`)
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(cueGrid.getByText("Red", { exact: true })).toBeVisible();

    await evalCommand(page, `recall cue ${sequenceId}.${cueId}`);
    await waitForBackendFrame(page);
    await evalCommand(page, `fix ${fixtureId} int @ 100`);
    await waitForBackendFrame(page);
    await evalCommand(page, `store cue ${sequenceId}.${cueId}`);
    await waitForStoredCueRows(page, sequenceId, cueId, 1);

    await expectWholeFixtureRows(page, [String(fixtureId)]);
    await expect(cueGrid.getByText("Red", { exact: true })).toBeVisible();
    await expect(cueGrid.getByText("Intensity", { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate((targetCueUid) => {
          const cue = (window as any).appStores.cues.get()[targetCueUid];
          const values = cue?.instructions?.[0]?.cue_instruction?.values ?? {};
          return {
            rows: cue?.instructions?.length ?? 0,
            attrs: Object.keys(values).sort(),
          };
        }, cueUid),
      )
      .toEqual({ rows: 1, attrs: ["Intensity", "Red"] });
  } finally {
    await resetOwnedStoreCueApp(page, backendSlot.backendPort);
  }
});
