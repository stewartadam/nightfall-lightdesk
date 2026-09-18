// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const inputSelector = "#header-cmdline";
const FIXTURE_IDS = Array.from({ length: 24 }, (_, index) => 311 + index);
const CUE_IDS = [96_500, 96_501, 96_502] as const;
const CUE_UIDS = [
  "c7610000000000000000000000000001",
  "c7610000000000000000000000000002",
  "c7610000000000000000000000000003",
] as const;
const SETUP_CUE_UID = "c7610000000000000000000000000004";
const RELEASE_CUE_UID = "c7610000000000000000000000000005";
const SEQUENCE_ID = 96_500;
const SEQUENCE_UID = "c7620000000000000000000000000001";
const CLIP_ID = 96_500;
const CLIP_UID = "c7630000000000000000000000000001";
const CLIP_LABEL = "Owned TanStack Clip";
const MULTI_ELEMENT_FIXTURE_ID = FIXTURE_IDS[FIXTURE_IDS.length - 1]!;
const MULTI_ELEMENT_FIXTURE_UID = ownedFixtureUid(FIXTURE_IDS.length - 1);

test.describe.configure({ timeout: 180_000 });

/** Starts every TanStack scenario from the same exact backend graph. */
test.beforeEach(async ({ backendSlot, page }) => {
  await prepareOwnedTanStackBackend(page, backendSlot.backendPort);
});

/** Stops playback, replaces the backend, and proves every owned store is blank. */
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
    .poll(() => ownedTanStackStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      parameters: 0,
      programmer: 0,
      sequences: 0,
    });
});

/** Returns the deterministic UID for one owned fixture row. */
function ownedFixtureUid(index: number): string {
  return `c760${(index + 1).toString(16).padStart(28, "0")}`;
}

/** Reads every backend-driven store owned by the TanStack scenarios. */
async function ownedTanStackStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      clips: Object.keys(stores.clips.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      parameters: stores.parameters.get().size,
      programmer: stores.programmerState.get().length,
      sequences: Object.keys(stores.sequences.get()).length,
    };
  });
}

/** Sends one correlated backend command and rejects a failed outcome. */
async function sendOwnedTanStackCommand(
  page: Page,
  message: object,
): Promise<void> {
  const result = await page.evaluate(async (command) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    return stores.sendAndAwait(command);
  }, message);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds one fixture parameter for the requested built-in attribute. */
function ownedFixtureParameter(attribute: string): object {
  return {
    resolution: "Coarse",
    attribute: { type: attribute },
    value_polarity: "Unsigned",
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: attribute === "Intensity" ? "HTP" : "LTP",
    use_grandmaster: attribute === "Intensity",
  };
}

/** Builds one owned fixture element with the full asserted column family. */
function ownedFixtureElement(label: string): object {
  return {
    label,
    parameters: [
      "Intensity",
      "Red",
      "Green",
      "Blue",
      "White",
      "Pan",
      "Tilt",
      "Zoom",
    ].map(ownedFixtureParameter),
  };
}

/** Builds one exact fixture row, including the expandable three-cell fixture. */
function ownedFixture(index: number): object {
  const id = FIXTURE_IDS[index];
  if (id === undefined) {
    throw new Error(`Missing owned TanStack fixture at index ${index}`);
  }
  const elementCount = id === MULTI_ELEMENT_FIXTURE_ID ? 3 : 1;
  return {
    identifiers: {
      id,
      uid: ownedFixtureUid(index),
      label: `Owned TanStack Fixture ${id}`,
    },
    make: "E2E",
    model: "TanStack Data Grid",
    mode: elementCount === 1 ? "Full Attributes" : "Three Cell Attributes",
    elements: Array.from({ length: elementCount }, (_, elementIndex) =>
      ownedFixtureElement(`Cell ${elementIndex + 1}`),
    ),
    placement: {
      position: { x: index, y: index % 4, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  };
}

/** Builds a fixed transition duration in seconds. */
function fixedDuration(secs: number): object {
  return { type: "Fixed", data: { secs, nanos: 0 } };
}

/** Builds one complete owned cue for the sequence editor rows. */
function ownedCue(index: number): object {
  const id = CUE_IDS[index];
  const uid = CUE_UIDS[index];
  if (id === undefined || uid === undefined) {
    throw new Error(`Missing owned TanStack cue at index ${index}`);
  }
  return {
    identifiers: { id, uid, label: `Owned TanStack Cue ${index + 1}` },
    trigger: { type: "Manual" },
    transitions:
      index === 1
        ? {
            delay_in: fixedDuration(3),
            fade_in: fixedDuration(2),
            fade_out: fixedDuration(2),
          }
        : {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds one complete sequence metadata cue. */
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

/** Builds the exact three-step sequence opened by sequence-editor tests. */
function ownedSequence(): object {
  return {
    identifiers: {
      id: SEQUENCE_ID,
      uid: SEQUENCE_UID,
      label: "Owned TanStack Sequence",
    },
    steps: [...CUE_UIDS],
    wrap: false,
    release_on_start: false,
    setup_cue: ownedMetaCue(SETUP_CUE_UID, "Owned TanStack Setup"),
    release_cue: ownedMetaCue(RELEASE_CUE_UID, "Owned TanStack Release"),
    default_timing: {
      delay_in: fixedDuration(1),
      fade_in: fixedDuration(2),
      curve_in: "Linear",
      delay_out: fixedDuration(0),
      fade_out: fixedDuration(2),
      curve_out: "Linear",
    },
    tracking_mode: { type: "Inherit" },
  };
}

/** Builds the clip displayed by the shared TanStack list renderer. */
function ownedClip(): object {
  return {
    identifiers: {
      id: CLIP_ID,
      uid: CLIP_UID,
      label: CLIP_LABEL,
    },
    source: { type: "Sequence", data: SEQUENCE_UID },
    priority: 0,
    options: {
      auto_release: false,
      deactivate_on_sequence_end: false,
    },
  };
}

/** Opens a blank app and persists the complete deterministic TanStack graph. */
async function prepareOwnedTanStackBackend(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.parameters?.get) &&
      Boolean((window as any).appStores?.programmerState?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() => ownedTanStackStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      parameters: 0,
      programmer: 0,
      sequences: 0,
    });

  for (let index = 0; index < FIXTURE_IDS.length; index += 1) {
    const fixtureId = FIXTURE_IDS[index];
    if (fixtureId === undefined) {
      throw new Error(`Missing owned TanStack fixture at index ${index}`);
    }
    await sendOwnedTanStackCommand(page, {
      module: "FixtureCommand",
      command: { type: "StoreFixture", data: ownedFixture(index) },
    });
    const isMultiElement = fixtureId === MULTI_ELEMENT_FIXTURE_ID;
    await sendOwnedTanStackCommand(page, {
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: isMultiElement ? "12-segment RGBW Bar" : "Moving Head RGBW",
          mode: isMultiElement ? "RGBW" : "Spot",
          label: `Owned TanStack Fixture ${fixtureId}`,
          update_existing_ids: [fixtureId],
          update_existing_only: true,
        },
      },
    });
  }
  for (let index = 0; index < CUE_IDS.length; index += 1) {
    await sendOwnedTanStackCommand(page, {
      module: "CueCommand",
      command: { type: "StoreCue", data: ownedCue(index) },
    });
  }
  await sendOwnedTanStackCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: ownedSequence() },
  });
  await sendOwnedTanStackCommand(page, {
    module: "ClipCommand",
    command: { type: "StoreClip", data: ownedClip() },
  });
  await expect
    .poll(() => ownedTanStackStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: CUE_IDS.length,
      clips: 1,
      fixtures: FIXTURE_IDS.length,
      parameters: FIXTURE_IDS.length,
      programmer: 0,
      sequences: 1,
    });
}

/** Opens the interactive app shell and proves the exact owned graph is loaded. */
async function openOwnedApp(page: Page): Promise<void> {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect(page.locator("main#app")).toBeVisible();
  await expect
    .poll(() => ownedTanStackStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: CUE_IDS.length,
      clips: 1,
      fixtures: FIXTURE_IDS.length,
      parameters: FIXTURE_IDS.length,
      programmer: 0,
      sequences: 1,
    });
}

/**
 * Waits for every exact owned fixture row in the TanStack prototype grid.
 */
async function waitForFixtureGridData(page: Page) {
  await page.evaluate(async (expectedFixtureCount) => {
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      /** Polls browser state until the awaited test condition is satisfied. */
      const tick = () => {
        const stores = (window as any).appStores;
        const api = stores?.dockApi?.get?.();
        const fixtures = stores?.fixtures?.get?.() ?? {};
        const parameters = stores?.parameters?.get?.();
        if (
          api &&
          Object.keys(fixtures).length === expectedFixtureCount &&
          parameters?.size === expectedFixtureCount
        ) {
          resolve();
          return;
        }
        if (Date.now() - started > 15_000) {
          reject(new Error("owned TanStack fixture data did not load"));
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  }, FIXTURE_IDS.length);
}

/**
 * Submits a command-line command for TanStack grid scenario setup.
 */
async function submitCommand(page: Page, command: string) {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submittedCommand,
        );
        const last = matches[matches.length - 1];
        return last
          ? { errorMessage: last.errorMessage, status: last.status }
          : null;
      }, command),
    )
    .toEqual({ status: "success" });
}

/** Selects an option from the opened Preline dropdown closest to the active toggle. */
async function clickOpenedSelectOption(toggle: Locator, label: string) {
  await expect(toggle).toBeVisible();
  const clicked = await toggle.evaluate((toggleElement, optionLabel) => {
    const toggleRect = toggleElement.getBoundingClientRect();
    const dropdowns = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-hs-select-dropdown].opened",
      ),
    ).filter((dropdown) => {
      const rect = dropdown.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const dropdownWithOption = dropdowns
      .map((dropdown) => {
        const option = Array.from(
          dropdown.querySelectorAll<HTMLElement>("[data-value]"),
        ).find((candidate) => candidate.textContent?.trim() === optionLabel);
        if (!option) return undefined;
        const rect = dropdown.getBoundingClientRect();
        const xDistance = Math.abs(rect.left - toggleRect.left);
        const yDistance = Math.abs(rect.top - toggleRect.bottom);
        return { option, distance: xDistance + yDistance };
      })
      .filter(
        (entry): entry is { option: HTMLElement; distance: number } =>
          entry !== undefined,
      )
      .sort((left, right) => left.distance - right.distance)[0];

    dropdownWithOption?.option.click();
    return dropdownWithOption !== undefined;
  }, label);
  expect(clicked).toBe(true);
}

/**
 * Returns the exact expandable owned fixture row in the prototype grid.
 */
async function expandableFixtureRowIndex(page: Page) {
  return await page.evaluate(
    ({ fixtureId, fixtureUid }) => {
      const stores = (window as any).appStores;
      const fixtureMap = stores?.fixtures?.get?.() ?? {};
      const parameters = stores?.parameters?.get?.() as
        | Map<
            string,
            {
              elements?: unknown[];
            }
          >
        | undefined;

      const fixtures = Object.values(fixtureMap) as Array<{
        identifiers: { id: number; uid: string };
      }>;
      const sortedFixtures = fixtures.sort(
        (lhs, rhs) => lhs.identifiers.id - rhs.identifiers.id,
      );
      const rowIndex = sortedFixtures.findIndex(
        (fixture) =>
          fixture.identifiers.id === fixtureId &&
          fixture.identifiers.uid === fixtureUid,
      );
      const elements = parameters?.get(fixtureUid)?.elements;
      if (rowIndex < 0) {
        throw new Error(`Owned expandable fixture ${fixtureId} was not loaded`);
      }
      if (!Array.isArray(elements) || elements.length <= 1) {
        throw new Error(`Owned fixture ${fixtureId} was not multi-element`);
      }
      return {
        fixtureId,
        rowIndex,
      };
    },
    {
      fixtureId: MULTI_ELEMENT_FIXTURE_ID,
      fixtureUid: MULTI_ELEMENT_FIXTURE_UID,
    },
  );
}

/**
 * Locates the fixture data grid in the TanStack prototype surface.
 */
function fixtureDataGrid(page: Page) {
  return page
    .locator('[data-grid-kind="tanstack"]:visible')
    .filter({
      has: page.locator(
        '[data-grid-header-id="tanstack-header-category:Color"]',
      ),
    })
    .first();
}

/**
 * Opens the TanStack fixture grid and waits for it to render rows.
 */
async function openTanStackFixturesGrid(page: Page) {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-fixtures-panel-settings",
      JSON.stringify({
        showOnlyWithAttributes: false,
        expandedFixtures: [],
        showReleasedOutput: false,
      }),
    );
  });
  await openOwnedApp(page);
  await waitForFixtureGridData(page);
  await page.getByText("Fixtures", { exact: true }).first().click();

  const grid = fixtureDataGrid(page);
  await expect(grid).toBeVisible();
  return grid;
}

/**
 * Finds the rendered grid row index for a fixture ID.
 */
async function fixtureRowIndexById(page: Page, fixtureId: number) {
  return await page.evaluate((id) => {
    const stores = (window as any).appStores;
    const fixtureMap = stores?.fixtures?.get?.() ?? {};
    const fixtures = Object.values(fixtureMap) as Array<{
      identifiers: { id: number; uid: string };
    }>;
    const rowIndex = fixtures
      .sort((lhs, rhs) => lhs.identifiers.id - rhs.identifiers.id)
      .findIndex((fixture) => fixture.identifiers.id === id);
    if (rowIndex < 0) {
      throw new Error(`No fixture with id ${id}`);
    }
    return rowIndex;
  }, fixtureId);
}

/**
 * Performs a pointer drag from one grid cell to another.
 */
async function dragBetweenCells(
  page: Page,
  start: Locator,
  end: Locator,
  modifiers: string[] = [],
) {
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  if (!startBox || !endBox) {
    throw new Error("Unable to resolve tanstack cell bounds for drag");
  }

  for (const modifier of modifiers) {
    await page.keyboard.down(modifier);
  }
  await page.mouse.move(
    startBox.x + startBox.width / 2,
    startBox.y + startBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    endBox.x + endBox.width / 2,
    endBox.y + endBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) {
    await page.keyboard.up(modifier);
  }
}

/**
 * Presses a cell while allowing a small pointer drift before release.
 */
async function pressCellWithPointerDrift(
  page: Page,
  cell: Locator,
  driftX: number,
  driftY: number,
) {
  const box = await cell.boundingBox();
  if (!box) {
    throw new Error("Unable to resolve tanstack cell bounds for pointer drift");
  }

  const startX = box.x + box.width - 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + driftX, startY + driftY);
  await page.mouse.up();
}

/**
 * Returns the selected columns for the first fixture row.
 */
async function selectedFirstRowColumns(grid: Locator) {
  return await grid.evaluate((element) =>
    Array.from(
      element.querySelectorAll<HTMLElement>(
        '[role="gridcell"][id$="-0"][data-selected="true"]',
      ),
    )
      .map((cell) => Number(cell.id.match(/^tanstack-cell-(\d+)-/)?.[1]))
      .filter((col) => Number.isFinite(col)),
  );
}

/**
 * Checks a canvas region for non-background pixels.
 */
async function canvasHasPaint(
  canvas: import("@playwright/test").Locator,
): Promise<boolean> {
  return await canvas.evaluate((canvasElement: HTMLCanvasElement) => {
    if (canvasElement.width === 0 || canvasElement.height === 0) {
      return false;
    }
    const context = canvasElement.getContext("2d");
    if (!context) {
      return false;
    }
    const { data } = context.getImageData(
      0,
      0,
      canvasElement.width,
      canvasElement.height,
    );
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Opens the sequence editor panel for TanStack grid coverage.
 */
async function openSequenceEditorPanel(
  page: import("@playwright/test").Page,
  options?: { stepCount?: number },
) {
  return await page.evaluate(
    async ({ cueUids, sequenceUid, stepCount }) => {
      type Duration = { secs: number; nanos: number };
      type TransitionMode = { type: "Fixed"; data: Duration };
      type Cue = {
        identifiers: { id: number; label: string; uid: string };
        trigger:
          | { type: "Manual" }
          | { type: "FollowPrevious" }
          | { type: "AfterDelay"; data: Duration };
        transitions: {
          delay_in?: TransitionMode;
          fade_in?: TransitionMode;
          fade_out?: TransitionMode;
        };
      };
      type Sequence = {
        identifiers: { uid: string };
        steps: string[];
        default_timing: {
          delay_in: TransitionMode;
          fade_in: TransitionMode;
          fade_out: TransitionMode;
        };
      };

      /** Waits for browser stores needed by the sequence editor grid scenario. */
      const waitForStores = () =>
        new Promise<any>((resolve, reject) => {
          const started = Date.now();

          /** Polls browser state until the awaited test condition is satisfied. */
          const tick = () => {
            const stores = (window as any).appStores;
            const api = stores?.dockApi?.get?.();
            const cues = stores?.cues?.get?.() ?? {};
            const sequences = stores?.sequences?.get?.() ?? {};
            const sequence = sequences[sequenceUid];
            if (
              api &&
              sequence &&
              cueUids.every((cueUid) => cues[cueUid] !== undefined)
            ) {
              resolve(stores);
              return;
            }
            if (Date.now() - started > 15_000) {
              reject(new Error("owned TanStack sequence data did not load"));
              return;
            }
            window.setTimeout(tick, 100);
          };
          tick();
        });

      const stores = await waitForStores();
      const api = stores.dockApi.get();
      const cues = stores.cues.get() as Record<string, Cue>;
      const sequences = stores.sequences.get() as Record<string, Sequence>;
      const sequence = sequences[sequenceUid];
      if (!sequence) {
        throw new Error(
          `Owned TanStack sequence ${sequenceUid} was not loaded`,
        );
      }
      const testCueUids: string[] = [...cueUids];
      const firstCueUid = cueUids[0];
      const firstCue = firstCueUid ? cues[firstCueUid] : undefined;
      if (!firstCueUid || !firstCue) {
        throw new Error("Owned TanStack base cue was not loaded");
      }
      const editableCueUid = cueUids[1];
      const editableCue = editableCueUid ? cues[editableCueUid] : undefined;
      if (!editableCueUid || !editableCue) {
        throw new Error("Owned TanStack editable cue was not loaded");
      }
      const clonedCueEntries = Array.from(
        { length: Math.max(0, stepCount - testCueUids.length) },
        (_, index) => {
          const clonedUid = `c764${(index + 1).toString(16).padStart(28, "0")}`;
          testCueUids.push(clonedUid);
          return [
            clonedUid,
            {
              ...firstCue,
              identifiers: {
                ...firstCue.identifiers,
                id: 97_000 + index,
                label: `Owned TanStack Stress Cue ${index + 1}`,
                uid: clonedUid,
              },
            },
          ] as const;
        },
      );

      const duration = (secs: number): Duration => ({ secs, nanos: 0 });
      const fixed = (secs: number): TransitionMode => ({
        type: "Fixed",
        data: duration(secs),
      });

      stores.cues.set({
        ...cues,
        ...Object.fromEntries(clonedCueEntries),
        [editableCueUid]: {
          ...editableCue,
          trigger: { type: "Manual" },
          transitions: {
            ...editableCue.transitions,
            delay_in: fixed(3),
            fade_in: fixed(2),
            fade_out: fixed(2),
          },
        },
      });
      stores.sequences.set({
        ...sequences,
        [sequence.identifiers.uid]: {
          ...sequence,
          steps: testCueUids,
          default_timing: {
            ...sequence.default_timing,
            delay_in: fixed(1),
            fade_in: fixed(2),
            fade_out: fixed(2),
          },
        },
      });

      const panelId = "panel-SequenceEditor-tanstack-e2e";
      api.getPanel(panelId)?.api.close();
      const panel = api.addPanel({
        id: panelId,
        component: "SequenceEditor",
        title: "Sequence E2E",
        params: {
          initialPanelId: panelId,
          initialSequenceUid: sequenceUid,
        },
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
      });
      panel.api.setActive();

      return { editableCueUid };
    },
    {
      cueUids: [...CUE_UIDS],
      sequenceUid: SEQUENCE_UID,
      stepCount: options?.stepCount ?? 3,
    },
  );
}

/**
 * Opens the clip list panel for TanStack grid coverage.
 */
async function openClipListPanel(page: import("@playwright/test").Page) {
  return await page.evaluate(
    async ({ clipLabel, clipUid }) => {
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();

        /** Polls browser state until the awaited test condition is satisfied. */
        const tick = () => {
          const stores = (window as any).appStores;
          const api = stores?.dockApi?.get?.();
          const clips = stores?.clips?.get?.() ?? {};
          if (api && clips[clipUid]?.[0]?.identifiers?.label === clipLabel) {
            resolve();
            return;
          }
          if (Date.now() - started > 15_000) {
            reject(new Error("owned TanStack clip data did not load"));
            return;
          }
          window.setTimeout(tick, 100);
        };
        tick();
      });

      const api = (window as any).appStores.dockApi.get();
      const panelId = "panel-ClipList";
      const panel =
        api.getPanel(panelId) ??
        api.addPanel({
          id: panelId,
          component: "ClipList",
          title: "Clips",
          params: { initialPanelId: panelId },
        });
      panel.api.setActive();

      const clip = (window as any).appStores.clips.get()[clipUid]?.[0];
      if (clip?.identifiers?.label !== clipLabel) {
        throw new Error(`Owned TanStack clip ${clipUid} was not loaded`);
      }
      return clipLabel;
    },
    {
      clipLabel: CLIP_LABEL,
      clipUid: CLIP_UID,
    },
  );
}

/** Verifies showfile-like fixture data replacement does not crash stale virtualized columns. */
test("TanStack Fixtures survives column shrink during showfile reload", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const grid = await openTanStackFixturesGrid(page);
  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() =>
      grid.evaluate((element) =>
        Array.from(element.querySelectorAll<HTMLElement>('[role="gridcell"]'))
          .map((cell) => Number(cell.id.match(/^tanstack-cell-(\d+)-/)?.[1]))
          .some((columnIndex) => columnIndex > 5),
      ),
    )
    .toBe(true);

  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    const fixture = stores.fixtures.get()?.[fixtureUid];
    if (!fixture) {
      throw new Error(`Owned reload fixture ${fixtureUid} was not loaded`);
    }

    stores.fixtures.set({ [fixtureUid]: fixture });
    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(0, 0, 0)",
            raw: { Dimmer: 255 },
            absolute: {
              Dimmer: { type: "AbsolutePercent", data: { value: 1 } },
            },
            relative: {},
            conflicts: new Set(),
            elements: [],
          },
        ],
      ]),
    );
    stores.layerStack.set([]);
  }, MULTI_ELEMENT_FIXTURE_UID);

  await expect(page.getByText("Error rendering component")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  expect(
    pageErrors.filter((message) => message.includes("'width' in undefined")),
  ).toEqual([]);
});

/** Verifies owned attributes render nested headers and support grid selection modes. */
test("TanStack Fixtures panel renders nested attribute headers", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-fixtures-panel-settings",
      JSON.stringify({
        showOnlyWithAttributes: false,
        expandedFixtures: [],
        showReleasedOutput: false,
      }),
    );
  });
  await openOwnedApp(page);
  await waitForFixtureGridData(page);
  await page.getByText("Fixtures", { exact: true }).first().click();

  const grid = fixtureDataGrid(page);
  await expect(grid).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveCSS(
    "border-bottom-style",
    "solid",
  );
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveCSS(
    "border-bottom-width",
    "1px",
  );
  await expect
    .poll(() =>
      grid.evaluate((element) => {
        const idCells = Array.from(
          element.querySelectorAll<HTMLElement>('[id^="tanstack-cell-0-"]'),
        );
        const nonExpandableParent = idCells
          .map((cell) => cell.textContent ?? "")
          .find((text) => {
            const trimmed = text.trim();
            return (
              /^\d+$/.test(trimmed) &&
              !text.startsWith("▶") &&
              !text.startsWith("▼")
            );
          });
        return nonExpandableParent?.slice(0, 4) ?? "";
      }),
    )
    .toBe("\u00a0".repeat(4));
  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-category:Color"]'),
  ).toBeVisible();
  await expect(
    grid.locator(
      '[data-grid-header-id="tanstack-header-category:Color:group:Red"]',
    ),
  ).toHaveText("Red");
  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-Red_Value"]'),
  ).toBeVisible();
  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-category:Position"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      grid.evaluate((element) =>
        Array.from(
          element.querySelectorAll<HTMLElement>('[role="gridcell"][id$="-0"]'),
        )
          .map((cell) => Number(cell.id.match(/^tanstack-cell-(\d+)-/)?.[1]))
          .filter((col) => Number.isFinite(col))
          .slice(0, 10)
          .join(","),
      ),
    )
    .toBe("0,1,2,3,4,5,6,7,8,9");

  const fixtureGridScreenshot = testInfo.outputPath(
    "owned-tanstack-fixture-grid.png",
  );
  await grid.screenshot({ path: fixtureGridScreenshot });
  await testInfo.attach("owned-tanstack-fixture-grid", {
    path: fixtureGridScreenshot,
    contentType: "image/png",
  });

  const visualLeafHeaderIndex = 4;
  const leafHeaderClickPoint = await grid.evaluate((element, index) => {
    const headers = Array.from(
      element.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    );
    const headerRects = headers.map((header) => ({
      header,
      rect: header.getBoundingClientRect(),
    }));
    const leafTop = Math.max(...headerRects.map(({ rect }) => rect.top));
    const leafHeaders = headerRects
      .filter(({ rect }) => Math.abs(rect.top - leafTop) < 1)
      .sort((lhs, rhs) => lhs.rect.left - rhs.rect.left);
    const target = leafHeaders[index];
    if (!target) {
      throw new Error(`No leaf header at visual index ${index}`);
    }
    return {
      x: target.rect.left + target.rect.width / 2,
      y: target.rect.top + target.rect.height / 2,
    };
  }, visualLeafHeaderIndex);
  await page.mouse.click(leafHeaderClickPoint.x, leafHeaderClickPoint.y);
  await expect
    .poll(() =>
      grid.evaluate((element) =>
        Array.from(
          element.querySelectorAll<HTMLElement>(
            '[role="gridcell"][id$="-0"][data-selected="true"]',
          ),
        ).map((cell) => Number(cell.id.match(/^tanstack-cell-(\d+)-/)?.[1])),
      ),
    )
    .toEqual([visualLeafHeaderIndex]);

  const idHeader = grid
    .locator('[data-grid-header-id="tanstack-header-id"]')
    .last();
  await idHeader.click();
  await expect(idHeader).toHaveAttribute("data-selected", "true");
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-0")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await grid
    .locator('[data-grid-header-id="tanstack-header-category:Color"]')
    .click();
  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-category:Color"]'),
  ).toHaveAttribute("data-selected", "true");
  await expect
    .poll(() =>
      grid.evaluate((element) =>
        Array.from(
          element.querySelectorAll<HTMLElement>(
            '[role="gridcell"][id$="-0"][data-selected="true"]',
          ),
        )
          .map((cell) => Number(cell.id.match(/^tanstack-cell-(\d+)-/)?.[1]))
          .filter((col) => Number.isFinite(col))
          .some((col) => col >= 2),
      ),
    )
    .toBe(true);

  await grid.locator("#tanstack-cell-0-0").click();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.keyboard.down("Shift");
  await page.keyboard.press("Space");
  await page.keyboard.up("Shift");
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-0-1")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await grid.locator("#tanstack-cell-0-0").click();
  await grid.locator("#tanstack-cell-0-0").click({ modifiers: ["Meta"] });
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await grid.locator("#tanstack-cell-0-0").click();
  await grid.locator("#tanstack-cell-2-2").click({ modifiers: ["Shift"] });
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await grid.locator("#tanstack-cell-1-1").click({ modifiers: ["Meta"] });
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await grid.locator("#tanstack-cell-0-0").click();
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await grid.locator("#tanstack-cell-2-2").click({ modifiers: ["Meta"] });
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await grid.locator("#tanstack-cell-2-2").click({ modifiers: ["Meta"] });
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await grid.locator("#tanstack-cell-0-0").click({ modifiers: ["Meta"] });
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await grid.locator("#tanstack-cell-0-0").click();
  await grid.locator("#tanstack-cell-2-2").click({ modifiers: ["Meta"] });
  await grid.locator("#tanstack-cell-2-2").click({ modifiers: ["Meta"] });
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await dragBetweenCells(
    page,
    grid.locator("#tanstack-cell-0-0"),
    grid.locator("#tanstack-cell-2-2"),
  );
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await dragBetweenCells(
    page,
    grid.locator("#tanstack-cell-0-0"),
    grid.locator("#tanstack-cell-1-1"),
    ["Meta"],
  );
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await grid.locator("#tanstack-cell-0-0").click();
  await dragBetweenCells(
    page,
    grid.locator("#tanstack-cell-2-2"),
    grid.locator("#tanstack-cell-3-3"),
    ["Meta"],
  );
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-3-3")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await page.setViewportSize({ width: 900, height: 700 });
  await expect
    .poll(() =>
      grid.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  await grid.locator("#tanstack-cell-4-4").click();
  await grid.locator("#tanstack-cell-0-0").click();
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});

/** Verifies owned fixture-grid scroll offsets survive Dockview tab switches. */
test("TanStack Fixtures preserves scroll position when switching dock tabs", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  await page.setViewportSize({ width: 900, height: 500 });
  await expect(grid).toBeVisible();
  await expect
    .poll(() =>
      grid.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);

  /** Reads rounded scroll offsets from the fixture grid container. */
  const readScroll = () =>
    grid.evaluate((element) => ({
      left: Math.round(element.scrollLeft),
      top: Math.round(element.scrollTop),
    }));

  await grid.evaluate((element) => {
    element.scrollTo({ left: 720, top: 180 });
  });
  await expect.poll(async () => (await readScroll()).left).toBeGreaterThan(0);
  await expect.poll(async () => (await readScroll()).top).toBeGreaterThan(0);
  const stored = await readScroll();

  await page
    .locator(".dv-tab")
    .filter({ hasText: "3D Visualizer" })
    .first()
    .click();
  await expect(grid).not.toBeVisible();
  await page.locator(".dv-tab").filter({ hasText: "Fixtures" }).first().click();
  await expect(grid).toBeVisible();

  await expect
    .poll(async () => (await readScroll()).left)
    .toBeGreaterThanOrEqual(stored.left - 1);
  await expect
    .poll(async () => (await readScroll()).top)
    .toBeGreaterThanOrEqual(stored.top - 1);
});

/** Verifies Shift+Space creates an extendable whole-row selection. */
test("TanStack Fixtures shift space extends row selection with arrow keys", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);

  await grid.locator("#tanstack-cell-0-2").click();
  await page.keyboard.down("Shift");
  await page.keyboard.press("Space");
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-3")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await page.keyboard.press("ArrowDown");
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-3")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await page.keyboard.press("ArrowUp");
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-3")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await page.keyboard.press("ArrowUp");
  await expect(grid.locator("#tanstack-cell-1-1")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-3")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await page.keyboard.up("Shift");
});

/** Verifies horizontal arrows collapse a whole-row selection to one active cell. */
test("TanStack Fixtures horizontal arrows leave whole-row selection", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);

  await grid.locator("#tanstack-cell-0-2").click();
  await page.keyboard.press("Shift+Space");
  await expect(grid.locator("#tanstack-cell-0-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await page.keyboard.press("ArrowRight");
  await expect(grid.locator("#tanstack-cell-0-2")).toHaveAttribute(
    "data-selected",
    "false",
  );
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-2-2")).toHaveAttribute(
    "data-selected",
    "false",
  );

  await page.keyboard.press("Shift+Space");
  await expect(grid.locator("#tanstack-cell-0-2")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await page.keyboard.press("ArrowLeft");
  await expect(grid.locator("#tanstack-cell-0-2")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(grid.locator("#tanstack-cell-1-2")).toHaveAttribute(
    "data-selected",
    "false",
  );
});

/** Verifies paging and boundary shortcuts navigate the complete owned grid. */
test("TanStack Fixtures supports page and row-boundary keyboard navigation", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  await page.setViewportSize({ width: 900, height: 420 });

  /** Reads the active grid cell coordinate from the rendered selected cell. */
  const activeCell = () =>
    grid.evaluate((element) => {
      const cell = element.querySelector<HTMLElement>(
        '[role="gridcell"][aria-selected="true"]',
      );
      const match = cell?.id.match(/^tanstack-cell-(\d+)-(\d+)$/);
      if (!match) return null;
      return {
        col: Number(match[1]),
        row: Number(match[2]),
      };
    });

  await grid.locator("#tanstack-cell-0-0").click();
  await page.keyboard.press("PageDown");
  await expect
    .poll(async () => (await activeCell())?.row ?? 0)
    .toBeGreaterThan(0);

  await page.keyboard.press("End");
  await expect
    .poll(async () => (await activeCell())?.col ?? 0)
    .toBeGreaterThan(0);
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);

  await page.keyboard.press("Home");
  await expect.poll(async () => (await activeCell())?.col).toBe(0);
  await expect
    .poll(() => grid.evaluate((element) => Math.round(element.scrollLeft)))
    .toBe(0);

  await page.keyboard.press("Control+End");
  await expect
    .poll(async () => (await activeCell())?.col ?? 0)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await activeCell())?.row ?? 0)
    .toBeGreaterThan(0);

  await page.keyboard.press("Control+Home");
  await expect.poll(activeCell).toEqual({ col: 0, row: 0 });
});

/** Verifies fixture 311 Red output aligns beneath its virtualized value header. */
test("TanStack Fixtures renders asserted values under the matching virtualized column", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  await submitCommand(page, "fix 311 red @ 100");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return stores?.programmerState?.get?.().length ?? 0;
      }),
    )
    .toBeGreaterThan(0);
  const rowIndex = await fixtureRowIndexById(page, 311);

  await expect(grid.locator(`#tanstack-cell-0-${rowIndex}`)).toContainText(
    "311",
  );

  /** Measures alignment between the Red value header and its selected cell. */
  const redValueAlignment = () =>
    grid.evaluate((element, row) => {
      const redValueHeader = Array.from(
        element.querySelectorAll<HTMLElement>('[role="columnheader"]'),
      ).find(
        (header) => header.dataset.gridHeaderId === "tanstack-header-Red_Value",
      );
      if (!redValueHeader) return null;

      const headerRect = redValueHeader.getBoundingClientRect();
      const valueCell = Array.from(
        element.querySelectorAll<HTMLElement>(
          `[role="gridcell"][id$="-${row}"]`,
        ),
      ).find((cell) => {
        const rect = cell.getBoundingClientRect();
        return Math.abs(rect.left - headerRect.left) < 1;
      });
      if (!valueCell) return null;

      const valueRect = valueCell.getBoundingClientRect();
      return {
        text: valueCell.textContent?.trim() ?? "",
        valueLeft: valueRect.left,
        valueRight: valueRect.right,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
      };
    }, rowIndex);
  await expect
    .poll(redValueAlignment)
    .toEqual(expect.objectContaining({ text: "100%" }));
  const alignment = await redValueAlignment();
  if (!alignment) {
    throw new Error("Missing Red Value alignment data");
  }
  expect(Math.abs(alignment.valueLeft - alignment.headerLeft)).toBeLessThan(1);
  expect(Math.abs(alignment.valueRight - alignment.headerRight)).toBeLessThan(
    1,
  );
});

/** Verifies all header levels retain their widths and align with virtualized body cells while scrolling. */
test("TanStack Fixtures keeps nested headers aligned when scrolling horizontally", async ({
  page,
}, testInfo) => {
  const grid = await openTanStackFixturesGrid(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect
    .poll(() =>
      grid.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeGreaterThan(0);

  /** Captures every header span and compares mounted body cells with their leaf headers. */
  const readGeometry = () =>
    grid.evaluate((element) => {
      const headers = Array.from(
        element.querySelectorAll<HTMLElement>('[role="columnheader"]'),
      );
      const leafTop = Math.max(
        ...headers.map((header) => header.getBoundingClientRect().top),
      );
      const leafHeaders = headers.filter(
        (header) => header.getBoundingClientRect().top === leafTop,
      );
      const cells = Array.from(
        element.querySelectorAll<HTMLElement>(
          '[role="gridcell"][data-grid-row-index="0"]',
        ),
      );
      return {
        widths: headers.map((header) => header.getBoundingClientRect().width),
        cellCount: cells.length,
        alignmentErrors: cells.flatMap((cell) => {
          const index = Number(cell.dataset.gridColumnIndex);
          const header = leafHeaders[index];
          if (!header) return [`Missing header for column ${index}`];
          const cellRect = cell.getBoundingClientRect();
          const headerRect = header.getBoundingClientRect();
          return Math.abs(cellRect.left - headerRect.left) < 1 &&
            Math.abs(cellRect.right - headerRect.right) < 1
            ? []
            : [
                `Column ${index}: header ${headerRect.left}..${headerRect.right}, cell ${cellRect.left}..${cellRect.right}`,
              ];
        }),
      };
    });

  await expect
    .poll(async () => (await readGeometry()).cellCount)
    .toBeGreaterThan(0);
  const initialWidths = (await readGeometry()).widths;
  for (const ratio of [0, 0.25, 0.5, 1, 0]) {
    await grid.evaluate((element, scrollRatio) => {
      element.scrollLeft =
        (element.scrollWidth - element.clientWidth) * scrollRatio;
    }, ratio);
    await expect
      .poll(async () => (await readGeometry()).alignmentErrors)
      .toEqual([]);
    await expect
      .poll(async () => (await readGeometry()).widths)
      .toEqual(initialWidths);
    if (ratio === 1) {
      await grid.screenshot({
        path: testInfo.outputPath("scrolled-right.png"),
      });
    }
  }
});

/** Verifies center-column virtualization keeps the rendered body below the full table size. */
test("TanStack Fixtures bounds body DOM across horizontal scrolling", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect
    .poll(() =>
      grid.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeGreaterThan(0);
  const modelColumnCount = Number(
    await grid.getAttribute("data-grid-model-column-count"),
  );
  const modelRowCount = Number(
    await grid.getAttribute("data-grid-model-row-count"),
  );
  expect(modelColumnCount).toBeGreaterThan(0);
  expect(modelRowCount).toBeGreaterThan(0);

  const renderedCellCounts: number[] = [];
  for (const scrollRatio of [0, 0.5, 1]) {
    const targetScrollLeft = await grid.evaluate((element, ratio) => {
      const maximum = element.scrollWidth - element.clientWidth;
      element.scrollLeft = maximum * ratio;
      return Math.round(element.scrollLeft);
    }, scrollRatio);
    await expect
      .poll(() => grid.evaluate((element) => Math.round(element.scrollLeft)))
      .toBe(targetScrollLeft);
    renderedCellCounts.push(await grid.getByRole("gridcell").count());
  }

  const fullTableCellCount = modelColumnCount * modelRowCount;
  expect(Math.max(...renderedCellCounts)).toBeLessThan(fullTableCellCount);
  expect(Math.min(...renderedCellCounts)).toBeGreaterThan(0);
});

/** Verifies repeated owned Dimmer and Color header clicks replace selection. */
test("TanStack Fixtures grouped header clicks update selection repeatedly", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  const targets = [
    {
      headerId: "tanstack-header-category:Dimmer",
    },
    {
      headerId: "tanstack-header-category:Color",
    },
  ];
  for (const target of targets) {
    await expect(
      grid.locator(`[data-grid-header-id="${target.headerId}"]`).last(),
    ).toBeVisible();
  }

  let previousSelection = "";
  for (let index = 0; index < 10; index += 1) {
    const target = targets[index % targets.length]!;
    const header = grid
      .locator(`[data-grid-header-id="${target.headerId}"]`)
      .last();
    await header.click();
    await expect(header).toHaveAttribute("data-selected", "true");
    await expect
      .poll(async () => (await selectedFirstRowColumns(grid)).join(","))
      .not.toBe(previousSelection);
    const currentSelection = (await selectedFirstRowColumns(grid)).join(",");
    expect(currentSelection).not.toBe("");
    previousSelection = currentSelection;
    await page.waitForTimeout(500);
  }
});

/** Verifies resizing an owned fixture header updates its visible cells. */
test("TanStack Fixtures column resizing updates visible cells", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  const fixtureHeader = grid
    .locator('[data-grid-header-id="tanstack-header-name"]')
    .last();
  await expect(fixtureHeader).toBeVisible();

  const fixtureCell = grid.locator("#tanstack-cell-1-0");
  const nextCell = grid.locator("#tanstack-cell-2-0");
  await expect(fixtureCell).toBeVisible();
  await expect(nextCell).toBeVisible();

  const initialHeaderWidth = await fixtureHeader.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const initialCellWidth = await fixtureCell.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const initialNextCellLeft = await nextCell.evaluate(
    (element) => element.getBoundingClientRect().left,
  );
  const headerBox = await fixtureHeader.boundingBox();
  expect(headerBox).not.toBeNull();

  const dragY = headerBox!.y + headerBox!.height / 2;
  await page.mouse.move(headerBox!.x + headerBox!.width - 2, dragY);
  await page.mouse.down();
  await page.mouse.move(headerBox!.x + headerBox!.width + 62, dragY, {
    steps: 8,
  });
  await page.mouse.up();

  await expect
    .poll(() =>
      fixtureHeader.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    )
    .toBeGreaterThan(initialHeaderWidth + 40);
  await expect
    .poll(() =>
      fixtureCell.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(initialCellWidth + 40);
  await expect
    .poll(() =>
      nextCell.evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBeGreaterThan(initialNextCellLeft + 40);

  await fixtureHeader.locator('[data-grid-resize-handle="true"]').dblclick();
  await expect
    .poll(() =>
      fixtureHeader.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    )
    .toBeLessThan(initialHeaderWidth + 5);
});

/** Verifies a wider provider value grows its column without mounting hidden measurement cells. */
test("TanStack Fixtures auto-sizes columns from all row content", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  const fixtureHeader = grid
    .locator('[data-grid-header-id="tanstack-header-name"]')
    .last();
  const initialWidth = await fixtureHeader.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const longLabel =
    "Owned TanStack Fixture With A Deliberately Much Longer Content Label";

  await page.evaluate(
    ({ fixtureUid, label }) => {
      const stores = (window as any).appStores;
      const fixtures = stores.fixtures.get();
      const fixture = fixtures[fixtureUid];
      if (!fixture) throw new Error(`Fixture ${fixtureUid} was not loaded`);
      stores.fixtures.set({
        ...fixtures,
        [fixtureUid]: {
          ...fixture,
          model: label,
        },
      });
    },
    { fixtureUid: ownedFixtureUid(0), label: longLabel },
  );

  await expect(grid.getByText(longLabel, { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      fixtureHeader.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    )
    .toBeGreaterThan(initialWidth + 100);
});

/** Verifies the exact three-element fixture expands and collapses immediately. */
test("TanStack Fixtures panel collapses immediately after expanding a fixture row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-fixtures-panel-settings",
      JSON.stringify({
        showOnlyWithAttributes: false,
        expandedFixtures: [],
        showReleasedOutput: false,
      }),
    );
  });
  await openOwnedApp(page);
  await waitForFixtureGridData(page);
  const { fixtureId, rowIndex } = await expandableFixtureRowIndex(page);
  await page.getByText("Fixtures", { exact: true }).first().click();

  const grid = fixtureDataGrid(page);
  await expect(grid).toBeVisible();
  const idCell = grid.locator(`#tanstack-cell-0-${rowIndex}`);
  await expect(idCell).toContainText(`▶ ${fixtureId}`);

  await idCell.click();
  await expect(idCell).toContainText(`▼ ${fixtureId}`);

  await idCell.click();
  await expect(idCell).toContainText(`▶ ${fixtureId}`, { timeout: 500 });
});

/** Verifies double-clicking the owned expandable fixture does not start editing. */
test("TanStack Fixtures double-clicks expandable rows without entering edit mode", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  const { fixtureId, rowIndex } = await expandableFixtureRowIndex(page);
  const idCell = grid.locator(`#tanstack-cell-0-${rowIndex}`);

  await expect(idCell).toContainText(`▶ ${fixtureId}`);
  await idCell.dblclick();
  await expect(idCell).toContainText(`▶ ${fixtureId}`);
  await expect(idCell.locator("input, textarea, select")).toHaveCount(0);
});

/** Verifies a small pointer drift still toggles the owned expandable fixture. */
test("TanStack Fixtures toggles expandable rows despite small pointer drift", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  const { fixtureId, rowIndex } = await expandableFixtureRowIndex(page);
  const idCell = grid.locator(`#tanstack-cell-0-${rowIndex}`);

  await expect(idCell).toContainText(`▶ ${fixtureId}`);
  await pressCellWithPointerDrift(page, idCell, 3, 0);
  await expect(idCell).toContainText(`▼ ${fixtureId}`);

  await pressCellWithPointerDrift(page, idCell, 3, 0);
  await expect(idCell).toContainText(`▶ ${fixtureId}`);
});

/** Verifies Enter and Space toggle the selected owned fixture ID row. */
test("TanStack Fixtures toggles expandable ID rows with Enter and Space", async ({
  page,
}) => {
  const grid = await openTanStackFixturesGrid(page);
  const { fixtureId, rowIndex } = await expandableFixtureRowIndex(page);
  const idCell = grid.locator(`#tanstack-cell-0-${rowIndex}`);

  await expect(idCell).toContainText(`▶ ${fixtureId}`);
  await idCell.click();
  await expect(idCell).toContainText(`▼ ${fixtureId}`);

  await page.keyboard.press("Enter");
  await expect(idCell).toContainText(`▶ ${fixtureId}`);
  await expect(idCell).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(idCell).toContainText(`▼ ${fixtureId}`);
  await expect(idCell).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Space");
  await expect(idCell).toContainText(`▶ ${fixtureId}`);
  await expect(idCell).toHaveAttribute("aria-selected", "true");
});

/** Verifies the exact owned clip renders through the shared TanStack list. */
test("TanStack renderer is used by shared list tables", async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-crud-panel-view-mode:clips-list",
      "list",
    );
  });
  await openOwnedApp(page);
  const firstClipLabel = await openClipListPanel(page);

  const clipPanel = page.locator(
    '[data-panel-kind="clips"][data-panel-id="panel-ClipList"]',
  );
  const grid = clipPanel.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await expect(
    grid.locator('[data-grid-header-id^="tanstack-header-placeholder-"]'),
  ).toHaveCount(0);
  await expect(grid.getByText(firstClipLabel)).toBeVisible();
});

/** Verifies fixture 311 Red output paints the shared programmer color cell. */
test("TanStack renderer displays shared custom color cells", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await openOwnedApp(page);
  await waitForFixtureGridData(page);
  await submitCommand(page, "fix 311 red @ 100");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return stores?.programmerState?.get?.().length ?? 0;
      }),
    )
    .toBeGreaterThan(0);

  await page.getByText("Programmer", { exact: true }).first().click();
  const programmerPanel = page.locator('[data-panel-kind="programmer"]');
  const grid = programmerPanel.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-category:Color"]'),
  ).toBeVisible();
  await expect
    .poll(() => canvasHasPaint(grid.locator("canvas").first()))
    .toBe(true);
});

/** Verifies sequence editor controls stay pinned while scrolling cue rows. */
test("TanStack sequence editor keeps toolbar and headers sticky", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 520 });
  await openOwnedApp(page);
  await openSequenceEditorPanel(page, { stepCount: 60 });

  const sequencePanel = page.locator(".panel-SequenceEditor-tanstack-e2e");
  const sequenceGrid = sequencePanel.locator(
    '[data-grid-owner="sequence-editor"]',
  );
  const grid = sequenceGrid.locator('[data-grid-kind="tanstack"]');
  const toolbar = sequencePanel.locator(
    '[data-sequence-editor-toolbar="true"]',
  );
  const cueHeader = grid.locator(
    '[data-grid-header-id="tanstack-header-cue_id"]',
  );

  await expect(toolbar).toBeVisible();
  await expect(cueHeader).toBeVisible();

  const before = await Promise.all([
    toolbar.boundingBox(),
    cueHeader.boundingBox(),
  ]);
  expect(before[0]).not.toBeNull();
  expect(before[1]).not.toBeNull();

  await grid.evaluate((element) => {
    element.scrollTop = 900;
  });
  await expect
    .poll(() => grid.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  const after = await Promise.all([
    toolbar.boundingBox(),
    cueHeader.boundingBox(),
  ]);
  expect(after[0]).not.toBeNull();
  expect(after[1]).not.toBeNull();
  expect(Math.abs(after[0]!.y - before[0]!.y)).toBeLessThan(1);
  expect(Math.abs(after[1]!.y - before[1]!.y)).toBeLessThan(1);
});

/** Verifies the owned sequence supports dropdowns, timing overlays, units, and deletion. */
test("TanStack sequence editor supports dropdown edits, timing overlays, and delete", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 2200, height: 1200 });
  await openOwnedApp(page);
  const context = await openSequenceEditorPanel(page);

  const sequencePanel = page.locator(".panel-SequenceEditor-tanstack-e2e");
  const sequenceGrid = sequencePanel.locator(
    '[data-grid-owner="sequence-editor"]',
  );
  const grid = sequenceGrid.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const triggerCell = grid.locator(
    `[data-grid-column-key="trigger"][data-grid-row-key="${context.editableCueUid}:cue"]`,
  );
  const triggerButton = triggerCell.getByRole("button");
  const triggerAffordance = triggerCell.locator(
    '[data-grid-dropdown-affordance="true"]',
  );
  await expect(triggerCell).toContainText("Manual");
  await expect(triggerAffordance).toHaveCount(1);
  await expect(triggerButton).toHaveCount(0);
  const editableRowIndex = await triggerCell.getAttribute(
    "data-grid-row-index",
  );
  expect(editableRowIndex).not.toBeNull();
  const nextEditableRowIndex = String(Number(editableRowIndex) + 1);

  await triggerCell.click();
  await expect(triggerCell).toHaveAttribute("data-selected", "true");
  await expect(triggerAffordance).toHaveCount(1);
  await expect(triggerButton).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(triggerAffordance).toHaveCount(0);
  await expect(triggerButton).toBeVisible();
  await expect(page.locator("[data-hs-select-dropdown].opened")).toBeVisible();
  await clickOpenedSelectOption(triggerButton, "Follow Previous");
  await expect(triggerButton).toHaveCount(0);

  await triggerCell.click();
  await page.keyboard.press("Space");
  await expect(triggerButton).toBeVisible();
  await expect(page.locator("[data-hs-select-dropdown].opened")).toBeVisible();
  await clickOpenedSelectOption(triggerButton, "Manual");
  await expect(triggerButton).toHaveCount(0);

  await triggerCell.dblclick();
  await expect(triggerButton).toBeVisible();
  await expect(page.locator("[data-hs-select-dropdown].opened")).toBeVisible();
  const triggerCellBox = await triggerCell.boundingBox();
  const triggerButtonBox = await triggerButton.boundingBox();
  expect(triggerCellBox).not.toBeNull();
  expect(triggerButtonBox).not.toBeNull();
  expect(Math.abs(triggerCellBox!.x - triggerButtonBox!.x)).toBeLessThan(1);
  expect(Math.abs(triggerCellBox!.y - triggerButtonBox!.y)).toBeLessThan(1);
  expect(
    Math.abs(triggerCellBox!.width - triggerButtonBox!.width),
  ).toBeLessThan(1.5);
  expect(
    Math.abs(triggerCellBox!.height - triggerButtonBox!.height),
  ).toBeLessThan(1.5);
  await page.evaluate(() => {
    (window as any).__tanstackSelectKeydownReachedControl = false;
    (window as any).__tanstackSelectKeydownReachedDocument = false;
    document.addEventListener(
      "keydown",
      () => {
        (window as any).__tanstackSelectKeydownReachedDocument = true;
      },
      { once: true },
    );
  });
  await triggerButton.evaluate((button) => {
    button.addEventListener(
      "keydown",
      () => {
        (window as any).__tanstackSelectKeydownReachedControl = true;
      },
      { once: true },
    );
  });
  await triggerButton.focus();
  const selectionRangeBeforeDropdownKey = await grid.getAttribute(
    "data-selection-range",
  );
  await triggerButton.dispatchEvent("keydown", {
    bubbles: true,
    cancelable: true,
  });
  await expect(triggerCell).toHaveAttribute("data-selected", "true");
  await expect
    .poll(() => grid.getAttribute("data-selection-range"))
    .toBe(selectionRangeBeforeDropdownKey);
  expect(
    await page.evaluate(
      () => (window as any).__tanstackSelectKeydownReachedControl,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as any).__tanstackSelectKeydownReachedDocument,
    ),
  ).toBe(false);
  await clickOpenedSelectOption(triggerButton, "Follow Previous");
  await expect(triggerButton).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate((cueUid) => {
        const cue = (window as any).appStores.cues.get()[cueUid];
        return cue?.trigger?.type;
      }, context.editableCueUid),
    )
    .toBe("FollowPrevious");

  await grid.locator(`#tanstack-cell-0-${editableRowIndex}`).click();
  await sequencePanel
    .getByRole("button", { name: "Jump preview to selected cue" })
    .click();
  const delayCell = grid.locator(
    `[data-grid-column-key="delay_in"][data-grid-row-index="${editableRowIndex}"]`,
  );
  const delayCanvas = delayCell.locator("canvas").first();
  await expect(delayCanvas).toBeVisible();
  await expect.poll(() => canvasHasPaint(delayCanvas)).toBe(true);

  await expect(delayCell).toContainText("3");
  await grid
    .getByRole("checkbox", {
      name: `Select row ${Number(editableRowIndex) + 1}`,
      exact: true,
    })
    .click();
  await delayCell.click();
  await page.keyboard.press("Delete");
  await expect(delayCell).toContainText("1");
  const fadeInCell = grid.locator(
    `[data-grid-column-key="fade_in"][data-grid-row-index="${editableRowIndex}"]`,
  );
  await fadeInCell.click();
  await delayCell.click({ modifiers: ["Shift"] });
  await delayCell.click({ button: "right" });
  await expect(page.getByText("Units", { exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Time" }).hover();
  await page.getByRole("menuitem", { name: "Milliseconds" }).click();
  await expect(delayCell).toContainText("1000ms");
  await expect(fadeInCell).toContainText("2000ms");
  await expect(
    grid.locator(
      `[data-grid-column-key="delay_in"][data-grid-row-index="${nextEditableRowIndex}"]`,
    ),
  ).toContainText(/ms/);
  await fadeInCell.click();
  await delayCell.click({ modifiers: ["Shift"] });
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await delayCell.dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: viewport!.width - 2,
    clientY: viewport!.height - 2,
  });
  await page.getByRole("menuitem", { name: "Time" }).hover();
  const hertzItem = page.getByRole("menuitem", { name: "Hertz" });
  await expect(hertzItem).toBeVisible();
  const hertzBox = await hertzItem.boundingBox();
  expect(hertzBox).not.toBeNull();
  expect(hertzBox!.x).toBeGreaterThanOrEqual(0);
  expect(hertzBox!.y).toBeGreaterThanOrEqual(0);
  expect(hertzBox!.x + hertzBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(hertzBox!.y + hertzBox!.height).toBeLessThanOrEqual(viewport!.height);
  await hertzItem.click();
  await expect(delayCell).toContainText("1hz");
  await expect(fadeInCell).toContainText("0.5hz");
  await expect(
    grid.locator(
      `[data-grid-column-key="delay_in"][data-grid-row-index="${nextEditableRowIndex}"]`,
    ),
  ).toContainText(/hz/);
  await fadeInCell.click();
  await delayCell.click({ modifiers: ["Shift"] });
  await delayCell.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Time" }).hover();
  await page.getByRole("menuitem", { name: "BPM" }).click();
  await expect(delayCell).toContainText("60bpm");
  await expect(fadeInCell).toContainText("30bpm");
  await expect(
    grid.locator(
      `[data-grid-column-key="delay_in"][data-grid-row-index="${nextEditableRowIndex}"]`,
    ),
  ).toContainText(/bpm/);
  const sequenceEditorScreenshot = testInfo.outputPath(
    "owned-tanstack-sequence-editor.png",
  );
  await grid.screenshot({ path: sequenceEditorScreenshot });
  await testInfo.attach("owned-tanstack-sequence-editor", {
    path: sequenceEditorScreenshot,
    contentType: "image/png",
  });
  await grid
    .getByRole("checkbox", {
      name: `Select row ${Number(nextEditableRowIndex) + 1}`,
      exact: true,
    })
    .click();

  const rowCountBeforeCueDelete = await grid
    .locator('[id^="tanstack-cell-0-"]')
    .count();
  await sequencePanel.getByRole("button", { name: "Delete cue" }).click();
  await expect
    .poll(() => grid.locator('[id^="tanstack-cell-0-"]').count())
    .toBe(Math.max(0, rowCountBeforeCueDelete - 1));
  await expect(
    grid.locator(`#tanstack-cell-1-${rowCountBeforeCueDelete - 1}`),
  ).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
});

/** Uses the cell selection perimeter as the sole focus indicator while editing a timing value. */
test("timing cell editors keep a single selection border", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await openOwnedApp(page);
  const context = await openSequenceEditorPanel(page);
  const grid = page.locator(
    '[data-grid-owner="sequence-editor"] [data-grid-kind="tanstack"]',
  );
  const cell = grid.locator(
    `[data-grid-column-key="delay_in"][data-grid-row-key="${context.editableCueUid}:cue"]`,
  );
  await expect(cell).toBeVisible();
  const original = await cell.textContent();
  await cell.dblclick();
  const editor = cell.locator("input");
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+A");
  await expect(editor).toHaveCSS("box-shadow", "none");
  await expect(editor).toHaveCSS("outline-style", "none");
  await expect(editor).toHaveCSS("border-left-width", "0px");
  await expect(cell).toHaveAttribute("data-selected", "true");
  await expect(cell).toHaveCSS("background-image", /linear-gradient/);
  await cell.screenshot({
    path: testInfo.outputPath("timing-editor-border.png"),
  });
  await page.emulateMedia({ forcedColors: "active" });
  await expect(editor).toHaveCSS("outline-style", "none");
  await expect(cell).toHaveCSS("outline-style", "solid");
  await expect(cell).toHaveCSS("outline-width", "1px");
  await page.emulateMedia({ forcedColors: "none" });
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(cell).toHaveText(original!);
});
