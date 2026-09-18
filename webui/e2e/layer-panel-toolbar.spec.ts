// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const FIXTURE_UID = "11111111111111111111111111111111";

/** Opens a store-seeded test shell and waits until Dockview can receive panels. */
async function openLayerPanelTestApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
}

/** Adds one isolated Layer Stack panel in the visible main grid. */
async function openLayerPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((id) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel(id)?.api.close();
    const panel = api.addPanel({
      id,
      component: "LayerStack",
      title: "Layers",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {},
    });
    panel.api.setActive();
    panel.focus();
  }, panelId);
}

/**
 * Seeds the browser stores with layer data needed by toolbar assertions.
 */
async function seedLayerData(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    stores.attributeMetadata.set([
      {
        key: "Intensity",
        attribute: { type: "Intensity" },
        label: "Intensity",
        category: "Dimmer",
        sort_order: 0,
      },
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
      {
        key: "Blue",
        attribute: { type: "Blue" },
        label: "Blue",
        category: "Color",
        sort_order: 4,
      },
    ]);

    /** Builds coarse parameter metadata for seeded layer fixture data. */
    const parameter = (attribute: string) => ({
      resolution: "Coarse",
      attribute: { type: attribute },
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: "HTP",
      use_grandmaster: true,
    });

    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 1, uid: fixtureUid, label: "Fixture 1" },
        make: "E2E",
        model: "Pixel Bar",
        mode: "RGB",
        elements: [
          {
            label: "Cell 1",
            parameters: [
              parameter("Intensity"),
              parameter("Red"),
              parameter("Green"),
              parameter("Blue"),
            ],
          },
        ],
      },
    });
    stores.layerStack.set([
      {
        creator: "Cue 1",
        object_ref: {
          type: "ByUid",
          data: { object_type: "Cue", uid: "22222222222222222222222222222222" },
        },
        priority: 10,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "Absolute", data: { value: 180 } },
                Red: { type: "Absolute", data: { value: 255 } },
                Blue: { type: "Absolute", data: { value: 16 } },
              },
            ],
          },
        ],
        asserted_relative_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Green: { type: "RelativePercent", data: { offset: 0.5 } },
              },
            ],
          },
        ],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Intensity: 180, Red: 255, Green: 32, Blue: 16 }],
          },
        ],
        computed_transitioning: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Blue: true }],
          },
        ],
      },
      {
        creator: "Empty Layer",
        priority: 20,
        asserted_absolute_values: [],
        asserted_relative_values: [],
        computed_values: [],
        computed_transitioning: [],
      },
    ]);
  }, FIXTURE_UID);
}

/**
 * Seeds a sequence layer whose relative-zero placeholders resolve to nonzero output.
 */
async function seedSequenceLayerIntensityData(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    stores.attributeMetadata.set([
      {
        key: "Intensity",
        attribute: { type: "Intensity" },
        label: "Intensity",
        category: "Dimmer",
        sort_order: 0,
      },
    ]);

    /** Builds coarse parameter metadata for seeded sequence layer fixture data. */
    const parameter = (attribute: string) => ({
      resolution: "Coarse",
      attribute: { type: attribute },
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: "HTP",
      use_grandmaster: true,
    });

    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 310, uid: fixtureUid, label: "Fixture 310" },
        make: "E2E",
        model: "RGBPixelTape 120ch",
        mode: "Dimmer",
        elements: [
          {
            label: "Pixel 1",
            parameters: [parameter("Intensity")],
          },
          {
            label: "Pixel 2",
            parameters: [parameter("Intensity")],
          },
        ],
      },
    });
    stores.layerStack.set([
      {
        creator: "sparkles int",
        object_ref: {
          type: "ByUid",
          data: {
            object_type: "Sequence",
            uid: "22222222222222222222222222222222",
          },
        },
        priority: 10,
        asserted_absolute_values: [],
        asserted_relative_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "Relative", data: { offset: 0 } },
              },
              {
                Intensity: { type: "Relative", data: { offset: 0 } },
              },
            ],
          },
        ],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Intensity: 127.5 }, { Intensity: 255 }],
          },
        ],
        computed_transitioning: [],
      },
    ]);
  }, FIXTURE_UID);
}

/**
 * Pushes a fresh layer-stack snapshot with changed output data and unchanged layer identity.
 */
async function updateLayerOutput(page: Page, intensity: number) {
  await page.evaluate(
    ({ fixtureUid, intensity }) => {
      const stores = (window as any).appStores;
      const currentLayers = stores.layerStack.get();
      const currentLayer = currentLayers[0];
      stores.layerStack.set([
        {
          ...currentLayer,
          computed_values: [
            {
              fixture_uid: fixtureUid,
              parameters: [
                { Intensity: intensity, Red: 255, Green: 32, Blue: 16 },
              ],
            },
          ],
        },
        ...currentLayers
          .slice(1)
          .map((layer: Record<string, unknown>) => ({ ...layer })),
      ]);
    },
    { fixtureUid: FIXTURE_UID, intensity },
  );
}

/**
 * Inserts a new layer ahead of the opened cue so row identity must survive a stack reorder.
 */
async function insertLayerBeforeCue(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    const currentLayers = stores.layerStack.get();
    stores.layerStack.set([
      {
        creator: "Inserted Layer",
        priority: 5,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "Absolute", data: { value: 64 } },
              },
            ],
          },
        ],
        asserted_relative_values: [],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Intensity: 64 }],
          },
        ],
        computed_transitioning: [],
      },
      ...currentLayers.map((layer: Record<string, unknown>) => ({ ...layer })),
    ]);
  }, FIXTURE_UID);
}

/**
 * Swaps the seeded layers without changing the stack length so keyed rows must reorder.
 */
async function swapSeededLayers(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const currentLayers = stores.layerStack.get();
    stores.layerStack.set([{ ...currentLayers[1] }, { ...currentLayers[0] }]);
  });
}

/**
 * Ensures toolbar expansion controls still operate on seeded layer panel content.
 */
test("layers panel toolbar controls layer expansion", async ({ page }) => {
  await openLayerPanelTestApp(page);

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });

  await seedLayerData(page);
  await openLayerPanel(page, "panel-LayerStack-e2e");

  const panel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-LayerStack-e2e"]',
  );
  await expect(panel).toBeVisible();
  await seedLayerData(page);
  await expect(
    panel.getByRole("button", { name: "Column visibility" }),
  ).toHaveCount(1);
  await expect(
    panel.locator('[data-grid-header-id="tanstack-header-Green_Rel"]'),
  ).toHaveCount(0);

  const populatedLayer = panel.locator("details").filter({ hasText: "Cue 1" });
  await expect(populatedLayer.locator("summary")).toContainText(
    /Layer 0:\s*Cue\s*Cue 1/,
  );
  await expect(populatedLayer).not.toHaveAttribute("open", "");
  await expect(
    panel.getByRole("button", { name: "Collapse all layers" }),
  ).toBeDisabled();

  await panel.getByRole("button", { name: "Expand all layers" }).click();
  await expect(populatedLayer).toHaveAttribute("open", "");
  await expect(
    panel.getByRole("columnheader", { name: "Green" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("gridcell", { name: "~ 50%", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("gridcell", { name: "16", exact: true }),
  ).toHaveCount(2);

  await panel.getByRole("button", { name: "Collapse all layers" }).click();
  await expect(populatedLayer).not.toHaveAttribute("open", "");

  await panel.getByRole("button", { name: "Expand all layers" }).click();
  await expect(populatedLayer).toHaveAttribute("open", "");
});

/**
 * Ensures sequence layers display resolved values instead of internal relative-zero placeholders.
 */
test("layers panel displays computed sequence intensity values", async ({
  page,
}) => {
  await openLayerPanelTestApp(page);

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });

  await seedSequenceLayerIntensityData(page);
  await openLayerPanel(page, "panel-LayerStack-sequence-values");

  const panel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-LayerStack-sequence-values"]',
  );
  await expect(panel).toBeVisible();
  const sequenceLayer = panel.locator("details").filter({
    hasText: "sparkles int",
  });
  await expect(sequenceLayer.locator("summary")).toContainText(
    /Layer 0:\s*Sequence\s*sparkles int/,
  );

  await panel.getByRole("button", { name: "Expand all layers" }).click();
  await expect(sequenceLayer).toHaveAttribute("open", "");
  const fixtureParentCell = sequenceLayer.locator(
    `[data-grid-column-key="id"][data-grid-row-key="${FIXTURE_UID}"]`,
  );
  await fixtureParentCell.click();
  await expect(fixtureParentCell).toContainText("▼ 310");
  await expect(
    sequenceLayer.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-1"]`,
    ),
  ).toContainText("50%");
  await expect(
    sequenceLayer.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-2"]`,
    ),
  ).toContainText("100%");
  await expect(
    sequenceLayer.locator(
      `[data-grid-column-key="Intensity_Out"][data-grid-row-key="${FIXTURE_UID}-1"]`,
    ),
  ).toContainText("127.5");
  await expect(
    sequenceLayer.locator(
      `[data-grid-column-key="Intensity_Out"][data-grid-row-key="${FIXTURE_UID}-2"]`,
    ),
  ).toContainText("255");
});

/** Verifies right-click exposes layer source navigation previously hidden behind Alt-click. */
test("layers panel context menu exposes layer source action", async ({
  page,
}) => {
  await openLayerPanelTestApp(page);

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });

  await seedLayerData(page);
  await openLayerPanel(page, "panel-LayerStack-context-e2e");

  const panel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-LayerStack-context-e2e"]',
  );
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Expand all layers" }).click();

  await panel
    .locator('[data-grid-column-key="Intensity_Value"]')
    .filter({ hasText: "180" })
    .click({ button: "right" });
  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Show layer source" }),
  ).toBeVisible();
});

/**
 * Ensures live layer snapshots update existing layer rows instead of remounting them.
 */
test("layers panel preserves clicked layer expansion during layer updates", async ({
  page,
}) => {
  await openLayerPanelTestApp(page);

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });

  await seedLayerData(page);
  await openLayerPanel(page, "panel-LayerStack-e2e-stable");

  const panel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-LayerStack-e2e-stable"]',
  );
  await expect(panel).toBeVisible();
  await seedLayerData(page);

  const populatedLayer = panel.locator("details").filter({ hasText: "Cue 1" });
  await populatedLayer.locator("summary").click();
  await expect(populatedLayer).toHaveAttribute("open", "");
  await populatedLayer.evaluate((element) => {
    (element as HTMLElement & { __layerRowMarker?: string }).__layerRowMarker =
      "mounted";
  });

  for (const intensity of [181, 182, 183, 184, 185]) {
    await updateLayerOutput(page, intensity);
    await expect(populatedLayer).toHaveAttribute("open", "");
    await expect
      .poll(async () =>
        populatedLayer.evaluate(
          (element) =>
            (element as HTMLElement & { __layerRowMarker?: string })
              .__layerRowMarker,
        ),
      )
      .toBe("mounted");
  }

  await expect(
    panel.getByRole("gridcell", { name: "185", exact: true }),
  ).toBeVisible();
});

/**
 * Ensures an expanded logical layer keeps its DOM node and open state when layer order changes.
 */
test("layers panel preserves expansion when a layer moves in the stack", async ({
  page,
}) => {
  await openLayerPanelTestApp(page);

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });

  await seedLayerData(page);
  await openLayerPanel(page, "panel-LayerStack-e2e-reorder");

  const panel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-LayerStack-e2e-reorder"]',
  );
  await expect(panel).toBeVisible();
  await seedLayerData(page);

  const populatedLayer = panel.locator("details").filter({ hasText: "Cue 1" });
  await populatedLayer.locator("summary").click();
  await expect(populatedLayer).toHaveAttribute("open", "");
  await populatedLayer.evaluate((element) => {
    (element as HTMLElement & { __layerRowMarker?: string }).__layerRowMarker =
      "mounted";
  });

  await insertLayerBeforeCue(page);

  await expect(populatedLayer).toHaveAttribute("open", "");
  await expect
    .poll(async () =>
      populatedLayer.evaluate(
        (element) =>
          (element as HTMLElement & { __layerRowMarker?: string })
            .__layerRowMarker,
      ),
    )
    .toBe("mounted");
  await expect(panel.locator("details").first()).toContainText(
    "Inserted Layer",
  );
  await expect(populatedLayer).toContainText("Layer 1:");
});

/**
 * Ensures keyed layer rows publish a new array when existing layers swap positions.
 */
test("layers panel reorders existing layer rows without remounting", async ({
  page,
}) => {
  await openLayerPanelTestApp(page);

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });

  await seedLayerData(page);
  await openLayerPanel(page, "panel-LayerStack-e2e-swap");

  const panel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-LayerStack-e2e-swap"]',
  );
  await expect(panel).toBeVisible();
  await seedLayerData(page);

  const populatedLayer = panel.locator("details").filter({ hasText: "Cue 1" });
  await populatedLayer.locator("summary").click();
  await expect(populatedLayer).toHaveAttribute("open", "");
  await populatedLayer.evaluate((element) => {
    (element as HTMLElement & { __layerRowMarker?: string }).__layerRowMarker =
      "mounted";
  });

  await swapSeededLayers(page);

  await expect(panel.locator("details").first()).toContainText("Empty Layer");
  await expect(populatedLayer).toHaveAttribute("open", "");
  await expect
    .poll(async () =>
      populatedLayer.evaluate(
        (element) =>
          (element as HTMLElement & { __layerRowMarker?: string })
            .__layerRowMarker,
      ),
    )
    .toBe("mounted");
  await expect(populatedLayer).toContainText("Layer 1:");
});
