// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  cueGridAttributeTimingColumnKey,
  cueGridAttributeValueColumnKey,
  gridCellByIdentifier,
  gridCellByKey,
  gridCellByRowIndex,
  gridHeaderByColumnKey,
} from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CUE_EDITOR_EMPTY_VALUE_BACKGROUND = "rgb(22, 22, 27)";
const CUE_EDITOR_ASSERTED_VALUE_BACKGROUND = "rgb(26, 26, 31)";
const PRIMARY_FIXTURE_ID = 96_100;
const PRIMARY_FIXTURE_UID = "c7200000000000000000000000000001";
const SECONDARY_FIXTURE_ID = 96_101;
const SECONDARY_FIXTURE_UID = "c7200000000000000000000000000002";
const BASE_CUE_ID = 96_100;
const BASE_CUE_UID = "c7200000000000000000000000000003";
const SETUP_CUE_UID = "c7200000000000000000000000000004";
const RELEASE_CUE_UID = "c7200000000000000000000000000005";
const BASE_SEQUENCE_ID = 96_100;
const BASE_SEQUENCE_UID = "c7200000000000000000000000000006";
const MARKER_CUE_ID = 96_101;
const MARKER_CUE_UID = "c7200000000000000000000000000007";
const MARKER_SEQUENCE_ID = 96_101;
const MARKER_SEQUENCE_UID = "c7200000000000000000000000000008";

test.describe.configure({ timeout: 180_000 });

/** Stops preview instance, replaces the backend, and proves owned state is blank. */
test.afterEach(async ({ backendSlot, page }) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
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

  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedCueEditorStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0, sequences: 0 });
});

/** Reads every browser store owned by the cue editor scenarios. */
async function ownedCueEditorStoreCounts(page: Page): Promise<object> {
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

/** Builds one standard eight-bit parameter for an owned fixture element. */
function ownedParameter(
  attribute: "Intensity" | "Red" | "Green" | "Blue" | "White" | "Amber",
): object {
  return {
    resolution: "Coarse",
    attribute: { type: attribute },
    value_polarity: "Unsigned",
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: "HTP",
    use_grandmaster: attribute === "Intensity",
  };
}

/** Builds the exact two-element fixture used by aggregation scenarios. */
function ownedPrimaryFixture(): object {
  const attributes = ["Intensity", "Red", "Green", "Blue", "White"] as const;
  return {
    identifiers: {
      id: PRIMARY_FIXTURE_ID,
      uid: PRIMARY_FIXTURE_UID,
      label: "Owned Cue Editor Primary",
    },
    make: "E2E",
    model: "Cue Editor RGBIW",
    mode: "Two Element",
    elements: [1, 2].map((index) => ({
      label: `Cell ${index}`,
      parameters: attributes.map(ownedParameter),
    })),
  };
}

/** Builds the exact one-element fixture used by cross-fixture scenarios. */
function ownedSecondaryFixture(): object {
  const attributes = [
    "Intensity",
    "Red",
    "Green",
    "Blue",
    "White",
    "Amber",
  ] as const;
  return {
    identifiers: {
      id: SECONDARY_FIXTURE_ID,
      uid: SECONDARY_FIXTURE_UID,
      label: "Owned Cue Editor Secondary",
    },
    make: "E2E",
    model: "Cue Editor RGBIWA",
    mode: "Single Element",
    elements: [
      {
        label: "Cell 1",
        parameters: attributes.map(ownedParameter),
      },
    ],
  };
}

/** Builds a complete empty cue for sequence setup and release metadata. */
function ownedMetaCue(uid: string, label: string): object {
  return {
    identifiers: { id: 0, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the exact empty base cue customized by each editor scenario. */
function ownedBaseCue(): object {
  return {
    identifiers: {
      id: BASE_CUE_ID,
      uid: BASE_CUE_UID,
      label: "Owned Cue Editor Base",
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    lookahead: false,
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the exact base sequence containing the owned cue. */
function ownedBaseSequence(): object {
  const zero = { type: "Fixed", data: { secs: 0, nanos: 0 } };
  return {
    identifiers: {
      id: BASE_SEQUENCE_ID,
      uid: BASE_SEQUENCE_UID,
      label: "Owned Cue Editor Sequence",
    },
    steps: [BASE_CUE_UID],
    wrap: false,
    release_on_start: false,
    setup_cue: ownedMetaCue(SETUP_CUE_UID, "Owned Setup"),
    release_cue: ownedMetaCue(RELEASE_CUE_UID, "Owned Release"),
    default_timing: {
      delay_in: zero,
      fade_in: zero,
      curve_in: "Linear",
      delay_out: zero,
      fade_out: zero,
      curve_out: "Linear",
    },
    tracking_mode: { type: "Inherit" },
  };
}

/** Opens a blank backend and stores only the shared cue editor graph. */
async function openOwnedCueEditorApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
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
    .poll(() => ownedCueEditorStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0, sequences: 0 });

  for (const fixture of [ownedPrimaryFixture(), ownedSecondaryFixture()]) {
    await sendCommandAndAwait(page, {
      module: "FixtureCommand",
      command: { type: "StoreFixture", data: fixture },
    });
  }
  await sendCommandAndAwait(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: ownedBaseCue() },
  });
  await sendCommandAndAwait(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: ownedBaseSequence() },
  });
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const ownedMetadata = [
      ["Intensity", "Dimmer"],
      ["Red", "Color"],
      ["Green", "Color"],
      ["Blue", "Color"],
      ["White", "Color"],
      ["Amber", "Color"],
    ].map(([attribute, category], index) => ({
      key: attribute,
      attribute: { type: attribute },
      label: attribute,
      category,
      sort_order: index + 1,
    }));
    const ownedKeys = new Set(ownedMetadata.map(({ key }) => key));
    stores.attributeMetadata.set([
      ...(stores.attributeMetadata.get?.() ?? []).filter(
        ({ key }: { key: string }) => !ownedKeys.has(key),
      ),
      ...ownedMetadata,
    ]);
  });
  await expect
    .poll(() => ownedCueEditorStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 1, fixtures: 2, sequences: 1 });
  await waitForCueEditorStores(page);
}

/**
 * Returns whether the cue editor's browser-side stores have loaded show data.
 */
async function cueEditorStoresReady(page: Page): Promise<boolean> {
  return page
    .evaluate(
      () =>
        typeof (window as any).appStores?.send === "function" &&
        Boolean((window as any).appStores?.dockApi?.get?.()) &&
        Object.keys((window as any).appStores?.fixtures?.get?.() ?? {}).length >
          0 &&
        Object.keys((window as any).appStores?.cues?.get?.() ?? {}).length > 0,
    )
    .catch(() => false);
}

/**
 * Waits for the app shell stores needed by cue editor tests.
 */
async function waitForCueEditorStores(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  await expect
    .poll(() => cueEditorStoresReady(page), { timeout: 30_000 })
    .toBe(true);
  await closeCueEditorPanels(page);
}

/**
 * Closes existing Cue Editor panels so tests bind to their seeded editor grid.
 */
async function closeCueEditorPanels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores?.dockApi?.get?.();
    for (const panel of [...(api?.panels ?? [])]) {
      const id = String(panel.id ?? "");
      if (id.includes("CueEditor") || id.startsWith("cue-editor-")) {
        panel.api.close();
      }
    }
  });
}

/**
 * Returns the Dockview active panel ID from the browser-side app stores.
 */
async function activeDockPanelId(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => (window as any).appStores?.dockApi?.get?.()?.activePanel?.id,
  );
}

/**
 * Sends a websocket command and asserts that the backend accepted it.
 */
async function sendCommandAndAwait(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(async (commandData) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(commandData);
  }, data);
  expect(result.outcome.type, JSON.stringify(result.outcome)).toBe("Succeeded");
}

/**
 * Sends an undo-stack command through the websocket command path.
 */
async function sendUndoCommandAndAwait(
  page: Page,
  type: "Undo" | "Redo" | "ClearHistory",
): Promise<void> {
  await sendCommandAndAwait(page, {
    module: "UndoCommand",
    command: { type, data: {} },
  });
}

/**
 * Waits for the engine frame that finalizes the pending undo batch.
 */
async function waitForUndoBatchToFinalize(page: Page): Promise<void> {
  await page.waitForTimeout(500);
}

/**
 * Locates the cue editor grid for one Dockview panel instance.
 */
function cueEditorGridForPanel(page: Page, panelId: string): Locator {
  return page
    .locator(`[data-cue-editor-panel-id=${JSON.stringify(panelId)}]`)
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
}

/** Activates one Cue Editor panel and waits for its rendered surface. */
async function activateCueEditorPanel(
  page: Page,
  panelId: string,
): Promise<void> {
  await page.evaluate((targetPanelId) => {
    const panel = (window as any).appStores?.dockApi
      ?.get?.()
      ?.getPanel(targetPanelId);
    if (!panel) throw new Error(`expected Cue Editor panel ${targetPanelId}`);
    panel.api.setActive();
    panel.focus();
  }, panelId);
  await expect(
    page.locator(
      `[data-cue-editor-panel-id=${JSON.stringify(panelId)}]:visible`,
    ),
  ).toBeVisible();
}

/**
 * Locates the tracked-values toggle inside one Cue Editor panel instance.
 */
function cueEditorTrackedToggleForPanel(page: Page, panelId: string): Locator {
  return page
    .locator(`[data-cue-editor-panel-id=${JSON.stringify(panelId)}]`)
    .getByRole("button", { name: "Toggle tracked values" });
}

/**
 * Scrolls the virtualized cue grid horizontally until a column is mounted.
 */
async function scrollCueGridToColumn(
  grid: Locator,
  columnKey: string,
): Promise<void> {
  const header = gridHeaderByColumnKey(grid, columnKey);
  if (await header.isVisible().catch(() => false)) return;

  for (let step = 0; step <= 40; step += 1) {
    const offset = step / 40;
    await grid.evaluate((element, nextOffset) => {
      const maxScrollLeft = Math.max(
        0,
        element.scrollWidth - element.clientWidth,
      );
      element.scrollLeft = Math.round(maxScrollLeft * nextOffset);
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, offset);
    await grid.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    if (await header.isVisible().catch(() => false)) return;
  }
  throw new Error(`expected cue grid column ${columnKey} to mount`);
}

/**
 * Scrolls the virtualized cue grid vertically until an identifier row is mounted.
 */
async function scrollCueGridToIdentifier(
  grid: Locator,
  identifierColumnKey: string,
  identifierText: string,
): Promise<string | null> {
  const visibleRowKey = await grid.evaluate(
    (element, options) => {
      for (const cell of Array.from(
        element.querySelectorAll(
          `[data-grid-column-key="${CSS.escape(options.identifierColumnKey)}"]`,
        ),
      )) {
        const text = cell.textContent?.trim() ?? "";
        const tokens = text.split(/\s+/).filter(Boolean);
        const matches =
          text === options.identifierText ||
          tokens.includes(options.identifierText);
        if (matches) {
          return cell.getAttribute("data-grid-row-key");
        }
      }
      return null;
    },
    { identifierColumnKey, identifierText },
  );
  if (visibleRowKey) return visibleRowKey;

  for (let step = 0; step <= 60; step += 1) {
    const ratio = step / 60;
    const rowKey = await grid.evaluate(
      (element, options) => {
        element.scrollTop = Math.round(
          (element.scrollHeight - element.clientHeight) * options.ratio,
        );
        element.dispatchEvent(new Event("scroll", { bubbles: true }));

        for (const cell of Array.from(
          element.querySelectorAll(
            `[data-grid-column-key="${CSS.escape(
              options.identifierColumnKey,
            )}"]`,
          ),
        )) {
          const text = cell.textContent?.trim() ?? "";
          const tokens = text.split(/\s+/).filter(Boolean);
          const matches =
            text === options.identifierText ||
            tokens.includes(options.identifierText);
          if (matches) {
            return cell.getAttribute("data-grid-row-key");
          }
        }
        return null;
      },
      { identifierColumnKey, identifierText, ratio },
    );
    if (rowKey) return rowKey;
    await grid.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  return null;
}

/**
 * Locates a cue grid cell after bringing its virtualized row into view.
 */
async function visibleCueGridCellByIdentifier(
  grid: Locator,
  options: {
    columnKey: string;
    identifierColumnKey: string;
    identifierText: string;
  },
): Promise<Locator> {
  await scrollCueGridToColumn(grid, options.columnKey);
  const rowKey = await scrollCueGridToIdentifier(
    grid,
    options.identifierColumnKey,
    options.identifierText,
  );
  if (!rowKey) {
    throw new Error(`expected cue grid row ${options.identifierText} to mount`);
  }
  return gridCellByKey(grid, {
    columnKey: options.columnKey,
    rowKey,
  });
}

/**
 * Reads the text for a currently mounted cue grid cell identified by row text.
 */
async function mountedCueGridCellTextByIdentifier(
  grid: Locator,
  options: {
    columnKey: string;
    identifierColumnKey: string;
    identifierText: string;
  },
): Promise<string | null> {
  return grid.evaluate((element, currentOptions) => {
    for (const idCell of Array.from(
      element.querySelectorAll(
        `[data-grid-column-key="${CSS.escape(
          currentOptions.identifierColumnKey,
        )}"]`,
      ),
    )) {
      const text = idCell.textContent?.trim() ?? "";
      const tokens = text.split(/\s+/).filter(Boolean);
      const matches =
        text === currentOptions.identifierText ||
        tokens.includes(currentOptions.identifierText);
      if (!matches) continue;

      const rowKey = idCell.getAttribute("data-grid-row-key");
      if (!rowKey) continue;

      return (
        element
          .querySelector(
            `[data-grid-row-key="${CSS.escape(rowKey)}"][data-grid-column-key="${CSS.escape(currentOptions.columnKey)}"]`,
          )
          ?.textContent?.trim() ?? null
      );
    }
    return null;
  }, options);
}

/**
 * Verifies the stored test cue either contains or omits the Intensity attribute.
 */
async function expectIntensityStored(
  page: Page,
  cueUid: string,
  expected: boolean,
): Promise<void> {
  await page.waitForFunction(
    ({ cueUid: targetCueUid, expected: expectedStored }) => {
      const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
      const instruction = cue?.instructions?.[0]?.cue_instruction;
      const values = instruction?.values ?? {};
      const transitions = instruction?.transitions_by_attribute ?? {};
      const fixtureTransitions =
        instruction?.transitions_by_fixture_attribute ?? [];
      const hasValue = values.Intensity !== undefined;
      const hasAttributeTiming = transitions.Intensity !== undefined;
      const hasFixtureTiming = fixtureTransitions.some(
        (entry: any) => entry.transitions_by_attribute?.Intensity !== undefined,
      );
      return (
        hasValue === expectedStored &&
        hasAttributeTiming === expectedStored &&
        hasFixtureTiming === expectedStored
      );
    },
    { cueUid, expected },
    { timeout: 5_000 },
  );
}

/**
 * Verifies the stored test cue has the expected parent instruction count.
 */
async function expectCueInstructionCount(
  page: Page,
  cueUid: string,
  expected: number,
): Promise<void> {
  await page.waitForFunction(
    ({ cueUid: targetCueUid, expected: expectedCount }) => {
      const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
      return cue?.instructions?.length === expectedCount;
    },
    { cueUid, expected },
    { timeout: 5_000 },
  );
}

/**
 * Verifies the seeded Intensity value source has the expected stored state.
 */
async function expectIntensityValueSource(
  page: Page,
  cueUid: string,
  expectedType: "Inline" | "Release" | "Cleared",
): Promise<void> {
  await page.waitForFunction(
    ({ cueUid: targetCueUid, expected }) => {
      const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
      const value = cue?.instructions?.[0]?.cue_instruction?.values?.Intensity;
      if (expected === "Cleared") return value === undefined;
      return value?.type === expected;
    },
    { cueUid, expected: expectedType },
    { timeout: 5_000 },
  );
}

/**
 * Verifies clearing Intensity preserved its timing metadata without a value.
 */
async function expectIntensityTimingOnly(
  page: Page,
  cueUid: string,
): Promise<void> {
  await page.waitForFunction(
    (targetCueUid) => {
      const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
      const instruction = cue?.instructions?.[0]?.cue_instruction;
      const values = instruction?.values ?? {};
      const transitions = instruction?.transitions_by_attribute ?? {};
      const fixtureTransitions =
        instruction?.transitions_by_fixture_attribute ?? [];
      const hasFixtureTiming = fixtureTransitions.some(
        (entry: any) => entry.transitions_by_attribute?.Intensity !== undefined,
      );
      return (
        values.Intensity === undefined &&
        transitions.Intensity !== undefined &&
        hasFixtureTiming
      );
    },
    cueUid,
    { timeout: 5_000 },
  );
}

/**
 * Restores a seeded cue and clears undo history before the next assertion flow.
 */
async function restoreCueAndClearHistory(
  page: Page,
  cue: object,
): Promise<void> {
  await page.evaluate(async (seedCue) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "CueCommand",
      command: { type: "StoreCue", data: seedCue },
    });
    stores.cues.set({
      ...stores.cues.get(),
      [(seedCue as any).identifiers.uid]: seedCue,
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await stores.sendAndAwait({
      module: "UndoCommand",
      command: { type: "ClearHistory", data: {} },
    });
  }, cue);
}

/**
 * Applies a seeded cue and sequence directly to browser stores after panel load.
 */
async function applySeededCueEditorState(
  page: Page,
  cue: object,
  sequence: object,
): Promise<void> {
  await page.evaluate(
    ({ seedCue, seedSequence }) => {
      const stores = (window as any).appStores;
      stores.cues.set({
        ...stores.cues.get(),
        [(seedCue as any).identifiers.uid]: seedCue,
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [(seedSequence as any).identifiers.uid]: seedSequence,
      });
    },
    { seedCue: cue, seedSequence: sequence },
  );
}

/**
 * Seeds a cue with Intensity timing data and opens an editor panel for it.
 */
async function seedTimingCueEditor(
  page: Page,
  panelId: string,
): Promise<{
  cueUid: string;
  fixtureId: number;
  originalCue: object;
  originalSequence: object;
  sequenceUid: string;
}> {
  return page.evaluate(
    async ({
      baseCueUid,
      baseSequenceUid,
      fixtureUid,
      panelId: targetPanelId,
    }: {
      baseCueUid: string;
      baseSequenceUid: string;
      fixtureUid: string;
      panelId: string;
    }) => {
      const stores = (window as any).appStores;

      /** Builds the Rust-style duration object used in seeded cue timing data. */
      const duration = (secs: number) => ({ secs, nanos: 0 });

      /** Builds a fixed transition mode from seconds for seeded cue timing data. */
      const fixed = (secs: number) => ({
        type: "Fixed",
        data: duration(secs),
      });

      const cues = stores.cues.get();
      const sequences = stores.sequences.get();
      const fixtures = stores.fixtures.get();
      const existingCue = cues[baseCueUid];
      const existingSequence = sequences[baseSequenceUid];
      const fixture = fixtures[fixtureUid];
      if (!existingCue || !existingSequence || !fixture) {
        throw new Error("expected the owned cue timing graph");
      }

      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const originalSequence = JSON.parse(JSON.stringify(existingSequence));
      const cueUid = baseCueUid;
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          label: "Cue Timing Live Edit E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Intensity: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 128 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {
                Intensity: {
                  fade_in: fixed(5),
                },
              },
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      };
      const sequence = {
        ...existingSequence,
        steps: existingSequence.steps?.includes(cueUid)
          ? existingSequence.steps
          : [cueUid, ...(existingSequence.steps ?? [])],
      };

      stores.cues.set({
        ...cues,
        [cueUid]: cue,
      });
      stores.sequences.set({
        ...sequences,
        [sequence.identifiers.uid]: sequence,
      });
      await stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      });
      await stores.send({
        module: "CueCommand",
        command: { type: "StoreSequence", data: sequence },
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });

      const api = stores.dockApi.get();
      api.getPanel(targetPanelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: targetPanelId,
        component: "CueEditor",
        title: "Cue Timing Live Edit E2E",
        params: {
          initialPanelId: targetPanelId,
          initialCueUid: cueUid,
          initialSequenceId: sequence.identifiers.id,
          initialSequenceUid: sequence.identifiers.uid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      panel.api.setActive();
      panel.focus();

      return {
        cueUid,
        fixtureId: fixture.identifiers.id,
        originalCue,
        originalSequence,
        sequenceUid: sequence.identifiers.uid,
      };
    },
    {
      baseCueUid: BASE_CUE_UID,
      baseSequenceUid: BASE_SEQUENCE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
      panelId,
    },
  );
}

/**
 * Restores cue and sequence records changed by a timing-editor regression test.
 */
async function restoreTimingCueEditor(
  page: Page,
  context: {
    originalCue: object;
    originalSequence: object;
    panelId: string;
  },
): Promise<void> {
  await page.evaluate(({ originalCue, originalSequence, panelId }) => {
    const stores = (window as any).appStores;
    stores.dockApi.get()?.getPanel(panelId)?.api.close();
    stores.cues.set({
      ...stores.cues.get(),
      [(originalCue as any).identifiers.uid]: originalCue,
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [(originalSequence as any).identifiers.uid]: originalSequence,
    });
  }, context);
}

/**
 * Verifies the seeded Green cue value is stored as a relative percentage offset.
 */
async function expectRelativeGreenStored(
  page: Page,
  cueUid: string,
  expectedOffset: number,
): Promise<void> {
  await page.waitForFunction(
    ({ cueUid: targetCueUid, expected }) => {
      const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
      const value =
        cue?.instructions?.[0]?.cue_instruction?.values?.Green?.data;
      return (
        value?.type === "RelativePercent" &&
        Math.abs(value.data.offset - expected) < 0.0001
      );
    },
    { cueUid, expected: expectedOffset },
    { timeout: 5_000 },
  );
}

/**
 * Verifies whether the Intensity grouped column header is visibly rendered.
 */
async function expectIntensityHeaderVisible(
  page: Page,
  expected: boolean,
): Promise<void> {
  const intensityHeaderId = `tanstack-header-${cueGridAttributeValueColumnKey(
    "Intensity",
  )}`;
  await page.waitForFunction(
    ({ expectedVisible, headerId }) => {
      const headers = [
        ...document.querySelectorAll(`[data-grid-header-id="${headerId}"]`),
      ];
      const hasVisibleHeader = headers.some((header) => {
        const element = header as HTMLElement;
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          element.getClientRects().length > 0
        );
      });
      return hasVisibleHeader === expectedVisible;
    },
    { expectedVisible: expected, headerId: intensityHeaderId },
    { timeout: 5_000 },
  );
}

test("cue editor column menu deletes an attribute with undo redo", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({ baseCueUid, baseSequenceUid, fixtureUid, secondaryAttr }) => {
      const stores = (window as any).appStores;

      /** Builds the Rust-style duration object used in seeded cue timing data. */
      const duration = (secs: number) => ({ secs, nanos: 0 });

      /** Builds a fixed transition mode from seconds for seeded cue timing data. */
      const fixed = (secs: number) => ({
        type: "Fixed",
        data: duration(secs),
      });

      const cues = stores.cues.get();
      const sequences = stores.sequences.get();
      const fixtures = stores.fixtures.get();
      const existingCue = cues[baseCueUid];
      const existingSequence = sequences[baseSequenceUid];
      const fixture = fixtures[fixtureUid];
      if (!existingCue || !existingSequence || !fixture) {
        throw new Error("expected the owned cue attribute graph");
      }
      const cueUid = baseCueUid;
      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const originalSequence = JSON.parse(JSON.stringify(existingSequence));
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          label: "Cue Attribute Delete E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Intensity: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 128 } },
                },
                [secondaryAttr]: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 64 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {
                Intensity: {
                  fade_in: fixed(2),
                },
              },
              transitions_by_fixture_attribute: [
                {
                  fixture: { fixture_uid: fixture.identifiers.uid },
                  transitions_by_attribute: {
                    Intensity: {
                      fade_out: fixed(3),
                    },
                  },
                },
              ],
            },
          },
        ],
      };
      const sequence = {
        ...existingSequence,
        steps: existingSequence.steps?.includes(cueUid)
          ? existingSequence.steps
          : [cueUid, ...(existingSequence.steps ?? [])],
      };

      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-attribute-delete-e2e";
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Attribute Delete E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      panel.api.setActive();
      panel.focus();

      return {
        cueUid,
        fixtureId: fixture.identifiers.id,
        originalCue,
        originalSequence,
        secondaryAttr,
        seedCue: cue,
        seedSequence: sequence,
        sequenceUid: sequence.identifiers.uid,
      };
    },
    {
      baseCueUid: BASE_CUE_UID,
      baseSequenceUid: BASE_SEQUENCE_UID,
      fixtureUid: SECONDARY_FIXTURE_UID,
      secondaryAttr: "Green",
    },
  );

  try {
    const grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-attribute-delete-e2e",
    );
    await expect(grid).toBeVisible();
    await applySeededCueEditorState(
      page,
      context.seedCue,
      context.seedSequence,
    );
    await expectIntensityStored(page, context.cueUid, true);

    const firstRowCell = await gridCellByIdentifier(grid, {
      columnKey: "id",
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(firstRowCell).toBeVisible();
    await firstRowCell.dispatchEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
    });
    await expect(
      page.getByRole("menuitem", { name: "Remove fixtures from cue" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Clear assertions" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Release assertions" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const intensityCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey("Intensity"),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(intensityCell).toBeVisible();
    await intensityCell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Release assertions" }).click();
    await expectIntensityValueSource(page, context.cueUid, "Release");
    await expect(intensityCell).toContainText("R");

    await intensityCell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Clear assertions" }).click();
    await expectIntensityValueSource(page, context.cueUid, "Cleared");
    await expectCueInstructionCount(page, context.cueUid, 1);
    await expectIntensityTimingOnly(page, context.cueUid);

    const secondaryHeaderForTimingOnlyRow = gridHeaderByColumnKey(
      grid,
      cueGridAttributeValueColumnKey(context.secondaryAttr),
    );
    await expect(secondaryHeaderForTimingOnlyRow).toBeVisible();
    await secondaryHeaderForTimingOnlyRow.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: `Delete ${context.secondaryAttr}` })
      .click();
    await expectCueInstructionCount(page, context.cueUid, 1);
    await expectIntensityTimingOnly(page, context.cueUid);

    await restoreCueAndClearHistory(page, context.seedCue);
    await expectIntensityStored(page, context.cueUid, true);

    const intensityHeader = gridHeaderByColumnKey(
      grid,
      cueGridAttributeValueColumnKey("Intensity"),
    );
    await expect(intensityHeader).toBeVisible();
    await intensityHeader.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete Intensity" }).click();

    await expectIntensityStored(page, context.cueUid, false);
    await expectIntensityHeaderVisible(page, false);
    await waitForUndoBatchToFinalize(page);

    await sendUndoCommandAndAwait(page, "Undo");
    await expectIntensityStored(page, context.cueUid, true);
    await expectIntensityHeaderVisible(page, true);

    await sendUndoCommandAndAwait(page, "Redo");
    await expectIntensityStored(page, context.cueUid, false);

    const secondaryHeader = gridHeaderByColumnKey(
      grid,
      cueGridAttributeValueColumnKey(context.secondaryAttr),
    );
    await expect(secondaryHeader).toBeVisible();
    await secondaryHeader.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: `Delete ${context.secondaryAttr}` })
      .click();
    await expectCueInstructionCount(page, context.cueUid, 0);
  } finally {
    if (!page.isClosed()) {
      await page
        .evaluate(({ originalCue, originalSequence }) => {
          const stores = (window as any).appStores;
          stores.cues.set({
            ...stores.cues.get(),
            [originalCue.identifiers.uid]: originalCue,
          });
          stores.sequences.set({
            ...stores.sequences.get(),
            [originalSequence.identifiers.uid]: originalSequence,
          });
        }, context)
        .catch((error) => {
          if (!page.isClosed()) throw error;
        });
    }
  }
});

/** Verifies live timing progress repaints do not reset an active timing editor. */
test("cue editor timing input survives live playback fill updates", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const panelId = "panel-CueEditor-timing-live-edit-e2e";
  const context = await seedTimingCueEditor(page, panelId);

  try {
    const panel = page.locator(
      `[data-cue-editor-panel-id=${JSON.stringify(panelId)}]:visible`,
    );
    const grid = cueEditorGridForPanel(page, panelId);
    await expect(grid).toBeVisible();

    await panel
      .getByRole("button", { name: "Switch to timings display mode" })
      .click();

    const previewTransitions = panel.getByRole("button", {
      name: "Toggle preview transitions",
    });
    await expect(previewTransitions).toBeVisible();
    if ((await previewTransitions.getAttribute("aria-pressed")) !== "true") {
      await previewTransitions.click();
    }

    const preview = panel.getByRole("button", { name: "Toggle cue preview" });
    await expect(preview).toBeVisible();
    if ((await preview.getAttribute("aria-pressed")) !== "true") {
      await preview.click();
    }

    const fixtureIdCell = await gridCellByIdentifier(grid, {
      columnKey: "id",
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    const fixtureRowIndex = Number(
      await fixtureIdCell.getAttribute("data-grid-row-index"),
    );
    expect(Number.isFinite(fixtureRowIndex)).toBe(true);
    const fadeInCell = gridCellByRowIndex(grid, {
      columnKey: cueGridAttributeTimingColumnKey("Intensity", "fade_in"),
      rowIndex: fixtureRowIndex,
    });
    await expect(fadeInCell).toHaveAttribute("data-editable", "true");
    await expect
      .poll(
        async () =>
          fadeInCell.evaluate(
            (element) => element.querySelector("canvas") !== null,
          ),
        { message: "expected the timing cell canvas to render" },
      )
      .toBe(true);

    await fadeInCell.dblclick();
    const editor = fadeInCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.press("ControlOrMeta+A");
    await editor.pressSequentially("2.75s", { delay: 120 });
    await page.waitForTimeout(300);

    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("2.75s");
    await editor.press("Enter");
    await expect(editor).toBeHidden();
  } finally {
    await restoreTimingCueEditor(page, {
      originalCue: context.originalCue,
      originalSequence: context.originalSequence,
      panelId,
    });
  }
});

/** Verifies cue relative value cells use compact marker text rather than badges. */
test("cue editor renders relative values with marker text", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({ baseCueUid, fixtureUid }) => {
      const stores = (window as any).appStores;
      stores.attributeMetadata.set([
        {
          key: "Green",
          attribute: { type: "Green" },
          label: "Green",
          category: "Color",
          sort_order: 3,
        },
      ]);
      const fixture = stores.fixtures.get()[fixtureUid];
      const cues = stores.cues.get();
      const existingCue = cues[baseCueUid];
      if (!fixture || !existingCue) {
        throw new Error("expected the owned relative-value graph");
      }
      const cueUid = baseCueUid;
      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          label: "Cue Relative Value Badge E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Green: {
                  type: "Inline",
                  data: {
                    type: "RelativePercent",
                    data: { offset: 0.5 },
                  },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      };

      await stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-relative-value-badge-e2e";
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Relative Value Badge E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      panel.api.setActive();
      panel.focus();

      return { cueUid, fixtureId: fixture.identifiers.id, originalCue };
    },
    {
      baseCueUid: BASE_CUE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
    },
  );

  try {
    await expectRelativeGreenStored(page, context.cueUid, 0.5);
    await sendUndoCommandAndAwait(page, "ClearHistory");

    const grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-relative-value-badge-e2e",
    );
    await expect(grid).toBeVisible();
    await expect(
      gridHeaderByColumnKey(grid, cueGridAttributeValueColumnKey("Green")),
    ).toBeVisible();
    await expect(
      grid.locator('[data-grid-header-id="tanstack-header-category:Color"]'),
    ).toBeVisible();

    const relativeCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey("Green"),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(relativeCell).toContainText("~ 50%");
    await expect(
      relativeCell.getByRole("img", { name: /relative/i }),
    ).toHaveCount(0);

    await relativeCell.dblclick();
    const editor = relativeCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.fill("75%");
    await editor.press("Enter");

    await expectRelativeGreenStored(page, context.cueUid, 0.75);
    await expect(relativeCell).toContainText("~ 75%");
    await expect(
      relativeCell.getByRole("img", { name: /relative/i }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(({ originalCue }) => {
      const stores = (window as any).appStores;
      stores.cues.set({
        ...stores.cues.get(),
        [originalCue.identifiers.uid]: originalCue,
      });
    }, context);
  }
});

/** Verifies starting a cue value edit with a relative marker keeps the editor active for subsequent characters. */
test("cue editor keeps keyboard-started relative value edits active", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({ baseCueUid, columnFixtureUid, editFixtureUid }) => {
      const stores = (window as any).appStores;
      stores.attributeMetadata.set([
        {
          key: "Red",
          attribute: { type: "Red" },
          label: "Red",
          category: "Color",
          sort_order: 2,
        },
        {
          key: "Green",
          attribute: { type: "Green" },
          label: "Green",
          category: "Color",
          sort_order: 3,
        },
      ]);
      const fixtures = stores.fixtures.get();
      const columnFixture = fixtures[columnFixtureUid];
      const editFixture = fixtures[editFixtureUid];
      const cues = stores.cues.get();
      const existingCue = cues[baseCueUid];
      if (!columnFixture || !editFixture || !existingCue) {
        throw new Error("expected the owned relative keyboard graph");
      }
      const cueUid = baseCueUid;
      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          label: "Cue Relative Keyboard Edit E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [
                  { fixture_uid: columnFixture.identifiers.uid, index: null },
                ],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Green: {
                  type: "Inline",
                  data: {
                    type: "AbsolutePercent",
                    data: { value: 0.25 },
                  },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
          {
            selection: {
              source: {
                type: "Resolved",
                data: [
                  { fixture_uid: editFixture.identifiers.uid, index: null },
                ],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Red: {
                  type: "Inline",
                  data: {
                    type: "AbsolutePercent",
                    data: { value: 0.5 },
                  },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      };

      await stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-relative-keyboard-edit-e2e";
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Relative Keyboard Edit E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      panel.api.setActive();
      panel.focus();

      return {
        cueUid,
        editFixtureId: editFixture.identifiers.id,
        editFixtureUid: editFixture.identifiers.uid,
        originalCue,
      };
    },
    {
      baseCueUid: BASE_CUE_UID,
      columnFixtureUid: PRIMARY_FIXTURE_UID,
      editFixtureUid: SECONDARY_FIXTURE_UID,
    },
  );

  try {
    const grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-relative-keyboard-edit-e2e",
    );
    await expect(grid).toBeVisible();
    await expect(
      gridHeaderByColumnKey(grid, cueGridAttributeValueColumnKey("Green")),
    ).toBeVisible();

    const valueCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey("Green"),
      identifierColumnKey: "id",
      identifierText: String(context.editFixtureId),
    });
    await expect(valueCell).toBeVisible();

    await valueCell.click();
    await page.keyboard.press("Shift+Backquote");
    const editor = valueCell.locator("input");
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("~");
    expect(await activeDockPanelId(page)).not.toBe("panel-CommandLine");

    await page.keyboard.type("75%");
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("~75%");

    await editor.press("Enter");
    await page.waitForFunction(
      ({ cueUid: targetCueUid, fixtureUid, expected }) => {
        const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
        const instruction = cue?.instructions?.find((item: any) =>
          item.selection?.source?.data?.some(
            (ref: any) => ref.fixture_uid === fixtureUid,
          ),
        );
        const value = instruction?.cue_instruction?.values?.Green?.data;
        return (
          value?.type === "RelativePercent" &&
          Math.abs(value.data.offset - expected) < 0.0001
        );
      },
      {
        cueUid: context.cueUid,
        fixtureUid: context.editFixtureUid,
        expected: 0.75,
      },
      { timeout: 5_000 },
    );
    await expect(valueCell).toContainText("~ 75%");
  } finally {
    await page.evaluate(({ originalCue }) => {
      const stores = (window as any).appStores;
      stores.cues.set({
        ...stores.cues.get(),
        [originalCue.identifiers.uid]: originalCue,
      });
    }, context);
  }
});

/** Verifies cue marker values render through the cue editor grid. */
test("cue editor renders cue tracking markers", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({
      baseCueUid,
      baseSequenceUid,
      fixtureUid,
      markerAttributes,
      markerCueId,
      markerCueUid,
      markerSequenceId,
      markerSequenceUid,
    }) => {
      const stores = (window as any).appStores;
      const fixture = stores.fixtures.get()[fixtureUid];
      const existingCue = stores.cues.get()[baseCueUid];
      const containingSequence = stores.sequences.get()[baseSequenceUid];
      if (!fixture || !existingCue || !containingSequence) {
        throw new Error("expected the owned tracking-marker graph");
      }
      stores.attributeMetadata.set([
        ...(stores.attributeMetadata.get?.() ?? []).filter(
          (item: any) => !markerAttributes.includes(item.key),
        ),
        ...markerAttributes.map((attribute, index) => ({
          key: attribute,
          attribute: { type: attribute },
          label: attribute,
          category: "Color",
          sort_order: index + 1,
        })),
      ]);
      const [releaseAttr, holdAttr, blockAttr, relativeBlockAttr] =
        markerAttributes;
      const values = {
        [releaseAttr]: { type: "Release" },
        [holdAttr]: { type: "HoldPosition" },
        [blockAttr]: {
          type: "Inline",
          data: { type: "Absolute", data: { value: 0 } },
        },
        [relativeBlockAttr]: {
          type: "Inline",
          data: { type: "RelativePercent", data: { offset: 1 } },
        },
      };

      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const originalSequence = JSON.parse(JSON.stringify(containingSequence));
      const cueUid = markerCueUid;
      const sequenceUid = markerSequenceUid;
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          id: markerCueId,
          uid: cueUid,
          label: "Cue Tracking Markers E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
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
      };
      const sequence = {
        ...containingSequence,
        identifiers: {
          ...containingSequence.identifiers,
          id: markerSequenceId,
          uid: sequenceUid,
          label: "Cue Tracking Markers E2E",
        },
        steps: [cueUid],
        setup_cue: {
          ...containingSequence.setup_cue,
          instructions: [
            ...(containingSequence.setup_cue?.instructions ?? []),
            ...(fixture.elements ?? []).map((_: any, index: number) => ({
              selection: {
                source: {
                  type: "Resolved",
                  data: [
                    {
                      fixture_uid: fixture.identifiers.uid,
                      index: index + 1,
                    },
                  ],
                },
                clauses: [],
              },
              cue_instruction: {
                values: {
                  [blockAttr]: values[blockAttr],
                  [relativeBlockAttr]: values[relativeBlockAttr],
                },
                transitions: {},
                transitions_by_attribute: {},
                transitions_by_fixture_attribute: [],
              },
            })),
          ],
        },
      };

      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-tracking-markers-e2e";
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Tracking Markers E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      panel.api.setActive();
      panel.focus();
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });
      const seeded =
        stores.cues.get()[cueUid]?.instructions?.[0]?.cue_instruction;
      if (
        seeded?.values?.[releaseAttr]?.type !== "Release" ||
        seeded?.values?.[holdAttr]?.type !== "HoldPosition" ||
        seeded?.values?.[blockAttr]?.type !== "Inline" ||
        seeded?.values?.[relativeBlockAttr]?.type !== "Inline"
      ) {
        throw new Error(JSON.stringify(seeded));
      }

      return {
        cueUid,
        originalCue,
        originalSequence,
        sequenceUid,
        fixtureId: fixture.identifiers.id,
        releaseAttr,
        holdAttr,
        blockAttr,
        relativeBlockAttr,
      };
    },
    {
      baseCueUid: BASE_CUE_UID,
      baseSequenceUid: BASE_SEQUENCE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
      markerAttributes: ["Intensity", "Red", "Green", "Blue"],
      markerCueId: MARKER_CUE_ID,
      markerCueUid: MARKER_CUE_UID,
      markerSequenceId: MARKER_SEQUENCE_ID,
      markerSequenceUid: MARKER_SEQUENCE_UID,
    },
  );

  try {
    const panelId = "panel-CueEditor-tracking-markers-e2e";
    await activateCueEditorPanel(page, panelId);
    await page.waitForFunction(
      ({ cueUid, releaseAttr, holdAttr, blockAttr, relativeBlockAttr }) => {
        const cue = (window as any).appStores?.cues?.get?.()?.[cueUid];
        return (
          cue?.instructions?.[0]?.cue_instruction?.values?.[releaseAttr]
            ?.type === "Release" &&
          cue?.instructions?.[0]?.cue_instruction?.values?.[holdAttr]?.type ===
            "HoldPosition" &&
          cue?.instructions?.[0]?.cue_instruction?.values?.[blockAttr]?.type ===
            "Inline" &&
          cue?.instructions?.[0]?.cue_instruction?.values?.[relativeBlockAttr]
            ?.type === "Inline"
        );
      },
      {
        cueUid: context.cueUid,
        releaseAttr: context.releaseAttr,
        holdAttr: context.holdAttr,
        blockAttr: context.blockAttr,
        relativeBlockAttr: context.relativeBlockAttr,
      },
      { timeout: 5_000 },
    );

    const grid = cueEditorGridForPanel(page, panelId);
    await expect(grid).toBeVisible();
    await activateCueEditorPanel(page, panelId);
    await expect(
      await visibleCueGridCellByIdentifier(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.releaseAttr),
        identifierColumnKey: "id",
        identifierText: String(context.fixtureId),
      }),
    ).toHaveText(/^R$/);
    await activateCueEditorPanel(page, panelId);
    await expect(
      await visibleCueGridCellByIdentifier(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.holdAttr),
        identifierColumnKey: "id",
        identifierText: String(context.fixtureId),
      }),
    ).toHaveText(/^H$/);
    await activateCueEditorPanel(page, panelId);
    await expect(
      await gridCellByIdentifier(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.blockAttr),
        identifierColumnKey: "id",
        identifierText: String(context.fixtureId),
      }),
    ).toHaveText(/^B\s+0$/);
    await activateCueEditorPanel(page, panelId);
    const blockedRelativeCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.relativeBlockAttr),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(blockedRelativeCell).toHaveText(/^B\s*~ 100%$/);
    await expect(
      blockedRelativeCell.getByRole("img", { name: "Blocked" }),
    ).toBeVisible();
    const screenshotPath = testInfo.outputPath(
      "owned-cue-tracking-markers.png",
    );
    await grid.screenshot({ path: screenshotPath });
    await testInfo.attach("owned-cue-tracking-markers", {
      path: screenshotPath,
      contentType: "image/png",
    });
  } finally {
    await page.evaluate(
      ({ cueUid, originalCue, originalSequence, sequenceUid }) => {
        const stores = (window as any).appStores;
        const restoredSequences = {
          ...stores.sequences.get(),
          [originalSequence.identifiers.uid]: originalSequence,
        };
        delete restoredSequences[sequenceUid];
        const restoredCues = {
          ...stores.cues.get(),
          [originalCue.identifiers.uid]: originalCue,
        };
        delete restoredCues[cueUid];
        stores.sequences.set(restoredSequences);
        stores.cues.set(restoredCues);
      },
      context,
    );
  }
});

/** Verifies an inherited tracked value can be overwritten by typing locally. */
test("cue editor overwrites tracked values with local assertions", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({ baseCueUid, baseSequenceUid, fixtureUid, trackedAttr }) => {
      const stores = (window as any).appStores;
      const fixture = stores.fixtures.get()[fixtureUid];
      const existingCue = stores.cues.get()[baseCueUid];
      const containingSequence = stores.sequences.get()[baseSequenceUid];
      if (!fixture || !existingCue || !containingSequence) {
        throw new Error("expected the owned tracked-override graph");
      }
      stores.attributeMetadata.set([
        ...(stores.attributeMetadata.get?.() ?? []).filter(
          (item: any) => item.key !== trackedAttr,
        ),
        {
          key: trackedAttr,
          attribute: { type: trackedAttr },
          label: trackedAttr,
          category: "Color",
          sort_order: 1,
        },
      ]);

      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const originalSequence = JSON.parse(JSON.stringify(containingSequence));
      const targetCueId = 910_001;
      const priorCueId = targetCueId - 1;
      const cueUid = "91000100-0000-4000-8000-000000000000";
      const priorCueUid = "91000000-0000-4000-8000-000000000000";
      const sequenceUid = "91000200-0000-4000-8000-000000000000";
      const selection = {
        source: {
          type: "Resolved",
          data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
        },
        clauses: [],
      };
      const priorCue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          id: priorCueId,
          uid: priorCueUid,
          label: "Cue Tracked Override Source E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        parts: [],
        instructions: [
          {
            selection,
            cue_instruction: {
              values: {
                [trackedAttr]: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 77 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      };
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          id: targetCueId,
          uid: cueUid,
          label: "Cue Tracked Override E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        parts: [],
        instructions: [],
      };
      const sequence = {
        ...containingSequence,
        identifiers: {
          ...containingSequence.identifiers,
          id: 900_000 + targetCueId,
          uid: sequenceUid,
          label: "Cue Tracked Override E2E",
        },
        steps: [priorCueUid, cueUid],
      };

      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [priorCueUid]: priorCue,
        [cueUid]: cue,
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [priorCueUid]: priorCue,
        [cueUid]: cue,
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-tracked-override-e2e";
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Tracked Override E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
          initialSequenceId: sequence.identifiers.id,
          initialSequenceUid: sequence.identifiers.uid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      panel.api.setActive();
      panel.focus();

      return {
        cue,
        cueId: targetCueId,
        cueUid,
        priorCue,
        priorCueId,
        priorCueUid,
        sequence,
        sequenceId: sequence.identifiers.id,
        sequenceUid,
        fixtureId: fixture.identifiers.id,
        originalCue,
        originalSequence,
        trackedAttr,
      };
    },
    {
      baseCueUid: BASE_CUE_UID,
      baseSequenceUid: BASE_SEQUENCE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
      trackedAttr: "Green",
    },
  );

  await page.evaluate(async ({ cue, priorCue, sequence }) => {
    const stores = (window as any).appStores;
    await stores.send({
      module: "CueCommand",
      command: { type: "StoreCue", data: priorCue },
    });
    await stores.send({
      module: "CueCommand",
      command: { type: "StoreCue", data: cue },
    });
    await stores.send({
      module: "CueCommand",
      command: { type: "StoreSequence", data: sequence },
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequence.identifiers.uid]: sequence,
    });
    stores.cues.set({
      ...stores.cues.get(),
      [priorCue.identifiers.uid]: priorCue,
      [cue.identifiers.uid]: cue,
    });
  }, context);
  await activateCueEditorPanel(page, "panel-CueEditor-tracked-override-e2e");

  try {
    const panelId = "panel-CueEditor-tracked-override-e2e";
    const panel = page.locator(
      `[data-cue-editor-panel-id=${JSON.stringify(panelId)}]:visible`,
    );
    const trackedToggle = cueEditorTrackedToggleForPanel(page, panelId);
    await trackedToggle.click();
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "true");
    const grid = cueEditorGridForPanel(page, panelId);
    await expect(grid).toBeVisible();

    const trackedCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.trackedAttr),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(trackedCell).toHaveText(/^77$/);
    await expect(trackedCell).toHaveAttribute("data-editable", "true");

    await trackedCell.dblclick();
    const editor = trackedCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.press("ControlOrMeta+A");
    await editor.pressSequentially("88");
    await editor.press("Enter");
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ cueUid, trackedAttr }) => {
              const stores = (window as any).appStores;
              /** Normalizes identifiers emitted with or without UUID separators. */
              const normalizeUid = (uid: unknown) =>
                String(uid).replaceAll("-", "").toLowerCase();
              /** Normalizes virtual intensity to its storage attribute key. */
              const normalizeAttribute = (attribute: string) =>
                attribute === "VirtualIntensity" ? "Intensity" : attribute;
              const cue = Object.values(stores.cues.get()).find(
                (candidate: any) =>
                  normalizeUid(candidate?.identifiers?.uid) ===
                  normalizeUid(cueUid),
              ) as any;
              return cue?.instructions?.some((instruction: any) =>
                Object.entries(instruction.cue_instruction.values ?? {}).some(
                  ([attribute, value]: [string, any]) =>
                    normalizeAttribute(attribute) ===
                      normalizeAttribute(trackedAttr) &&
                    value?.data?.data?.value === 88,
                ),
              );
            },
            { cueUid: context.cueUid, trackedAttr: context.trackedAttr },
          ),
        { message: "expected tracked edit to create a local cue assertion" },
      )
      .toBe(true);

    const overwrittenCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.trackedAttr),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(overwrittenCell).toHaveText(/^88$/);
    await expect(overwrittenCell).toHaveCSS(
      "background-color",
      CUE_EDITOR_ASSERTED_VALUE_BACKGROUND,
    );

    await overwrittenCell.click();
    await page.keyboard.press("Delete");
    await expectCueInstructionCount(page, context.cueUid, 0);
    await panel
      .getByRole("button", { name: "Switch to timings display mode" })
      .click();
    await expect(panel.getByText("No fixture values in cue p0")).toBeVisible();
  } finally {
    await page.evaluate(
      ({ cueUid, originalCue, originalSequence, priorCueUid, sequenceUid }) => {
        const stores = (window as any).appStores;
        const restoredSequences = {
          ...stores.sequences.get(),
          [originalSequence.identifiers.uid]: originalSequence,
        };
        delete restoredSequences[sequenceUid];
        const restoredCues = {
          ...stores.cues.get(),
          [originalCue.identifiers.uid]: originalCue,
        };
        if (cueUid !== originalCue.identifiers.uid) {
          delete restoredCues[cueUid];
        }
        delete restoredCues[priorCueUid];
        stores.sequences.set(restoredSequences);
        stores.cues.set(restoredCues);
      },
      context,
    );
  }
});

/** Verifies values mode can expand fixture rows and show element-scoped values. */
test("cue editor values mode expands fixture element values", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({ attr, baseCueUid, baseSequenceUid, fixtureUid }) => {
      const stores = (window as any).appStores;
      const fixture = stores.fixtures.get()[fixtureUid];
      const existingCue = stores.cues.get()[baseCueUid];
      const containingSequence = stores.sequences.get()[baseSequenceUid];
      if (!fixture || !existingCue || !containingSequence) {
        throw new Error("expected the owned element-value graph");
      }
      stores.attributeMetadata.set([
        ...(stores.attributeMetadata.get?.() ?? []).filter(
          (item: any) => item.key !== attr,
        ),
        {
          key: attr,
          attribute: { type: attr },
          label: attr,
          category: "Dimmer",
          sort_order: 1,
        },
      ]);

      const cueUid = baseCueUid;
      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const originalSequence = JSON.parse(JSON.stringify(containingSequence));
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          label: "Cue Element Values E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        parts: [],
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: 1 }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                [attr]: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 11 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: 2 }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                [attr]: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 22 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      };
      const sequence = {
        ...containingSequence,
        steps: [cueUid],
      };

      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });
      void stores.send({
        module: "CueCommand",
        command: { type: "StoreSequence", data: sequence },
      });
      void stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-element-values-e2e";
      api.getPanel(panelId)?.api.close();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Element Values E2E",
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
          initialSequenceId: sequence.identifiers.id,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      panel.api.setActive();
      panel.focus();

      return {
        attr,
        cueUid,
        fixtureId: fixture.identifiers.id,
        originalCue,
        originalSequence,
      };
    },
    {
      attr: "Intensity",
      baseCueUid: BASE_CUE_UID,
      baseSequenceUid: BASE_SEQUENCE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
    },
  );

  try {
    const grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-element-values-e2e",
    );
    await expect(grid).toBeVisible();
    await expect(
      gridHeaderByColumnKey(grid, cueGridAttributeValueColumnKey(context.attr)),
    ).toBeVisible();

    const parentIdCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: "id",
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    const parentRowIndex = Number(
      await parentIdCell.getAttribute("data-grid-row-index"),
    );
    expect(Number.isFinite(parentRowIndex)).toBe(true);

    await expect(
      gridCellByRowIndex(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.attr),
        rowIndex: parentRowIndex,
      }),
    ).toHaveText("V");
    await parentIdCell.click();
    await expect(
      gridCellByRowIndex(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.attr),
        rowIndex: parentRowIndex + 1,
      }),
    ).toHaveText(/^11$/);
    await expect(
      gridCellByRowIndex(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.attr),
        rowIndex: parentRowIndex + 2,
      }),
    ).toHaveText(/^22$/);
    const screenshotPath = testInfo.outputPath("owned-cue-element-values.png");
    await grid.screenshot({ path: screenshotPath });
    await testInfo.attach("owned-cue-element-values", {
      path: screenshotPath,
      contentType: "image/png",
    });

    await parentIdCell.click();
    const parentValueCell = gridCellByRowIndex(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.attr),
      rowIndex: parentRowIndex,
    });
    await parentValueCell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Clear assertions" }).click();
    await page.waitForFunction(
      ({ cueUid, attr }) =>
        (
          (window as any).appStores.cues.get()[cueUid]?.instructions ?? []
        ).every(
          (instruction: any) =>
            instruction.cue_instruction?.values?.[attr] === undefined,
        ),
      { cueUid: context.cueUid, attr: context.attr },
    );
  } finally {
    await page.evaluate(({ originalCue, originalSequence }) => {
      const stores = (window as any).appStores;
      stores.sequences.set({
        ...stores.sequences.get(),
        [originalSequence.identifiers.uid]: originalSequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [originalCue.identifiers.uid]: originalCue,
      });
    }, context);
  }
});

/** Verifies the cue editor toolbar can reveal tracked-in sequence values. */
test("cue editor toolbar toggles tracked values", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(180_000);

  await openOwnedCueEditorApp(page, backendSlot.backendPort);

  const context = await page.evaluate(
    async ({
      baseCueUid,
      baseSequenceUid,
      editColumnFixtureUid,
      fixtureUid,
      staleAttr,
      trackedAttr,
      trackedOnlyAttr,
      trackedOnlyEditAttr,
      trackedOnlyFixtureUid,
    }) => {
      const stores = (window as any).appStores;
      const fixtures = stores.fixtures.get();
      const fixture = fixtures[fixtureUid];
      const trackedOnlyFixture = fixtures[trackedOnlyFixtureUid];
      const editColumnFixture = fixtures[editColumnFixtureUid];
      const existingCue = stores.cues.get()[baseCueUid];
      const containingSequence = stores.sequences.get()[baseSequenceUid];
      if (
        !fixture ||
        !trackedOnlyFixture ||
        !editColumnFixture ||
        !existingCue ||
        !containingSequence
      ) {
        throw new Error("expected the owned tracked-values graph");
      }
      const metadataAttributes = [
        trackedAttr,
        staleAttr,
        trackedOnlyAttr,
        trackedOnlyEditAttr,
      ];
      stores.attributeMetadata.set([
        ...(stores.attributeMetadata.get?.() ?? []).filter(
          (item: any) => !metadataAttributes.includes(item.key),
        ),
        ...metadataAttributes.map((attribute: string, index: number) => ({
          key: attribute,
          attribute: { type: attribute },
          label: attribute,
          category: "Color",
          sort_order: index + 1,
        })),
      ]);
      const originalCue = JSON.parse(JSON.stringify(existingCue));
      const originalSequence = JSON.parse(JSON.stringify(containingSequence));
      const targetCueId = 940_001;
      const priorCueId = targetCueId - 1;
      const cueUid = "94000100-0000-4000-8000-000000000000";
      const priorCueUid = "94000000-0000-4000-8000-000000000000";
      const sequenceUid = "94000200-0000-4000-8000-000000000000";

      const selection = {
        source: {
          type: "Resolved",
          data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
        },
        clauses: [],
      };
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          id: targetCueId,
          uid: cueUid,
          label: "Cue Tracked Values E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        instructions: [
          {
            selection,
            cue_instruction: {
              values: {},
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
          {
            selection: {
              source: {
                type: "Resolved",
                data: [
                  {
                    fixture_uid: trackedOnlyFixture.identifiers.uid,
                    index: null,
                  },
                ],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {},
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      };
      const trackedElementInstructions = (fixture.elements ?? []).map(
        (_: any, index: number) => ({
          selection: {
            source: {
              type: "Resolved",
              data: [
                {
                  fixture_uid: fixture.identifiers.uid,
                  index: index + 1,
                },
              ],
            },
            clauses: [],
          },
          cue_instruction: {
            values: {
              [trackedAttr]: {
                type: "Inline",
                data: { type: "Absolute", data: { value: 42 } },
              },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        }),
      );
      if (trackedElementInstructions.length === 0) {
        throw new Error("expected fixture elements for tracked aggregation");
      }
      const trackedFixtureInstruction = {
        selection,
        cue_instruction: {
          values: {
            [trackedAttr]: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 42 } },
            },
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      };
      const trackedOnlyFixtureInstruction = {
        selection: {
          source: {
            type: "Resolved",
            data: [
              {
                fixture_uid: trackedOnlyFixture.identifiers.uid,
                index: null,
              },
            ],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            [trackedOnlyAttr]: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 77 } },
            },
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      };
      const priorCue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          id: priorCueId,
          uid: priorCueUid,
          label: "Cue Tracked Source Prior E2E",
        },
        trigger: { type: "Manual" },
        transitions_by_attribute: {},
        parts: [],
        instructions: [trackedOnlyFixtureInstruction],
      };
      const staleFixtureInstruction = {
        selection,
        cue_instruction: {
          values: {
            [staleAttr]: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 10 } },
            },
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      };
      const staleElementInstruction = {
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: fixture.identifiers.uid, index: 1 }],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            [staleAttr]: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 20 } },
            },
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      };
      const editColumnInstruction = {
        selection: {
          source: {
            type: "Resolved",
            data: [
              {
                fixture_uid: editColumnFixture.identifiers.uid,
                index: null,
              },
            ],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            [trackedOnlyEditAttr]: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 5 } },
            },
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      };
      const sequence = {
        ...containingSequence,
        identifiers: {
          ...containingSequence.identifiers,
          id: 940_001,
          uid: sequenceUid,
          label: "Cue Tracked Values E2E",
        },
        steps: [priorCueUid, cueUid],
        setup_cue: {
          ...containingSequence.setup_cue,
          instructions: [
            trackedFixtureInstruction,
            ...trackedElementInstructions,
            editColumnInstruction,
            staleFixtureInstruction,
            staleElementInstruction,
          ],
        },
      };

      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [priorCueUid]: priorCue,
        [cueUid]: cue,
      });
      await stores.send({
        module: "CueCommand",
        command: { type: "StoreSequence", data: sequence },
      });
      await stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: priorCue },
      });
      await stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequence.identifiers.uid]: sequence,
      });
      stores.cues.set({
        ...stores.cues.get(),
        [priorCueUid]: priorCue,
        [cueUid]: cue,
      });

      return {
        cueId: targetCueId,
        cueUid,
        priorCueUid,
        priorCueId,
        sequenceUid: sequence.identifiers.uid,
        sequenceId: sequence.identifiers.id,
        fixtureUid: fixture.identifiers.uid,
        originalCue,
        originalSequence,
        seedCue: cue,
        seedPriorCue: priorCue,
        seedSequence: sequence,
        fixtureId: fixture.identifiers.id,
        trackedOnlyFixtureUid: trackedOnlyFixture.identifiers.uid,
        trackedOnlyFixtureId: trackedOnlyFixture.identifiers.id,
        elementCount: fixture.elements.length,
        trackedAttr,
        trackedOnlyAttr,
        trackedOnlyEditAttr,
        staleAttr,
      };
    },
    {
      baseCueUid: BASE_CUE_UID,
      baseSequenceUid: BASE_SEQUENCE_UID,
      editColumnFixtureUid: PRIMARY_FIXTURE_UID,
      fixtureUid: PRIMARY_FIXTURE_UID,
      staleAttr: "Blue",
      trackedAttr: "Green",
      trackedOnlyAttr: "Amber",
      trackedOnlyEditAttr: "White",
      trackedOnlyFixtureUid: SECONDARY_FIXTURE_UID,
    },
  );

  try {
    await page.evaluate(
      ({
        cueUid,
        priorCueUid,
        seedCue,
        seedPriorCue,
        seedSequence,
        sequenceId,
        sequenceUid,
      }) => {
        const stores = (window as any).appStores;
        stores.sequences.set({
          ...stores.sequences.get(),
          [seedSequence.identifiers.uid]: seedSequence,
        });
        stores.cues.set({
          ...stores.cues.get(),
          [priorCueUid]: seedPriorCue,
          [cueUid]: seedCue,
        });

        const panelId = "panel-CueEditor-tracked-values-e2e";
        const api = stores.dockApi.get();
        api.clear();
        const clipPanel = api.addPanel({
          id: "panel-ClipList",
          component: "ClipList",
          title: "Clips",
          params: { initialPanelId: "panel-ClipList" },
        });
        clipPanel.focus();
        const panel = api.addPanel({
          id: panelId,
          component: "CueEditor",
          title: "Cue Tracked Values E2E",
          params: {
            initialPanelId: panelId,
            initialCueUid: cueUid,
            initialSequenceId: sequenceId,
            initialSequenceUid: sequenceUid,
          },
          position: {
            referencePanel: "panel-ClipList",
            direction: "within",
          },
        });
        panel.focus();
      },
      context,
    );
    let panelId = "panel-CueEditor-tracked-values-e2e";
    await expect(
      page.locator(`[data-cue-editor-panel-id=${JSON.stringify(panelId)}]`),
    ).toBeVisible();
    let grid = cueEditorGridForPanel(page, panelId);

    let trackedToggle = cueEditorTrackedToggleForPanel(page, panelId);
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(
      ({ cueUid, priorCueUid, seedCue, seedPriorCue, seedSequence }) => {
        const stores = (window as any).appStores;
        stores.sequences.set({
          ...stores.sequences.get(),
          [seedSequence.identifiers.uid]: seedSequence,
        });
        stores.cues.set({
          ...stores.cues.get(),
          [priorCueUid]: seedPriorCue,
          [cueUid]: seedCue,
        });
      },
      context,
    );
    await trackedToggle.click();
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "true");
    await expect(grid).toBeVisible();
    await page.evaluate(
      ({ cueUid, priorCueUid, seedCue, seedPriorCue, seedSequence }) => {
        const stores = (window as any).appStores;
        stores.sequences.set({
          ...stores.sequences.get(),
          [seedSequence.identifiers.uid]: seedSequence,
        });
        stores.cues.set({
          ...stores.cues.get(),
          [priorCueUid]: seedPriorCue,
          [cueUid]: seedCue,
        });
      },
      context,
    );
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.trackedOnlyAttr),
    );
    await expect
      .poll(
        () =>
          mountedCueGridCellTextByIdentifier(grid, {
            columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyAttr),
            identifierColumnKey: "id",
            identifierText: String(context.trackedOnlyFixtureId),
          }),
        { timeout: 10_000 },
      )
      .toBe("77");
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.trackedOnlyEditAttr),
    );
    const trackedOnlyBlankCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyEditAttr),
      identifierColumnKey: "id",
      identifierText: String(context.trackedOnlyFixtureId),
    });
    await expect(trackedOnlyBlankCell).toHaveAttribute("data-editable", "true");
    await expect(trackedOnlyBlankCell).toHaveText("");
    await expect(trackedOnlyBlankCell).toHaveCSS(
      "background-color",
      CUE_EDITOR_EMPTY_VALUE_BACKGROUND,
    );
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.trackedOnlyAttr),
    );
    const priorCueTrackedCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyAttr),
      identifierColumnKey: "id",
      identifierText: String(context.trackedOnlyFixtureId),
    });
    await priorCueTrackedCell.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      `Tracked from Cue ${context.sequenceId}.${context.priorCueId}. Alt-click to open.`,
    );
    await priorCueTrackedCell.click({ modifiers: ["Alt"] });
    await expect(
      page.getByRole("tab", {
        name: `Cue ${context.sequenceId}.${context.priorCueId}`,
      }),
    ).toBeVisible();
    await page.evaluate(({ priorCueUid }) => {
      (window as any).appStores.dockApi
        .get()
        .getPanel(`cue-editor-${priorCueUid}-p0`)
        ?.api.close();
    }, context);
    await page.evaluate(() => {
      (window as any).appStores.dockApi
        .get()
        .getPanel("panel-CueEditor-tracked-values-e2e")
        ?.focus();
    });
    await expect
      .poll(() => activeDockPanelId(page), { timeout: 8_000 })
      .toBe("panel-CueEditor-tracked-values-e2e");
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "true");
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.trackedOnlyEditAttr),
    );
    const trackedOnlyBlankCellAfterFollow =
      await visibleCueGridCellByIdentifier(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyEditAttr),
        identifierColumnKey: "id",
        identifierText: String(context.trackedOnlyFixtureId),
      });
    await trackedOnlyBlankCellAfterFollow.click();
    await page.keyboard.press("Enter");
    const trackedOnlyBlankEditor = grid.locator("input").last();
    await expect(trackedOnlyBlankEditor).toBeVisible();
    await trackedOnlyBlankEditor.fill("33");
    await trackedOnlyBlankEditor.press("Enter");
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ cueUid, trackedOnlyEditAttr }) => {
              const stores = (window as any).appStores;
              return stores.cues
                .get()
                [cueUid]?.instructions?.some(
                  (instruction: any) =>
                    instruction.cue_instruction.values?.[trackedOnlyEditAttr]
                      ?.data?.data?.value === 33,
                );
            },
            {
              cueUid: context.cueUid,
              trackedOnlyEditAttr: context.trackedOnlyEditAttr,
            },
          ),
        { message: "expected tracked-only edit to create a cue assertion" },
      )
      .toBe(true);
    const trackedOnlyEditedCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyEditAttr),
      identifierColumnKey: "id",
      identifierText: String(context.trackedOnlyFixtureId),
    });
    await expect(trackedOnlyEditedCell).toHaveText(/^33$/);
    await expect(trackedOnlyEditedCell).toHaveCSS(
      "background-color",
      CUE_EDITOR_ASSERTED_VALUE_BACKGROUND,
    );
    await trackedOnlyEditedCell.click();
    await page.keyboard.press("Enter");
    const trackedOnlyClearEditor = grid.locator("input").last();
    await expect(trackedOnlyClearEditor).toBeVisible();
    await trackedOnlyClearEditor.press("ControlOrMeta+A");
    await trackedOnlyClearEditor.press("Backspace");
    await trackedOnlyClearEditor.press("Enter");
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ cueUid, trackedOnlyEditAttr }) => {
              const stores = (window as any).appStores;
              return stores.cues
                .get()
                [cueUid]?.instructions?.every(
                  (instruction: any) =>
                    !instruction.cue_instruction.values?.[trackedOnlyEditAttr],
                );
            },
            {
              cueUid: context.cueUid,
              trackedOnlyEditAttr: context.trackedOnlyEditAttr,
            },
          ),
        { message: "expected clearing tracked-only edit to remove assertion" },
      )
      .toBe(true);
    const trackedOnlyClearedCell = await visibleCueGridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyEditAttr),
      identifierColumnKey: "id",
      identifierText: String(context.trackedOnlyFixtureId),
    });
    await expect(trackedOnlyClearedCell).toHaveText("");
    await expect(trackedOnlyClearedCell).toHaveCSS(
      "background-color",
      CUE_EDITOR_EMPTY_VALUE_BACKGROUND,
    );
    await page.evaluate(
      ({ cueUid, trackedOnlyEditAttr, trackedOnlyFixtureUid }) => {
        const stores = (window as any).appStores;
        const currentCue = stores.cues.get()[cueUid];
        stores.cues.set({
          ...stores.cues.get(),
          [cueUid]: {
            ...currentCue,
            instructions: currentCue.instructions.filter(
              (instruction: any) =>
                !instruction.cue_instruction.values?.[trackedOnlyEditAttr] &&
                !(
                  Object.keys(instruction.cue_instruction.values ?? {})
                    .length === 0 &&
                  instruction.selection?.source?.type === "Resolved" &&
                  instruction.selection.source.data?.some(
                    (ref: any) => ref.fixture_uid === trackedOnlyFixtureUid,
                  )
                ),
            ),
          },
        });
      },
      {
        cueUid: context.cueUid,
        trackedOnlyEditAttr: context.trackedOnlyEditAttr,
        trackedOnlyFixtureUid: context.trackedOnlyFixtureUid,
      },
    );
    if (context.elementCount === 1) {
      await expect(
        await visibleCueGridCellByIdentifier(grid, {
          columnKey: cueGridAttributeValueColumnKey(context.staleAttr),
          identifierColumnKey: "id",
          identifierText: String(context.fixtureId),
        }),
      ).toHaveText(/^20$/);
    }

    await page
      .getByRole("button", { name: "Switch to timings display mode" })
      .click();
    await expect(
      gridHeaderByColumnKey(
        grid,
        cueGridAttributeTimingColumnKey(context.trackedAttr, "fade_in"),
      ),
    ).toHaveCount(0);

    await page.evaluate(
      async ({ cueUid, sequenceUid, sequenceId, fixtureUid, staleAttr }) => {
        const stores = (window as any).appStores;
        const selection = {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: fixtureUid, index: null }],
          },
          clauses: [],
        };
        const staleElementInstruction = {
          selection: {
            source: {
              type: "Resolved",
              data: [{ fixture_uid: fixtureUid, index: 1 }],
            },
            clauses: [],
          },
          cue_instruction: {
            values: {
              [staleAttr]: {
                type: "Inline",
                data: { type: "Absolute", data: { value: 20 } },
              },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        };
        const staleFixtureInstruction = {
          selection,
          cue_instruction: {
            values: {
              [staleAttr]: {
                type: "Inline",
                data: { type: "Absolute", data: { value: 10 } },
              },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        };
        const current = stores.sequences.get()[sequenceUid];
        const sequence = {
          ...current,
          setup_cue: {
            ...current.setup_cue,
            instructions: [staleElementInstruction, staleFixtureInstruction],
          },
        };
        stores.sequences.set({
          ...stores.sequences.get(),
          [sequenceUid]: sequence,
        });

        const api = stores.dockApi.get();
        api.getPanel("panel-CueEditor-tracked-values-e2e")?.api.close();
        const panelId = "panel-CueEditor-tracked-values-reverse-e2e";
        if (!api.getPanel(panelId)) {
          const panel = api.addPanel({
            id: panelId,
            component: "CueEditor",
            title: "Cue Tracked Values Reverse E2E",
            params: {
              initialPanelId: panelId,
              initialCueUid: cueUid,
              initialSequenceId: sequenceId,
              initialSequenceUid: sequenceUid,
            },
            position: {
              referencePanel: "panel-ClipList",
              direction: "within",
            },
          });
          panel.focus();
        }
        api.getPanel(panelId)?.focus();
      },
      {
        cueUid: context.cueUid,
        sequenceUid: context.sequenceUid,
        sequenceId: context.sequenceId,
        fixtureUid: context.fixtureUid,
        staleAttr: context.staleAttr,
      },
    );
    grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-tracked-values-reverse-e2e",
    );
    panelId = "panel-CueEditor-tracked-values-reverse-e2e";
    trackedToggle = cueEditorTrackedToggleForPanel(page, panelId);
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "false");
    await trackedToggle.click();
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "true");
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.staleAttr),
    );
    await expect(
      await visibleCueGridCellByIdentifier(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.staleAttr),
        identifierColumnKey: "id",
        identifierText: String(context.fixtureId),
      }),
    ).toHaveText(/^10$/);

    await page.evaluate(
      async ({ cueUid, sequenceUid, sequenceId, fixtureUid, staleAttr }) => {
        const stores = (window as any).appStores;
        const selection = {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: fixtureUid, index: null }],
          },
          clauses: [],
        };
        const staleFixtureInstruction = {
          selection,
          cue_instruction: {
            values: {
              [staleAttr]: {
                type: "Inline",
                data: { type: "Absolute", data: { value: 10 } },
              },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        };
        const staleElementReleaseInstruction = {
          selection: {
            source: {
              type: "Resolved",
              data: [{ fixture_uid: fixtureUid, index: 1 }],
            },
            clauses: [],
          },
          cue_instruction: {
            values: {
              [staleAttr]: { type: "Release" },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        };
        const current = stores.sequences.get()[sequenceUid];
        const sequence = {
          ...current,
          setup_cue: {
            ...current.setup_cue,
            instructions: [
              staleFixtureInstruction,
              staleElementReleaseInstruction,
            ],
          },
        };
        stores.sequences.set({
          ...stores.sequences.get(),
          [sequenceUid]: sequence,
        });
        const currentCue = stores.cues.get()[cueUid];
        stores.cues.set({
          ...stores.cues.get(),
          [cueUid]: {
            ...currentCue,
            instructions: [
              {
                selection,
                cue_instruction: {
                  values: {
                    [staleAttr]: {
                      type: "Inline",
                      data: { type: "Absolute", data: { value: 10 } },
                    },
                  },
                  transitions: {},
                  transitions_by_attribute: {},
                  transitions_by_fixture_attribute: [],
                },
              },
            ],
          },
        });

        const api = stores.dockApi.get();
        api.getPanel("panel-CueEditor-tracked-values-reverse-e2e")?.api.close();
        const panelId = "panel-CueEditor-tracked-values-clear-e2e";
        if (!api.getPanel(panelId)) {
          const panel = api.addPanel({
            id: panelId,
            component: "CueEditor",
            title: "Cue Tracked Values Clear E2E",
            params: {
              initialPanelId: panelId,
              initialCueUid: cueUid,
              initialSequenceId: sequenceId,
              initialSequenceUid: sequenceUid,
            },
            position: {
              referencePanel: "panel-ClipList",
              direction: "within",
            },
          });
          panel.focus();
        }
        api.getPanel(panelId)?.focus();
      },
      {
        cueUid: context.cueUid,
        sequenceUid: context.sequenceUid,
        sequenceId: context.sequenceId,
        fixtureUid: context.fixtureUid,
        staleAttr: context.staleAttr,
      },
    );
    await activateCueEditorPanel(
      page,
      "panel-CueEditor-tracked-values-clear-e2e",
    );
    grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-tracked-values-clear-e2e",
    );
    panelId = "panel-CueEditor-tracked-values-clear-e2e";
    trackedToggle = cueEditorTrackedToggleForPanel(page, panelId);
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "false");
    await trackedToggle.click();
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "true");
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.staleAttr),
    );
    await expect(
      await visibleCueGridCellByIdentifier(grid, {
        columnKey: cueGridAttributeValueColumnKey(context.staleAttr),
        identifierColumnKey: "id",
        identifierText: String(context.fixtureId),
      }),
    ).toHaveText(/^B\s+10$/);

    await page.evaluate(
      ({
        cueUid,
        sequenceUid,
        sequenceId,
        trackedOnlyFixtureUid,
        trackedOnlyAttr,
      }) => {
        const stores = (window as any).appStores;
        const trackedOnlyInstruction = {
          selection: {
            source: {
              type: "Resolved",
              data: [{ fixture_uid: trackedOnlyFixtureUid, index: null }],
            },
            clauses: [],
          },
          cue_instruction: {
            values: {
              [trackedOnlyAttr]: {
                type: "Inline",
                data: { type: "Absolute", data: { value: 77 } },
              },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        };
        const currentSequence = stores.sequences.get()[sequenceUid];
        stores.sequences.set({
          ...stores.sequences.get(),
          [sequenceUid]: {
            ...currentSequence,
            setup_cue: {
              ...currentSequence.setup_cue,
              instructions: [trackedOnlyInstruction],
            },
          },
        });

        const currentCue = stores.cues.get()[cueUid];
        stores.cues.set({
          ...stores.cues.get(),
          [cueUid]: {
            ...currentCue,
            instructions: [],
            parts: [],
          },
        });

        const api = stores.dockApi.get();
        api.getPanel("panel-CueEditor-tracked-values-clear-e2e")?.api.close();
        const panelId = "panel-CueEditor-tracked-values-empty-e2e";
        if (!api.getPanel(panelId)) {
          const panel = api.addPanel({
            id: panelId,
            component: "CueEditor",
            title: "Cue Tracked Values Empty E2E",
            params: {
              initialPanelId: panelId,
              initialCueUid: cueUid,
              initialSequenceId: sequenceId,
              initialSequenceUid: sequenceUid,
            },
            position: {
              referencePanel: "panel-ClipList",
              direction: "within",
            },
          });
          panel.focus();
        }
        api.getPanel(panelId)?.focus();
      },
      {
        cueUid: context.cueUid,
        sequenceUid: context.sequenceUid,
        sequenceId: context.sequenceId,
        trackedOnlyFixtureUid: context.trackedOnlyFixtureUid,
        trackedOnlyAttr: context.trackedOnlyAttr,
      },
    );
    grid = cueEditorGridForPanel(
      page,
      "panel-CueEditor-tracked-values-empty-e2e",
    );
    panelId = "panel-CueEditor-tracked-values-empty-e2e";
    trackedToggle = cueEditorTrackedToggleForPanel(page, panelId);
    await expect(page.getByText("No fixture values in cue p0")).toBeVisible();
    await page
      .getByRole("button", { name: "Switch to timings display mode" })
      .click();
    await expect(page.getByText("No fixture values in cue p0")).toBeVisible();
    await page
      .getByRole("button", { name: "Switch to values display mode" })
      .click();
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "false");
    await trackedToggle.click();
    await expect(trackedToggle).toHaveAttribute("aria-pressed", "true");
    await scrollCueGridToColumn(
      grid,
      cueGridAttributeValueColumnKey(context.trackedOnlyAttr),
    );
    await expect
      .poll(
        async () =>
          mountedCueGridCellTextByIdentifier(grid, {
            columnKey: cueGridAttributeValueColumnKey(context.trackedOnlyAttr),
            identifierColumnKey: "id",
            identifierText: String(context.trackedOnlyFixtureId),
          }),
        { timeout: 10_000 },
      )
      .toBe("77");
  } finally {
    if (!page.isClosed()) {
      await page
        .evaluate(
          ({
            cueUid,
            originalCue,
            originalSequence,
            priorCueUid,
            sequenceUid,
          }) => {
            const stores = (window as any).appStores;
            const restoredCues = {
              ...stores.cues.get(),
              [originalCue.identifiers.uid]: originalCue,
            };
            delete restoredCues[cueUid];
            delete restoredCues[priorCueUid];
            const restoredSequences = {
              ...stores.sequences.get(),
              [originalSequence.identifiers.uid]: originalSequence,
            };
            delete restoredSequences[sequenceUid];
            stores.sequences.set(restoredSequences);
            stores.cues.set(restoredCues);
          },
          context,
        )
        .catch((error) => {
          if (!page.isClosed()) throw error;
        });
    }
  }
});
