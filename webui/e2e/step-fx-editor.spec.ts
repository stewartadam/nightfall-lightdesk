// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens an isolated app session with one fixture for selection and preview projection. */
async function openStepFxEditorApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    const initializationKey = "step-fx-e2e-storage-initialized";
    if (window.sessionStorage.getItem(initializationKey) !== "true") {
      window.localStorage.clear();
      window.sessionStorage.setItem(initializationKey, "true");
    }
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.stepFx?.get),
  );
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (const fixtureId of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Step FX Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`fixture creation failed: ${JSON.stringify(result)}`);
      }
    }
    const structuredGroupResult = await stores.sendAndAwait({
      module: "GroupCommand",
      command: {
        type: "StoreGroup",
        data: {
          identifiers: {
            id: 98,
            uid: "98989898989898989898989898989898",
            label: "Structured group",
          },
          selection: {
            source: {
              type: "FixtureRange",
              data: {
                start: { fixture_id: 1 },
                end: { fixture_id: 4 },
              },
            },
            clauses: [{ type: "Blocks", data: { axis: "X", amount: 2 } }],
            union: [],
          },
          description: "Exercises container-aware Step FX phase projection",
        },
      },
    });
    if (structuredGroupResult.outcome.type !== "Succeeded") {
      throw new Error(
        `structured group creation failed: ${JSON.stringify(structuredGroupResult)}`,
      );
    }
    const recursiveGroupUid = "99999999999999999999999999999999";
    const groupResult = await stores.sendAndAwait({
      module: "GroupCommand",
      command: {
        type: "StoreGroup",
        data: {
          identifiers: {
            id: 99,
            uid: recursiveGroupUid,
            label: "Recursive group",
          },
          selection: {
            source: {
              type: "Group",
              data: { type: "ByUid", data: { uid: recursiveGroupUid } },
            },
            clauses: [],
            union: [],
          },
          description: "Exercises cycle-safe Step FX phase projection",
        },
      },
    });
    if (groupResult.outcome.type !== "Succeeded") {
      throw new Error(`group creation failed: ${JSON.stringify(groupResult)}`);
    }
  });
}

/** Adds a frontend-only custom attribute to one loaded fixture for picker scoping checks. */
async function addFixtureAttribute(
  page: Page,
  fixtureId: number,
  label: string,
): Promise<void> {
  await page.evaluate(
    ({ fixtureId, label }) => {
      const stores = (window as any).appStores;
      const entry = Object.entries(stores.fixtures.get()).find(
        ([, fixture]: [string, any]) => fixture.identifiers.id === fixtureId,
      ) as [string, any] | undefined;
      if (!entry) throw new Error(`Fixture ${fixtureId} is not loaded`);
      const [key, source] = entry;
      const fixture = structuredClone(source);
      const template = fixture.elements
        .flatMap((element: any) => element.parameters)
        .at(0);
      if (!template) throw new Error(`Fixture ${fixtureId} has no parameters`);
      fixture.elements[0].parameters.push({
        ...template,
        attribute: { type: "Custom", data: { label } },
      });
      stores.fixtures.setKey(key, fixture);
    },
    { fixtureId, label },
  );
}

/** Returns the sole stored Step FX definition from the browser store. */
async function storedStepFx(page: Page): Promise<any | undefined> {
  return page.evaluate(
    () => Object.values((window as any).appStores.stepFx.get())[0],
  );
}

/** Deletes the sole stored Step FX through the acknowledged command channel. */
async function deleteStoredStepFx(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const definition = Object.values(stores.stepFx.get())[0] as any;
    if (!definition) throw new Error("No stored Step FX exists");
    const result = await stores.sendAndAwait({
      module: "StepFxCommand",
      command: { type: "Delete", data: definition.identifiers.id },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`Step FX deletion failed: ${JSON.stringify(result)}`);
    }
  });
}

/** Returns the backend runtime anchor for the active Step FX editor preview. */
async function stepFxPreviewStatus(page: Page): Promise<any | undefined> {
  return page.evaluate(
    () =>
      (
        Object.values((window as any).appStores.activeInstances.get()) as any[]
      ).find(
        (playback: any) =>
          playback.is_preview && playback.display_kind === "StepFx",
      )?.step_fx_preview,
  );
}

/** Measures wrapped waveform error against the first fixture's phased backend clock. */
async function stepFxPlayheadError(
  page: Page,
  selectionPhaseOffset: number,
  options: {
    direction?: "Forward" | "Reverse" | "Bounce";
    totalBeats?: number;
    cycleBeats?: number;
    beatDurationSeconds?: number;
  } = {},
): Promise<number | undefined> {
  return page.evaluate(
    ({ phaseOffset, direction, totalBeats, cycleBeats, beatDuration }) => {
      const preview = (
        Object.values((window as any).appStores.activeInstances.get()) as any[]
      ).find(
        (playback: any) =>
          playback.is_preview && playback.display_kind === "StepFx",
      )?.step_fx_preview;
      const playhead = document.querySelector(
        '[data-step-fx-waveform-playhead][data-selected="true"]',
      );
      if (!preview || !playhead) return undefined;
      const elapsed =
        preview.elapsed.secs +
        preview.elapsed.nanos / 1_000_000_000 +
        (Math.max(0, Date.now() - preview.sampled_at_epoch_ms) / 1_000) *
          preview.elapsed_rate;
      const continuityOffset =
        preview.track_phase_offsets.find(
          (candidate: any) => candidate.attribute.type === "Intensity",
        )?.absolute ?? 0;
      const cycleSeconds = (cycleBeats ?? totalBeats) * beatDuration;
      const startCyclePosition =
        direction === "Bounce" ? phaseOffset / 2 : phaseOffset;
      const cyclePosition =
        (((elapsed / cycleSeconds + startCyclePosition + continuityOffset) %
          1) +
          1) %
        1;
      const expectedPhase =
        direction === "Reverse"
          ? 1 - cyclePosition
          : direction === "Bounce"
            ? cyclePosition <= 0.5
              ? cyclePosition * 2
              : 2 - cyclePosition * 2
            : cyclePosition;
      const actualX = Number(playhead.getAttribute("x1"));
      const directError = Math.abs(actualX - expectedPhase * 1_000);
      return Math.min(directError, 1_000 - directError);
    },
    {
      phaseOffset: selectionPhaseOffset,
      direction: options.direction ?? "Forward",
      totalBeats: options.totalBeats ?? 2,
      cycleBeats: options.cycleBeats,
      beatDuration: options.beatDurationSeconds ?? 0.5,
    },
  );
}

/** Reads the synchronized live-step markers across waveform, sheet, and step bar. */
async function liveStepHighlightState(editor: Locator): Promise<{
  waveform: string[];
  rows: string[];
  selectors: string[];
}> {
  return editor.evaluate((root) => ({
    waveform: Array.from(
      root.querySelectorAll(
        '[data-step-fx-waveform-segment][data-live="true"]',
      ),
    ).map((element) => element.getAttribute("data-step-index") ?? ""),
    rows: Array.from(
      root.querySelectorAll('[data-step-fx-step-row][data-live="true"]'),
    ).map((element) => element.getAttribute("data-step-index") ?? ""),
    selectors: Array.from(
      root.querySelectorAll('[data-step-fx-step-selector][data-live="true"]'),
    ).map((element) => element.getAttribute("data-step-index") ?? ""),
  }));
}

/** Closes the open Step FX editor through its Dockview panel API. */
async function closeStepFxEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.panels.find((candidate: any) =>
      candidate.id.startsWith("step-fx-editor-"),
    );
    panel?.api.close();
  });
}

/** Opens Properties for the active Step FX editor and returns its visible panel. */
async function openStepFxProperties(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const editorPanel = api.panels.find((candidate: any) =>
      candidate.id.startsWith("step-fx-editor-"),
    );
    if (!editorPanel) throw new Error("Step FX editor panel is not open");
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
      });
    }
    editorPanel.api.setActive();
    editorPanel.focus();
  });
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  const propertiesPanel = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]:visible',
  );
  await expect(propertiesPanel).toBeVisible();
  return propertiesPanel;
}

/** Returns focus to the open Step FX editor after inspecting its properties. */
async function focusStepFxEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const editorPanel = api.panels.find((candidate: any) =>
      candidate.id.startsWith("step-fx-editor-"),
    );
    if (!editorPanel) throw new Error("Step FX editor panel is not open");
    editorPanel.api.setActive();
    editorPanel.focus();
  });
  const visiblePropertiesPanel = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]:visible',
  );
  if ((await visiblePropertiesPanel.count()) > 0) {
    await page.getByRole("tab", { name: "Properties", exact: true }).click();
    await expect(visiblePropertiesPanel).toHaveCount(0);
  }
}

/** Opens Properties and commits one authored selection expression. */
async function setEditorSelection(
  page: Page,
  editor: Locator,
  selection: string,
): Promise<void> {
  const propertiesPanel = await openStepFxProperties(page);
  const input = propertiesPanel.getByLabel("Selection");
  await input.fill(selection);
  await propertiesPanel.getByRole("button", { name: "Apply" }).click();
  await focusStepFxEditor(page);
  await expect(editor).toBeVisible();
}

/** Opens and returns the compact speed-and-scaling toolbar menu. */
async function openStepFxTimingControls(
  page: Page,
  editor: Locator,
): Promise<Locator> {
  const trigger = editor.getByRole("button", { name: "Speed and scaling" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  const menu = page.locator('[data-menu-kind="step-fx-timing"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens and returns the visual Start position toolbar menu. */
async function openStepFxStartPositionControls(
  page: Page,
  editor: Locator,
): Promise<Locator> {
  const trigger = editor.getByRole("button", { name: "Start position" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  const menu = page.locator('[data-menu-kind="step-fx-start-position"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** Exercises whole-color authoring, reference preservation, and switching back to emitter lanes. */
test("Step FX Color lane authors two colors and preserves Blueprint references", async ({
  backendSlot,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();
  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().activePanel.api.maximize(),
  );
  await editor
    .getByRole("button", { name: "Add Color lane", exact: true })
    .click();
  await expect(
    editor.getByRole("tab", { name: "Color", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    editor.getByRole("img", { name: "Color cycle preview" }),
  ).toBeVisible();
  await editor.getByLabel("Edit step 1 color").click();
  await editor
    .getByRole("button", { name: "Choose #00FF00", exact: true })
    .click();
  await expect
    .poll(
      async () => (await storedStepFx(page))?.color_lane?.steps[0].target.green,
    )
    .toBe(1);
  await expect(editor.getByText("Hex #00FF00", { exact: true })).toBeVisible();
  await editor.getByLabel("Edit step 1 color").click();
  await editor.getByLabel("Color step 2 shape").selectOption("Snap");
  await expect
    .poll(
      async () => (await storedStepFx(page))?.color_lane?.steps[1].curve.type,
    )
    .toBe("Snap");
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (const data of [
      "fix 1",
      "red @ 100 green @ 25 blue @ 0",
      "store blueprint 88 filter color",
    ]) {
      const result = await stores.sendAndAwait({
        module: "DeskCommand",
        command: { type: "Eval", data },
      });
      if (result.outcome.type !== "Succeeded")
        throw new Error(JSON.stringify(result));
    }
  });
  const source = editor.getByLabel("Step 2 color source");
  await expect(source.locator("option")).toHaveCount(2);
  await source.selectOption({ index: 1 });
  await expect
    .poll(
      async () =>
        (await storedStepFx(page))?.color_lane?.steps[1].blueprint_uid,
    )
    .toBeTruthy();
  await expect(editor.getByText(/Live Blueprint reference/)).toBeVisible();
  await expect(editor.getByLabel("Edit step 2 color")).toHaveCount(0);
  const search = editor.getByRole("searchbox", { name: "Search attributes" });
  await search.fill("Red");
  await expect(
    editor.getByRole("menuitemcheckbox", { name: "Red", exact: true }),
  ).toHaveCount(0);
  await search.press("Escape");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-color-lane.png"),
    fullPage: true,
  });
  const stopPreview = editor.getByRole("button", { name: "Stop preview" });
  if (await stopPreview.isVisible()) await stopPreview.click();
  await page.reload();
  await expect(editor.locator("[data-step-fx-color-editor]")).toBeVisible();
  await expect(editor.getByText(/Live Blueprint reference/)).toBeVisible();
  await expect(source.locator("option:checked")).not.toContainText(
    "Unavailable",
  );
  await editor
    .getByRole("button", { name: "Remove Color lane", exact: true })
    .click();
  await search.fill("Red");
  await editor
    .getByRole("menuitemcheckbox", { name: "Red", exact: true })
    .click();
  await search.press("Escape");
  await expect(
    editor.getByRole("button", { name: "Add Color lane", exact: true }),
  ).toBeDisabled();
  await expect(editor.getByLabel("Step 1 value")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-independent-channel.png"),
    fullPage: true,
  });
  if (await stopPreview.isVisible()) await stopPreview.click();
});

/** Verifies the attribute catalog follows concrete fixture and group targets. */
test("Step FX attribute search is limited to target fixtures", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await addFixtureAttribute(page, 2, "Grouped Fixture Only");
  await addFixtureAttribute(page, 9, "Non-target Fixture Only");
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const attributeSearch = editor.getByRole("searchbox", {
    name: "Search attributes",
  });
  const attributeMenu = editor.getByRole("menu", { name: "Attributes" });
  await attributeSearch.focus();
  await expect(attributeMenu).toBeVisible();
  await expect(
    attributeMenu.getByRole("menuitemcheckbox", {
      name: "Grouped Fixture Only",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    attributeMenu.getByRole("menuitemcheckbox", {
      name: "Non-target Fixture Only",
      exact: true,
    }),
  ).toHaveCount(0);

  await attributeSearch.press("Escape");
  await setEditorSelection(page, editor, "Group 98");
  await attributeSearch.focus();
  await expect(
    attributeMenu.getByRole("menuitemcheckbox", {
      name: "Grouped Fixture Only",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    attributeMenu.getByRole("menuitemcheckbox", {
      name: "Non-target Fixture Only",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-target-attributes.png"),
    fullPage: true,
  });
});

/** Presses one platform-native editor shortcut with explicit modifier lifetime. */
async function pressEditorShortcut(page: Page, key: string): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

/** Starts and holds a pointer drag by a rendered pixel delta for transient assertions. */
async function holdPointerDragBy(
  page: Page,
  target: Locator,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("Waveform drag target is not visible");
  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 4 });
}

/** Verifies waveform geometry edits, sheet ownership highlights, and preview lockout. */
test("Step FX waveform geometry drag-edits authored fields", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const waveformPlot = editor.locator("[data-step-fx-waveform-plot]");
  const firstValueField = editor.locator("[data-step-fx-value-field]").first();
  const firstValueInput = editor.getByLabel("Step 1 value");
  const firstRampField = editor.locator("[data-step-fx-ramp-field]").first();
  const firstRampStartInput = editor.getByLabel("Step 1 ramp start");
  const firstRampEndInput = editor.getByLabel("Step 1 ramp end");
  const initialValue = Number(await firstValueInput.inputValue());
  await expect.poll(() => storedStepFx(page)).not.toBeUndefined();
  await expect.poll(() => stepFxPreviewStatus(page)).toBeTruthy();
  await expect(waveformPlot).toHaveAttribute(
    "data-drag-editing-disabled",
    "false",
  );

  const firstValuePoint = editor.getByRole("button", {
    name: "Adjust waveform control point for step 1",
  });
  await firstValuePoint.hover();
  await expect(firstValuePoint).toHaveCSS("cursor", "grab");
  await holdPointerDragBy(page, firstValuePoint, 0, 24);
  const dragLabel = editor.locator("[data-step-fx-waveform-drag-label]");
  await expect(dragLabel).toContainText("Step 1 ramp end:");
  await expect(dragLabel).toContainText("Value:");
  await expect(firstValueField).toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect(firstValueField).toHaveClass(/border-amber-300/);
  await expect(firstRampField).toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect(firstRampField).toHaveAttribute(
    "data-waveform-ramp-drag-point",
    "ramp-end",
  );
  await expect(firstRampField).toHaveClass(/ring-amber-300/);
  await expect
    .poll(async () => Number(await firstValueInput.inputValue()))
    .not.toBe(initialValue);
  expect(Number.isInteger(Number(await firstValueInput.inputValue()) * 2)).toBe(
    true,
  );
  await page.mouse.up();
  await expect(dragLabel).toHaveCount(0);
  await expect(firstValueField).not.toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect(firstRampField).not.toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );

  await holdPointerDragBy(page, firstValuePoint, 0, -1_000);
  await expect(firstValueInput).toHaveValue("100");
  await page.mouse.up();

  const rampStartPoint = editor.getByRole("button", {
    name: "Adjust waveform ramp start for step 1",
  });
  await rampStartPoint.hover();
  await expect(rampStartPoint).toHaveCSS("cursor", "ew-resize");
  const initialRampStart = Number(
    await firstRampStartInput.getAttribute("aria-valuenow"),
  );
  await holdPointerDragBy(page, rampStartPoint, 32, 0);
  await expect(firstRampField).toHaveAttribute(
    "data-waveform-ramp-drag-point",
    "ramp-start",
  );
  await expect(firstRampField).toHaveClass(/ring-amber-300/);
  await expect(firstValueField).not.toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect
    .poll(async () =>
      Number(await firstRampStartInput.getAttribute("aria-valuenow")),
    )
    .toBeGreaterThan(initialRampStart);
  await page.mouse.up();

  const initialRampEnd = Number(
    await firstRampEndInput.getAttribute("aria-valuenow"),
  );
  await holdPointerDragBy(page, firstValuePoint, -32, 0);
  await expect(firstRampField).toHaveAttribute(
    "data-waveform-ramp-drag-point",
    "ramp-end",
  );
  await expect(firstValueField).toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect
    .poll(async () =>
      Number(await firstRampEndInput.getAttribute("aria-valuenow")),
    )
    .toBeLessThan(initialRampEnd);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-control-point-drag.png"),
    fullPage: true,
  });
  await page.mouse.up();

  const firstWidth = editor.getByLabel("Step 1 width");
  const secondWidth = editor.getByLabel("Step 2 width");
  const initialWidthTotal =
    Number(await firstWidth.inputValue()) +
    Number(await secondWidth.inputValue());
  const boundary = editor.getByRole("button", {
    name: "Drag boundary between steps 1 and 2",
  });
  await boundary.hover();
  await expect(boundary).toHaveCSS("cursor", "ew-resize");
  await holdPointerDragBy(page, boundary, 48, 0);
  await expect(firstWidth).toHaveAttribute("data-waveform-drag-active", "true");
  await expect(secondWidth).toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect(firstWidth).toHaveClass(/border-amber-300/);
  await expect(secondWidth).toHaveClass(/border-amber-300/);
  await expect
    .poll(async () => Number(await firstWidth.inputValue()))
    .toBeGreaterThan(1);
  expect(
    Number(await firstWidth.inputValue()) +
      Number(await secondWidth.inputValue()),
  ).toBeCloseTo(initialWidthTotal, 3);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-boundary-drag-highlight.png"),
    fullPage: true,
  });
  await page.mouse.up();

  const shiftDragLeadingWidth = Number(await firstWidth.inputValue());
  const shiftDragTrailingWidth = Number(await secondWidth.inputValue());
  await page.keyboard.down("Shift");
  await holdPointerDragBy(page, boundary, -36, 0);
  await expect(firstWidth).toHaveAttribute("data-waveform-drag-active", "true");
  await expect(secondWidth).not.toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect(firstWidth).toHaveClass(/border-amber-300/);
  await expect(secondWidth).not.toHaveClass(/border-amber-300/);
  await expect
    .poll(async () => Number(await firstWidth.inputValue()))
    .toBeLessThan(shiftDragLeadingWidth);
  await expect(secondWidth).toHaveValue(shiftDragTrailingWidth.toString());
  expect(
    Number(await firstWidth.inputValue()) +
      Number(await secondWidth.inputValue()),
  ).not.toBeCloseTo(initialWidthTotal, 3);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-shift-boundary-drag.png"),
    fullPage: true,
  });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  const startPositionTrigger = editor.getByRole("button", {
    name: "Start position",
  });
  const startHandle = editor.getByRole("button", {
    name: "Move waveform start marker",
  });
  const plotBounds = await waveformPlot.boundingBox();
  if (!plotBounds) throw new Error("Waveform plot is not visible");
  const firstWidthBeforeStartDrag = Number(await firstWidth.inputValue());
  const secondWidthBeforeStartDrag = Number(await secondWidth.inputValue());
  const boundaryPosition =
    (firstWidthBeforeStartDrag /
      (firstWidthBeforeStartDrag + secondWidthBeforeStartDrag)) *
    100;
  const startPositionMenu = await openStepFxStartPositionControls(page, editor);
  await startPositionMenu
    .getByLabel("Start position value")
    .fill(boundaryPosition.toString());
  await startPositionTrigger.click();
  await expect(startPositionMenu).toBeHidden();
  await expect
    .poll(async () => (await storedStepFx(page))?.phase?.waypoints[0])
    .toBeCloseTo(boundaryPosition / 100, 3);

  const boundaryBounds = await boundary.boundingBox();
  if (!boundaryBounds) throw new Error("Step boundary is not visible");
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("[data-step-fx-waveform-start-handle]") !== null,
        {
          x: boundaryBounds.x + boundaryBounds.width / 2,
          y: boundaryBounds.y + boundaryBounds.height / 2,
        },
      ),
    )
    .toBe(true);

  await startHandle.hover();
  expect(
    await startHandle.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe("rgba(0, 0, 0, 0)");
  const spreadBeforeDrag = await storedStepFx(page);
  if (!spreadBeforeDrag) throw new Error("Step FX draft is not stored");
  await page.keyboard.down("Shift");
  await holdPointerDragBy(page, startHandle, plotBounds.width * 0.12, 0);
  await expect(dragLabel).toContainText("Spread:");
  await expect(
    startPositionTrigger.locator('[data-waveform-drag-active="true"]'),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const waypoints = (await storedStepFx(page))?.phase?.waypoints ?? [];
      return waypoints.at(-1) - waypoints[0];
    })
    .toBeGreaterThan(
      spreadBeforeDrag.phase.waypoints.at(-1) -
        spreadBeforeDrag.phase.waypoints[0],
    );
  expect((await storedStepFx(page)).phase.waypoints[0]).toBeCloseTo(
    spreadBeforeDrag.phase.waypoints[0],
    3,
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await holdPointerDragBy(page, startHandle, plotBounds.width * 0.24, 0);
  await expect(dragLabel).toContainText("Start:");
  await expect(
    startPositionTrigger.locator('[data-waveform-drag-active="true"]'),
  ).toBeVisible();
  await expect(
    startPositionTrigger.locator('[data-waveform-drag-active="true"]'),
  ).toHaveClass(/border-amber-300/);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-drag-highlight.png"),
    fullPage: true,
  });
  await page.mouse.up();
  await expect(startPositionTrigger).not.toContainText("Spread 0→100%");
  await expect
    .poll(async () => (await storedStepFx(page))?.phase?.waypoints[0])
    .toBeGreaterThan(0.15);

  await editor.getByRole("radio", { name: "Waveform" }).click();
  await expect(waveformPlot).toHaveAttribute(
    "data-drag-editing-disabled",
    "true",
  );
  await expect(firstValuePoint).toBeDisabled();
  await expect(rampStartPoint).toBeDisabled();
  const lockedValue = Number(await firstValueInput.inputValue());
  await holdPointerDragBy(page, firstValuePoint, 0, -24);
  await expect(waveformPlot).not.toHaveAttribute("data-dragging", "true");
  await page.mouse.up();
  await expect(firstValueInput).toHaveValue(lockedValue.toString());

  await editor.getByRole("button", { name: "Stop preview" }).click();
  await expect(waveformPlot).toHaveAttribute(
    "data-drag-editing-disabled",
    "false",
  );
  await expect(firstValuePoint).toBeEnabled();
  await expect(rampStartPoint).toBeEnabled();
});

/** Verifies paused waveform copies remain pointer-editable without duplicate tab stops. */
test("Step FX repeated waveform cycles drag-edit while paused", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const waveformPlot = editor.locator("[data-step-fx-waveform-plot]");
  await expect.poll(() => stepFxPreviewStatus(page)).toBeTruthy();
  await editor.getByRole("radio", { name: "Waveform" }).click();
  await expect(waveformPlot).toHaveAttribute("data-mode-transitioning", "true");
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );

  const previousCycle = waveformPlot.locator(
    '[data-step-fx-waveform-cycle="-1"]',
  );
  const repeatedRampEnd = previousCycle
    .locator('[data-control-point="ramp-end"]')
    .first();
  await expect(previousCycle).toHaveAttribute("aria-hidden", "true");
  await expect(repeatedRampEnd).toBeDisabled();

  await editor.getByRole("button", { name: "Stop preview" }).click();
  await expect(waveformPlot).toHaveAttribute(
    "data-drag-editing-disabled",
    "false",
  );
  await expect(repeatedRampEnd).toBeEnabled();
  await expect(repeatedRampEnd).toHaveAttribute("tabindex", "-1");
  await expect(repeatedRampEnd).not.toHaveAttribute("aria-label", /.+/);

  const firstValueField = editor.locator("[data-step-fx-value-field]").first();
  const firstValueInput = editor.getByLabel("Step 1 value");
  const firstRampField = editor.locator("[data-step-fx-ramp-field]").first();
  const firstRampEndInput = editor.getByLabel("Step 1 ramp end");
  const initialValue = Number(await firstValueInput.inputValue());
  const initialRampEnd = Number(
    await firstRampEndInput.getAttribute("aria-valuenow"),
  );
  await holdPointerDragBy(page, repeatedRampEnd, -20, 20);
  await expect(firstValueField).toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect(firstRampField).toHaveAttribute(
    "data-waveform-ramp-drag-point",
    "ramp-end",
  );
  await expect
    .poll(async () => Number(await firstValueInput.inputValue()))
    .toBeLessThan(initialValue);
  await expect
    .poll(async () =>
      Number(await firstRampEndInput.getAttribute("aria-valuenow")),
    )
    .toBeLessThan(initialRampEnd);
  await page.mouse.up();

  const repeatedRampStart = previousCycle
    .locator('[data-control-point="ramp-start"]')
    .nth(1);
  const secondValueField = editor.locator("[data-step-fx-value-field]").nth(1);
  const secondRampField = editor.locator("[data-step-fx-ramp-field]").nth(1);
  const secondRampStartInput = editor.getByLabel("Step 2 ramp start");
  const initialRampStart = Number(
    await secondRampStartInput.getAttribute("aria-valuenow"),
  );
  await holdPointerDragBy(page, repeatedRampStart, 20, 0);
  await expect(secondRampField).toHaveAttribute(
    "data-waveform-ramp-drag-point",
    "ramp-start",
  );
  await expect(secondValueField).not.toHaveAttribute(
    "data-waveform-drag-active",
    "true",
  );
  await expect
    .poll(async () =>
      Number(await secondRampStartInput.getAttribute("aria-valuenow")),
    )
    .toBeGreaterThan(initialRampStart);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-repeated-cycle-point-drag.png"),
    fullPage: true,
  });
  await page.mouse.up();
});

/** Verifies contribution and preview controls ease spatial presentation changes. */
test("Step FX animates contribution tracks, waveform modes, direction, and live steps", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const waveform = editor.locator("[data-step-fx-waveform]");
  const waveformPlot = waveform.locator("[data-step-fx-waveform-plot]");
  const selectedPlayhead = waveform.locator(
    '[data-step-fx-waveform-playhead][data-selected="true"]',
  );
  const fixtureScrollMode = editor.getByRole("radio", { name: "Fixture" });
  const waveformScrollMode = editor.getByRole("radio", { name: "Waveform" });
  const waveformCycles = waveformPlot.locator("[data-step-fx-waveform-cycle]");
  const cycleDelimiters = waveformPlot.locator(
    "[data-step-fx-waveform-cycle-delimiter]",
  );
  await expect(editor).toBeVisible();
  await expect.poll(() => stepFxPreviewStatus(page)).toBeTruthy();
  await expect(selectedPlayhead).toHaveCount(1);
  await expect(waveform).not.toContainText("Offset");
  await expect(
    editor.getByRole("columnheader", { name: "Ramp duration" }),
  ).toBeVisible();
  const sheetContainer = editor.locator("[data-step-fx-sheet-container]");
  const firstStepRow = editor.locator("[data-step-fx-sheet] tbody tr").first();
  const [
    valueInputBox,
    widthInputBox,
    transitionRangeBox,
    curveInputBox,
    valueInputAppearance,
    valueInputOverflowPx,
    sheetOverflowPx,
  ] = await Promise.all([
    editor.getByLabel("Step 1 value").boundingBox(),
    editor.getByLabel("Step 1 width").boundingBox(),
    firstStepRow.getByText("0–100%", { exact: true }).boundingBox(),
    editor.getByLabel("Step 1 curve").boundingBox(),
    editor
      .getByLabel("Step 1 value")
      .evaluate((element) => getComputedStyle(element).appearance),
    editor
      .getByLabel("Step 1 value")
      .evaluate((element) => element.scrollWidth - element.clientWidth),
    sheetContainer.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ]);
  if (!valueInputBox || !widthInputBox || !transitionRangeBox || !curveInputBox)
    throw new Error("Step FX value and width inputs are not visible");
  expect(valueInputBox.width).toBeGreaterThanOrEqual(60);
  expect(valueInputAppearance).toBe("none");
  expect(valueInputOverflowPx).toBeLessThanOrEqual(0);
  expect(widthInputBox.width).toBeGreaterThanOrEqual(60);
  await expect(editor.getByLabel("Step 1 value")).toHaveValue("100");
  await expect(
    editor.locator("[data-step-fx-value-field]").first(),
  ).toContainText("%");
  expect(transitionRangeBox.x + transitionRangeBox.width).toBeLessThanOrEqual(
    curveInputBox.x + 1,
  );
  expect(sheetOverflowPx).toBeLessThanOrEqual(1);
  const curveSelect = editor.getByLabel("Step 1 curve");
  await expect(curveSelect.locator("[data-step-fx-curve-icon]")).toHaveCount(1);
  await curveSelect.click();
  const curveMenu = page.locator('[data-menu-kind="step-fx-curve"]');
  await expect(curveMenu).toBeVisible();
  await expect(curveMenu.locator("[data-step-fx-curve-option]")).toHaveText([
    "Snap",
    "Linear",
    "Ease",
    "Ease In",
    "Ease Out",
  ]);
  await expect(curveMenu.locator("[data-step-fx-curve-icon]")).toHaveCount(5);
  const easeIconPaths = await curveMenu
    .locator('[data-step-fx-curve-option^="Ease"] path')
    .evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  expect(new Set(easeIconPaths).size).toBe(3);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-curve-menu.png"),
    fullPage: true,
  });
  await curveMenu.getByRole("button", { name: "Ease", exact: true }).click();
  await expect(curveSelect).toContainText("Ease");
  await expect(
    curveSelect.locator('[data-step-fx-curve-icon="Ease"]'),
  ).toHaveCount(1);
  await expect(
    waveform.locator("[data-step-fx-waveform-path]").first(),
  ).toHaveAttribute("d", /C /);
  const contributionStage = editor.locator("[data-step-fx-contribution-stage]");
  const contributionPanel = contributionStage.locator(
    "[data-step-fx-contribution-panel]",
  );
  const stepActionToolbar = contributionStage.locator(
    ":scope > [data-step-fx-step-actions-toolbar]",
  );
  const contributionTabs = editor.getByRole("tablist", {
    name: "Intensity contribution",
  });
  const absoluteTab = contributionTabs.getByRole("tab", {
    name: "Absolute",
    exact: false,
  });
  const relativeTab = contributionTabs.getByRole("tab", {
    name: "Relative",
    exact: false,
  });
  await expect(stepActionToolbar).toHaveCount(1);
  await expect(
    contributionPanel.locator("[data-step-fx-step-actions-toolbar]"),
  ).toHaveCount(0);
  const toolbarBeforeSlide = await stepActionToolbar.boundingBox();
  if (!toolbarBeforeSlide)
    throw new Error("Step FX action toolbar is not visible");

  await relativeTab.click();
  await expect(relativeTab).toHaveAttribute("aria-selected", "true");
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-direction",
    "right",
  );
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "outgoing",
  );
  const toolbarDuringSlide = await stepActionToolbar.boundingBox();
  if (!toolbarDuringSlide)
    throw new Error("Step FX action toolbar disappeared during track switch");
  expect(Math.abs(toolbarDuringSlide.x - toolbarBeforeSlide.x)).toBeLessThan(1);
  expect(Math.abs(toolbarDuringSlide.y - toolbarBeforeSlide.y)).toBeLessThan(1);
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "incoming",
  );
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "idle",
  );
  await expect(contributionPanel).toHaveAttribute(
    "data-track-kind",
    "relative",
  );
  await expect(editor.getByText("No relative steps.")).toBeVisible();
  await editor.getByRole("button", { name: "Add relative step" }).click();
  await editor.getByRole("button", { name: "Toggle selection mode" }).click();
  await editor
    .getByRole("checkbox", { name: "Select step 1", exact: true })
    .check();
  await editor
    .getByRole("button", { name: "Duplicate selected steps" })
    .click();
  await expect(editor.locator("[data-step-fx-sheet] tbody tr")).toHaveCount(3);

  await absoluteTab.click();
  await expect(absoluteTab).toHaveAttribute("aria-selected", "true");
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-direction",
    "left",
  );
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "outgoing",
  );
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "idle",
  );
  await expect(contributionPanel).toHaveAttribute(
    "data-track-kind",
    "absolute",
  );
  await relativeTab.click();
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "idle",
  );
  await expect(
    editor.getByRole("button", { name: "Move selected steps up" }),
  ).toBeEnabled();
  await absoluteTab.click();
  await expect(contributionStage).toHaveAttribute(
    "data-contribution-slide-phase",
    "idle",
  );
  await expect(selectedPlayhead).toHaveCount(1);
  const liveTableRow = editor.locator(
    '[data-step-fx-step-row][data-live="true"]',
  );
  await expect(liveTableRow).toHaveCount(1);
  const liveRowTransition = await liveTableRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      durationSeconds: Math.max(
        ...style.transitionDuration
          .split(",")
          .map((duration) => Number.parseFloat(duration)),
      ),
      properties: style.transitionProperty
        .split(",")
        .map((value) => value.trim()),
    };
  });
  expect(liveRowTransition.properties).toContain("box-shadow");
  expect(liveRowTransition.durationSeconds).toBeGreaterThan(0);
  const initialLiveStepIndex =
    await liveTableRow.getAttribute("data-step-index");
  await expect
    .poll(() => liveTableRow.getAttribute("data-step-index"))
    .not.toBe(initialLiveStepIndex);
  await expect(fixtureScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformScrollMode).toHaveAttribute("aria-checked", "false");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "fixtures");
  await expect(waveformCycles).toHaveCount(1);
  await expect(cycleDelimiters).toHaveCount(0);

  await waveformScrollMode.click();
  await expect(waveformScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "waveform");
  await expect(waveformPlot).toHaveAttribute("data-mode-transitioning", "true");
  await expect(waveformCycles).toHaveCount(3);
  await expect(cycleDelimiters).toHaveCount(3);
  await expect(cycleDelimiters.first()).toHaveClass(/text-red-500/);
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );

  const primaryWaveformCycle = waveformPlot.locator(
    '[data-step-fx-waveform-cycle="0"]',
  );
  const initialTransform = await primaryWaveformCycle.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(() =>
      primaryWaveformCycle.evaluate(
        (element) => getComputedStyle(element).transform,
      ),
    )
    .not.toBe(initialTransform);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-centered-waveform-animation.png"),
    fullPage: true,
  });

  await fixtureScrollMode.click();
  await expect(fixtureScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "fixtures");
  await expect(waveformPlot).toHaveAttribute("data-mode-transitioning", "true");
  await expect(waveformCycles).toHaveCount(3);
  await expect(cycleDelimiters).toHaveCount(0);
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );

  const startPositionMenu = await openStepFxStartPositionControls(page, editor);
  await startPositionMenu
    .getByLabel("Start position value", { exact: true })
    .fill("25");
  await editor.getByRole("button", { name: "Start position" }).click();
  await expect(startPositionMenu).toHaveCount(0);
  const phaseMarker = waveform.locator("[data-step-fx-waveform-phase-marker]");
  await expect(phaseMarker).toHaveCount(1);
  const forwardStartPositionX = Number(await phaseMarker.getAttribute("x1"));

  const directionGroup = editor.getByRole("radiogroup", {
    name: "Step FX direction",
  });
  const reverseDirection = directionGroup.getByRole("radio", {
    name: "Reverse direction",
  });
  await reverseDirection.click();
  await expect(reverseDirection).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute(
    "data-direction-transitioning",
    "true",
  );
  await expect(selectedPlayhead).toHaveCount(1);
  await expect(liveTableRow).toHaveCount(1);
  await expect(waveformPlot).toHaveAttribute(
    "data-direction-transitioning",
    "false",
  );
  await expect
    .poll(() => stepFxPlayheadError(page, 0.25, { direction: "Reverse" }))
    .toBeLessThan(60);
  expect(Number(await phaseMarker.getAttribute("x1"))).toBeGreaterThan(
    forwardStartPositionX,
  );

  const dividerLabels = waveform.locator(
    "[data-step-fx-waveform-divider-label]",
  );
  await expect(dividerLabels).toHaveCount(2);
  const firstWidth = editor.getByLabel("Step 1 width");
  await firstWidth.fill("3");
  await firstWidth.press("Tab");
  await expect(dividerLabels.nth(1)).toHaveText("25%");
  const reversePositionMenu = await openStepFxStartPositionControls(
    page,
    editor,
  );
  await reversePositionMenu.getByRole("radio", { name: "Degrees" }).click();
  await expect(dividerLabels.nth(1)).toHaveText("90°");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-reverse-divider-labels.png"),
    fullPage: true,
  });
  await reversePositionMenu.getByRole("radio", { name: "Percent" }).click();
  await editor.getByRole("button", { name: "Start position" }).click();
  await expect(reversePositionMenu).toHaveCount(0);
  await firstWidth.fill("1");
  await firstWidth.press("Tab");
  await expect(dividerLabels.nth(1)).toHaveText("50%");

  const bounceDirection = directionGroup.getByRole("radio", {
    name: "Bounce direction",
  });
  await bounceDirection.click();
  await expect(bounceDirection).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute(
    "data-direction-transitioning",
    "true",
  );
  await expect(waveformPlot).toHaveAttribute(
    "data-direction-transitioning",
    "false",
  );
  await expect
    .poll(() =>
      stepFxPlayheadError(page, 0.25, {
        direction: "Bounce",
        cycleBeats: 4,
      }),
    )
    .toBeLessThan(60);
  expect(Number(await phaseMarker.getAttribute("x1"))).toBeCloseTo(
    forwardStartPositionX,
  );
  await waveformScrollMode.click();
  await expect(waveformScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "waveform");
  await expect(waveformCycles).toHaveCount(1);
  await expect(cycleDelimiters).toHaveCount(0);
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );
  await page.screenshot({
    path: testInfo.outputPath("step-fx-bounce-start-position.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Stop preview" }).click();
});

/** Verifies Waveform mode centers the active fixture inside fixed graph gutters. */
test("Step FX waveform scrolling centers within the graph viewport", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const waveformPlot = editor.locator("[data-step-fx-waveform-plot]");
  const selectedPlayhead = waveformPlot.locator(
    '[data-step-fx-waveform-live-value][data-selected="true"]',
  );
  const leftGutter = waveformPlot.locator(
    '[data-step-fx-waveform-gutter="left"]',
  );
  const rightGutter = waveformPlot.locator(
    '[data-step-fx-waveform-gutter="right"]',
  );
  await editor.getByRole("button", { name: "Stop preview" }).click();
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "fixtures");
  const fixtureLeftGutterBounds = await leftGutter.boundingBox();
  const fixtureRightGutterBounds = await rightGutter.boundingBox();
  if (!fixtureLeftGutterBounds || !fixtureRightGutterBounds)
    throw new Error("Fixture-mode waveform gutters are not visible");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-fixture-scroll-viewport.png"),
    fullPage: true,
  });

  await editor.getByRole("radio", { name: "Waveform" }).click();
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "waveform");
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );
  await expect(selectedPlayhead).toHaveCount(1);
  const waveformLeftGutterBounds = await leftGutter.boundingBox();
  const waveformRightGutterBounds = await rightGutter.boundingBox();
  const selectedPlayheadBounds = await selectedPlayhead.boundingBox();
  if (
    !waveformLeftGutterBounds ||
    !waveformRightGutterBounds ||
    !selectedPlayheadBounds
  )
    throw new Error("Waveform-mode viewport geometry is not visible");
  expect(waveformLeftGutterBounds).toEqual(fixtureLeftGutterBounds);
  expect(waveformRightGutterBounds).toEqual(fixtureRightGutterBounds);
  const graphCenter =
    (waveformLeftGutterBounds.x +
      waveformLeftGutterBounds.width +
      waveformRightGutterBounds.x) /
    2;
  expect(
    Math.abs(
      selectedPlayheadBounds.x + selectedPlayheadBounds.width / 2 - graphCenter,
    ),
  ).toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-scroll-viewport.png"),
    fullPage: true,
  });
});

/** Verifies destructive keys remove step selections without hijacking field editing. */
test("Step FX Delete and Backspace remove selected steps", async ({
  backendSlot,
  page,
}) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const rows = editor.locator("[data-step-fx-sheet] tbody tr");
  await editor.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(rows).toHaveCount(3);

  const firstSegment = editor.getByRole("button", {
    name: "Select step 1 from waveform",
  });
  const secondSegment = editor.getByRole("button", {
    name: "Select step 2 from waveform",
  });
  await firstSegment.click();
  await secondSegment.click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  await secondSegment.press("Delete");
  await expect(rows).toHaveCount(1);

  await editor.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(rows).toHaveCount(2);
  const widthInput = editor.getByLabel("Step 1 width");
  await widthInput.focus();
  await widthInput.press("Backspace");
  await expect(rows).toHaveCount(2);

  const remainingFirstSegment = editor.getByRole("button", {
    name: "Select step 1 from waveform",
  });
  await remainingFirstSegment.click();
  await page.keyboard.press("Backspace");
  await expect(rows).toHaveCount(1);
  const stopPreview = editor.getByRole("button", { name: "Stop preview" });
  if (await stopPreview.isVisible()) await stopPreview.click();
});

/** Verifies copied multi-row blocks are pasted after the complete selection. */
test("Step FX paste follows the last selected row", async ({
  backendSlot,
  page,
}, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  const rows = editor.locator("[data-step-fx-sheet] tbody tr");
  await editor.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(rows).toHaveCount(3);
  for (const [index, value] of ["10", "20", "30"].entries()) {
    const input = editor.getByLabel(`Step ${index + 1} value`);
    await input.fill(value);
    await input.press("Tab");
  }

  await editor.getByRole("button", { name: "Toggle selection mode" }).click();
  await editor.getByRole("checkbox", { name: "Select step 1" }).check();
  await editor.getByRole("checkbox", { name: "Select step 2" }).check();
  await editor.getByRole("button", { name: "Stop preview" }).focus();
  await pressEditorShortcut(page, "c");
  await pressEditorShortcut(page, "v");

  await expect(rows).toHaveCount(5);
  await expect
    .poll(() =>
      rows
        .getByLabel(/Step \d+ value/)
        .evaluateAll((inputs) =>
          inputs.map((input) => (input as HTMLInputElement).value),
        ),
    )
    .toEqual(["10", "20", "10", "20", "30"]);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-multi-row-paste.png"),
    fullPage: true,
  });
  const stopPreview = editor.getByRole("button", { name: "Stop preview" });
  if (await stopPreview.isVisible()) await stopPreview.click();
});

/** Exercises creation, sheet edits, preview, autosave, close guard, reopen, and deletion. */
test("Step FX sheet editor completes the first-release authoring workflow", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openStepFxEditorApp(page, backendSlot.backendPort);

  const fxTab = page.getByRole("tab", { name: "Fx" });
  await expect(fxTab).toBeVisible();
  await fxTab.click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  const attributeSearch = editor.getByRole("searchbox", {
    name: "Search attributes",
  });
  const laneList = editor.getByRole("tablist", {
    name: "Step FX attributes",
  });
  await expect(attributeSearch).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Add attribute" }),
  ).toHaveCount(0);
  await expect(laneList).toBeVisible();
  await expect(editor.locator('button[title="Remove Intensity"]')).toHaveCount(
    0,
  );
  const attributeSearchBox = await attributeSearch.boundingBox();
  const laneListBox = await laneList.boundingBox();
  if (!attributeSearchBox || !laneListBox)
    throw new Error("Step FX attribute controls are not visible");
  expect(attributeSearchBox.y + attributeSearchBox.height).toBeLessThan(
    laneListBox.y,
  );
  await attributeSearch.focus();
  const attributeMenu = editor.getByRole("menu", { name: "Attributes" });
  await expect(attributeMenu).toBeVisible();
  const expandedLaneListBox = await laneList.boundingBox();
  if (!expandedLaneListBox)
    throw new Error("Expanded Step FX attribute list is not visible");
  expect(Math.abs(expandedLaneListBox.y - laneListBox.y)).toBeLessThan(2);
  const intensityMenuItem = attributeMenu.getByRole("menuitemcheckbox", {
    name: "Intensity",
  });
  const blueMenuItem = attributeMenu.getByRole("menuitemcheckbox", {
    name: "Blue",
  });
  const attributeMenuLabels = await attributeMenu
    .getByRole("menuitemcheckbox")
    .allTextContents();
  expect(attributeMenuLabels).toEqual(
    [...attributeMenuLabels].sort((left, right) => left.localeCompare(right)),
  );
  await expect(intensityMenuItem).toHaveAttribute("aria-checked", "true");
  await expect(blueMenuItem).toHaveAttribute("aria-checked", "false");
  await blueMenuItem.click();
  await expect(blueMenuItem).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => attributeMenu.getByRole("menuitemcheckbox").allTextContents())
    .toEqual(attributeMenuLabels);
  await expect(laneList.getByRole("tab", { name: "Blue" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-attribute-picker.png"),
    fullPage: true,
  });
  await blueMenuItem.click();
  await expect(laneList.getByRole("tab", { name: "Blue" })).toHaveCount(0);
  await attributeSearch.press("Escape");
  await expect(attributeMenu).toBeHidden();
  const editorToolbar = editor.locator('[data-component="PanelToolbar"]');
  await expect(editorToolbar).toHaveCount(1);
  await expect(
    editorToolbar
      .locator('[data-slot="right"]')
      .getByRole("button", { name: "Stop preview" }),
  ).toBeVisible();
  const toolbarLeft = editorToolbar.locator('[data-slot="left"]');
  const actionToolbar = editor.getByRole("toolbar", {
    name: "Step edit actions",
  });
  const stepToolbar = editor.getByRole("toolbar", { name: "Step bar" });
  await expect(
    toolbarLeft.getByRole("tablist", { name: "Intensity contribution" }),
  ).toHaveCount(0);
  await expect(
    actionToolbar.getByRole("tablist", { name: "Intensity contribution" }),
  ).toBeVisible();
  await expect(
    stepToolbar.getByRole("tablist", { name: "Intensity contribution" }),
  ).toHaveCount(0);
  await expect(
    toolbarLeft.getByRole("button", { name: "Overrides" }),
  ).toHaveCount(0);
  const overridesButton = actionToolbar.getByRole("button", {
    name: "Overrides",
  });
  await expect(overridesButton).toBeVisible();
  await expect(
    toolbarLeft.getByRole("button", { name: "Speed and scaling" }),
  ).toContainText("120 BPM · Auto");
  const startPositionButton = toolbarLeft.getByRole("button", {
    name: "Start position",
  });
  await expect(startPositionButton).toContainText("Spread 0→100%");
  const directionGroup = toolbarLeft.getByRole("radiogroup", {
    name: "Step FX direction",
  });
  const directionBox = await directionGroup.boundingBox();
  const speedBox = await toolbarLeft
    .getByRole("button", { name: "Speed and scaling" })
    .boundingBox();
  const startSeparatorBox = await toolbarLeft
    .locator("[data-step-fx-start-position-separator]")
    .boundingBox();
  const startPositionBox = await startPositionButton.boundingBox();
  if (!directionBox || !speedBox || !startSeparatorBox || !startPositionBox)
    throw new Error("Step FX global toolbar controls are not visible");
  expect(directionBox.x).toBeLessThan(speedBox.x);
  expect(speedBox.x + speedBox.width).toBeLessThan(startSeparatorBox.x);
  expect(startSeparatorBox.x + startSeparatorBox.width).toBeLessThan(
    startPositionBox.x,
  );
  const directionToSpeedGap =
    speedBox.x - (directionBox.x + directionBox.width);
  const speedToSeparatorGap =
    startSeparatorBox.x - (speedBox.x + speedBox.width);
  const separatorToStartGap =
    startPositionBox.x - (startSeparatorBox.x + startSeparatorBox.width);
  expect(Math.abs(directionToSpeedGap - speedToSeparatorGap)).toBeLessThan(1);
  expect(Math.abs(directionToSpeedGap - separatorToStartGap)).toBeLessThan(1);
  const actionToolbarBox = await actionToolbar.boundingBox();
  const actionButtons = [
    actionToolbar.getByRole("button", { name: "Add step", exact: true }),
    actionToolbar.getByRole("button", { name: "Move selected steps up" }),
    actionToolbar.getByRole("button", { name: "Move selected steps down" }),
    actionToolbar.getByRole("button", { name: "Duplicate selected steps" }),
    actionToolbar.getByRole("button", { name: "Divide step widths evenly" }),
    actionToolbar.getByRole("button", { name: "Delete selected steps" }),
    actionToolbar.getByRole("button", { name: "Toggle selection mode" }),
  ];
  const actionButtonBoxes = await Promise.all(
    actionButtons.map((button) => button.boundingBox()),
  );
  if (!actionToolbarBox || actionButtonBoxes.some((box) => !box))
    throw new Error("Step FX edit actions are not visible");
  expect(
    Math.abs(actionButtonBoxes[0]!.x - (actionToolbarBox.x + 8)),
  ).toBeLessThan(2);
  for (let index = 1; index < actionButtonBoxes.length; index += 1) {
    expect(actionButtonBoxes[index - 1]!.x).toBeLessThan(
      actionButtonBoxes[index]!.x,
    );
  }
  const selectionModeSeparatorBox = await actionToolbar
    .locator("[data-step-fx-selection-mode-separator]")
    .boundingBox();
  if (!selectionModeSeparatorBox)
    throw new Error("Step FX selection-mode separator is not visible");
  expect(actionButtonBoxes[5]!.x + actionButtonBoxes[5]!.width).toBeLessThan(
    selectionModeSeparatorBox.x,
  );
  expect(
    selectionModeSeparatorBox.x + selectionModeSeparatorBox.width,
  ).toBeLessThan(actionButtonBoxes[6]!.x);
  const contributionTabs = actionToolbar.getByRole("tablist", {
    name: "Intensity contribution",
  });
  const firstStepSelector = stepToolbar.locator(
    '[data-step-fx-step-selector][data-step-index="0"]',
  );
  const contributionTabsBox = await contributionTabs.boundingBox();
  const firstStepSelectorBox = await firstStepSelector.boundingBox();
  const overridesSeparatorBox = await actionToolbar
    .locator("[data-step-fx-overrides-separator]")
    .boundingBox();
  const overridesBox = await overridesButton.boundingBox();
  if (
    !contributionTabsBox ||
    !firstStepSelectorBox ||
    !overridesSeparatorBox ||
    !overridesBox
  )
    throw new Error("Step FX table navigation controls are not visible");
  expect(actionButtonBoxes[actionButtonBoxes.length - 1]!.x).toBeLessThan(
    contributionTabsBox.x,
  );
  expect(contributionTabsBox.x + contributionTabsBox.width).toBeLessThan(
    overridesSeparatorBox.x,
  );
  expect(overridesSeparatorBox.x + overridesSeparatorBox.width).toBeLessThan(
    overridesBox.x,
  );
  expect(
    Math.abs(firstStepSelectorBox.x - (actionToolbarBox.x + 8)),
  ).toBeLessThan(2);
  await expect(stepToolbar).not.toContainText("Steps");
  await expect(
    stepToolbar.getByRole("button", { name: "Previous steps" }),
  ).toHaveCount(0);
  await expect(
    stepToolbar.getByRole("button", { name: "Next steps" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      stepToolbar
        .locator('[data-step-fx-step-selector][data-live="true"]')
        .evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .toContain("inset");
  const directionRadios = directionGroup.getByRole("radio");
  expect(
    await directionRadios.evaluateAll((radios) =>
      radios.map((radio) => radio.getAttribute("aria-label")),
    ),
  ).toEqual(["Reverse direction", "Bounce direction", "Forward direction"]);
  await expect(
    directionGroup.getByRole("radio", { name: "Forward direction" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    directionGroup.getByRole("radio", { name: "Reverse direction" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(editor.getByLabel("Fixtures")).toHaveCount(0);
  await expect(editor.locator("[data-step-fx-general-settings]")).toHaveCount(
    0,
  );
  await expect(editorToolbar).not.toContainText(
    /Autosave pending|Saving|Saved|Stored/,
  );
  await expect(editor.getByText("Step FX 1", { exact: true })).toHaveCount(0);
  await expect(editor.getByLabel("Step FX label")).toHaveCount(0);
  const splitter = editor.locator('[data-component="VerticalLayoutSplitter"]');
  const tablePane = splitter.locator('[data-slot="top"]');
  const waveformPane = splitter.locator('[data-slot="bottom"]');
  const splitterHandle = editor.getByRole("separator", {
    name: "Resize Step FX table and waveform",
  });
  await expect(splitterHandle).toHaveClass(/hs-layout-splitter-control/);
  await expect(splitterHandle).toHaveAttribute("aria-valuemin", "0");
  await expect(splitterHandle).toHaveAttribute("aria-valuemax", "100");
  const initialTableHeight = await tablePane.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const handleBox = await splitterHandle.boundingBox();
  if (!handleBox) throw new Error("Step FX layout splitter is not visible");
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y - initialTableHeight,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      tablePane.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeLessThan(initialTableHeight - 16);
  const compressedTableBox = await tablePane.boundingBox();
  const compressedToolbarBox = await stepToolbar.boundingBox();
  if (!compressedTableBox || !compressedToolbarBox)
    throw new Error("Compressed Step FX table navigation is not visible");
  expect(compressedTableBox.height).toBeGreaterThanOrEqual(47);
  expect(compressedToolbarBox.y).toBeGreaterThanOrEqual(compressedTableBox.y);
  expect(
    Math.abs(
      compressedToolbarBox.y +
        compressedToolbarBox.height -
        (compressedTableBox.y + compressedTableBox.height),
    ),
  ).toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-compressed-table-toolbar.png"),
    fullPage: true,
  });
  const compressedHandleBox = await splitterHandle.boundingBox();
  if (!compressedHandleBox)
    throw new Error("Compressed Step FX layout splitter is not visible");
  await page.mouse.move(
    compressedHandleBox.x + compressedHandleBox.width / 2,
    compressedHandleBox.y + compressedHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    compressedHandleBox.x + compressedHandleBox.width / 2,
    handleBox.y + handleBox.height / 2 + 32,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      tablePane.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(initialTableHeight + 16);
  await expect(
    waveformPane.getByRole("group", {
      name: "Step ramp waveform",
    }),
  ).toBeVisible();
  const timingMenu = await openStepFxTimingControls(page, editor);
  await expect(
    timingMenu.getByLabel("Step FX speed", { exact: true }),
  ).toHaveValue("120");
  await expect(
    timingMenu
      .locator('[data-input-group="speed"]')
      .getByLabel("Step FX speed unit"),
  ).toHaveValue("BPM");
  const cycleScaleGroup = timingMenu.locator(
    '[data-input-group="cycle-scale"]',
  );
  await expect(
    cycleScaleGroup.getByLabel("Automatic cycle scaling"),
  ).toBeChecked();
  await expect(
    cycleScaleGroup.getByLabel("Fixed cycle scaling"),
  ).not.toBeChecked();
  await expect(timingMenu.getByLabel("Step FX cycle beats")).toBeDisabled();
  await expect(timingMenu.getByLabel("Step FX cycle beats")).toHaveValue("2");
  const fixedScaleInput = timingMenu.getByLabel("Step FX cycle beats");
  await cycleScaleGroup.getByLabel("Fixed cycle scaling").check();
  await fixedScaleInput.fill("8");
  await expect(
    editor.getByRole("button", { name: "Speed and scaling" }),
  ).toContainText("120 BPM · Fixed");
  await cycleScaleGroup.getByLabel("Automatic cycle scaling").check();
  await expect(fixedScaleInput).toBeDisabled();
  await expect(fixedScaleInput).toHaveValue("2");
  await cycleScaleGroup.getByLabel("Fixed cycle scaling").check();
  await expect(fixedScaleInput).toBeEnabled();
  await expect(fixedScaleInput).toHaveValue("8");
  await cycleScaleGroup.getByLabel("Automatic cycle scaling").check();
  await expect(
    editor.getByRole("button", { name: "Speed and scaling" }),
  ).toContainText("120 BPM · Auto");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-timing-auto-mode.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Speed and scaling" }).click();
  await expect(timingMenu).toBeHidden();
  await expect(editor.locator("[data-step-fx-sheet] tbody tr")).toHaveCount(2);
  await expect(
    editor.getByRole("button", { name: "Insert", exact: true }),
  ).toHaveCount(0);
  const addStepButton = editor.getByRole("button", {
    name: "Add step",
    exact: true,
  });
  await expect(addStepButton).toBeVisible();
  await expect(addStepButton).toHaveAttribute(
    "data-component",
    "ToolbarButton",
  );
  await expect(addStepButton.locator("svg")).toHaveCount(1);
  await expect(addStepButton).toHaveText("");
  await expect(
    editor.getByRole("button", { name: "Select all", exact: true }),
  ).toHaveCount(0);
  const selectionModeToggle = editor.getByRole("button", {
    name: "Toggle selection mode",
  });
  await expect(selectionModeToggle).toHaveAttribute("aria-pressed", "false");
  await expect(
    editor.getByRole("checkbox", {
      name: "Select step 1",
      exact: true,
    }),
  ).toHaveCount(0);
  await selectionModeToggle.click();
  await expect(selectionModeToggle).toHaveAttribute("aria-pressed", "true");
  const selectStepOne = editor.getByRole("checkbox", {
    name: "Select step 1",
    exact: true,
  });
  await expect(selectStepOne).not.toBeChecked();
  await expect(
    editor.getByRole("button", {
      name: "Duplicate selected steps",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", {
      name: "Delete selected steps",
      exact: true,
    }),
  ).toBeDisabled();
  for (const actionName of [
    "Move selected steps up",
    "Move selected steps down",
    "Duplicate selected steps",
    "Divide step widths evenly",
    "Delete selected steps",
  ]) {
    const action = actionToolbar.getByRole("button", {
      name: actionName,
      exact: true,
    });
    await expect(action).toHaveAttribute("data-component", "ToolbarButton");
    await expect(action.locator("svg")).toHaveCount(1);
    await expect(action).toHaveText("");
  }
  const firstDistributedWidth = editor.getByLabel("Step 1 width");
  const secondDistributedWidth = editor.getByLabel("Step 2 width");
  await firstDistributedWidth.fill("0.5");
  await firstDistributedWidth.press("Tab");
  await secondDistributedWidth.fill("1.5");
  await secondDistributedWidth.press("Tab");
  await actionToolbar
    .getByRole("button", { name: "Divide step widths evenly" })
    .click();
  await expect(firstDistributedWidth).toHaveValue("1");
  await expect(secondDistributedWidth).toHaveValue("1");
  await selectStepOne.check();
  await selectStepOne.uncheck();
  await expect(selectStepOne).not.toBeChecked();
  await expect(
    editor.locator('[data-step-fx-sheet] input[type="checkbox"]:checked'),
  ).toHaveCount(0);
  await selectStepOne.check();
  const waveform = editor.getByRole("group", {
    name: "Step ramp waveform",
  });
  await expect(stepToolbar).toBeVisible();
  await expect(actionToolbar).toBeVisible();
  await expect(waveform).toBeVisible();
  await expect(
    actionToolbar.getByRole("button", { name: "Move selected steps up" }),
  ).toBeEnabled();
  await expect(
    actionToolbar.getByRole("button", { name: "Move selected steps down" }),
  ).toBeEnabled();
  await expect(
    actionToolbar.getByRole("button", {
      name: "Duplicate selected steps",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    actionToolbar.getByRole("button", {
      name: "Delete selected steps",
      exact: true,
    }),
  ).toBeEnabled();
  const tableNavigationBox = await stepToolbar.boundingBox();
  const stepActionsBox = await actionToolbar.boundingBox();
  const sheetContainerBox = await editor
    .locator("[data-step-fx-sheet-container]")
    .boundingBox();
  const waveformBox = await waveform.boundingBox();
  if (
    !tableNavigationBox ||
    !stepActionsBox ||
    !sheetContainerBox ||
    !waveformBox
  )
    throw new Error("Step FX authoring surfaces are not visible");
  expect(
    Math.abs(stepActionsBox.y + stepActionsBox.height - sheetContainerBox.y),
  ).toBeLessThan(2);
  expect(tableNavigationBox.y).toBeGreaterThan(sheetContainerBox.y);
  expect(
    Math.abs(
      tableNavigationBox.y +
        tableNavigationBox.height -
        (sheetContainerBox.y + sheetContainerBox.height),
    ),
  ).toBeLessThan(2);
  expect(sheetContainerBox.y + sheetContainerBox.height).toBeLessThan(
    waveformBox.y,
  );
  const splitterHandleBox = await splitterHandle.boundingBox();
  if (!splitterHandleBox)
    throw new Error("Step FX table/waveform splitter is not visible");
  expect(splitterHandleBox.y).toBeGreaterThanOrEqual(
    sheetContainerBox.y + sheetContainerBox.height,
  );
  expect(splitterHandleBox.y + splitterHandleBox.height).toBeLessThanOrEqual(
    waveformBox.y,
  );
  await expect(
    waveform.getByRole("button", { name: "Stop preview" }),
  ).toHaveCount(0);
  await expect(
    waveform.getByRole("group", { name: "Waveform preview" }),
  ).toBeVisible();
  await expect(waveform).not.toContainText(/beat cycle|Live · index|Forward/);
  const waveformSegments = waveform.locator("[data-step-fx-waveform-segment]");
  const graphBounds = waveform.locator("[data-step-fx-waveform-graph-bounds]");
  const scaleMaximumLabel = waveform.locator(
    "[data-step-fx-waveform-scale-max]",
  );
  const scaleMinimumLabel = waveform.locator(
    "[data-step-fx-waveform-scale-min]",
  );
  await expect(waveformSegments).toHaveCount(2);
  await expect(graphBounds).toHaveCount(1);
  await expect(scaleMaximumLabel).toHaveText("100");
  await expect(scaleMinimumLabel).toHaveText("0");
  const waveformPlotArea = waveform.locator("[data-step-fx-waveform-plot]");
  const [
    waveformPlotAreaBox,
    graphBoundsBox,
    firstSegmentBox,
    lastSegmentBox,
    scaleMaximumLabelBox,
    scaleMinimumLabelBox,
  ] = await Promise.all([
    waveformPlotArea.boundingBox(),
    graphBounds.boundingBox(),
    waveformSegments.nth(0).boundingBox(),
    waveformSegments.nth(1).boundingBox(),
    scaleMaximumLabel.boundingBox(),
    scaleMinimumLabel.boundingBox(),
  ]);
  if (
    !waveformPlotAreaBox ||
    !graphBoundsBox ||
    !firstSegmentBox ||
    !lastSegmentBox ||
    !scaleMaximumLabelBox ||
    !scaleMinimumLabelBox
  ) {
    throw new Error("Inset waveform geometry is not visible");
  }
  const graphViewBoxX = Number(await graphBounds.getAttribute("x"));
  const graphViewBoxWidth = Number(await graphBounds.getAttribute("width"));
  expect(graphBoundsBox.x).toBeGreaterThan(waveformPlotAreaBox.x);
  expect(graphBoundsBox.x + graphBoundsBox.width).toBeLessThan(
    waveformPlotAreaBox.x + waveformPlotAreaBox.width,
  );
  expect(Math.abs(firstSegmentBox.y - graphBoundsBox.y)).toBeLessThan(2);
  expect(Math.abs(firstSegmentBox.height - graphBoundsBox.height)).toBeLessThan(
    2,
  );
  expect(Math.abs(firstSegmentBox.x - graphBoundsBox.x)).toBeLessThan(2);
  expect(
    Math.abs(
      lastSegmentBox.x +
        lastSegmentBox.width -
        (graphBoundsBox.x + graphBoundsBox.width),
    ),
  ).toBeLessThan(2);
  expect(
    scaleMaximumLabelBox.x + scaleMaximumLabelBox.width,
  ).toBeLessThanOrEqual(graphBoundsBox.x);
  expect(
    Math.abs(
      scaleMaximumLabelBox.y +
        scaleMaximumLabelBox.height / 2 -
        graphBoundsBox.y,
    ),
  ).toBeLessThan(2);
  expect(
    scaleMinimumLabelBox.x + scaleMinimumLabelBox.width,
  ).toBeLessThanOrEqual(graphBoundsBox.x);
  expect(
    Math.abs(
      scaleMinimumLabelBox.y +
        scaleMinimumLabelBox.height / 2 -
        (graphBoundsBox.y + graphBoundsBox.height),
    ),
  ).toBeLessThan(2);
  const playhead = waveform.locator("[data-step-fx-waveform-playhead]");
  const phaseMarker = waveform.locator("[data-step-fx-waveform-phase-marker]");
  const phaseMarkerLabel = waveform.locator(
    "[data-step-fx-waveform-phase-label]",
  );
  const waveformPathClip = waveform.locator(
    "[data-step-fx-waveform-path-clip]",
  );
  const waveformPathClipGroup = waveform.locator(
    "[data-step-fx-waveform-path-clip-group]",
  );
  const dividerLabels = waveform.locator(
    "[data-step-fx-waveform-divider-label]",
  );
  await expect(playhead).toHaveCount(1);
  await expect(phaseMarker).toHaveCount(1);
  await expect(phaseMarkerLabel).toHaveText("Start");
  await expect(waveformPathClip).toHaveCount(1);
  await expect(waveformPathClipGroup).toHaveAttribute(
    "clip-path",
    /^url\(#.+\)$/,
  );
  await expect(dividerLabels).toHaveCount(2);
  await expect(dividerLabels.nth(0)).toHaveText("0%");
  await expect(dividerLabels.nth(1)).toHaveText("50%");
  const [phaseMarkerBox, phaseMarkerLabelBox, firstDividerLabelBox] =
    await Promise.all([
      phaseMarker.boundingBox(),
      phaseMarkerLabel.boundingBox(),
      dividerLabels.nth(0).boundingBox(),
    ]);
  if (!phaseMarkerBox || !phaseMarkerLabelBox || !firstDividerLabelBox) {
    throw new Error("Waveform boundary labels or Start marker are not visible");
  }
  expect(phaseMarkerBox.x - graphBoundsBox.x).toBeGreaterThanOrEqual(3);
  expect(phaseMarkerBox.x - graphBoundsBox.x).toBeLessThanOrEqual(5);
  expect(Number(await waveformPathClip.getAttribute("x"))).toBeCloseTo(
    Number(await phaseMarker.getAttribute("x1")),
  );
  expect(
    Math.abs(
      phaseMarkerLabelBox.x + phaseMarkerLabelBox.width / 2 - phaseMarkerBox.x,
    ),
  ).toBeLessThan(2);
  expect(firstDividerLabelBox.y).toBeGreaterThanOrEqual(
    graphBoundsBox.y + graphBoundsBox.height,
  );
  const liveHighlightLayering = await waveform.evaluate((element) => {
    const liveHighlight = element.querySelector(
      "[data-step-fx-waveform-live-segment]",
    );
    const controls = [
      element.querySelector("[data-step-fx-waveform-divider]"),
      element.querySelector("[data-step-fx-waveform-path]"),
      element.querySelector("[data-step-fx-waveform-playhead]"),
      element.querySelector("[data-step-fx-waveform-phase-marker]"),
    ];
    return Boolean(
      liveHighlight &&
        controls.every(
          (control) =>
            control &&
            Boolean(
              liveHighlight.compareDocumentPosition(control) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            ),
        ),
    );
  });
  expect(liveHighlightLayering).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-insets.png"),
    fullPage: true,
  });
  await expect(editor.getByLabel("Phase groups")).toHaveCount(0);
  const startPositionTrigger = editor.getByRole("button", {
    name: "Start position",
  });
  const showAllPlayheads = editor.getByLabel("Show all waveform playheads");
  await expect(showAllPlayheads).not.toBeChecked();
  await expect(showAllPlayheads).toBeEnabled();
  await expect(startPositionTrigger).toContainText("Spread 0→100%");
  await expect.poll(() => stepFxPreviewStatus(page)).toBeTruthy();
  await expect
    .poll(async () => {
      const state = await liveStepHighlightState(editor);
      return (
        state.waveform.length === 1 &&
        state.rows.length === 1 &&
        state.selectors.length === 1 &&
        state.waveform[0] === state.rows[0] &&
        state.rows[0] === state.selectors[0]
      );
    })
    .toBe(true);
  await expect(editor.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Copy" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Paste" })).toHaveCount(0);
  await editor.getByRole("button", { name: "Stop preview" }).focus();
  await pressEditorShortcut(page, "c");
  await expect
    .poll(async () => {
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      return JSON.parse(copied).length;
    })
    .toBe(1);
  const initialPlayheadX = Number(await playhead.getAttribute("x1"));
  await expect
    .poll(async () => Number(await playhead.getAttribute("x1")))
    .not.toBe(initialPlayheadX);
  await expect.poll(() => stepFxPlayheadError(page, 0)).toBeLessThan(60);
  const startPositionMenu = await openStepFxStartPositionControls(page, editor);
  const togetherMode = startPositionMenu.getByRole("radio", {
    name: "Together start position",
  });
  const spreadMode = startPositionMenu.getByRole("radio", {
    name: "Spread start position",
  });
  const percentPositionUnit = startPositionMenu.getByRole("radio", {
    name: "Percent",
  });
  const degreePositionUnit = startPositionMenu.getByRole("radio", {
    name: "Degrees",
  });
  await expect(showAllPlayheads).toBeChecked();
  await expect(showAllPlayheads).toBeDisabled();
  await expect(spreadMode).toHaveAttribute("aria-checked", "true");
  await expect(
    startPositionMenu.getByLabel("Start position value", { exact: true }),
  ).toHaveValue("0");
  await expect(
    startPositionMenu.getByLabel("Spread amount", { exact: true }),
  ).toHaveValue("100");
  await expect(
    startPositionMenu.getByLabel("Spread amount slider"),
  ).toHaveValue("100");
  await expect(percentPositionUnit).toHaveAttribute("aria-checked", "true");
  await expect(percentPositionUnit).toHaveClass(/bg-blue-600/);
  await expect(
    startPositionMenu.locator("[data-step-fx-start-position-direction]"),
  ).toHaveAttribute("data-step-fx-start-position-direction", "clockwise");
  await expect(
    startPositionMenu.locator("[data-step-fx-start-position-direction]"),
  ).toHaveAttribute("data-step-fx-start-position-direction-radius", "54");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-start-position-percent.png"),
    fullPage: true,
  });
  await startPositionMenu
    .getByLabel("Spread amount", { exact: true })
    .fill("50");
  await startPositionMenu.getByRole("button", { name: "Reverse" }).click();
  await expect(
    startPositionMenu.getByLabel("Spread amount", { exact: true }),
  ).toHaveValue("-50");
  await expect(
    startPositionMenu.getByLabel("Spread amount slider"),
  ).toHaveValue("50");
  await expect(
    startPositionMenu.getByRole("button", { name: "-25%" }),
  ).toBeVisible();
  await expect(
    startPositionMenu.locator("[data-step-fx-start-position-direction]"),
  ).toHaveAttribute(
    "data-step-fx-start-position-direction",
    "counterclockwise",
  );
  await startPositionMenu.getByRole("button", { name: "-25%" }).click();
  await expect(
    startPositionMenu.getByLabel("Spread amount", { exact: true }),
  ).toHaveValue("-25");
  await startPositionMenu.getByRole("button", { name: "Reverse" }).click();
  await startPositionMenu.getByRole("button", { name: "100%" }).click();
  await degreePositionUnit.click();
  await expect(degreePositionUnit).toHaveAttribute("aria-checked", "true");
  await expect(degreePositionUnit).toHaveClass(/bg-blue-600/);
  await expect(percentPositionUnit).toHaveAttribute("aria-checked", "false");
  await expect(percentPositionUnit).not.toHaveClass(/bg-blue-600/);
  await expect(dividerLabels.nth(0)).toHaveText("0°");
  await expect(dividerLabels.nth(1)).toHaveText("180°");
  await expect(
    startPositionMenu.getByLabel("Start position value", { exact: true }),
  ).toHaveValue("0");
  await expect(
    startPositionMenu.getByLabel("Spread amount", { exact: true }),
  ).toHaveValue("360");
  await expect(startPositionTrigger).toContainText("Spread 0→360°");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-degrees.png"),
    fullPage: true,
  });
  await percentPositionUnit.click();
  await expect(percentPositionUnit).toHaveAttribute("aria-checked", "true");
  await expect(percentPositionUnit).toHaveClass(/bg-blue-600/);
  await expect(dividerLabels.nth(0)).toHaveText("0%");
  await expect(dividerLabels.nth(1)).toHaveText("50%");
  await expect(
    startPositionMenu.locator("[data-step-fx-start-position-marker]"),
  ).toHaveCount(1);
  await togetherMode.click();
  await expect(showAllPlayheads).not.toBeChecked();
  await expect(showAllPlayheads).toBeDisabled();
  await expect(editor.locator("[data-step-fx-show-all-warning]")).toBeVisible();
  await expect(togetherMode).toHaveAttribute("aria-checked", "true");
  await expect(spreadMode).toHaveAttribute("aria-checked", "false");
  await expect(togetherMode).toHaveClass(/bg-blue-600/);
  await expect(spreadMode).not.toHaveClass(/bg-blue-600/);
  await startPositionMenu
    .getByLabel("Start position value", { exact: true })
    .fill("50");
  await expect.poll(() => stepFxPlayheadError(page, 0.5)).toBeLessThan(60);
  expect(Number(await phaseMarker.getAttribute("x1"))).toBeCloseTo(
    graphViewBoxX + graphViewBoxWidth * 0.5,
  );
  await expect(startPositionTrigger).toContainText("Start 50%");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-phase-offset.png"),
    fullPage: true,
  });
  await spreadMode.click();
  await expect(showAllPlayheads).toBeChecked();
  await expect(showAllPlayheads).toBeDisabled();
  await startPositionMenu
    .getByLabel("Start position value", { exact: true })
    .fill("0");
  await startPositionMenu
    .getByLabel("Spread amount", { exact: true })
    .fill("100");
  await expect.poll(() => stepFxPlayheadError(page, 0)).toBeLessThan(60);
  await expect(startPositionTrigger).toContainText("Spread 0→100%");
  await startPositionTrigger.click();
  await expect(startPositionMenu).toHaveCount(0);
  await expect(showAllPlayheads).not.toBeChecked();
  await expect(showAllPlayheads).toBeEnabled();
  const overridesToggle = editor.getByRole("button", { name: "Overrides" });
  await expect(overridesToggle).toHaveAttribute("aria-expanded", "false");
  await overridesToggle.click();
  await expect(overridesToggle).toHaveAttribute("aria-expanded", "true");
  const overridesContent = page.getByRole("region", { name: "Overrides" });
  await expect(overridesContent).toBeVisible();
  const phaseOverride = overridesContent.getByRole("checkbox", {
    name: "Override start position",
  });
  await phaseOverride.check();
  const lanePhaseField = overridesContent.getByLabel("Lane start position");
  await expect(lanePhaseField).toHaveValue("0>360");
  await lanePhaseField.fill("90");
  await lanePhaseField.press("Enter");
  await expect.poll(() => stepFxPlayheadError(page, 0.25)).toBeLessThan(60);
  expect(Number(await phaseMarker.getAttribute("x1"))).toBeCloseTo(
    graphViewBoxX + graphViewBoxWidth * 0.25,
  );
  await phaseOverride.uncheck();
  await expect.poll(() => stepFxPlayheadError(page, 0)).toBeLessThan(60);
  await overridesToggle.click();
  await expect(overridesToggle).toHaveAttribute("aria-expanded", "false");
  await expect(overridesContent).toHaveCount(0);
  await waveform
    .locator('[data-step-fx-waveform-segment][data-step-index="1"]')
    .click();
  await expect(
    editor.getByRole("checkbox", { name: "Select step 2", exact: true }),
  ).toBeChecked();
  await waveform
    .locator('[data-step-fx-waveform-segment][data-step-index="0"]')
    .click();
  await setEditorSelection(page, editor, "Fixture 1");
  await expect(
    editor.getByRole("group", { name: "Waveform preview" }),
  ).toContainText("0°");
  const playheadLabels = waveform.locator(
    "[data-step-fx-waveform-playhead-label]",
  );
  const waveformPlot = waveform.locator("[data-step-fx-waveform-plot]");
  const fixtureScrollMode = editor.getByRole("radio", { name: "Fixture" });
  const waveformScrollMode = editor.getByRole("radio", { name: "Waveform" });
  await expect(playheadLabels).toHaveText("Fixture 1");
  await expect(fixtureScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformScrollMode).toHaveAttribute("aria-checked", "false");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "fixtures");
  await expect(
    waveformPlot.locator("[data-step-fx-waveform-cycle]"),
  ).toHaveCount(1);

  await setEditorSelection(page, editor, "Fixture 1>4");
  const previewIndexes = editor
    .getByRole("group", { name: "Waveform preview" })
    .locator("[data-step-fx-preview-index]");
  await expect(previewIndexes).toHaveCount(4);
  await expect(previewIndexes).toHaveText(["10°", "290°", "3180°", "4270°"]);
  const customStartMenu = await openStepFxStartPositionControls(page, editor);
  await customStartMenu
    .getByRole("radio", { name: "Custom start position" })
    .click();
  const advancedStartPosition = customStartMenu.getByLabel(
    "Advanced start position expression",
  );
  await expect(advancedStartPosition).toHaveValue("0>360>0");
  await expect(startPositionTrigger).toContainText("Custom 0→100→0%");
  await expect(previewIndexes).toHaveText(["10°", "2180°", "3360°", "4180°"]);
  await advancedStartPosition.fill("0>360");
  await advancedStartPosition.press("Enter");
  await expect(previewIndexes).toHaveText(["10°", "290°", "3180°", "4270°"]);
  await startPositionTrigger.click();
  await expect(customStartMenu).toHaveCount(0);
  await expect(previewIndexes.nth(0)).toHaveAttribute("title", /Fixture 1/);
  await expect(previewIndexes.nth(3)).toHaveAttribute("title", /Fixture 4/);
  await expect(showAllPlayheads).not.toBeChecked();
  await showAllPlayheads.check();
  await expect(playhead).toHaveCount(4);
  await expect(playheadLabels).toHaveCount(1);
  await expect(playheadLabels).toHaveText("Fixture 1");
  const selectedPlayhead = waveform.locator(
    '[data-step-fx-waveform-playhead][data-selected="true"]',
  );
  const otherPlayheads = waveform.locator(
    '[data-step-fx-waveform-playhead][data-selected="false"]',
  );
  await expect(otherPlayheads).toHaveCount(3);
  await expect(selectedPlayhead).toHaveAttribute("data-preview-index", "0");
  await expect(selectedPlayhead).toHaveClass(/text-amber-300/);
  await expect
    .poll(() =>
      otherPlayheads.evaluateAll((nodes) =>
        nodes.every((node) => node.classList.contains("text-neutral-400")),
      ),
    )
    .toBe(true);
  await previewIndexes.nth(1).click();
  await expect(selectedPlayhead).toHaveAttribute("data-preview-index", "1");
  await expect(
    waveform.locator(
      '[data-step-fx-waveform-playhead-label][data-selected="true"]',
    ),
  ).toHaveText("Fixture 2");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-show-all-playheads.png"),
    fullPage: true,
  });
  await showAllPlayheads.uncheck();
  await expect(playhead).toHaveCount(1);
  await expect(previewIndexes.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => stepFxPlayheadError(page, 0.25)).toBeLessThan(60);
  await waveformScrollMode.click();
  await expect(waveformScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "waveform");
  await expect(waveformPlot).toHaveAttribute("data-mode-transitioning", "true");
  await expect(
    waveformPlot.locator("[data-step-fx-waveform-cycle]"),
  ).toHaveCount(3);
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );
  const primaryWaveformCycle = waveformPlot.locator(
    '[data-step-fx-waveform-cycle="0"]',
  );
  const initialWaveformTransform = await primaryWaveformCycle.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(() =>
      primaryWaveformCycle.evaluate(
        (element) => getComputedStyle(element).transform,
      ),
    )
    .not.toBe(initialWaveformTransform);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-waveform-scroll-mode.png"),
    fullPage: true,
  });
  await fixtureScrollMode.click();
  await expect(fixtureScrollMode).toHaveAttribute("aria-checked", "true");
  await expect(waveformPlot).toHaveAttribute("data-scroll-mode", "fixtures");
  await expect(waveformPlot).toHaveAttribute("data-mode-transitioning", "true");
  await expect(
    waveformPlot.locator("[data-step-fx-waveform-cycle]"),
  ).toHaveCount(1);
  await expect(waveformPlot).toHaveAttribute(
    "data-mode-transitioning",
    "false",
  );
  await previewIndexes.nth(0).click();

  await setEditorSelection(page, editor, "Fixture 4>1");
  await expect(previewIndexes.nth(0)).toHaveAttribute("title", /Fixture 4/);
  await expect(previewIndexes.nth(3)).toHaveAttribute("title", /Fixture 1/);

  await setEditorSelection(page, editor, "{Fixture 1>2} + Fixture 3>4");
  await expect(previewIndexes).toHaveCount(3);
  await expect(previewIndexes.nth(0)).toHaveAttribute(
    "title",
    /Fixture 1(?:\.1)?, Fixture 2(?:\.1)? \(2\)/,
  );
  await expect(playheadLabels).toHaveText(
    /Fixture 1(?:\.1)?, Fixture 2(?:\.1)?/,
  );

  await setEditorSelection(page, editor, "Fixture 1>9");
  const previewIndexInput = editor.getByLabel("Waveform preview index");
  await expect(previewIndexes).toHaveCount(0);
  await expect(previewIndexInput).toHaveValue("1");
  await expect(previewIndexInput).toHaveAttribute("max", "9");
  await previewIndexInput.fill("3");
  await expect(previewIndexInput).toHaveValue("3");
  await expect.poll(() => stepFxPlayheadError(page, 2 / 9)).toBeLessThan(60);
  const samplingWarnings = waveform.locator(
    "[data-step-fx-playhead-sampling-warning]",
  );
  await expect(samplingWarnings).toHaveCount(0);
  await waveformPlot.evaluate((element) => {
    element.style.width = "30px";
    element.style.alignSelf = "flex-start";
  });
  await showAllPlayheads.check();
  await expect
    .poll(async () => {
      const plotBox = await waveformPlot.boundingBox();
      return plotBox
        ? (await playhead.count()) <= Math.floor(plotBox.width / 5)
        : false;
    })
    .toBe(true);
  const sampledPlayheadCount = await playhead.count();
  const samplingMessage = `Showing ${sampledPlayheadCount} of 9 playheads to reduce visual clutter. The selected index is always shown.`;
  await expect(samplingWarnings).toHaveCount(1);
  await expect(samplingWarnings).toHaveAttribute("aria-label", samplingMessage);
  await samplingWarnings.hover();
  await expect(page.getByRole("tooltip")).toHaveText(samplingMessage);
  await page.waitForTimeout(300);
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-sampled-playheads.png"),
    fullPage: true,
  });
  await expect(selectedPlayhead).toHaveAttribute("data-preview-index", "2");
  await expect(playheadLabels).toHaveCount(1);
  await waveformPlot.evaluate((element) => {
    element.style.removeProperty("width");
    element.style.removeProperty("align-self");
  });
  await showAllPlayheads.uncheck();
  await expect(samplingWarnings).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-preview-index-input.png"),
    fullPage: true,
  });

  await setEditorSelection(page, editor, "Fixture 1>4");
  await expect(previewIndexes).toHaveCount(4);
  await previewIndexes.nth(0).click();

  await setEditorSelection(page, editor, "Group 99");
  await expect(editor.getByText("Selection warning")).toHaveAttribute(
    "title",
    /Circular reference detected in group 99/,
  );
  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      return stored?.selection?.source?.data?.type;
    })
    .toBe("ByUid");
  const selectionProperties = await openStepFxProperties(page);
  await expect(selectionProperties.getByLabel("Selection")).toHaveValue(
    "Group 99",
  );
  await page.screenshot({
    path: testInfo.outputPath("step-fx-group-selection.png"),
    fullPage: true,
  });
  await focusStepFxEditor(page);

  await setEditorSelection(page, editor, "Fixture 1>4");
  await expect(previewIndexes).toHaveCount(4);

  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values((window as any).appStores.activeInstances.get()).some(
          (playback: any) =>
            playback.is_preview && playback.display_kind === "StepFx",
        ),
      ),
    )
    .toBe(true);

  const editTimingMenu = await openStepFxTimingControls(page, editor);
  const speedInput = editTimingMenu.getByLabel("Step FX speed", {
    exact: true,
  });
  await speedInput.fill("8.5");
  await speedInput.press("ArrowUp");
  await expect(speedInput).toHaveValue("9.5");
  await editTimingMenu.getByLabel("Step FX speed unit").selectOption("Hz");
  await speedInput.fill("4");
  await speedInput.press("Tab");
  await editTimingMenu.getByLabel("Fixed cycle scaling").check();
  await editTimingMenu.getByLabel("Step FX cycle beats").fill("4");
  await editTimingMenu.getByLabel("Step FX cycle beats").press("Tab");
  await expect
    .poll(async () => (await stepFxPreviewStatus(page))?.track_phase_offsets)
    .not.toEqual([]);
  await expect(previewIndexes).toHaveCount(4);
  await expect(previewIndexes).toHaveText(["10°", "290°", "3180°", "4270°"]);
  const reverseDirection = directionGroup.getByRole("radio", {
    name: "Reverse direction",
  });
  await reverseDirection.click();
  await expect(reverseDirection).toHaveAttribute("aria-checked", "true");
  await expect(waveform).not.toContainText("Reverse");
  await expect(waveform.locator("[data-step-fx-waveform-segment]")).toHaveCount(
    2,
  );
  await expect
    .poll(() =>
      stepFxPlayheadError(page, 0, {
        direction: "Reverse",
        totalBeats: 2,
        cycleBeats: 4,
        beatDurationSeconds: 0.25,
      }),
    )
    .toBeLessThan(60);
  const bounceDirection = directionGroup.getByRole("radio", {
    name: "Bounce direction",
  });
  await bounceDirection.click();
  await expect(bounceDirection).toHaveAttribute("aria-checked", "true");
  await expect(waveform).not.toContainText("Bounce");
  await expect(waveform.locator("[data-step-fx-waveform-segment]")).toHaveCount(
    2,
  );
  await expect(waveform.locator("[data-step-fx-waveform-point]")).toHaveCount(
    4,
  );
  await expect
    .poll(() =>
      stepFxPlayheadError(page, 0, {
        direction: "Bounce",
        totalBeats: 2,
        cycleBeats: 8,
        beatDurationSeconds: 0.25,
      }),
    )
    .toBeLessThan(60);
  expect(
    await waveform
      .locator("[data-step-fx-waveform-point]")
      .evaluateAll((points) =>
        points.every(
          (point) =>
            getComputedStyle(point).zIndex ===
            (point.getAttribute("data-control-point") === "ramp-start"
              ? "30"
              : "40"),
        ),
      ),
  ).toBe(true);
  const rampStart = editor.getByLabel("Step 1 ramp start");
  const rampEnd = editor.getByLabel("Step 1 ramp end");
  await expect(rampStart).toBeVisible();
  await expect(rampEnd).toBeVisible();
  await expect(rampStart.locator(".noUi-tooltip")).toHaveText("0%");
  await expect(rampEnd.locator(".noUi-tooltip")).toHaveText("100%");
  for (let increment = 0; increment < 25; increment += 1) {
    await rampStart.press("ArrowRight");
  }
  await expect(
    editor.locator('[data-step-index="0"]').getByText("25–100%"),
  ).toBeVisible();
  await rampEnd.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-ramp-range.png"),
    fullPage: true,
  });
  await editor.getByLabel("Step 1 curve").click();
  await page
    .locator('[data-menu-kind="step-fx-curve"]')
    .getByRole("button", { name: "Ease", exact: true })
    .click();
  await expect(
    waveform.locator("[data-step-fx-waveform-path]"),
  ).toHaveAttribute("d", /C /);
  await editor.getByLabel("Step 1 value").fill("75");
  await editor.getByLabel("Step 1 value").press("Tab");

  await editor.getByRole("tab", { name: "Relative", exact: false }).click();
  await expect(editor.getByText("No relative steps.")).toBeVisible();
  await editor.getByRole("button", { name: "Add relative step" }).click();
  await expect(editor.locator("[data-step-fx-sheet] tbody tr")).toHaveCount(2);
  await expect(
    editor.getByRole("button", { name: "Remove relative steps" }),
  ).toBeVisible();
  await editor
    .getByRole("checkbox", { name: "Select step 1", exact: true })
    .check();
  await editor
    .getByRole("button", { name: "Duplicate selected steps" })
    .click();
  await expect(editor.locator("[data-step-fx-sheet] tbody tr")).toHaveCount(3);
  let trackTimingMenu = await openStepFxTimingControls(page, editor);
  await trackTimingMenu.getByLabel("Automatic cycle scaling").check();
  await expect(trackTimingMenu.getByLabel("Step FX cycle beats")).toHaveValue(
    "3",
  );
  await expect(trackTimingMenu).toContainText("Relative steps cycle: 6 beats");
  await editor.getByRole("button", { name: "Speed and scaling" }).click();
  await expect(trackTimingMenu).toBeHidden();
  await editor.getByRole("tab", { name: "Absolute", exact: false }).click();
  await expect(
    editor.locator("[data-step-fx-contribution-panel]"),
  ).toHaveAttribute("data-track-kind", "absolute");
  await expect(
    editor.locator("[data-step-fx-contribution-stage]"),
  ).toHaveAttribute("data-contribution-slide-phase", "idle");
  trackTimingMenu = await openStepFxTimingControls(page, editor);
  await expect(trackTimingMenu.getByLabel("Step FX cycle beats")).toHaveValue(
    "2",
  );
  await expect(trackTimingMenu).toContainText("Absolute steps cycle: 4 beats");
  await editor.getByRole("button", { name: "Speed and scaling" }).click();
  await expect(trackTimingMenu).toBeHidden();
  await editor.getByRole("tab", { name: "Relative", exact: false }).click();
  await expect(
    editor.locator("[data-step-fx-contribution-panel]"),
  ).toHaveAttribute("data-track-kind", "relative");
  await expect(
    editor.locator("[data-step-fx-contribution-stage]"),
  ).toHaveAttribute("data-contribution-slide-phase", "idle");
  trackTimingMenu = await openStepFxTimingControls(page, editor);
  await expect(trackTimingMenu.getByLabel("Step FX cycle beats")).toHaveValue(
    "3",
  );
  await expect(editor.getByText("Invalid", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-independent-auto-cycles.png"),
    fullPage: true,
  });
  await trackTimingMenu.getByLabel("Fixed cycle scaling").check();
  await trackTimingMenu.getByLabel("Step FX cycle beats").fill("4");
  await trackTimingMenu.getByLabel("Step FX cycle beats").press("Tab");
  await expect(trackTimingMenu).toContainText(
    "Steps are scaled proportionally to fit a 8-beat cycle",
  );
  await expect(waveform.locator("[data-step-fx-waveform-segment]")).toHaveCount(
    3,
  );
  await expect(waveform.locator("[data-step-fx-waveform-point]")).toHaveCount(
    6,
  );
  await editor.getByRole("button", { name: "Speed and scaling" }).click();
  await expect(trackTimingMenu).toHaveCount(0);
  await editor.getByRole("button", { name: "Move selected steps up" }).click();
  await editor.getByRole("button", { name: "Stop preview" }).click();
  await expect(playhead).toHaveCount(1);
  await expect(
    waveform.locator("[data-step-fx-waveform-live-segment]"),
  ).toHaveCount(0);
  await editor.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(playhead).toHaveCount(1);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        const fixtures = Object.values(stores.fixtures.get())
          .filter((fixture: any) => fixture.identifiers.id <= 4)
          .sort(
            (left: any, right: any) =>
              left.identifiers.id - right.identifiers.id,
          );
        const parameters = stores.parameters.get();
        const values = fixtures.map((fixture: any) => {
          const raw = parameters.get(fixture.identifiers.uid)?.raw;
          return raw?.VirtualIntensity ?? raw?.Intensity;
        });
        return (
          values.length === 4 &&
          values.every((value: unknown) => typeof value === "number") &&
          values.some((value, index) => index > 0 && value !== values[0]) &&
          (values[0] !== values[1] || values[2] !== values[3])
        );
      }),
    )
    .toBe(true);

  await expect
    .poll(() => storedStepFx(page))
    .toMatchObject({
      identifiers: { id: 1, label: "Step FX 1" },
      direction: "Bounce",
      cycle_scale: { type: "Fixed", data: 4 },
      phase: { waypoints: [0, 1] },
      lanes: [
        {
          attribute: { type: "Intensity" },
          absolute: {
            steps: [
              {
                width_beats: 1,
                target: { type: "AbsolutePercent", data: { value: 0.75 } },
              },
              {
                width_beats: 1,
                target: { type: "AbsolutePercent", data: { value: 0 } },
              },
            ],
          },
          relative: { steps: [{}, {}, {}] },
        },
      ],
    });
  const firstWidth = editor.getByLabel("Step 1 width");
  const validWidth = await firstWidth.inputValue();
  await firstWidth.fill("0");
  await firstWidth.press("Tab");
  await expect(
    editor.getByText("Width must be finite and greater than zero", {
      exact: true,
    }),
  ).toBeVisible();
  await closeStepFxEditor(page);
  const closeDialog = page.getByRole("dialog", {
    name: "Discard unsaved Step FX changes?",
  });
  await expect(closeDialog).toBeVisible();
  await closeDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeVisible();
  await firstWidth.fill(validWidth);
  await firstWidth.press("Tab");
  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      return stored?.lanes[0]?.absolute.steps[0]?.width_beats;
    })
    .toBe(Number(validWidth));
  await page.screenshot({
    path: testInfo.outputPath("step-fx-editor-sheet.png"),
    fullPage: true,
  });

  await closeStepFxEditor(page);
  await expect(editor).toBeHidden();
  await fxTab.click();
  const card = page.getByRole("button", { name: /1: Step FX 1/i });
  await expect(card).toBeVisible();
  await card.click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Step FX label")).toHaveCount(0);

  await closeStepFxEditor(page);
  await fxTab.click();
  await page.getByRole("button", { name: "Toggle selection mode" }).click();
  await card.click();
  await page.getByRole("button", { name: "Delete selected effects" }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Delete selected effects",
  });
  await deleteDialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => storedStepFx(page)).toBeUndefined();
});

/** Verifies decimal width entry retains focus and hides backend float serialization noise. */
test("Step FX width accepts decimal text through an autosave round trip", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await expect.poll(() => storedStepFx(page)).not.toBeUndefined();
  await expect(
    editor.getByRole("columnheader", { name: "Beats", exact: true }),
  ).toBeVisible();
  const firstWidth = editor.getByLabel("Step 1 width");
  await expect(firstWidth).toHaveAttribute("step", "0.001");
  await firstWidth.fill("");
  await firstWidth.pressSequentially("0.166667");
  await expect(firstWidth).toBeFocused();
  await expect(firstWidth).toHaveValue("0.166667");
  await firstWidth.press("Tab");

  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      return stored?.lanes[0]?.absolute.steps[0]?.width_beats;
    })
    .toBeCloseTo(0.167, 5);
  await expect(firstWidth).toHaveValue("0.167");
  expect(
    await firstWidth.evaluate((element: HTMLInputElement) => ({
      message: element.validationMessage,
      stepMismatch: element.validity.stepMismatch,
      valid: element.checkValidity(),
    })),
  ).toEqual({ message: "", stepMismatch: false, valid: true });

  const waveform = editor.locator("[data-step-fx-waveform]");
  await expect(
    waveform.locator(
      '[data-step-fx-waveform-divider-label][data-step-index="1"]',
    ),
  ).toHaveText("14.3%");
  expect(
    await waveform
      .locator("line.text-neutral-800")
      .evaluateAll(
        (lines) =>
          lines.filter(
            (line) => line.getAttribute("x1") === line.getAttribute("x2"),
          ).length,
      ),
  ).toBe(0);
  const graphBounds = await waveform
    .locator("[data-step-fx-waveform-graph-bounds]")
    .boundingBox();
  const maximumLabelBounds = await waveform
    .locator("[data-step-fx-waveform-scale-max]")
    .boundingBox();
  const minimumLabelBounds = await waveform
    .locator("[data-step-fx-waveform-scale-min]")
    .boundingBox();
  if (!graphBounds || !maximumLabelBounds || !minimumLabelBounds)
    throw new Error("Waveform scale geometry is not visible");
  for (const labelBounds of [maximumLabelBounds, minimumLabelBounds]) {
    const labelRight = labelBounds.x + labelBounds.width;
    expect(labelRight).toBeLessThanOrEqual(graphBounds.x);
    expect(graphBounds.x - labelRight).toBeLessThan(8);
  }
  await page.screenshot({
    path: testInfo.outputPath("step-fx-beat-width-polish.png"),
    fullPage: true,
  });

  const stopPreview = editor.getByRole("button", { name: "Stop preview" });
  if (await stopPreview.isVisible()) await stopPreview.click();
});

/** Verifies editor hotkeys open, focus, dismiss, and retain focus through autosave. */
test("Step FX editor hotkeys accelerate popover editing", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await expect.poll(() => storedStepFx(page)).not.toBeUndefined();
  const shortcutAnchor = editor.getByRole("radio", {
    name: "Forward direction",
  });
  await shortcutAnchor.focus();

  await page.keyboard.press("b");
  const timingMenu = page.locator('[data-menu-kind="step-fx-timing"]');
  await expect(timingMenu).toBeVisible();
  await expect(
    timingMenu.getByLabel("Step FX speed", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(timingMenu).toBeHidden();

  await page.keyboard.press("s");
  const spreadMenu = page.locator('[data-menu-kind="step-fx-start-position"]');
  await expect(spreadMenu).toBeVisible();
  await expect(
    spreadMenu.getByRole("radio", { name: "Percent" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(spreadMenu).toBeHidden();

  await page.keyboard.press("o");
  const overrides = page.getByRole("region", { name: "Overrides" });
  await expect(overrides).toBeVisible();
  await expect(
    overrides.getByRole("checkbox", { name: "Override speed" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(overrides).toBeHidden();

  const showAllPlayheads = editor.getByLabel("Show all waveform playheads");
  await expect(showAllPlayheads).not.toBeChecked();
  await page.keyboard.press("a");
  await expect(showAllPlayheads).toBeChecked();
  await page.keyboard.press("a");
  await expect(showAllPlayheads).not.toBeChecked();

  await page.keyboard.press("p");
  await expect(
    editor.getByRole("button", { name: "Preview", exact: true }),
  ).toBeVisible();
  await expect.poll(() => stepFxPreviewStatus(page)).toBeUndefined();
  await page.keyboard.press("p");
  await expect(
    editor.getByRole("button", { name: "Stop preview" }),
  ).toBeVisible();
  await expect.poll(() => stepFxPreviewStatus(page)).toBeTruthy();

  await page.keyboard.press("n");
  const attributeSearch = editor.getByRole("searchbox", {
    name: "Search attributes",
  });
  await expect(attributeSearch).toBeFocused();
  await expect(editor.getByRole("menu", { name: "Attributes" })).toBeVisible();
  await attributeSearch.press("Escape");
  await expect(editor.getByRole("menu", { name: "Attributes" })).toBeHidden();

  await shortcutAnchor.focus();
  await page.keyboard.press("s");
  await spreadMenu
    .getByRole("radio", { name: "Together start position" })
    .click();
  await page.keyboard.press("Escape");
  await expect(showAllPlayheads).toBeDisabled();
  const togetherWarning = editor.locator("[data-step-fx-show-all-warning]");
  await togetherWarning.hover();
  await expect(
    page.getByRole("tooltip").filter({
      hasText:
        "Show all is unavailable in Together mode because all fixtures overlap and behave as one.",
    }),
  ).toBeVisible();

  await shortcutAnchor.focus();
  await page.keyboard.press("Shift+s");
  const advancedExpression = page.getByLabel(
    "Advanced start position expression",
  );
  await expect(spreadMenu).toBeVisible();
  await expect(advancedExpression).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(spreadMenu).toBeHidden();

  await shortcutAnchor.focus();
  await page.keyboard.press("b");
  const speed = timingMenu.getByLabel("Step FX speed", { exact: true });
  await speed.fill("100");
  await speed.dispatchEvent("change");
  await expect(speed).toBeFocused();
  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      const duration = stored?.timing?.beat_duration;
      return duration ? duration.secs + duration.nanos / 1_000_000_000 : 0;
    })
    .toBeCloseTo(0.6, 4);
  await expect(timingMenu).toBeVisible();
  await expect(speed).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-hotkey-bpm-focus.png"),
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  const stopPreview = editor.getByRole("button", { name: "Stop preview" });
  if (await stopPreview.isVisible()) await stopPreview.click();
});

/** Verifies external deletion stops preview and cannot recreate the removed definition. */
test("Step FX editor handles deletion of its open definition", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await expect.poll(() => storedStepFx(page)).not.toBeUndefined();
  const firstWidth = editor.getByLabel("Step 1 width");
  await firstWidth.fill("0");
  await firstWidth.press("Tab");
  await expect(
    editor.getByText("Width must be finite and greater than zero", {
      exact: true,
    }),
  ).toBeVisible();

  await deleteStoredStepFx(page);

  await expect.poll(() => storedStepFx(page)).toBeUndefined();
  await expect(
    editor.getByRole("alert").filter({
      hasText: "This Step FX was deleted elsewhere",
    }),
  ).toBeVisible();
  await expect.poll(() => stepFxPreviewStatus(page)).toBeUndefined();
  await firstWidth.fill("2");
  await firstWidth.press("Tab");
  await page.waitForTimeout(700);
  await expect.poll(() => storedStepFx(page)).toBeUndefined();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-open-definition-deleted.png"),
    fullPage: true,
  });

  await editor.getByRole("button", { name: "Close editor" }).click();
  const closeDialog = page.getByRole("dialog", {
    name: "Discard unsaved Step FX changes?",
  });
  await expect(closeDialog).toBeVisible();
  await closeDialog.getByRole("button", { name: "Discard" }).click();
  await expect(editor).toBeHidden();
});

/** Verifies step paging appears only after selectors exceed the available width. */
test("Step FX pages overflowing step selectors", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Toggle selection mode" }).click();
  const actionToolbar = editor.getByRole("toolbar", {
    name: "Step edit actions",
  });
  const stepToolbar = editor.getByRole("toolbar", { name: "Step bar" });
  const addStepButton = actionToolbar.getByRole("button", {
    name: "Add step",
    exact: true,
  });
  const previousButton = stepToolbar.getByRole("button", {
    name: "Previous steps",
  });
  const nextButton = stepToolbar.getByRole("button", { name: "Next steps" });
  await expect(previousButton).toHaveCount(0);
  await expect(nextButton).toHaveCount(0);
  await expect(stepToolbar).not.toContainText("Steps");

  for (let index = 0; index < 18; index += 1) await addStepButton.click();
  await expect(editor.locator("[data-step-fx-sheet] tbody tr")).toHaveCount(20);
  await expect(previousButton).toBeVisible();
  await expect(previousButton).toBeDisabled();
  await expect(nextButton).toBeVisible();
  await expect(nextButton).toBeEnabled();

  const pagerViewport = stepToolbar.locator(
    "[data-step-fx-step-pager-viewport]",
  );
  const initialScrollLeft = await pagerViewport.evaluate(
    (element) => element.scrollLeft,
  );
  await nextButton.click();
  await expect
    .poll(() => pagerViewport.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(initialScrollLeft);
  await expect(previousButton).toBeEnabled();
  const finalStepSelector = stepToolbar.locator(
    '[data-step-fx-step-selector][data-step-index="19"]',
  );
  await expect
    .poll(async () => {
      const viewportBox = await pagerViewport.boundingBox();
      const selectorBox = await finalStepSelector.boundingBox();
      return Boolean(
        viewportBox &&
          selectorBox &&
          selectorBox.x >= viewportBox.x - 1 &&
          selectorBox.x + selectorBox.width <=
            viewportBox.x + viewportBox.width + 1,
      );
    })
    .toBe(true);
  await finalStepSelector.click();
  await expect(
    editor.getByRole("checkbox", { name: "Select step 20", exact: true }),
  ).toBeChecked();
  await expect(nextButton).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("step-fx-overflow-pager.png"),
    fullPage: true,
  });
  await previousButton.click();
  await expect
    .poll(() => pagerViewport.evaluate((element) => element.scrollLeft))
    .toBeLessThan(300);
  await editor.getByRole("button", { name: "Stop preview" }).click();
});

/** Verifies Overrides remains interactive when a stored draft loads after panel mount. */
test("Step FX Overrides expands after reopening a stored effect", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);

  const fxTab = page.getByRole("tab", { name: "Fx" });
  await fxTab.click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await expect.poll(() => storedStepFx(page)).not.toBeUndefined();
  await closeStepFxEditor(page);
  await expect(editor).toBeHidden();

  await fxTab.click();
  await page.getByRole("button", { name: /1: Step FX 1/i }).click();
  await expect(editor).toBeVisible();

  const overridesToggle = editor.getByRole("button", { name: "Overrides" });
  await expect(overridesToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Overrides" })).toHaveCount(0);
  await overridesToggle.click();
  await expect(overridesToggle).toHaveAttribute("aria-expanded", "true");
  const overridesContent = page.getByRole("region", { name: "Overrides" });
  await expect(overridesContent).toBeVisible();
  const speedOverride = overridesContent.getByRole("checkbox", {
    name: "Override speed",
  });
  const phaseOverride = overridesContent.getByRole("checkbox", {
    name: "Override start position",
  });
  const speedField = overridesContent.getByLabel("Lane BPM");
  const phaseField = overridesContent.getByLabel("Lane start position");
  await expect(speedField).toBeVisible();
  await expect(phaseField).toBeVisible();
  await expect(speedField).toBeDisabled();
  await expect(phaseField).toBeDisabled();
  await expect(speedField).toHaveValue("120");
  await expect(phaseField).toHaveValue("0>360");
  const speedSection = overridesContent.locator(
    '[data-step-fx-lane-override="speed"]',
  );
  const phaseSection = overridesContent.locator(
    '[data-step-fx-lane-override="start-position"]',
  );
  const initialBoxes = await Promise.all([
    overridesContent.boundingBox(),
    speedSection.boundingBox(),
    phaseSection.boundingBox(),
    speedField.boundingBox(),
    phaseField.boundingBox(),
    speedSection.getByText("Override speed", { exact: true }).boundingBox(),
    phaseSection
      .getByText("Override start position", { exact: true })
      .boundingBox(),
  ]);
  if (initialBoxes.some((box) => !box)) {
    throw new Error("Step FX override controls are not visible");
  }
  await page.screenshot({
    path: testInfo.outputPath("step-fx-reopened-overrides-disabled.png"),
    fullPage: true,
  });
  await speedOverride.check();
  await phaseOverride.check();
  await expect(speedField).toBeEnabled();
  await expect(phaseField).toBeEnabled();
  const enabledBoxes = await Promise.all([
    overridesContent.boundingBox(),
    speedSection.boundingBox(),
    phaseSection.boundingBox(),
    speedField.boundingBox(),
    phaseField.boundingBox(),
    speedSection.getByText("Override speed", { exact: true }).boundingBox(),
    phaseSection
      .getByText("Override start position", { exact: true })
      .boundingBox(),
  ]);
  if (enabledBoxes.some((box) => !box)) {
    throw new Error("Enabled Step FX override controls are not visible");
  }
  const [
    menuBox,
    speedSectionBox,
    phaseSectionBox,
    speedFieldBox,
    phaseFieldBox,
    speedToggleTextBox,
    phaseToggleTextBox,
  ] = enabledBoxes as NonNullable<(typeof enabledBoxes)[number]>[];
  for (const [initialBox, enabledBox] of initialBoxes.map((box, index) => [
    box!,
    enabledBoxes[index]!,
  ])) {
    expect(Math.abs(initialBox.x - enabledBox.x)).toBeLessThan(2);
    expect(Math.abs(initialBox.y - enabledBox.y)).toBeLessThan(2);
    expect(Math.abs(initialBox.width - enabledBox.width)).toBeLessThan(2);
    expect(Math.abs(initialBox.height - enabledBox.height)).toBeLessThan(2);
  }
  expect(speedSectionBox.y + speedSectionBox.height).toBeLessThanOrEqual(
    phaseSectionBox.y,
  );
  expect(Math.abs(speedFieldBox.x - phaseFieldBox.x)).toBeLessThan(2);
  expect(speedFieldBox.x + speedFieldBox.width).toBeLessThanOrEqual(
    menuBox.x + menuBox.width,
  );
  expect(phaseFieldBox.x + phaseFieldBox.width).toBeLessThanOrEqual(
    menuBox.x + menuBox.width,
  );
  expect(
    Math.abs(
      speedToggleTextBox.y +
        speedToggleTextBox.height / 2 -
        (speedFieldBox.y + speedFieldBox.height / 2),
    ),
  ).toBeLessThan(2);
  expect(
    Math.abs(
      phaseToggleTextBox.y +
        phaseToggleTextBox.height / 2 -
        (phaseFieldBox.y + phaseFieldBox.height / 2),
    ),
  ).toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-reopened-overrides.png"),
    fullPage: true,
  });
  await overridesToggle.click();
  await expect(overridesToggle).toHaveAttribute("aria-expanded", "false");
  await expect(overridesContent).toHaveCount(0);
});

/** Verifies that Properties owns Step FX identity and spatial selection. */
test("Step FX label and Selection are editable from Properties", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);

  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Step FX label")).toHaveCount(0);

  const propertiesPanel = await openStepFxProperties(page);
  await expect(
    propertiesPanel.getByText("Step FX 1 Properties", { exact: true }),
  ).toBeVisible();
  await expect(propertiesPanel.getByLabel("Selection")).toBeVisible();
  await expect(propertiesPanel.getByLabel("Fixtures")).toHaveCount(0);
  const stepFxLabel = propertiesPanel.getByLabel("Step FX label");
  await expect(stepFxLabel).toHaveValue("Step FX 1");
  await stepFxLabel.fill("Renamed Step FX");
  await stepFxLabel.press("Enter");
  await expect(
    propertiesPanel.getByText("Renamed Step FX Properties", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await storedStepFx(page))?.identifiers.label)
    .toBe("Renamed Step FX");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-properties-label.png"),
    fullPage: true,
  });

  await focusStepFxEditor(page);
  await editor.getByRole("button", { name: "Stop preview" }).click();
});

/** Verifies bounded expansion retains a group container until its stored pipeline resolves. */
test("Step FX phase projection preserves groups through bounded expand", async ({
  backendSlot,
  page,
}) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  const propertiesPanel = await openStepFxProperties(page);
  const selectionField = propertiesPanel.getByLabel("Selection");
  await selectionField.fill("Group 98 | Expand 1");
  await propertiesPanel.getByRole("button", { name: "Apply" }).click();

  const previewIndexes = editor.locator("[data-step-fx-preview-index]");
  await expect(previewIndexes).toHaveCount(1);
  await expect(previewIndexes.first()).toHaveAttribute(
    "title",
    /Fixture 1, Fixture 2, Fixture 3, Fixture 4 \(4\)/,
  );
  await expect
    .poll(async () => (await storedStepFx(page))?.selection.clauses)
    .toEqual([{ type: "Expand", data: { depth: 1 } }]);

  await editor.getByRole("button", { name: "Stop preview" }).click();
});

/** Verifies autosave activity temporarily replaces the panel's registered tab icon. */
test("Step FX tab icon reflects backend-acknowledged autosave", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await expect.poll(() => storedStepFx(page)).not.toBeUndefined();

  const panelId = await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.panels.find((candidate: any) =>
      candidate.id.startsWith("step-fx-editor-"),
    );
    if (!panel) throw new Error("Step FX editor panel is not open");
    return panel.id as string;
  });
  const tab = page.locator(
    `.dv-default-tab[data-dockview-panel-id="${panelId}"]`,
  );
  await expect(tab).toBeVisible();
  await expect(tab).not.toHaveAttribute("aria-label", /saving/);

  await page.evaluate((currentPanelId) => {
    const currentTab = document.querySelector(
      `.dv-default-tab[data-dockview-panel-id="${currentPanelId}"]`,
    );
    if (!currentTab) throw new Error("Step FX editor tab is not rendered");
    const observer = new MutationObserver((records) => {
      const observedSavingStatus = records.some(
        (record) =>
          record.type === "attributes" &&
          record.attributeName === "data-panel-tab-status" &&
          record.oldValue === null,
      );
      const observedSpinningIcon = records.some((record) =>
        Array.from(record.addedNodes).some(
          (node) =>
            node instanceof SVGElement &&
            node.classList.contains("animate-spin"),
        ),
      );
      if (observedSavingStatus) (window as any).__observedPanelSaving = true;
      if (observedSpinningIcon)
        (window as any).__observedPanelSavingSpinner = true;
    });
    observer.observe(currentTab, {
      attributeFilter: ["data-panel-tab-status"],
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });
    (window as any).__panelSavingObserver = observer;
  }, panelId);

  await editor.getByLabel("Step 1 value").fill("75");
  await editor.getByLabel("Step 1 value").press("Tab");
  await expect
    .poll(() => page.evaluate(() => (window as any).__observedPanelSaving))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__observedPanelSavingSpinner),
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      return stored?.lanes[0]?.absolute.steps[0]?.target?.data?.value;
    })
    .toBe(0.75);

  await page.evaluate((currentPanelId) => {
    const registration = (window as any).appStores.registerPanelTabStatus(
      currentPanelId,
    );
    registration.setStatus("saving");
    (window as any).__panelTabStatusRegistration = registration;
  }, panelId);
  const savingIcon = tab.locator('[data-panel-tab-status="saving"]');
  await expect(savingIcon).toBeVisible();
  await expect(savingIcon.locator("svg")).toHaveClass(/animate-spin/);
  await expect(tab).toHaveAttribute("aria-label", /saving/);
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).appStores.dockApi.get().toJSON()),
    ),
  ).not.toContain("saving");
  await page.screenshot({
    path: testInfo.outputPath("step-fx-tab-saving.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    (window as any).__panelTabStatusRegistration?.dispose();
    (window as any).__panelSavingObserver?.disconnect();
    delete (window as any).__panelTabStatusRegistration;
    delete (window as any).__panelSavingObserver;
    delete (window as any).__observedPanelSaving;
    delete (window as any).__observedPanelSavingSpinner;
  });
  await expect(savingIcon).toHaveCount(0);
  await expect(tab).not.toHaveAttribute("aria-label", /saving/);
});

/** Ensures the final lane can be removed without leaving stale waveform accessors. */
test("Step FX editor renders its empty state after removing the final lane", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await openStepFxEditorApp(page, backendSlot.backendPort);

  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await editor
    .getByRole("button", { name: "Remove Intensity lane", exact: true })
    .click();
  await expect(
    editor.getByText("Add an attribute lane to begin."),
  ).toBeVisible();
  await expect(page.getByText("Error rendering component")).toHaveCount(0);
  expect(runtimeErrors).not.toContainEqual(
    expect.stringContaining("reading 'attribute'"),
  );
  await page.screenshot({
    path: testInfo.outputPath("step-fx-empty-lanes.png"),
    fullPage: true,
  });
});

/** Verifies each effect's editor-only viewport controls survive a full reload. */
test("Step FX restores its viewport state after page reload", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openStepFxEditorApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await setEditorSelection(page, editor, "Fixture 1>4");

  const attributeSearch = editor.getByRole("searchbox", {
    name: "Search attributes",
  });
  await attributeSearch.focus();
  await editor
    .getByRole("menu", { name: "Attributes" })
    .getByRole("menuitemcheckbox", { name: "Blue" })
    .click();
  await attributeSearch.press("Escape");
  const blueTab = editor
    .getByRole("tablist", { name: "Step FX attributes" })
    .getByRole("tab", { name: "Blue" });
  await expect(blueTab).toHaveAttribute("aria-selected", "true");

  const relativeTab = editor.getByRole("tab", {
    name: "Relative",
    exact: false,
  });
  await relativeTab.click();
  await expect(relativeTab).toHaveAttribute("aria-selected", "true");
  await editor.getByRole("button", { name: "Add relative step" }).click();

  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      return stored?.lanes.find((lane: any) => lane.attribute?.type === "Blue")
        ?.relative?.steps.length;
    })
    .toBeGreaterThan(0);

  const wrappedSpreadMenu = await openStepFxStartPositionControls(page, editor);
  await wrappedSpreadMenu
    .getByLabel("Start position value", { exact: true })
    .fill("84");
  await wrappedSpreadMenu
    .getByLabel("Spread amount", { exact: true })
    .fill("52");
  await editor.getByRole("button", { name: "Start position" }).click();
  await expect(wrappedSpreadMenu).toHaveCount(0);
  await expect
    .poll(async () =>
      (await storedStepFx(page))?.phase?.waypoints.map((value: number) =>
        Number(value.toFixed(2)),
      ),
    )
    .toEqual([0.84, 1.36]);

  await closeStepFxEditor(page);
  await expect(editor).toBeHidden();
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: /1: Step FX 1/i }).click();
  await expect(editor).toBeVisible();
  await blueTab.click();
  await relativeTab.click();

  const waveformScrollMode = editor.getByRole("radio", { name: "Waveform" });
  const showAllPlayheads = editor.getByLabel("Show all waveform playheads");
  await waveformScrollMode.click();
  await expect(waveformScrollMode).toHaveAttribute("aria-checked", "true");
  await showAllPlayheads.check();
  const previewIndexes = editor.locator("[data-step-fx-preview-index]");
  await expect(previewIndexes).toHaveCount(4);
  await previewIndexes.nth(0).click();
  await editor.getByRole("button", { name: "Stop preview" }).click();
  const stoppedWaveform = editor.locator("[data-step-fx-waveform]");
  const stoppedPlayheads = stoppedWaveform.locator(
    "[data-step-fx-waveform-playhead]",
  );
  const stoppedSelectedPlayhead = stoppedWaveform.locator(
    '[data-step-fx-waveform-playhead][data-selected="true"]',
  );
  await expect(stoppedPlayheads).toHaveCount(4);
  await expect(stoppedSelectedPlayhead).toHaveAttribute(
    "data-preview-index",
    "0",
  );
  await expect
    .poll(() =>
      stoppedPlayheads.evaluateAll((elements) =>
        elements
          .map((element) => ({
            cycleOffset: Number(
              element.getAttribute("data-playhead-cycle-offset"),
            ),
            previewIndex: Number(element.getAttribute("data-preview-index")),
          }))
          .sort((left, right) => left.previewIndex - right.previewIndex),
      ),
    )
    .toEqual([
      { cycleOffset: 0, previewIndex: 0 },
      { cycleOffset: 0, previewIndex: 1 },
      { cycleOffset: 1, previewIndex: 2 },
      { cycleOffset: 1, previewIndex: 3 },
    ]);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-wrapped-spread.png"),
    fullPage: true,
  });
  const fullCycleSpreadMenu = await openStepFxStartPositionControls(
    page,
    editor,
  );
  await fullCycleSpreadMenu
    .getByLabel("Start position value", { exact: true })
    .fill("25");
  await fullCycleSpreadMenu
    .getByLabel("Spread amount", { exact: true })
    .fill("100");
  await editor.getByRole("button", { name: "Start position" }).click();
  await expect(fullCycleSpreadMenu).toHaveCount(0);
  await expect
    .poll(async () =>
      (await storedStepFx(page))?.phase?.waypoints.map((value: number) =>
        Number(value.toFixed(2)),
      ),
    )
    .toEqual([0.25, 1.25]);
  await expect
    .poll(() =>
      stoppedPlayheads.evaluateAll((elements) =>
        elements
          .map((element) => ({
            cycleOffset: Number(
              element.getAttribute("data-playhead-cycle-offset"),
            ),
            previewIndex: Number(element.getAttribute("data-preview-index")),
          }))
          .sort((left, right) => left.previewIndex - right.previewIndex),
      ),
    )
    .toEqual([
      { cycleOffset: 0, previewIndex: 0 },
      { cycleOffset: 0, previewIndex: 1 },
      { cycleOffset: -1, previewIndex: 2 },
      { cycleOffset: 0, previewIndex: 3 },
    ]);
  await expect
    .poll(() =>
      stoppedPlayheads.evaluateAll((elements) => {
        const plot = elements[0]?.closest("[data-step-fx-waveform-plot]");
        if (!plot) return false;
        const plotBounds = plot.getBoundingClientRect();
        return elements.every((element) => {
          const bounds = element.getBoundingClientRect();
          const center = bounds.left + bounds.width / 2;
          return center >= plotBounds.left && center <= plotBounds.right;
        });
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("step-fx-full-cycle-spread-wrap.png"),
    fullPage: true,
  });
  await previewIndexes.nth(2).click();
  await expect(stoppedSelectedPlayhead).toHaveAttribute(
    "data-preview-index",
    "2",
  );
  await expect(
    stoppedWaveform.locator("[data-step-fx-waveform-live-segment]"),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      stoppedSelectedPlayhead.evaluate((element) => {
        const plot = element.closest("[data-step-fx-waveform-plot]");
        if (!plot) return Number.POSITIVE_INFINITY;
        const playheadBounds = element.getBoundingClientRect();
        const plotBounds = plot.getBoundingClientRect();
        return Math.abs(
          playheadBounds.left +
            playheadBounds.width / 2 -
            (plotBounds.left + plotBounds.width / 2),
        );
      }),
    )
    .toBeLessThan(2);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const entry = Object.entries(window.localStorage).find(([key]) =>
          key.startsWith("nightfall.stepFxEditor.viewport."),
        );
        return entry ? JSON.parse(entry[1]) : undefined;
      }),
    )
    .toMatchObject({
      selectedAttribute: "Blue",
      trackKind: "relative",
      centerSelectedFixture: true,
      showAllPlayheads: true,
      previewIndex: 2,
      previewActive: false,
    });

  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  const restoredEditor = page.locator("[data-step-fx-editor]");
  await expect(restoredEditor).toBeVisible();
  await expect(
    restoredEditor
      .getByRole("tablist", { name: "Step FX attributes" })
      .getByRole("tab", { name: "Blue" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    restoredEditor.getByRole("tab", { name: "Relative", exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    restoredEditor.getByRole("radio", { name: "Waveform" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    restoredEditor.getByLabel("Show all waveform playheads"),
  ).toBeChecked();
  await expect(
    restoredEditor.locator('[data-step-fx-preview-index="2"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    restoredEditor.getByRole("button", { name: "Preview", exact: true }),
  ).toBeVisible();
  const restoredWaveform = restoredEditor.locator("[data-step-fx-waveform]");
  const restoredPlayheads = restoredWaveform.locator(
    "[data-step-fx-waveform-playhead]",
  );
  await expect(restoredPlayheads).toHaveCount(4);
  await expect(
    restoredWaveform.locator(
      '[data-step-fx-waveform-playhead][data-selected="true"]',
    ),
  ).toHaveAttribute("data-preview-index", "2");

  await page.screenshot({
    path: testInfo.outputPath("step-fx-restored-viewport.png"),
    fullPage: true,
  });
});
