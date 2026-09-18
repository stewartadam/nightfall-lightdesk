// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const OBJECT_INPUT_PLACEHOLDER = "Search showfile objects...";
const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const SCENE_OBJECT_UID = "showfile-object-palette-scene-object";

/** Waits until the app has mounted its dev stores bridge and Dockview API. */
async function waitForApp(page: Page): Promise<void> {
  await prepareStoreSeededTestApp(page);
}

/** Seeds enough showfile objects to exercise type-token palette filtering. */
async function seedShowfileObjects(page: Page): Promise<void> {
  await page.evaluate((sceneObjectUid) => {
    const stores = (window as any).appStores;
    stores.stepFx.set({});
    stores.fxModules.set({
      "module-fx-71": {
        identifiers: { id: 71, uid: "module-fx-71", label: "Palette Module" },
        module_name: "example-pattern",
        selection: {
          source: { type: "Fixture", data: { fixture_id: 1 } },
          clauses: [],
        },
        config: {},
      },
    });
    const pagedFixtures = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => {
        const id = 200 + index;
        return [
          `fixture-page-${id}`,
          {
            identifiers: {
              id,
              uid: `fixture-page-${id}`,
              label: `Paged Fixture ${id}`,
            },
            make: "E2E",
            model: `Paged ${id}`,
            mode: "Default",
            elements: [{ label: "Element 1", parameters: [] }],
          },
        ];
      }),
    );
    stores.fixtures.set({
      "fixture-16": {
        identifiers: { id: 16, uid: "fixture-16", label: "" },
        make: "E2E",
        model: "Snare",
        mode: "Default",
        elements: [{ label: "Element 1", parameters: [] }],
      },
      ...pagedFixtures,
    });
    stores.groups.set({
      "group-33": {
        identifiers: { id: 33, uid: "group-33", label: "Drum Group" },
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: "fixture-16", index: 1 }],
          },
          clauses: [],
        },
        description: "snare group",
      },
    });
    stores.fx.set({
      "fx-12": {
        identifiers: { id: 12, uid: "fx-12", label: "Pulse Sweep" },
        selection: {
          source: { type: "Fixture", data: { fixture_id: 1 } },
          clauses: [],
        },
        attributes: {
          Intensity: {
            rate: { secs: 1, nanos: 0 },
            width: 1,
            phase_range: [0, 6.283185307179586],
            is_relative: false,
            params: {
              kind: "Sin",
              min: 0,
              max: 255,
              duty_cycle: 1,
            },
          },
        },
      },
    });
    stores.cues.set({
      "cue-12": {
        identifiers: { id: 12, uid: "cue-12", label: "Cue With Same Id" },
        description: "stage wash low intensity",
      },
    });
    stores.sequences.set({
      "seq-7": {
        identifiers: { id: 7, uid: "seq-7", label: "Main Sequence" },
        steps: ["cue-12"],
        wrap: true,
      },
    });
    stores.blueprints.set({
      "bp-44": {
        identifiers: { id: 44, uid: "bp-44", label: "Position Fan" },
        values: {},
      },
    });
    stores.colorPaths.set({
      "color-path-55": {
        identifiers: { id: 55, uid: "color-path-55", label: "Palette Color" },
        interpolation_space: "Hsv",
        hue_direction: "Shortest",
        curve: "Linear",
        timing: {
          in_color: undefined,
          out_color: undefined,
          brightness_percent: undefined,
          attributes: {},
        },
      },
    });
    stores.masters.set({
      "master-61": {
        identifiers: { id: 61, uid: "master-61", label: "Palette Master" },
        kind: "InhibitiveIntensity",
        target: { type: "Fixtures", data: { type: "All" } },
        mode: { type: "AlwaysOn" },
        level_percent: 100,
      },
    });
    stores.sceneObjects.set({
      [sceneObjectUid]: {
        identifiers: {
          id: 901,
          uid: sceneObjectUid,
          label: "Palette Truss",
        },
        objectType: "truss",
        placement: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
        properties: {
          type: "Truss",
          data: {
            length: 2,
            trussType: "Box",
            diameter: 0.3,
          },
        },
      },
    });
    stores.timecodes.set({
      "timecode-81": [
        {
          identifiers: {
            id: 81,
            uid: "timecode-81",
            label: "Palette Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
        {
          is_active: false,
          current_time: { secs: 0, nanos: 0 },
        },
      ],
    });
    stores.timelines.set({
      "timeline-91": {
        identifiers: {
          id: 91,
          uid: "timeline-91",
          label: "Palette Timeline",
        },
        timecode_uid: "timecode-81",
        timecode_start: { secs: 0, nanos: 0 },
        audio_path: "palette.wav",
        audio_enabled: true,
        end_time: undefined,
        tracks: [],
        markers: [],
        regions: [],
        loop_range: undefined,
        bpm: 120,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: undefined,
        scroll_mode: "free",
      },
    });
    stores.visualizerSceneObjectSelection.set([]);
    stores.visualizerEditSelection.set([]);
  }, SCENE_OBJECT_UID);
}

/** Opens an isolated grid-mode sequence list panel for palette tag assertions. */
async function openSequenceGridPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.setItem(
      "nightfall-crud-panel-view-mode:sequence-list",
      "grid",
    );
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-SequenceList-object-palette-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceList",
      title: "Sequences",
      params: { initialPanelId: panelId },
    });
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
  });
}

/** Opens the showfile object palette and returns its search input. */
async function openObjectPalette(page: Page) {
  await page.keyboard.press("Meta+P");
  const input = page.getByPlaceholder(OBJECT_INPUT_PLACEHOLDER);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  return input;
}

/** Closes the showfile object palette and waits for its mounted shell to hide. */
async function closeObjectPalette(page: Page): Promise<void> {
  const input = page.getByPlaceholder(OBJECT_INPUT_PLACEHOLDER);
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-showfile-object-palette-shell="true"]'),
  ).toHaveAttribute("data-dialog-visible", "false");
}

/** Focuses the header command input and seeds an in-progress app command. */
async function focusHeaderCommandInput(page: Page) {
  const headerInput = page.locator("#header-cmdline");
  await expect(headerInput).toBeVisible();
  await headerInput.fill("fixture 1");
  await headerInput.focus();
  await expect(headerInput).toBeFocused();
  return headerInput;
}

/** Verifies shared search controls preserve removable type tokens and fit narrow screens. */
test("showfile object palette applies and removes type token badges", async ({
  page,
}, testInfo) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  const input = await openObjectPalette(page);
  await input.fill("fx ");

  await expect(
    page.getByRole("button", { name: "Remove FX filter" }),
  ).toBeVisible();
  await expect(page.locator('[data-showfile-object-id="fx:12"]')).toBeVisible();
  await expect(page.locator('[data-showfile-object-id="cue:12"]')).toHaveCount(
    0,
  );

  await page.keyboard.press("Backspace");
  await expect(
    page.getByRole("button", { name: "Remove FX filter" }),
  ).toHaveCount(0);
  await input.fill("stage wash");
  await expect(
    page.locator('[data-showfile-object-id="cue:12"]'),
  ).toBeVisible();
  const cueResult = page.locator('[data-showfile-object-id="cue:12"]');
  await expect(cueResult.getByText("Cue With Same Id")).toBeVisible();
  await expect(cueResult.getByText("Cue 7.12")).toBeVisible();

  await input.fill("bp ");
  await expect(
    page.getByRole("button", { name: "Remove Blueprint filter" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-showfile-object-id="blueprint:44"]'),
  ).toBeVisible();
  const picker = page.locator(
    '[data-dialog-kind="showfile-object-palette"] .nf-search-picker',
  );
  await picker.screenshot({
    path: testInfo.outputPath("shared-object-picker.png"),
  });
  await page.setViewportSize({ width: 390, height: 720 });
  await expect(input).toBeFocused();
  const bounds = await picker.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await picker.screenshot({
    path: testInfo.outputPath("shared-object-picker-narrow.png"),
  });
  await page.getByRole("button", { name: "Remove Blueprint filter" }).click();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
});

test("showfile object palette filters timeline and support object tokens", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  for (const [query, filterName, resultId] of [
    ["timeline 91", "Timeline", "timeline:91"],
    ["tc 81", "Timecode", "timecode:81"],
    ["color-path 55", "Color Path", "colorPath:55"],
    ["master 61", "Master", "master:61"],
    ["fx-module 71", "Module FX", "fxModule:71"],
  ] as const) {
    const input = await openObjectPalette(page);
    await input.fill(query);
    await expect(
      page.getByRole("button", { name: `Remove ${filterName} filter` }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-showfile-object-id="${resultId}"]`),
    ).toBeVisible();
    await closeObjectPalette(page);
  }
});

test("showfile object palette captures typing immediately after the hotkey", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  const palette = page.locator("[data-showfile-object-palette-shell]");
  await expect(palette).toBeAttached();
  await expect(palette).toBeHidden();
  await expect(palette).toHaveAttribute("data-dialog-visible", "false");

  await page.keyboard.press("Meta+P");
  await page.keyboard.type("stage wash");

  const input = page.getByPlaceholder(OBJECT_INPUT_PLACEHOLDER);
  await expect(input).toBeVisible();
  await expect(palette).toHaveAttribute("data-dialog-visible", "true");
  await expect(input).toHaveValue("stage wash");
  await expect(
    page.locator('[data-showfile-object-id="cue:12"]'),
  ).toBeVisible();
});

test("showfile and command palette shortcuts stay separate", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  await openObjectPalette(page);
  await expect(
    page.locator(
      '[data-dialog-kind="showfile-object-palette"][data-dialog-visible="true"]',
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Meta+Shift+P");
  await expect(page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER)).toBeVisible();
  await expect(
    page.locator(
      '[data-dialog-kind="command-palette"][data-dialog-visible="true"]',
    ),
  ).toBeVisible();
});

test("app palette shortcuts work from the header command input", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);

  const headerInput = await focusHeaderCommandInput(page);
  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByPlaceholder(OBJECT_INPUT_PLACEHOLDER)).toBeVisible();
  await expect(headerInput).toHaveValue("fixture 1");

  await page.keyboard.press("Escape");
  await headerInput.focus();
  await expect(headerInput).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(headerInput).toHaveValue("fixture 1");
});

test("showfile object palette supports page key navigation", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  const input = await openObjectPalette(page);
  await input.fill("fixture ");
  const selectedObject = page.locator(
    '[data-showfile-object-index][data-selected="true"]',
  );
  await expect(selectedObject).toHaveCount(1);
  await expect(selectedObject).toHaveAttribute(
    "data-showfile-object-index",
    "0",
  );

  await input.press("PageDown");
  await expect
    .poll(async () =>
      Number(await selectedObject.getAttribute("data-showfile-object-index")),
    )
    .toBeGreaterThan(0);

  await input.press("PageUp");
  await expect(selectedObject).toHaveAttribute(
    "data-showfile-object-index",
    "0",
  );
});

test("selecting a scene object opens the scene object editing panel", async ({
  page,
}, testInfo) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  const input = await openObjectPalette(page);
  await input.fill("object ");
  await expect(
    page.getByRole("button", { name: "Remove Scene Object filter" }),
  ).toBeVisible();
  await input.fill("901");
  await seedShowfileObjects(page);
  const sceneObjectResult = page.locator(
    '[data-showfile-object-id="sceneObject:901"]',
  );
  await expect(sceneObjectResult).toBeVisible();
  await sceneObjectResult.click();

  await expect(page.getByText("Scene Objects", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.visualizerSceneObjectSelection.get(),
      ),
    )
    .toEqual([SCENE_OBJECT_UID]);
  await expect(
    page.getByRole("checkbox", { name: "Select row 1" }),
  ).toBeChecked();

  await testInfo.attach("showfile-object-palette-scene-object", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("enter opens editors and mod-enter selects objects in their panel", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  let input = await openObjectPalette(page);
  await input.fill("fx ");
  await input.fill("12");
  await expect(page.locator('[data-showfile-object-id="fx:12"]')).toBeVisible();
  await expect(
    page.locator('[data-showfile-object-action-badge="true"]'),
  ).toHaveText("Open editor");
  await input.press("Enter");
  await expect(
    page.getByText("FX 12: Pulse Sweep", { exact: true }),
  ).toBeVisible();

  input = await openObjectPalette(page);
  await input.fill("fx ");
  await input.fill("12");
  await page.keyboard.down("Meta");
  await expect(
    page.locator('[data-showfile-object-action-badge="true"]'),
  ).toHaveText("Select in panel");
  await input.press("Enter");
  await page.keyboard.up("Meta");

  await expect(
    page.getByRole("checkbox", { name: "Select row 1" }),
  ).toBeChecked();
});

test("mod-enter selects fixtures and focuses the existing groups panel", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  let input = await openObjectPalette(page);
  await input.fill("fixture ");
  await input.fill("16");
  await expect(
    page.locator('[data-showfile-object-id="fixture:16"]'),
  ).toBeVisible();
  const fixtureResult = page.locator('[data-showfile-object-id="fixture:16"]');
  await expect(fixtureResult.getByText("Unnamed")).toBeVisible();
  await expect(fixtureResult.getByText("Fixture 16")).toBeVisible();
  await page.keyboard.down("Meta");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Meta");

  const fixturePanel = page.locator('[data-panel-id="panel-FixtureGrid"]');
  await expect(
    fixturePanel.getByRole("gridcell", { name: "16", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  input = await openObjectPalette(page);
  await input.fill("group ");
  await input.fill("33");
  await expect(
    page.locator('[data-showfile-object-id="group:33"]'),
  ).toBeVisible();
  await page.keyboard.down("Meta");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Meta");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as any).appStores?.dockApi?.get?.();
        return {
          defaultGroupsPanelExists: Boolean(api?.getPanel("panel-Groups")),
          duplicateGroupsPanelExists: Boolean(
            api?.getPanel("panel-GroupsPanel"),
          ),
        };
      }),
    )
    .toEqual({
      defaultGroupsPanelExists: true,
      duplicateGroupsPanelExists: false,
    });
});

test("object metadata tags appear in palette results and sequence cards", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=showfile-object-palette&startup:draftRecovery=false",
  );
  await waitForApp(page);
  await seedShowfileObjects(page);

  const input = await openObjectPalette(page);
  await input.fill("fixture ");
  await input.fill("16");

  const fixtureResult = page.locator('[data-showfile-object-id="fixture:16"]');
  await expect(fixtureResult).toBeVisible();
  await expect(
    fixtureResult.locator('[data-showfile-object-tag="fixture-profile"]'),
  ).toContainText("Snare");
  await expect(
    fixtureResult.locator('[data-showfile-object-tag="fixture-mode"]'),
  ).toContainText("Default");

  await page.keyboard.press("Escape");

  const sequenceInput = await openObjectPalette(page);
  await sequenceInput.fill("sequence ");
  await sequenceInput.fill("7");

  const sequenceResult = page.locator('[data-showfile-object-id="sequence:7"]');
  await expect(sequenceResult).toBeVisible();
  await expect(
    sequenceResult.locator('[data-sequence-tag="wrap"]'),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await openSequenceGridPanel(page);

  const sequenceCard = page.getByRole("button", {
    name: /7:\s*Main Sequence/,
  });
  await expect(
    sequenceCard.locator('[data-sequence-tag="wrap"]'),
  ).toBeVisible();
});
