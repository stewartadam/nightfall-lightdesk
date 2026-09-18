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
  gridHeaderByColumnKey,
} from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import {
  prepareStoreSeededTestApp,
  waitForDockviewApp,
} from "./showfile-startup";

const FIXTURE_ID = 95_100;
const FIXTURE_UID = "c7100000000000000000000000000001";
const BASE_CUE_ID = 95_100;
const BASE_CUE_UID = "c7100000000000000000000000000002";

test.setTimeout(120_000);

/** Replaces the backend and proves cue-timing data does not survive a scenario. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedCueTimingStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0, sequences: 0 });
});

/** Reads the browser stores whose isolation matters to cue-timing scenarios. */
async function ownedCueTimingStoreCounts(page: Page): Promise<object> {
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

/** Sends one correlated backend command and rejects a failed outcome. */
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

/** Builds one RGBI parameter shared by both owned fixture elements. */
function ownedParameter(
  attribute: "Intensity" | "Red" | "Green" | "Blue",
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

/** Builds the exact two-element RGBI fixture used by cue timing grids. */
function ownedCueTimingFixture(): object {
  return {
    identifiers: {
      id: FIXTURE_ID,
      uid: FIXTURE_UID,
      label: "Owned Cue Timing Fixture",
    },
    make: "E2E",
    model: "Cue Timing RGBI",
    mode: "Two Element",
    elements: [1, 2].map((index) => ({
      label: `Cell ${index}`,
      parameters: [
        ownedParameter("Intensity"),
        ownedParameter("Red"),
        ownedParameter("Green"),
        ownedParameter("Blue"),
      ],
    })),
  };
}

/** Builds the exact empty base cue that connected scenarios customize. */
function ownedBaseCue(): object {
  return {
    identifiers: {
      id: BASE_CUE_ID,
      uid: BASE_CUE_UID,
      label: "Owned Cue Timing Base",
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

/** Opens a blank backend and stores the connected cue-timing fixture and cue. */
async function openOwnedCueTimingApp(
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
    .poll(() => ownedCueTimingStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0, sequences: 0 });

  await sendCommand(page, {
    module: "FixtureCommand",
    command: { type: "StoreFixture", data: ownedCueTimingFixture() },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: ownedBaseCue() },
  });
  await expect
    .poll(() => ownedCueTimingStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 1, fixtures: 1, sequences: 0 });
}

/** Opens a blank backend, disconnects it, and clears every mutable browser store. */
async function openOwnedStoreSeededCueTimingApp(
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
  await prepareStoreSeededTestApp(page);
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
 * Waits for app shell stores needed by cue timing tests.
 */
async function waitForCueEditorStores(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  await expect
    .poll(() => cueEditorStoresReady(page), { timeout: 45_000 })
    .toBe(true);
}

/** Retries a seed operation after a startup-triggered document replacement. */
async function afterStartupResync<T>(
  page: Page,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const contextWasReplaced =
        error instanceof Error &&
        error.message.includes("Execution context was destroyed");
      if (!contextWasReplaced || attempt === 2) throw error;
      await waitForDockviewApp(page);
    }
  }
  throw new Error("startup resync retry exhausted");
}

/**
 * Counts blue-dominant canvas pixels to verify cue timing preview output.
 */
async function countBlueDominantPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    const context2d = canvasElement.getContext("2d");
    if (!context2d) throw new Error("cue grid cell canvas is not a 2d canvas");

    const rect = canvasElement.getBoundingClientRect();
    if (
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      canvasElement.width <= 0 ||
      canvasElement.height <= 0
    ) {
      return 0;
    }

    const scaleX = canvasElement.width / rect.width;
    const scaleY = canvasElement.height / rect.height;
    const imageWidth = Math.floor(rect.width * scaleX);
    const imageHeight = Math.floor(rect.height * scaleY);
    if (
      !Number.isFinite(imageWidth) ||
      !Number.isFinite(imageHeight) ||
      imageWidth <= 0 ||
      imageHeight <= 0
    ) {
      return 0;
    }

    const image = context2d.getImageData(0, 0, imageWidth, imageHeight);

    let blueDominantPixels = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
      if (blue > red + 20 && blue > green + 12) blueDominantPixels += 1;
    }
    return blueDominantPixels;
  });
}

/**
 * Scrolls the sequence grid horizontally and waits for the virtualized viewport to settle.
 */
async function scrollGridHorizontally(
  grid: Locator,
  scrollLeft: number,
): Promise<void> {
  await grid.evaluate((element, nextScrollLeft) => {
    element.scrollLeft = nextScrollLeft;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, scrollLeft);
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBe(scrollLeft);
}

/**
 * Scrolls a virtualized grid vertically until the requested identifier row is rendered.
 */
async function scrollGridToIdentifier(
  grid: Locator,
  identifierColumnKey: string,
  identifierText: string,
): Promise<void> {
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const found = await grid.evaluate(
      (element, options) => {
        element.scrollTop = Math.round(
          (element.scrollHeight - element.clientHeight) * options.ratio,
        );
        element.dispatchEvent(new Event("scroll", { bubbles: true }));

        return Array.from(
          element.querySelectorAll(
            `[data-grid-column-key="${CSS.escape(
              options.identifierColumnKey,
            )}"]`,
          ),
        ).some((cell) => {
          const text = cell.textContent?.replace(/^[^0-9]*/, "").trim();
          return text === options.identifierText;
        });
      },
      { identifierColumnKey, identifierText, ratio },
    );
    if (found) return;
  }

  throw new Error(
    `No rendered data-grid row found for ${identifierColumnKey}=${identifierText}`,
  );
}

/** Verifies inherited cue timings and fixture overrides edit independently. */
test("cue timings show inherited values and Delete clears overrides", async ({
  backendSlot,
  page,
}) => {
  await openOwnedCueTimingApp(page, backendSlot.backendPort);
  await waitForCueEditorStores(page);

  const context = await page.evaluate(
    async ({ baseCueUid, fixtureId, fixtureUid }) => {
      const stores = (window as any).appStores;

      /** Builds the Rust-style duration object used in seeded cue timing data. */
      const duration = (secs: number) => ({ secs, nanos: 0 });

      /** Builds a fixed transition mode from seconds for seeded cue timing data. */
      const fixed = (secs: number) => ({
        type: "Fixed",
        data: duration(secs),
      });

      const cues = stores.cues.get();
      const existingCue = cues[baseCueUid];
      if (!existingCue) throw new Error("expected the owned base cue");
      const cueUid = "95000100-0000-4000-8000-000000000000";
      const cueId = 950_001;
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          id: cueId,
          uid: cueUid,
          label: "Cue Timing Test",
        },
        trigger: { type: "Manual" },
        transitions: {
          fade_in: fixed(4),
          delay_in: fixed(5),
        },
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
                Red: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 128 } },
                },
              },
              transitions: {
                fade_in: fixed(3),
                delay_in: fixed(1),
              },
              transitions_by_attribute: {
                Red: {
                  fade_in: fixed(9),
                  fade_out: fixed(6),
                },
              },
            },
          },
        ],
        tracking_flags: "HTP",
      };
      stores.cues.set({
        ...cues,
        [cueUid]: cue,
      });
      await stores.send({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      });
      stores.cues.set({
        ...stores.cues.get(),
        [cueUid]: cue,
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-timing-e2e";
      api.getPanel(panelId)?.api.close();
      api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Timing E2E",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
      });
      const panel = api.getPanel(panelId);
      panel?.api.setActive();
      panel?.focus();

      return { cueId, cueUid, fixtureId, panelId };
    },
    {
      baseCueUid: BASE_CUE_UID,
      fixtureId: FIXTURE_ID,
      fixtureUid: FIXTURE_UID,
    },
  );

  try {
    const cuePanel = page.locator(
      `[data-panel-id="${context.panelId}"]:visible`,
    );
    await cuePanel
      .getByRole("button", { name: "Switch to timings display mode" })
      .click();
    const grid = cuePanel
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();
    await scrollGridToIdentifier(grid, "id", String(context.fixtureId));

    const delayCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeTimingColumnKey("Red", "delay_in"),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    const fadeInCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeTimingColumnKey("Red", "fade_in"),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    const delayOutCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeTimingColumnKey("Red", "delay_out"),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    const fadeOutCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeTimingColumnKey("Red", "fade_out"),
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(delayCell).toContainText("1s");
    await expect(delayCell).toHaveCSS("color", "rgb(143, 143, 143)");
    await expect(fadeInCell).toContainText("9s");
    await expect(fadeInCell).not.toHaveCSS("color", "rgb(143, 143, 143)");

    await fadeInCell.click();
    await page.keyboard.press("Delete");

    await expect
      .poll(async () =>
        page.evaluate((cueUid) => {
          const cue = (window as any).appStores.cues.get()[cueUid];
          const transition =
            cue?.instructions?.[0]?.cue_instruction?.transitions_by_attribute
              ?.Red;
          return {
            fadeInCleared: transition?.fade_in === undefined,
            fadeOutSecs: transition?.fade_out?.data?.secs,
          };
        }, context.cueUid),
      )
      .toEqual({ fadeInCleared: true, fadeOutSecs: 6 });
    await expect(fadeInCell).toContainText("3s");
    await expect(fadeInCell).toHaveCSS("color", "rgb(143, 143, 143)");

    await fadeOutCell.dblclick({ force: true });
    const editor = fadeOutCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.fill("8s");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () =>
        page.evaluate((cueUid) => {
          const cue = (window as any).appStores.cues.get()[cueUid];
          return cue.instructions?.[0]?.cue_instruction
            ?.transitions_by_fixture_attribute?.[0]?.transitions_by_attribute
            ?.Red?.fade_out?.data?.secs;
        }, context.cueUid),
      )
      .toBe(8);

    await page.evaluate(() => {
      const originalPostMessage = Worker.prototype.postMessage;
      (window as any).__cueTimingStoreCueSendCount = 0;
      Worker.prototype.postMessage = function (
        message: unknown,
        transferOrOptions?: StructuredSerializeOptions | Transferable[],
      ) {
        const data = (message as { data?: unknown })?.data as
          | { module?: unknown; command?: { type?: unknown } }
          | undefined;
        if (
          data?.module === "CueCommand" &&
          data.command?.type === "StoreCue"
        ) {
          (window as any).__cueTimingStoreCueSendCount += 1;
        }
        return originalPostMessage.call(
          this,
          message,
          transferOrOptions as never,
        );
      };
    });
    await fadeInCell.click();
    await fadeOutCell.click({ modifiers: ["Shift"] });
    await page.keyboard.press("2");
    const multiColumnEditor = fadeOutCell.locator("input");
    await expect(multiColumnEditor).toBeVisible();
    await page.keyboard.press("Enter");

    await expect
      .poll(async () =>
        page.evaluate((cueUid) => {
          const cue = (window as any).appStores.cues.get()[cueUid];
          const transition =
            cue.instructions?.[0]?.cue_instruction
              ?.transitions_by_fixture_attribute?.[0]?.transitions_by_attribute
              ?.Red;
          return {
            delayOutSecs: transition?.delay_out?.data?.secs,
            fadeInSecs: transition?.fade_in?.data?.secs,
            fadeOutSecs: transition?.fade_out?.data?.secs,
          };
        }, context.cueUid),
      )
      .toEqual({ delayOutSecs: 2, fadeInSecs: 2, fadeOutSecs: 2 });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__cueTimingStoreCueSendCount),
      )
      .toBe(1);
    await expect(fadeInCell).toContainText("2s");
    await expect(delayOutCell).toContainText("2s");
    await expect(fadeOutCell).toContainText("2s");
  } finally {
    await page.evaluate(({ cueUid }) => {
      const stores = (window as any).appStores;
      const cues = { ...stores.cues.get() };
      delete cues[cueUid];
      stores.cues.set(cues);
    }, context);
  }
});

/** Verifies cue preview progress paints behind an owned fixture timing cell. */
test("cue timings grid paints preview progress behind timing cells", async ({
  backendSlot,
  page,
}) => {
  await openOwnedCueTimingApp(page, backendSlot.backendPort);
  await waitForCueEditorStores(page);

  const context = await page.evaluate(
    ({ fixtureId, fixtureUid }) => {
      const stores = (window as any).appStores;

      /** Builds the Rust-style duration object used in seeded cue timing data. */
      const duration = (secs: number) => ({ secs, nanos: 0 });

      /** Builds a fixed transition mode from seconds for seeded cue timing data. */
      const fixed = (secs: number) => ({
        type: "Fixed",
        data: duration(secs),
      });

      const cues = stores.cues.get();
      const cueUid = "55555555-5555-5555-5555-555555555500";
      stores.cues.set({
        ...cues,
        [cueUid]: {
          identifiers: {
            id: 55,
            uid: cueUid,
            label: "Cue Timing Progress Test",
          },
          trigger: { type: "Manual" },
          transitions: {
            fade_in: fixed(2),
            delay_in: fixed(2),
            fade_out: fixed(2),
            delay_out: fixed(2),
          },
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
                    data: { type: "Absolute", data: { value: 128 } },
                  },
                },
                transitions: {},
                transitions_by_attribute: {},
              },
            },
          ],
          parts: [],
          tracking_flags: "HTP",
        },
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-timing-progress-e2e";
      api.getPanel(panelId)?.api.close();
      api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Timing Progress E2E",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
      });
      const panel = api.getPanel(panelId);
      panel?.api.setActive();
      panel?.focus();

      return { cueUid, fixtureId, panelId };
    },
    { fixtureId: FIXTURE_ID, fixtureUid: FIXTURE_UID },
  );

  const cuePanel = page.locator(`[data-panel-id="${context.panelId}"]:visible`);
  await cuePanel
    .getByRole("button", { name: "Switch to timings display mode" })
    .click();
  const grid = cuePanel
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  const delayCell = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeTimingColumnKey("Intensity", "delay_in"),
    identifierColumnKey: "id",
    identifierText: String(context.fixtureId),
  });
  const delayCanvas = delayCell.locator("canvas").first();
  await expect(delayCanvas).toBeVisible();
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.activeInstances.set({});
    stores.layerStack.set([]);
  });

  await expect.poll(async () => countBlueDominantPixels(delayCanvas)).toBe(0);
  await page.evaluate(async (cueUid) => {
    const stores = (window as any).appStores;
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
    const objectRef = {
      type: "ByUid",
      data: { object_type: "Cue", uid: cueUid },
    };
    stores.layerStack.set([
      {
        creator: "Owned Cue Timing Preview",
        object_ref: objectRef,
        priority: 1,
        is_releasing: false,
        asserted_absolute_values: [],
        asserted_relative_values: [],
        lookahead_asserted_values: [],
        computed_values: [],
        computed_transitioning: [],
      },
    ]);
    stores.activeInstances.set({
      c7100000000000000000000000000003: {
        instance_id: "c7100000000000000000000000000003",
        kind: "Cue",
        display_kind: "Cue",
        tags: [],
        object_ref: objectRef,
        is_preview: true,
        is_releasing: false,
        is_paused: false,
        activation_epoch_ms: Date.now() - 1_000,
        owner_uids: [],
        intensity_scale: 1,
        rate: 1,
        rate_master_scale: 1,
        effective_rate: 1,
        status: {
          position: { type: "None" },
          source_activation_epoch_ms: Date.now() - 1_000,
        },
      },
    });
  }, context.cueUid);

  await expect
    .poll(async () => countBlueDominantPixels(delayCanvas), { timeout: 3000 })
    .toBeGreaterThan(8);
});

/** Verifies synthetic sequence playback paints timing progress by phase. */
test("sequence timings grid paints active playback progress behind timing cells", async ({
  backendSlot,
  page,
}) => {
  await openOwnedStoreSeededCueTimingApp(page, backendSlot.backendPort);

  const panelId = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const cueUid = "11111111111111111111111111111111";
    const nextCueUid = "66666666666666666666666666666666";
    const releaseCueUid = "44444444444444444444444444444444";
    const sequenceUid = "22222222222222222222222222222222";
    const fixtureUid = "77777777777777777777777777777777";

    /** Builds a fixed transition mode from seconds for seeded sequence timing data. */
    const fixed = (secs: number) => ({
      type: "Fixed",
      data: { secs, nanos: 0 },
    });

    /** Builds the coarse intensity parameter used by the seeded cue instruction. */
    const intensityParameter = {
      resolution: "Coarse",
      attribute: { type: "Intensity" },
      value_polarity: "Unsigned",
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: "HTP",
      use_grandmaster: true,
    };

    stores.attributeMetadata.set([
      {
        key: "Intensity",
        attribute: { type: "Intensity" },
        label: "Intensity",
        category: "Dimmer",
        sort_order: 0,
      },
    ]);
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: {
          id: 901,
          uid: fixtureUid,
          label: "Timing Progress Fixture",
        },
        make: "E2E",
        model: "Timing Progress Dimmer",
        mode: "Default",
        elements: [
          {
            label: "Dimmer",
            parameters: [intensityParameter],
          },
        ],
      },
    });

    const cue = {
      identifiers: {
        id: 101,
        uid: cueUid,
        label: "Sequence Timing Progress Cue",
      },
      trigger: { type: "Manual" },
      transitions: {
        delay_out: fixed(4),
        fade_out: fixed(4),
      },
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
                data: { type: "Absolute", data: { value: 128 } },
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
    const nextCue = {
      ...cue,
      identifiers: {
        id: 102,
        uid: nextCueUid,
        label: "Sequence Timing Progress After",
      },
      trigger: { type: "AfterDelay", data: { secs: 60, nanos: 0 } },
      transitions: {},
      instructions: [],
    };
    const emptyCue = (uid: string, label: string) => ({
      identifiers: { id: 0, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    const releaseCue = {
      ...emptyCue(releaseCueUid, "Release"),
      transitions: {
        delay_in: fixed(10),
        fade_in: fixed(40),
        delay_out: fixed(0),
        fade_out: fixed(40),
      },
    };

    stores.cues.set({
      ...stores.cues.get(),
      [cueUid]: cue,
      [nextCueUid]: nextCue,
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        identifiers: {
          id: 901,
          uid: sequenceUid,
          label: "Sequence Timing Progress",
        },
        steps: [cueUid, nextCueUid],
        wrap: false,
        release_on_start: false,
        setup_cue: emptyCue("33333333333333333333333333333333", "Setup"),
        release_cue: releaseCue,
        default_timing: {
          delay_in: fixed(4),
          fade_in: fixed(60),
          curve_in: "Linear",
          delay_out: fixed(4),
          fade_out: fixed(2),
          curve_out: "Linear",
        },
      },
    });
    const sequenceObjectRef = {
      type: "ByUid",
      data: { object_type: "Sequence", uid: sequenceUid },
    };
    stores.layerStack.set([
      {
        creator: "Sequence Timing Progress",
        object_ref: sequenceObjectRef,
        priority: 1,
        is_releasing: false,
        asserted_absolute_values: [],
        asserted_relative_values: [],
        computed_values: [],
        computed_transitioning: [],
      },
    ]);
    stores.activeInstances.set({
      "55555555555555555555555555555555": {
        instance_id: "55555555555555555555555555555555",
        kind: "Sequence",
        display_kind: "Sequence",
        tags: [],
        object_ref: sequenceObjectRef,
        is_preview: false,
        is_releasing: false,
        intensity_scale: 1,
        rate: 1,
        status: {
          position: {
            type: "Sequence",
            data: {
              sequence_uid: sequenceUid,
              current_position: 1,
              cue_count: 2,
              current_cue_uid: cueUid,
              current_label: "Sequence Timing Progress Cue",
              current_part_count: 0,
              next_position: 2,
              next_cue_uid: nextCueUid,
              next_label: "Sequence Timing Progress After",
              next_part_count: 0,
              retained_cues: [
                {
                  position: 1,
                  cue_uid: cueUid,
                  transition_elapsed: { secs: 5, nanos: 0 },
                },
              ],
            },
          },
          source_activation_epoch_ms: Date.now() - 30_000,
        },
      },
    });

    const api = stores.dockApi.get();
    const panelId = "panel-SequenceEditor-timing-progress-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Timing Progress E2E",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequenceUid,
      },
    });
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
    return panelId;
  });

  const sequencePanel = page.locator(`[data-panel-id="${panelId}"]:visible`);
  const grid = sequencePanel
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  const delayCanvas = gridCellByKey(grid, {
    columnKey: "fade_in",
    rowKey: "11111111111111111111111111111111:cue",
  })
    .locator("canvas")
    .first();
  await expect(delayCanvas).toBeVisible();

  await expect
    .poll(async () => countBlueDominantPixels(delayCanvas), { timeout: 3000 })
    .toBeGreaterThan(8);

  const afterDelayCanvas = gridCellByKey(grid, {
    columnKey: "after_delay",
    rowKey: "66666666666666666666666666666666:cue",
  })
    .locator("canvas")
    .first();
  const activeCueDelayOutCanvas = gridCellByKey(grid, {
    columnKey: "delay_out",
    rowKey: "11111111111111111111111111111111:cue",
  })
    .locator("canvas")
    .first();
  const activeCueFadeOutCanvas = gridCellByKey(grid, {
    columnKey: "fade_out",
    rowKey: "11111111111111111111111111111111:cue",
  })
    .locator("canvas")
    .first();
  await afterDelayCanvas.evaluate((element) => {
    element
      .closest('[data-grid-column-key="after_delay"]')
      ?.scrollIntoView({ block: "nearest", inline: "center" });
    element
      .closest('[data-grid-kind="tanstack"]')
      ?.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(afterDelayCanvas).toBeVisible();

  await scrollGridHorizontally(grid, 600);
  await expect(activeCueFadeOutCanvas).toBeVisible();
  await expect
    .poll(async () => countBlueDominantPixels(activeCueFadeOutCanvas), {
      timeout: 3000,
    })
    .toBeGreaterThan(8);

  await expect(activeCueDelayOutCanvas).toBeVisible();
  await expect
    .poll(async () => countBlueDominantPixels(activeCueDelayOutCanvas), {
      timeout: 3000,
    })
    .toBeGreaterThan(8);

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const instanceId = "55555555555555555555555555555555";
    const cueUid = "11111111111111111111111111111111";
    const nextCueUid = "66666666666666666666666666666666";
    const instances = stores.activeInstances.get();
    stores.activeInstances.set({
      ...instances,
      [instanceId]: {
        ...instances[instanceId],
        status: {
          ...instances[instanceId].status,
          position: {
            type: "Sequence",
            data: {
              ...instances[instanceId].status.position.data,
              current_position: 2,
              current_cue_uid: nextCueUid,
              current_label: "Sequence Timing Progress After",
              next_position: null,
              next_cue_uid: null,
              next_label: null,
              retained_cues: [
                {
                  position: 1,
                  cue_uid: cueUid,
                  transition_elapsed: { secs: 5, nanos: 0 },
                },
                {
                  position: 2,
                  cue_uid: nextCueUid,
                  transition_elapsed: { secs: 1, nanos: 0 },
                },
              ],
            },
          },
        },
      },
    });
  });
  await expect
    .poll(async () => countBlueDominantPixels(activeCueFadeOutCanvas), {
      timeout: 3000,
    })
    .toBeGreaterThan(8);
  await expect
    .poll(async () => countBlueDominantPixels(activeCueDelayOutCanvas), {
      timeout: 3000,
    })
    .toBe(0);

  await scrollGridHorizontally(grid, 0);

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const instanceId = "55555555555555555555555555555555";
    const instances = stores.activeInstances.get();
    stores.activeInstances.set({
      ...instances,
      [instanceId]: {
        ...instances[instanceId],
        is_releasing: true,
        release_epoch_ms: Date.now() - 15_000,
      },
    });
    stores.layerStack.set(
      stores.layerStack.get().map((layer: any) => ({
        ...layer,
        is_releasing: true,
      })),
    );
  });

  const releaseCueFadeInCanvas = gridCellByKey(grid, {
    columnKey: "fade_in",
    rowKey: "44444444444444444444444444444444:cue",
  })
    .locator("canvas")
    .first();
  await expect(releaseCueFadeInCanvas).toBeVisible();

  await scrollGridHorizontally(grid, 600);
  const releaseCueFadeOutCanvas = gridCellByKey(grid, {
    columnKey: "fade_out",
    rowKey: "44444444444444444444444444444444:cue",
  })
    .locator("canvas")
    .first();
  await expect(releaseCueFadeOutCanvas).toBeVisible();
  expect(await countBlueDominantPixels(activeCueFadeOutCanvas)).toBe(0);
});

/** Verifies wrapped sequence durations include transitions and next-cue start timing. */
test("sequence timings grid shows cue durations and wrapped sequence total", async ({
  backendSlot,
  page,
}) => {
  await openOwnedStoreSeededCueTimingApp(page, backendSlot.backendPort);

  const panelId = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const sequenceUid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const cueOneUid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const cueTwoUid = "cccccccccccccccccccccccccccccccc";
    const cueThreeUid = "dddddddddddddddddddddddddddddddd";
    const fixtureUid = "99999999999999999999999999999999";
    const fixtureRef = { fixture_uid: fixtureUid, index: 1 };

    /** Builds a Duration-like value from whole seconds for seeded cue triggers. */
    const seconds = (secs: number) => ({ secs, nanos: 0 });

    /** Builds a minimal cue row for sequence-duration display tests. */
    const cue = (
      id: number,
      uid: string,
      label: string,
      delaySeconds: number,
      transitionSeconds: number,
    ) => ({
      identifiers: { id, uid, label },
      trigger: {
        type: "AfterDelay",
        data: seconds(delaySeconds),
      },
      transitions: {
        delay_out: { type: "Fixed", data: seconds(0) },
        fade_out: { type: "Fixed", data: seconds(transitionSeconds) },
      },
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    /** Adds a per-fixture attribute timing override that should drive displayed cue duration. */
    const cueWithFixtureAttributeDuration = (
      sourceCue: ReturnType<typeof cue>,
      attr: string,
      fadeOutSeconds: number,
    ) => ({
      ...sourceCue,
      instructions: [
        {
          selection: {
            source: {
              type: "Resolved",
              data: [fixtureRef],
            },
            clauses: [],
          },
          cue_instruction: {
            values: {
              [attr]: {
                type: "Inline",
                data: { type: "Absolute", data: { value: 1 } },
              },
            },
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [
              {
                fixture: fixtureRef,
                transitions_by_attribute: {
                  [attr]: {
                    fade_out: { type: "Fixed", data: seconds(fadeOutSeconds) },
                  },
                },
              },
            ],
          },
        },
      ],
    });

    /** Builds a backend cue duration profile message for seeded sequence summary rows. */
    const cueDurationProfile = (
      cueUid: string,
      cueId: number,
      transitionSeconds: number,
    ) => ({
      cue_uid: cueUid,
      cue_id: cueId,
      profile: {
        max_delay_in: seconds(0),
        max_fade_in: seconds(0),
        max_delay_out: seconds(0),
        max_fade_out: seconds(transitionSeconds),
        assertion_duration: seconds(0),
        release_duration: seconds(transitionSeconds),
        max_transition_duration: seconds(transitionSeconds),
      },
    });

    /** Builds a minimal embedded sequence meta cue. */
    const metaCue = (uid: string, label: string) => ({
      identifiers: { id: 0, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    stores.cues.set({
      ...stores.cues.get(),
      [cueOneUid]: cueWithFixtureAttributeDuration(
        cue(1, cueOneUid, "Wrapped One", 2, 1),
        "Intensity",
        10,
      ),
      [cueTwoUid]: cue(2, cueTwoUid, "Wrapped Two", 5, 2),
      [cueThreeUid]: cue(3, cueThreeUid, "Wrapped Three", 7, 4),
    });
    stores.cueDurationProfiles.set({
      ...stores.cueDurationProfiles.get(),
      [cueOneUid]: cueDurationProfile(cueOneUid, 1, 10),
      [cueTwoUid]: cueDurationProfile(cueTwoUid, 2, 2),
      [cueThreeUid]: cueDurationProfile(cueThreeUid, 3, 4),
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        identifiers: {
          id: 902,
          uid: sequenceUid,
          label: "Wrapped Duration Summary",
        },
        steps: [cueOneUid, cueTwoUid, cueThreeUid],
        wrap: true,
        release_on_start: false,
        setup_cue: metaCue("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "Setup"),
        release_cue: metaCue("ffffffffffffffffffffffffffffffff", "Release"),
        default_timing: {
          delay_in: { type: "Fixed", data: seconds(0) },
          fade_in: { type: "Fixed", data: seconds(0) },
          curve_in: "Linear",
          delay_out: { type: "Fixed", data: seconds(0) },
          fade_out: { type: "Fixed", data: seconds(0) },
          curve_out: "Linear",
        },
      },
    });

    const api = stores.dockApi.get();
    const panelId = "panel-SequenceEditor-duration-summary-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Duration Summary E2E",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequenceUid,
      },
    });
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
    return panelId;
  });

  const sequencePanel = page.locator(`[data-panel-id="${panelId}"]:visible`);
  const grid = sequencePanel
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-duration"]'),
  ).toContainText("Duration");

  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);

  await expect(
    grid.locator('[data-grid-header-id="tanstack-header-start_time"]'),
  ).toContainText("Start");
  await expect(
    gridCellByKey(grid, {
      columnKey: "start_time",
      rowKey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cue",
    }),
  ).toContainText("0s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "start_time",
      rowKey: "cccccccccccccccccccccccccccccccc:cue",
    }),
  ).toContainText("5s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "start_time",
      rowKey: "dddddddddddddddddddddddddddddddd:cue",
    }),
  ).toContainText("12s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "duration",
      rowKey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cue",
    }),
  ).toContainText("10s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "duration",
      rowKey: "cccccccccccccccccccccccccccccccc:cue",
    }),
  ).toContainText("7s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "duration",
      rowKey: "dddddddddddddddddddddddddddddddd:cue",
    }),
  ).toContainText("4s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "label",
      rowKey: "sequence-duration-summary",
    }),
  ).toContainText("Sequence Duration");
  await expect(
    gridCellByKey(grid, {
      columnKey: "duration",
      rowKey: "sequence-duration-summary",
    }),
  ).toContainText("16s");

  await gridCellByKey(grid, {
    columnKey: "label",
    rowKey: "sequence-duration-summary",
  }).click();
  await expect(
    sequencePanel.getByRole("button", { name: "Duplicate cue" }),
  ).toBeDisabled();
  await expect(
    sequencePanel.getByRole("button", { name: "Open cue part editor" }),
  ).toBeDisabled();
});

/** Verifies manual cue boundaries leave dependent duration values unknown. */
test("sequence timings grid leaves manual-boundary durations unknown", async ({
  backendSlot,
  page,
}) => {
  await openOwnedStoreSeededCueTimingApp(page, backendSlot.backendPort);

  const panelId = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const sequenceUid = "12121212121212121212121212121212";
    const cueOneUid = "13131313131313131313131313131313";
    const cueTwoUid = "14141414141414141414141414141414";
    const cueThreeUid = "15151515151515151515151515151515";

    /** Builds a Duration-like value from whole seconds for seeded cue triggers. */
    const seconds = (secs: number) => ({ secs, nanos: 0 });

    /** Builds a fixed transition mode from seconds for seeded cue timing data. */
    const fixed = (secs: number) => ({ type: "Fixed", data: seconds(secs) });

    /** Builds a minimal cue row for manual-boundary duration display tests. */
    const cue = (
      id: number,
      uid: string,
      label: string,
      trigger: any,
      fadeOutSeconds: number,
    ) => ({
      identifiers: { id, uid, label },
      trigger,
      transitions: {
        delay_out: fixed(0),
        fade_out: fixed(fadeOutSeconds),
      },
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    /** Builds a minimal embedded sequence meta cue. */
    const metaCue = (uid: string, label: string) => ({
      identifiers: { id: 0, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    stores.cues.set({
      ...stores.cues.get(),
      [cueOneUid]: cue(
        1,
        cueOneUid,
        "Known Before Manual",
        {
          type: "AfterDelay",
          data: seconds(0),
        },
        10,
      ),
      [cueTwoUid]: cue(2, cueTwoUid, "Manual Boundary", { type: "Manual" }, 2),
      [cueThreeUid]: cue(
        3,
        cueThreeUid,
        "After Manual",
        {
          type: "AfterDelay",
          data: seconds(5),
        },
        4,
      ),
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        identifiers: {
          id: 903,
          uid: sequenceUid,
          label: "Manual Boundary Duration Summary",
        },
        steps: [cueOneUid, cueTwoUid, cueThreeUid],
        wrap: false,
        release_on_start: false,
        setup_cue: metaCue("16161616161616161616161616161616", "Setup"),
        release_cue: metaCue("17171717171717171717171717171717", "Release"),
        default_timing: {
          delay_in: fixed(0),
          fade_in: fixed(0),
          curve_in: "Linear",
          delay_out: fixed(0),
          fade_out: fixed(0),
          curve_out: "Linear",
        },
      },
    });

    const api = stores.dockApi.get();
    const panelId = "panel-SequenceEditor-manual-boundary-duration-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Manual Boundary Duration E2E",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequenceUid,
      },
    });
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
    return panelId;
  });

  const grid = page
    .locator(`[data-panel-id="${panelId}"]:visible`)
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);

  await expect(
    gridCellByKey(grid, {
      columnKey: "start_time",
      rowKey: "13131313131313131313131313131313:cue",
    }),
  ).toContainText("0s");
  await expect(
    gridCellByKey(grid, {
      columnKey: "duration",
      rowKey: "13131313131313131313131313131313:cue",
    }),
  ).toHaveText("");
  await expect(
    gridCellByKey(grid, {
      columnKey: "start_time",
      rowKey: "14141414141414141414141414141414:cue",
    }),
  ).toHaveText("");
  await expect(
    gridCellByKey(grid, {
      columnKey: "duration",
      rowKey: "sequence-duration-summary",
    }),
  ).toHaveText("");
});

/** Verifies one owned multi-element fixture expands into exact element rows. */
test("cue timings grid expands fixture rows to element timing rows", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedCueTimingApp(page, backendSlot.backendPort);
  await waitForCueEditorStores(page);

  const context = await afterStartupResync(page, () =>
    page.evaluate(
      ({ baseCueUid, fixtureUid }) => {
        const stores = (window as any).appStores;
        const firstElementIndex = 1;
        const secondElementIndex = 2;
        const attr = "Intensity";

        /** Builds the Rust-style duration object used in seeded cue timing data. */
        const duration = (secs: number) => ({ secs, nanos: 0 });

        /** Builds a fixed transition mode from seconds for seeded cue timing data. */
        const fixed = (secs: number) => ({
          type: "Fixed",
          data: duration(secs),
        });

        const cues = stores.cues.get();
        const existingCue = cues[baseCueUid];
        if (!existingCue) throw new Error("expected the owned base cue");
        const cueUid = existingCue.identifiers.uid;
        const cue = {
          ...existingCue,
          identifiers: {
            ...existingCue.identifiers,
            uid: cueUid,
            label: "Cue Element Timing Test",
          },
          trigger: { type: "Manual" },
          transitions: {
            delay_in: fixed(0),
            fade_in: fixed(1),
          },
          transitions_by_attribute: {},
          instructions: [
            {
              selection: {
                source: {
                  type: "Resolved",
                  data: [{ fixture_uid: fixtureUid, index: firstElementIndex }],
                },
                clauses: [],
              },
              cue_instruction: {
                values: {
                  [attr]: {
                    type: "Inline",
                    data: { type: "Absolute", data: { value: 128 } },
                  },
                },
                transitions: {},
                transitions_by_attribute: {
                  [attr]: {
                    delay_in: fixed(1),
                  },
                },
                transitions_by_fixture_attribute: [
                  {
                    fixture: {
                      fixture_uid: fixtureUid,
                      index: firstElementIndex,
                    },
                    transitions_by_attribute: {
                      [attr]: {
                        delay_in: fixed(1),
                      },
                    },
                  },
                ],
              },
            },
            {
              selection: {
                source: {
                  type: "Resolved",
                  data: [
                    { fixture_uid: fixtureUid, index: secondElementIndex },
                  ],
                },
                clauses: [],
              },
              cue_instruction: {
                values: {
                  [attr]: {
                    type: "Inline",
                    data: { type: "Absolute", data: { value: 128 } },
                  },
                },
                transitions: {},
                transitions_by_attribute: {
                  [attr]: {
                    delay_in: fixed(3),
                  },
                },
                transitions_by_fixture_attribute: [
                  {
                    fixture: {
                      fixture_uid: fixtureUid,
                      index: secondElementIndex,
                    },
                    transitions_by_attribute: {
                      [attr]: {
                        delay_in: fixed(3),
                      },
                    },
                  },
                ],
              },
            },
          ],
          parts: [],
          tracking_flags: "HTP",
        };
        void stores.send({
          module: "CueCommand",
          command: { type: "StoreCue", data: cue },
        });

        const api = stores.dockApi.get();
        const panelId = "panel-CueEditor-element-timing-e2e";
        api.getPanel(panelId)?.api.close();
        api.addPanel({
          id: panelId,
          component: "CueEditor",
          title: "Cue Element Timing E2E",
          position: {
            referencePanel: "panel-FixtureGrid",
            direction: "within",
          },
          params: {
            initialPanelId: panelId,
            initialCueUid: cueUid,
          },
        });
        const panel = api.getPanel(panelId);
        panel?.api.setActive();
        panel?.focus();

        return {
          firstElementIndex,
          secondElementIndex,
          panelId,
        };
      },
      { baseCueUid: BASE_CUE_UID, fixtureUid: FIXTURE_UID },
    ),
  );

  const cuePanel = page.locator(`[data-panel-id="${context.panelId}"]:visible`);
  await cuePanel
    .getByRole("button", { name: "Switch to timings display mode" })
    .click();
  const grid = cuePanel
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const fixtureIdCell = grid
    .locator('[data-grid-column-key="id"]')
    .filter({ hasText: /▶\s*\d+/ })
    .first();
  await expect(fixtureIdCell).toBeVisible();
  const parentFixtureId = await fixtureIdCell.evaluate((cell) => {
    const match = cell.textContent?.match(/\d+/);
    if (!match) throw new Error("expected fixture id in parent row");
    return match[0];
  });
  const parentRowKey = await fixtureIdCell.getAttribute("data-grid-row-key");
  if (!parentRowKey) throw new Error("expected row key on parent row");
  await fixtureIdCell.click();
  await expect(
    gridCellByKey(grid, { columnKey: "id", rowKey: parentRowKey }),
  ).toContainText("▼");

  const firstElementId = `${parentFixtureId}.${context.firstElementIndex}`;
  const secondElementId = `${parentFixtureId}.${context.secondElementIndex}`;
  const firstElementIdCell = await gridCellByIdentifier(grid, {
    columnKey: "id",
    identifierColumnKey: "id",
    identifierText: firstElementId,
  });
  await expect(firstElementIdCell).toContainText(firstElementId);
  await expect(
    await gridCellByIdentifier(grid, {
      columnKey: "id",
      identifierColumnKey: "id",
      identifierText: secondElementId,
    }),
  ).toContainText(secondElementId);
  await page.screenshot({
    path: testInfo.outputPath("owned-cue-timing-element-rows.png"),
  });
});

/** Verifies Shift+Enter applies a typed timing fan within collapsed grouped fixture rows. */
test("cue timings fan grouped parent rows within fixtures with Shift+Enter", async ({
  backendSlot,
  page,
}) => {
  await openOwnedCueTimingApp(page, backendSlot.backendPort);
  await waitForCueEditorStores(page);

  const context = await page.evaluate(
    ({ baseCueUid, fixtureUid }) => {
      const stores = (window as any).appStores;
      const firstElementIndex = 1;
      const secondElementIndex = 2;
      const attr = "Intensity";
      const cues = stores.cues.get();
      const existingCue = cues[baseCueUid];
      if (!existingCue) throw new Error("expected the owned base cue");
      const cueUid = existingCue.identifiers.uid;
      const cue = {
        ...existingCue,
        identifiers: {
          ...existingCue.identifiers,
          uid: cueUid,
          label: "Cue Grouped Timing Fan Test",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [
                  { fixture_uid: fixtureUid, index: firstElementIndex },
                  { fixture_uid: fixtureUid, index: secondElementIndex },
                ],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                [attr]: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 128 } },
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
      stores.cues.set({
        ...cues,
        [cueUid]: cue,
      });

      const api = stores.dockApi.get();
      const panelId = "panel-CueEditor-grouped-fan-e2e";
      api.getPanel(panelId)?.api.close();
      api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Cue Grouped Fan E2E",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
        },
      });
      const panel = api.getPanel(panelId);
      panel?.api.setActive();
      panel?.focus();

      return {
        attr,
        cueUid,
        fixtureUid,
        firstElementIndex,
        secondElementIndex,
        panelId,
      };
    },
    { baseCueUid: BASE_CUE_UID, fixtureUid: FIXTURE_UID },
  );

  const cuePanel = page.locator(`[data-panel-id="${context.panelId}"]:visible`);
  await cuePanel
    .getByRole("button", { name: "Switch to timings display mode" })
    .click();
  const grid = cuePanel
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const parentIdCell = grid
    .locator('[data-grid-column-key="id"]')
    .filter({ hasText: /▶\s*\d+/ })
    .first();
  await expect(parentIdCell).toBeVisible();
  const parentFixtureId = await parentIdCell.evaluate((cell) => {
    const match = cell.textContent?.match(/\d+/);
    if (!match) throw new Error("expected fixture id in parent row");
    return match[0];
  });

  const parentFadeInColumnKey = cueGridAttributeTimingColumnKey(
    context.attr,
    "fade_in",
  );
  const parentFadeInCell = grid.locator(
    `[data-grid-column-key="${parentFadeInColumnKey}"][data-grid-row-index="0"]`,
  );
  /** Enters a within-fixture fan on the collapsed grouped parent timing cell. */
  const applyParentFadeInFan = async () => {
    await parentFadeInCell.dblclick({ force: true });
    const editor = grid.locator("input").last();
    await editor.fill("0>5s");
    await expect(
      page.locator('[data-grid-inline-tooltip="true"]').filter({
        hasText:
          "Applying across fixtures, press Shift+Enter to apply within fixtures",
      }),
    ).toBeVisible();
    await editor.press("Shift+Enter");
  };

  await applyParentFadeInFan();
  await expect(parentFadeInCell).toContainText("V");
  /** Reads the stored child fade-in timings for the seeded grouped fixture cue. */
  const childFadeInSeconds = () =>
    page.evaluate(
      ({ attr, cueUid, fixtureUid, firstElementIndex, secondElementIndex }) => {
        /** Returns a stable comparable UUID string for cue and fixture lookup. */
        const normalizeUid = (uid: unknown) =>
          typeof uid === "string" ? uid.replaceAll("-", "").toLowerCase() : "";
        /** Returns the UI/storage-normalized cue attribute name. */
        const normalizeAttributeName = (attribute: string) =>
          attribute === "VirtualIntensity" ? "Intensity" : attribute;
        const cue = (window as any).appStores.cues.get()[cueUid];
        const instructions = [
          ...(cue?.instructions ?? []),
          ...(cue?.parts ?? []).flatMap((part: any) => part.instructions ?? []),
        ];
        const transitions = instructions.flatMap(
          (instruction: any) =>
            instruction?.cue_instruction?.transitions_by_fixture_attribute ??
            [],
        );

        /** Returns the stored fade-in duration seconds for one fixture element. */
        const fadeInSecondsForElement = (index: number) => {
          const entry = transitions.find(
            (transition: any) =>
              normalizeUid(transition.fixture?.fixture_uid) ===
                normalizeUid(fixtureUid) && transition.fixture?.index === index,
          );
          const duration =
            entry?.transitions_by_attribute?.[normalizeAttributeName(attr)]
              ?.fade_in?.data;
          return duration
            ? duration.secs + duration.nanos / 1_000_000_000
            : undefined;
        };

        return [
          fadeInSecondsForElement(firstElementIndex),
          fadeInSecondsForElement(secondElementIndex),
        ];
      },
      context,
    );

  await expect.poll(() => childFadeInSeconds()).toEqual([0, 5]);

  await parentFadeInCell.dblclick({ force: true });
  const invalidFanEditor = grid.locator("input").last();
  await invalidFanEditor.fill("0>>5s");
  await invalidFanEditor.press("Enter");
  await expect.poll(() => childFadeInSeconds()).toEqual([0, 5]);

  await parentFadeInCell.click({ button: "right" });
  const clearAssertionsMenuItem = page.getByRole("menuitem", {
    name: "Clear assertions",
  });
  await expect(clearAssertionsMenuItem).toBeEnabled();
  await clearAssertionsMenuItem.click();
  await expect.poll(() => childFadeInSeconds()).toEqual([undefined, undefined]);

  await applyParentFadeInFan();
  await expect.poll(() => childFadeInSeconds()).toEqual([0, 5]);

  await gridHeaderByColumnKey(grid, parentFadeInColumnKey).click();
  await expect(parentFadeInCell).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect.poll(() => childFadeInSeconds()).toEqual([undefined, undefined]);

  await page.keyboard.press("1");
  const postColumnDeleteEditor = grid.locator("input").last();
  await expect(postColumnDeleteEditor).toBeVisible();
  await expect(postColumnDeleteEditor).toHaveValue("1");
  await page.keyboard.press("Enter");

  await expect.poll(() => childFadeInSeconds()).toEqual([1, 1]);

  await parentFadeInCell.click();
  await page.keyboard.press("Delete");

  await expect.poll(() => childFadeInSeconds()).toEqual([undefined, undefined]);

  await page.keyboard.press("2");
  const postDeleteEditor = grid.locator("input").last();
  await expect(postDeleteEditor).toBeVisible();
  await expect(postDeleteEditor).toHaveValue("2");
  await page.keyboard.press("Enter");

  await expect.poll(() => childFadeInSeconds()).toEqual([2, 2]);
  await expect(parentFadeInCell).toContainText("2s");
  await expect(parentFadeInCell).not.toHaveCSS("color", "rgb(143, 143, 143)");

  await parentIdCell.click();
  const firstElementFadeInCell = await gridCellByIdentifier(grid, {
    columnKey: parentFadeInColumnKey,
    identifierColumnKey: "id",
    identifierText: `${parentFixtureId}.${context.firstElementIndex}`,
  });
  const secondElementFadeInCell = await gridCellByIdentifier(grid, {
    columnKey: parentFadeInColumnKey,
    identifierColumnKey: "id",
    identifierText: `${parentFixtureId}.${context.secondElementIndex}`,
  });
  await expect(firstElementFadeInCell).toContainText("2s");
  await expect(secondElementFadeInCell).toContainText("2s");
  await expect(firstElementFadeInCell).not.toHaveCSS(
    "color",
    "rgb(143, 143, 143)",
  );
  await expect(secondElementFadeInCell).not.toHaveCSS(
    "color",
    "rgb(143, 143, 143)",
  );

  await firstElementFadeInCell.click();
  await page.keyboard.press("Delete");
  await expect.poll(() => childFadeInSeconds()).toEqual([undefined, 2]);

  await page.keyboard.press("4");
  const postElementDeleteEditor = grid.locator("input").last();
  await expect(postElementDeleteEditor).toBeVisible();
  await expect(postElementDeleteEditor).toHaveValue("4");
  await page.keyboard.press("Escape");

  await applyParentFadeInFan();
  await expect.poll(() => childFadeInSeconds()).toEqual([0, 5]);

  await page.keyboard.press("3");
  const postFanEditor = grid.locator("input").last();
  await expect(postFanEditor).toBeVisible();
  await expect(postFanEditor).toHaveValue("3");
  await page.keyboard.press("Escape");
});

/** Verifies parent timing cells show varied child timings without losing parent timing. */
test("cue timings badge varied whole-fixture parent rows within elements", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedCueTimingApp(page, backendSlot.backendPort);
  await waitForCueEditorStores(page);

  const context = await afterStartupResync(page, () =>
    page.evaluate(
      ({ baseCueUid, fixtureId, fixtureUid }) => {
        const stores = (window as any).appStores;
        const firstElementIndex = 1;
        const lastElementIndex = 2;
        const attr = "Intensity";

        /** Builds the Rust-style duration object used in seeded cue timing data. */
        const duration = (secs: number) => ({ secs, nanos: 0 });

        /** Builds a fixed transition mode from seconds for seeded cue timing data. */
        const fixed = (secs: number) => ({
          type: "Fixed",
          data: duration(secs),
        });

        const cues = stores.cues.get();
        const existingCue = cues[baseCueUid];
        if (!existingCue) throw new Error("expected the owned base cue");
        const cueUid = "92000100-0000-4000-8000-000000000000";
        const cueId = 920_001;
        const cue = {
          ...existingCue,
          identifiers: {
            ...existingCue.identifiers,
            id: cueId,
            uid: cueUid,
            label: "Cue Whole Fixture Timing Fan Test",
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
                  [attr]: {
                    type: "Inline",
                    data: { type: "Absolute", data: { value: 128 } },
                  },
                },
                transitions: {},
                transitions_by_attribute: {},
                transitions_by_fixture_attribute: [
                  {
                    fixture: { fixture_uid: fixtureUid },
                    transitions_by_attribute: {
                      [attr]: {
                        fade_in: fixed(2),
                      },
                    },
                  },
                ],
              },
            },
          ],
          parts: [],
          tracking_flags: "HTP",
        };
        stores.cues.set({
          ...cues,
          [cueUid]: cue,
        });
        void stores.send({
          module: "CueCommand",
          command: { type: "StoreCue", data: cue },
        });
        stores.cues.set({
          ...stores.cues.get(),
          [cueUid]: cue,
        });

        const api = stores.dockApi.get();
        const panelId = "panel-CueEditor-whole-fixture-fan-e2e";
        api.getPanel(panelId)?.api.close();
        api.addPanel({
          id: panelId,
          component: "CueEditor",
          title: "Cue Whole Fixture Fan E2E",
          position: {
            referencePanel: "panel-FixtureGrid",
            direction: "within",
          },
          params: {
            initialPanelId: panelId,
            initialCueUid: cueUid,
          },
        });
        const panel = api.getPanel(panelId);
        panel?.api.setActive();
        panel?.focus();

        return {
          attr,
          cueId,
          cueUid,
          fixtureUid,
          fixtureId,
          firstElementIndex,
          lastElementIndex,
          panelId,
          seedCue: cue,
        };
      },
      {
        baseCueUid: BASE_CUE_UID,
        fixtureId: FIXTURE_ID,
        fixtureUid: FIXTURE_UID,
      },
    ),
  );

  await page.waitForTimeout(500);
  await page.evaluate(({ cueUid, seedCue }) => {
    const stores = (window as any).appStores;
    stores.cues.set({
      ...stores.cues.get(),
      [cueUid]: seedCue,
    });
  }, context);

  try {
    const cuePanel = page.locator(
      `[data-panel-id="${context.panelId}"]:visible`,
    );
    await cuePanel
      .getByRole("button", { name: "Switch to timings display mode" })
      .click();
    const grid = cuePanel
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();

    const fadeInColumnKey = cueGridAttributeTimingColumnKey(
      context.attr,
      "fade_in",
    );
    const fadeInCell = await gridCellByIdentifier(grid, {
      columnKey: fadeInColumnKey,
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(fadeInCell).toContainText("2s");

    await fadeInCell.dblclick({ force: true });
    const editor = grid.locator("input").last();
    await editor.fill("0>1s");
    await expect(
      page.locator('[data-grid-inline-tooltip="true"]').filter({
        hasText:
          "Applying across fixtures, press Shift+Enter to apply within fixtures",
      }),
    ).toBeVisible();
    await editor.press("Shift+Enter");

    await expect(fadeInCell).toContainText("V");
    await expect(fadeInCell).toContainText("2s");
    await expect
      .poll(() =>
        page.evaluate(
          ({
            attr,
            cueUid,
            fixtureUid,
            firstElementIndex,
            lastElementIndex,
          }) => {
            /** Returns a stable comparable UUID string for cue and fixture lookup. */
            const normalizeUid = (uid: unknown) =>
              typeof uid === "string"
                ? uid.replaceAll("-", "").toLowerCase()
                : "";
            /** Returns the UI/storage-normalized cue attribute name. */
            const normalizeAttributeName = (attribute: string) =>
              attribute === "VirtualIntensity" ? "Intensity" : attribute;
            /** Returns duration seconds for a stored transition mode. */
            const transitionSeconds = (transition: any) => {
              const duration = transition?.fade_in?.data;
              return duration
                ? duration.secs + duration.nanos / 1_000_000_000
                : undefined;
            };
            const cue = (window as any).appStores.cues.get()[cueUid];
            const transitions =
              cue?.instructions?.[0]?.cue_instruction
                ?.transitions_by_fixture_attribute ?? [];
            const transitionForElement = (index: number) =>
              transitions.find(
                (transition: any) =>
                  normalizeUid(transition.fixture?.fixture_uid) ===
                    normalizeUid(fixtureUid) &&
                  transition.fixture?.index === index,
              )?.transitions_by_attribute?.[normalizeAttributeName(attr)];
            const fixtureWideTransition = transitions.find(
              (transition: any) =>
                normalizeUid(transition.fixture?.fixture_uid) ===
                  normalizeUid(fixtureUid) && transition.fixture?.index == null,
            )?.transitions_by_attribute?.[normalizeAttributeName(attr)];

            return {
              fixtureWideSecs: transitionSeconds(fixtureWideTransition),
              firstSecs: transitionSeconds(
                transitionForElement(firstElementIndex),
              ),
              lastSecs: transitionSeconds(
                transitionForElement(lastElementIndex),
              ),
            };
          },
          context,
        ),
      )
      .toEqual({
        fixtureWideSecs: 2,
        firstSecs: 0,
        lastSecs: 1,
      });
    await page.screenshot({
      path: testInfo.outputPath("owned-cue-timing-varied-parent.png"),
    });

    await fadeInCell.click();
    await page.keyboard.press("Delete");

    await expect
      .poll(() =>
        page.evaluate(
          ({
            attr,
            cueUid,
            fixtureUid,
            firstElementIndex,
            lastElementIndex,
          }) => {
            /** Returns a stable comparable UUID string for cue and fixture lookup. */
            const normalizeUid = (uid: unknown) =>
              typeof uid === "string"
                ? uid.replaceAll("-", "").toLowerCase()
                : "";
            /** Returns the UI/storage-normalized cue attribute name. */
            const normalizeAttributeName = (attribute: string) =>
              attribute === "VirtualIntensity" ? "Intensity" : attribute;
            /** Returns duration seconds for a stored transition mode. */
            const transitionSeconds = (transition: any) => {
              const duration = transition?.fade_in?.data;
              return duration
                ? duration.secs + duration.nanos / 1_000_000_000
                : undefined;
            };
            const cue = (window as any).appStores.cues.get()[cueUid];
            const transitions =
              cue?.instructions?.[0]?.cue_instruction
                ?.transitions_by_fixture_attribute ?? [];
            const transitionForElement = (index: number) =>
              transitions.find(
                (transition: any) =>
                  normalizeUid(transition.fixture?.fixture_uid) ===
                    normalizeUid(fixtureUid) &&
                  transition.fixture?.index === index,
              )?.transitions_by_attribute?.[normalizeAttributeName(attr)];
            const fixtureWideTransition = transitions.find(
              (transition: any) =>
                normalizeUid(transition.fixture?.fixture_uid) ===
                  normalizeUid(fixtureUid) && transition.fixture?.index == null,
            )?.transitions_by_attribute?.[normalizeAttributeName(attr)];

            return {
              fixtureWideSecs: transitionSeconds(fixtureWideTransition),
              firstSecs: transitionSeconds(
                transitionForElement(firstElementIndex),
              ),
              lastSecs: transitionSeconds(
                transitionForElement(lastElementIndex),
              ),
            };
          },
          context,
        ),
      )
      .toEqual({
        fixtureWideSecs: undefined,
        firstSecs: 0,
        lastSecs: 1,
      });

    await expect(fadeInCell).toContainText("V");
    await expect(fadeInCell).toContainText("0s");
    await page.keyboard.press("Shift+Delete");

    await expect
      .poll(() =>
        page.evaluate(
          ({
            attr,
            cueUid,
            fixtureUid,
            firstElementIndex,
            lastElementIndex,
          }) => {
            /** Returns a stable comparable UUID string for cue and fixture lookup. */
            const normalizeUid = (uid: unknown) =>
              typeof uid === "string"
                ? uid.replaceAll("-", "").toLowerCase()
                : "";
            /** Returns the UI/storage-normalized cue attribute name. */
            const normalizeAttributeName = (attribute: string) =>
              attribute === "VirtualIntensity" ? "Intensity" : attribute;
            /** Returns duration seconds for a stored transition mode. */
            const transitionSeconds = (transition: any) => {
              const duration = transition?.fade_in?.data;
              return duration
                ? duration.secs + duration.nanos / 1_000_000_000
                : undefined;
            };
            const cue = (window as any).appStores.cues.get()[cueUid];
            const transitions =
              cue?.instructions?.[0]?.cue_instruction
                ?.transitions_by_fixture_attribute ?? [];
            const transitionForElement = (index: number) =>
              transitions.find(
                (transition: any) =>
                  normalizeUid(transition.fixture?.fixture_uid) ===
                    normalizeUid(fixtureUid) &&
                  transition.fixture?.index === index,
              )?.transitions_by_attribute?.[normalizeAttributeName(attr)];
            const fixtureWideTransition = transitions.find(
              (transition: any) =>
                normalizeUid(transition.fixture?.fixture_uid) ===
                  normalizeUid(fixtureUid) && transition.fixture?.index == null,
            )?.transitions_by_attribute?.[normalizeAttributeName(attr)];

            return {
              fixtureWideSecs: transitionSeconds(fixtureWideTransition),
              firstSecs: transitionSeconds(
                transitionForElement(firstElementIndex),
              ),
              lastSecs: transitionSeconds(
                transitionForElement(lastElementIndex),
              ),
            };
          },
          context,
        ),
      )
      .toEqual({
        fixtureWideSecs: undefined,
        firstSecs: undefined,
        lastSecs: undefined,
      });
  } finally {
    await page.evaluate(({ cueUid }) => {
      const stores = (window as any).appStores;
      const cues = { ...stores.cues.get() };
      delete cues[cueUid];
      stores.cues.set(cues);
    }, context);
  }
});
