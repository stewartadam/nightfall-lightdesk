// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  cueGridAttributeTimingColumnKey,
  gridCellByRowIndex,
} from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const FIXTURE_ID = 94_401;
const CUE_ID = 94_401;
const FIXTURE_UID = "c4410000000000000000000000000001";
const CUE_UID = "c4410000000000000000000000000002";
const CUE_LABEL = "Owned Cue Properties Preview";

/** Verifies backward scrubbing restores earlier fixture output and stepping stays paused. */
test("cue transition slider scrubs output backward and steps through time", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedCuePropertiesApp(page, backendSlot.backendPort);
  await sendCommand(page, {
    module: "DeskCommand",
    command: {
      type: "SaveNamedShowfile",
      data: { name: "scrub-output", options: {} },
    },
  });
  await sendCommand(page, {
    module: "DeskCommand",
    command: { type: "LoadNamedShowfile", data: "scrub-output" },
  });
  await waitForDockviewApp(page);
  const panelId = "panel-CueEditor-scrub-e2e";
  await openCuePreviewPanel(page, { panelId });
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const skipTransitions = panel.getByRole("button", {
    name: "Toggle preview transitions",
  });
  await expect(skipTransitions).toHaveAttribute("aria-pressed", "false");
  await skipTransitions.click();
  await expect(skipTransitions).toHaveAttribute("aria-pressed", "true");
  await skipTransitions.click();
  await expect(skipTransitions).toHaveAttribute("aria-pressed", "false");
  await panel.getByRole("button", { name: "Toggle cue preview" }).click();
  const slider = panel.getByRole("slider", { name: "Transition progress" });
  await expect(slider).toBeVisible();

  /** Reads the rendered intensity for the owned fixture's first element. */
  const intensity = () =>
    page.evaluate((uid) => {
      const row = (window as any).appStores.parameters.get().get(uid);
      return (
        row?.elements?.find((element: any) => element.elementIndex === 1)?.raw
          .Intensity ?? row?.raw.Intensity
      );
    }, FIXTURE_UID);

  await slider.fill("3");
  await expect(
    panel.getByRole("button", { name: "Resume transition" }),
  ).toBeVisible();
  await expect.poll(intensity).toBe(128);
  await slider.fill("2");
  await expect.poll(intensity).toBe(64);
  await expect(slider).toHaveValue("2");
  await panel.getByRole("button", { name: "Step transition backward" }).click();
  await expect(slider).toHaveValue("1.9");
  await panel.getByRole("button", { name: "Step transition forward" }).click();
  await expect(slider).toHaveValue("2");
  await page.screenshot({
    path: testInfo.outputPath("transition-scrubber.png"),
  });
  await panel.getByRole("button", { name: "Resume transition" }).click();
  await expect.poll(intensity).toBe(128);
  await panel.getByRole("button", { name: "Toggle cue preview" }).click();
  await expect(slider).toBeHidden();
});

/** Measures the horizontal timing fill away from cell text and borders. */
async function timingFillFraction(cell: Locator): Promise<number> {
  return cell
    .locator("canvas")
    .first()
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Expected timing cell canvas");
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || canvas.width <= 0 || canvas.height <= 0) return 0;
      const scale = canvas.width / rect.width;
      const padding = Math.ceil(2 * scale);
      const width = canvas.width - 2 * padding;
      if (width <= 0) return 0;
      const pixels = context.getImageData(
        padding,
        Math.ceil(4 * scale),
        width,
        1,
      ).data;
      let filled = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index + 2] > pixels[index] + 20 &&
          pixels[index + 2] > pixels[index + 1] + 12
        )
          filled += 1;
      }
      return filled / width;
    });
}

/** Verifies collapsed fixture rows use element override timing when scrubbing backward and forward. */
test("cue transition backgrounds respect fixture element overrides", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedCuePropertiesApp(page, backendSlot.backendPort);
  const baselineUid = "c4410000000000000000000000000003";
  await sendCommand(page, {
    module: "FixtureCommand",
    command: {
      type: "StoreFixture",
      data: {
        ...ownedFixture(),
        identifiers: {
          id: FIXTURE_ID + 1,
          uid: baselineUid,
          label: "Inherited timing fixture",
        },
      },
    },
  });
  const cue = {
    ...ownedFixedCue(),
    transitions: {
      delay_in: fixed(0),
      fade_in: fixed(1),
      delay_out: fixed(0),
      fade_out: fixed(0),
    },
    instructions: [
      {
        ...ownedInstruction([1], {}),
        cue_instruction: {
          ...ownedInstruction([1], {}).cue_instruction,
          transitions_by_fixture_attribute: [
            {
              fixture: { fixture_uid: FIXTURE_UID, index: 1 },
              transitions_by_attribute: {
                Intensity: { delay_in: fixed(1), fade_in: fixed(1) },
              },
            },
          ],
        },
      },
    ],
  };
  cue.instructions.push({
    ...ownedInstruction([1], {}),
    selection: {
      source: {
        type: "Resolved",
        data: [{ fixture_uid: baselineUid, index: 1 }],
      },
      clauses: [],
    },
    cue_instruction: ownedInstruction([1], {}).cue_instruction,
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: cue },
  });
  await sendCommand(page, {
    module: "DeskCommand",
    command: {
      type: "SaveNamedShowfile",
      data: { name: "override-progress", options: {} },
    },
  });
  await sendCommand(page, {
    module: "DeskCommand",
    command: { type: "LoadNamedShowfile", data: "override-progress" },
  });
  await waitForDockviewApp(page);
  const panelId = "panel-CueEditor-override-progress";
  await openCuePreviewPanel(page, { panelId });
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await panel
    .getByRole("button", { name: "Switch to timings display mode" })
    .click();
  await panel.getByRole("button", { name: "Toggle cue preview" }).click();
  const slider = panel.getByRole("slider", { name: "Transition progress" });
  await expect(slider).toHaveAttribute("max", "2");
  const grid = panel.locator('[data-grid-kind="tanstack"]');
  const delay = gridCellByRowIndex(grid, {
    rowIndex: 0,
    columnKey: cueGridAttributeTimingColumnKey("Intensity", "delay_in"),
  });
  const fade = gridCellByRowIndex(grid, {
    rowIndex: 0,
    columnKey: cueGridAttributeTimingColumnKey("Intensity", "fade_in"),
  });
  await expect(delay).toContainText("1s");
  await expect(fade).toContainText("1s");
  await slider.fill("1.75");
  await expect.poll(() => timingFillFraction(delay)).toBeGreaterThan(0.97);
  await expect.poll(() => timingFillFraction(fade)).toBeCloseTo(0.75, 1);
  for (const field of ["delay_in", "fade_in"] as const) {
    const baselineCell = gridCellByRowIndex(grid, {
      rowIndex: 1,
      columnKey: cueGridAttributeTimingColumnKey("Intensity", field),
    });
    await expect
      .poll(() => timingFillFraction(baselineCell))
      .toBeGreaterThan(0.97);
  }
  await slider.fill("1.25");
  await expect.poll(() => timingFillFraction(fade)).toBeCloseTo(0.25, 1);
  await slider.fill("1.75");
  await expect.poll(() => timingFillFraction(fade)).toBeCloseTo(0.75, 1);
  await page.screenshot({
    path: testInfo.outputPath("fixture-override-progress.png"),
  });
  await panel.getByRole("button", { name: "Toggle cue preview" }).click();
});

test.describe.configure({ timeout: 120_000 });

/** Stops cue previews, replaces the backend, and proves owned stores are blank. */
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
    .poll(() => ownedCuePropertiesStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0 });
});

/** Reads every backend store owned by the cue properties scenarios. */
async function ownedCuePropertiesStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
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

/** Builds an intensity parameter for one owned fixture element. */
function intensityParameter(): object {
  return {
    resolution: "Coarse",
    attribute: { type: "Intensity" },
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: "HTP",
    use_grandmaster: true,
  };
}

/** Builds the exact two-element fixture used by fixed and fanned timings. */
function ownedFixture(): object {
  return {
    identifiers: {
      id: FIXTURE_ID,
      uid: FIXTURE_UID,
      label: "Owned Cue Properties Fixture",
    },
    make: "E2E",
    model: "Cue Properties Fixture",
    mode: "Two Cell Intensity",
    elements: [1, 2].map((index) => ({
      label: `Cell ${index}`,
      parameters: [intensityParameter()],
    })),
  };
}

/** Builds the Rust-style duration object used by cue transition modes. */
function duration(secs: number): object {
  return {
    secs: Math.trunc(secs),
    nanos: Math.trunc((secs % 1) * 1_000_000_000),
  };
}

/** Builds a fixed transition mode from seconds. */
function fixed(secs: number): object {
  return { type: "Fixed", data: duration(secs) };
}

/** Builds an interpolated transition mode from its endpoint seconds. */
function interpolated(start: number, end: number): object {
  return {
    type: "Interpolated",
    data: { start: duration(start), end: duration(end) },
  };
}

/** Builds a manually fanned transition mode from per-element seconds. */
function manual(values: number[]): object {
  return { type: "Manual", data: values.map(duration) };
}

/** Builds the resolved selection for one or both owned fixture elements. */
function ownedSelection(elementIndexes: number[]): object {
  return {
    source: {
      type: "Resolved",
      data: elementIndexes.map((index) => ({
        fixture_uid: FIXTURE_UID,
        index,
      })),
    },
    clauses: [],
  };
}

/** Builds an intensity instruction with caller-supplied transition timing. */
function ownedInstruction(elementIndexes: number[], transitions: object) {
  return {
    selection: ownedSelection(elementIndexes),
    cue_instruction: {
      values: {
        Intensity: {
          type: "Inline",
          data: { type: "Absolute", data: { value: 128 } },
        },
      },
      transitions,
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Builds the fixed-duration cue shared by deletion and preview ownership tests. */
function ownedFixedCue(): object {
  return {
    identifiers: { id: CUE_ID, uid: CUE_UID, label: CUE_LABEL },
    trigger: { type: "Manual" },
    transitions: {
      delay_in: fixed(1),
      fade_in: fixed(2),
      delay_out: fixed(4),
      fade_out: fixed(3),
    },
    transitions_by_attribute: {},
    instructions: [ownedInstruction([1], {})],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the cue whose instruction fans timing across two owned elements. */
function ownedFannedCue(): object {
  return {
    ...ownedFixedCue(),
    identifiers: { id: CUE_ID, uid: CUE_UID, label: "Fanned Timing" },
    transitions: {},
    instructions: [
      ownedInstruction([1, 2], {
        delay_in: interpolated(0, 2),
        fade_in: interpolated(0.25, 2.25),
        delay_out: manual([0, 1, 0]),
        fade_out: interpolated(2.5, 0.5),
      }),
    ],
  };
}

/** Opens a fresh app and stores the exact fixture and fixed cue graph. */
async function openOwnedCuePropertiesApp(
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
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.fixtures?.get),
  );
  await expect
    .poll(() => ownedCuePropertiesStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 0, fixtures: 0 });

  await sendCommand(page, {
    module: "FixtureCommand",
    command: { type: "StoreFixture", data: ownedFixture() },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: ownedFixedCue() },
  });
  await expect
    .poll(() => ownedCuePropertiesStoreCounts(page))
    .toEqual({ activeInstances: 0, cues: 1, fixtures: 1 });
}

/**
 * Opens a panel from the command palette for cue preview assertions.
 */
async function openPanel(page: Page, panelName: string) {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  const command = page
    .locator('[data-command-index="0"]')
    .filter({ hasText: `Open ${panelName}` });
  await expect(command).toBeVisible();
  await command.click();
  await expect(
    page.locator('[data-dialog-kind="command-palette"]'),
  ).toBeHidden();
}

/**
 * Focuses a Dockview panel by its stable id without depending on tab title text.
 */
async function focusPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((targetPanelId) => {
    const panel = (window as any).appStores?.dockApi
      ?.get?.()
      ?.getPanel(targetPanelId);
    if (!panel) throw new Error(`Expected Dockview panel ${targetPanelId}`);
    panel.api.setActive();
    panel.focus();
  }, panelId);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(panelId);
}

/** Expands the Dockview properties edge group without changing the inspected panel. */
async function expandPropertiesPanel(
  page: Page,
  inspectedPanelId: string,
): Promise<void> {
  await page.evaluate(async (panelId) => {
    const api = (window as any).appStores.dockApi.get();
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const inspectedPanel = api.getPanel(panelId);
        inspectedPanel?.api.setActive();
        inspectedPanel?.focus();
        resolve();
      });
    });
  }, inspectedPanelId);
}

/**
 * Opens a cue editor panel against a seeded cue and returns panel/cue identifiers.
 */
async function openCuePreviewPanel(
  page: Page,
  options: { panelId: string; cueUid?: string },
): Promise<{ panelId: string; cueUid: string }> {
  return await page.evaluate(
    async (options) => {
      type AppStoresWindow = Window & {
        appStores?: {
          dockApi?: { get: () => any };
          cueDefinitionsLoaded?: { set: (loaded: boolean) => void };
          cues?: { get: () => Record<string, any> };
        };
      };

      /** Waits for stores needed by the cue preview panel. */
      const waitForStores = () =>
        new Promise<NonNullable<AppStoresWindow["appStores"]>>(
          (resolve, reject) => {
            const started = Date.now();

            /** Polls app stores until seeded cue data is available. */
            const tick = () => {
              const stores = (window as AppStoresWindow).appStores;
              const api = stores?.dockApi?.get?.();
              const cue = stores?.cues?.get?.()?.[options.cueUid];
              if (api && stores?.cues && cue) {
                resolve(stores);
                return;
              }
              if (Date.now() - started > 45_000) {
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
      const cue = cues[options.cueUid];
      if (!api || !cue) {
        throw new Error("cue editor stores did not initialize");
      }
      stores.cueDefinitionsLoaded?.set?.(true);

      api.getPanel(options.panelId)?.api.close();
      api.addPanel({
        id: options.panelId,
        component: "CueEditor",
        title: `Cue Preview Owner ${options.panelId}`,
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: options.panelId,
          initialCueUid: cue.identifiers.uid,
        },
      });

      return { panelId: options.panelId, cueUid: cue.identifiers.uid };
    },
    { ...options, cueUid: options.cueUid ?? CUE_UID },
  );
}

/**
 * Counts active, non-releasing cue preview instances for the source cue.
 */
async function countActiveCuePreviewInstances(
  page: Page,
  cueUid: string,
): Promise<number> {
  return await page.evaluate((cueUid) => {
    /** Normalizes UUID strings for store comparisons. */
    const normalizeUid = (uid: unknown) =>
      String(uid).replaceAll("-", "").toLowerCase();
    const stores = (window as any).appStores;
    const cue = stores?.cues?.get?.()?.[cueUid];
    const expectedName = cue
      ? `Cue Preview: ${cue.identifiers.label}`
      : undefined;
    const instances = stores?.activeInstances?.get?.() ?? {};
    return Object.values(instances).filter(
      (playback: any) =>
        playback.is_preview &&
        !playback.is_releasing &&
        ((playback.object_ref?.type === "ByUid" &&
          playback.object_ref.data?.object_type === "Cue" &&
          normalizeUid(playback.object_ref.data?.uid) ===
            normalizeUid(cueUid)) ||
          (expectedName !== undefined && playback.name === expectedName)),
    ).length;
  }, cueUid);
}

/** Verifies cue editor panels close after the last backing cue is removed. */
test("cue editor panel closes when its cue is deleted", async ({
  backendSlot,
  page,
}) => {
  await openOwnedCuePropertiesApp(page, backendSlot.backendPort);

  const opened = await openCuePreviewPanel(page, {
    panelId: "panel-CueEditor-close-deleted-cue",
  });

  await expect
    .poll(
      async () =>
        page.evaluate(
          (panelId) =>
            Boolean(
              (window as any).appStores?.dockApi?.get?.()?.getPanel?.(panelId),
            ),
          opened.panelId,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);

  await page.evaluate((cueUid) => {
    const stores = (window as any).appStores;
    if (!stores.cues.get()[cueUid]) {
      throw new Error("expected opened cue to exist before deletion");
    }
    stores.cues.set({});
  }, opened.cueUid);

  await expect
    .poll(
      async () =>
        page.evaluate(
          (panelId) =>
            Boolean(
              (window as any).appStores?.dockApi?.get?.()?.getPanel?.(panelId),
            ),
          opened.panelId,
        ),
      { timeout: 10_000 },
    )
    .toBe(false);
});

/** Verifies fixed cue timings drive both properties and preview progress. */
test("cue properties transition duration and preview progress use full transition span", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedCuePropertiesApp(page, backendSlot.backendPort);
  await openCuePreviewPanel(page, {
    panelId: "panel-CueEditor-properties-e2e",
  });

  try {
    await focusPanel(page, "panel-CueEditor-properties-e2e");
    await expandPropertiesPanel(page, "panel-CueEditor-properties-e2e");
    const propertiesPanel = page.locator(
      '[data-panel-id="panel-PropertiesInspector"]',
    );
    await expect(propertiesPanel).toBeVisible();
    await expect(
      propertiesPanel.getByText("Transition Duration: 7.0s"),
    ).toBeVisible();
    await expect(propertiesPanel.getByText("7.0s total")).toBeVisible();

    await focusPanel(page, "panel-CueEditor-properties-e2e");
    const cuePanel = page.locator(
      '[data-panel-id="panel-CueEditor-properties-e2e"]',
    );
    const previewToggle = cuePanel.getByRole("button", {
      name: "Toggle cue preview",
    });
    await previewToggle.click();
    await expandPropertiesPanel(page, "panel-CueEditor-properties-e2e");

    await expect
      .poll(async () => {
        const text = await page
          .locator("text=/s \\/ 7\\.0s/")
          .first()
          .textContent();
        return text?.trim() ?? "";
      })
      .toMatch(/^(0\.[1-9]|[1-7]\.\d)s \/ 7\.0s$/);

    await expect
      .poll(async () => {
        const text = await page
          .locator("text=/s \\/ 7\\.0s/")
          .first()
          .textContent();
        const seconds = Number.parseFloat(text?.trim().split("s /")[0] ?? "");
        return Number.isFinite(seconds) ? seconds : 0;
      })
      .toBeGreaterThan(1);

    await focusPanel(page, "panel-CueEditor-properties-e2e");
    await page.keyboard.press("Control+ArrowUp");
    await expandPropertiesPanel(page, "panel-CueEditor-properties-e2e");

    await expect
      .poll(async () => {
        const text = await page
          .locator("text=/s \\/ 7\\.0s/")
          .first()
          .textContent();
        const seconds = Number.parseFloat(text?.trim().split("s /")[0] ?? "");
        return Number.isFinite(seconds) ? seconds : 7;
      })
      .toBeLessThan(1);
    await page.screenshot({
      path: testInfo.outputPath("cue-properties-fixed-preview.png"),
    });

    await openPanel(page, "Status Display");
    const previewPlaybackRow = page.getByRole("row", {
      name: /Cue Cue Preview: Owned Cue Properties Preview/,
    });
    await expect(previewPlaybackRow).toBeVisible();
    const stoppedInstanceId = await page.evaluate(() => {
      const playback = Object.values(
        (window as any).appStores.activeInstances.get(),
      ).find(
        (playback: any) =>
          playback.name === "Cue Preview: Owned Cue Properties Preview" &&
          !playback.is_releasing,
      ) as any;
      if (!playback?.instance_id) return undefined;
      return playback.instance_id as string;
    });
    expect(stoppedInstanceId).toBeTruthy();
    await sendCommand(page, {
      module: "InstanceCommand",
      command: { type: "Stop", data: stoppedInstanceId },
    });

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Object.values((window as any).appStores.activeInstances.get()).some(
            (playback: any) =>
              playback.name === "Cue Preview: Owned Cue Properties Preview" &&
              !playback.is_releasing,
          ),
        ),
      )
      .toBe(false);

    await focusPanel(page, "panel-CueEditor-properties-e2e");
    await expect
      .poll(async () =>
        page.evaluate((panelId) => {
          const instances = Object.values(
            (window as any).appStores.activeInstances.get(),
          )
            .filter(
              (playback: any) =>
                playback.name === "Cue Preview: Owned Cue Properties Preview",
            )
            .map((playback: any) => ({
              name: playback.name,
              tags: playback.tags,
              isReleasing: playback.is_releasing,
            }));
          const pressed = document
            .querySelector(
              `[data-panel-id="${panelId}"] button[aria-label="Toggle cue preview"]`,
            )
            ?.getAttribute("aria-pressed");
          return { pressed, instances };
        }, "panel-CueEditor-properties-e2e"),
      )
      .toEqual({ pressed: "false", instances: [] });
  } finally {
    await sendCommand(page, {
      module: "InstanceCommand",
      command: { type: "StopAll" },
    });
  }
});

/** Verifies per-element timing fans contribute their full transition span. */
test("cue properties transition duration includes fanned instruction timings", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedCuePropertiesApp(page, backendSlot.backendPort);
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: ownedFannedCue() },
  });
  await openCuePreviewPanel(page, {
    panelId: "panel-CueEditor-fanned-properties-e2e",
  });

  await focusPanel(page, "panel-CueEditor-fanned-properties-e2e");
  const fannedPanel = page.locator(
    '[data-panel-id="panel-CueEditor-fanned-properties-e2e"]',
  );
  await expect(
    fannedPanel.getByRole("button", { name: "Switch to values display mode" }),
  ).toBeVisible();
  await expandPropertiesPanel(page, "panel-CueEditor-fanned-properties-e2e");
  await expect(
    page.locator('[data-panel-id="panel-PropertiesInspector"]'),
  ).toBeVisible();
  await expect(page.getByText("Transition Duration: 4.3s")).toBeVisible();
  await expect(page.getByText("4.3s total")).toBeVisible();

  await focusPanel(page, "panel-CueEditor-fanned-properties-e2e");
  await fannedPanel.getByRole("button", { name: "Toggle cue preview" }).click();
  await expandPropertiesPanel(page, "panel-CueEditor-fanned-properties-e2e");

  await expect
    .poll(async () => {
      const text = await page
        .locator("text=/s \\/ 4\\.3s/")
        .first()
        .textContent();
      return text?.trim() ?? "";
    })
    .toMatch(/^(0\.[1-9]|[1-4]\.\d)s \/ 4\.3s$/);
  await page.screenshot({
    path: testInfo.outputPath("cue-properties-fanned-preview.png"),
  });

  await sendCommand(page, {
    module: "InstanceCommand",
    command: { type: "StopAll" },
  });
  await expect
    .poll(() => countActiveCuePreviewInstances(page, CUE_UID))
    .toBe(0);
});

/**
 * Verifies closing a passive same-cue editor does not stop another editor's preview.
 */
test("cue editor preview is owned by the editor playback", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await openOwnedCuePropertiesApp(page, backendSlot.backendPort);
  const first = await openCuePreviewPanel(page, {
    panelId: "panel-CueEditor-preview-owner-a",
  });
  await expect
    .poll(() => countActiveCuePreviewInstances(page, first.cueUid))
    .toBe(0);
  await focusPanel(page, first.panelId);
  const firstPreviewToggle = page
    .locator(`[data-panel-id="${first.panelId}"]`)
    .getByRole("button", { name: "Toggle cue preview" });
  await expect(firstPreviewToggle).toBeVisible();
  await firstPreviewToggle.click();
  await expect
    .poll(() => countActiveCuePreviewInstances(page, first.cueUid))
    .toBe(1);

  const second = await openCuePreviewPanel(page, {
    panelId: "panel-CueEditor-preview-owner-b",
    cueUid: first.cueUid,
  });
  await expect
    .poll(() => countActiveCuePreviewInstances(page, first.cueUid))
    .toBe(1);

  await page.evaluate((panelId) => {
    (window as any).appStores.dockApi.get().getPanel(panelId)?.api.close();
  }, second.panelId);
  await expect
    .poll(() => countActiveCuePreviewInstances(page, first.cueUid))
    .toBe(1);

  await sendCommand(page, {
    module: "InstanceCommand",
    command: { type: "StopAll" },
  });
  await expect
    .poll(() => countActiveCuePreviewInstances(page, first.cueUid))
    .toBe(0);
});
