// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";

import { prepareStoreSeededTestApp } from "./showfile-startup";

const FIXTURE_UID = "33333333333333333333333333333333";
const FIXTURE_PANEL_ID = "panel-DataGridInstrumentationFixtures-e2e";
const LAYER_PANEL_ID = "panel-DataGridInstrumentationLayer-e2e";

/** Seeds fixture, parameter, and layer stores with active attribute values. */
async function seedGridData(page: Page): Promise<void> {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds coarse parameter metadata for seeded grid instrumentation data. */
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
        sort_order: 1,
      },
      {
        key: "Green",
        attribute: { type: "Green" },
        label: "Green",
        category: "Color",
        sort_order: 2,
      },
    ]);

    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 33, uid: fixtureUid, label: "Fixture 33" },
        make: "E2E",
        model: "Instrumented Bar",
        mode: "RGB",
        elements: [
          {
            label: "Cell 1",
            parameters: [
              parameter("Intensity"),
              parameter("Red"),
              parameter("Green"),
            ],
          },
        ],
      },
    });

    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(180, 20, 40)",
            raw: { Intensity: 200, Red: 180, Green: 20 },
            absolute: {
              Intensity: { type: "Absolute", data: { value: 200 } },
              Red: { type: "Absolute", data: { value: 180 } },
            },
            relative: {
              Green: { type: "RelativePercent", data: { offset: 0.25 } },
            },
            conflicts: new Set(),
            elements: [],
          },
        ],
      ]),
    );

    stores.layerStack.set([
      {
        creator: "Timeline",
        priority: 10,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "Absolute", data: { value: 200 } },
                Red: { type: "Absolute", data: { value: 180 } },
              },
            ],
          },
        ],
        asserted_relative_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Green: { type: "RelativePercent", data: { offset: 0.25 } },
              },
            ],
          },
        ],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Intensity: 200, Red: 180, Green: 20 }],
          },
        ],
        computed_transitioning: [],
      },
    ]);
  }, FIXTURE_UID);
}

/** Opens an isolated fixture DataGrid owner for instrumentation assertions. */
async function openFixtureGrid(page: Page): Promise<void> {
  await page.evaluate((fixturePanelId) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel(fixturePanelId)?.api.close();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const panel = api.addPanel({
      id: fixturePanelId,
      component: "FixtureGrid",
      title: "Fixtures",
      params: { initialPanelId: fixturePanelId },
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
  }, FIXTURE_PANEL_ID);
}

/** Opens an isolated layer DataGrid owner for instrumentation assertions. */
async function openLayerGrid(page: Page): Promise<void> {
  await page.evaluate((layerPanelId) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel(layerPanelId)?.api.close();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const panel = api.addPanel({
      id: layerPanelId,
      component: "LayerStack",
      title: "Layers",
      params: {},
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
  }, LAYER_PANEL_ID);
}

/** Mutates seeded stores after observers mount so DOM churn counters have work to observe. */
async function updateGridData(page: Page): Promise<void> {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(42, 84, 126)",
            raw: { Intensity: 120, Red: 42, Green: 84 },
            absolute: {
              Intensity: { type: "Absolute", data: { value: 120 } },
              Red: { type: "Absolute", data: { value: 42 } },
            },
            relative: {
              Green: { type: "RelativePercent", data: { offset: 0.5 } },
            },
            conflicts: new Set(),
            elements: [],
          },
        ],
      ]),
    );

    const [layer] = stores.layerStack.get();
    stores.layerStack.set([
      {
        ...layer,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "Absolute", data: { value: 120 } },
                Red: { type: "Absolute", data: { value: 42 } },
              },
            ],
          },
        ],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Intensity: 120, Red: 42, Green: 84 }],
          },
        ],
      },
    ]);
  }, FIXTURE_UID);
}

/** Publishes a new parameter map while preserving row identities for reuse metrics. */
async function refreshParameterMapIdentity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.parameters.set(new Map(stores.parameters.get()));
  });
}

/** Reads one frontend performance metric from the app store. */
async function readPerformanceMeasure(page: Page, name: string): Promise<any> {
  return page.evaluate(
    (metricName) =>
      (window as any).appStores.performanceMeasureStats.get()[metricName],
    name,
  );
}

test("DataGrid churn instrumentation records fixture and layer grid counts", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=datagrid-instrumentation");
  await prepareStoreSeededTestApp(page);
  await seedGridData(page);
  await openFixtureGrid(page);

  await expect(
    page.locator(
      `[data-panel-kind="fixtures"][data-panel-id="${FIXTURE_PANEL_ID}"]`,
    ),
  ).toBeVisible();

  await updateGridData(page);

  const fixtureCellMetric = `nightfall:data-grid.fixtures.${FIXTURE_PANEL_ID}.cell-resolves`;
  const fixtureFrameMetric = `nightfall:data-grid.fixtures.${FIXTURE_PANEL_ID}.update-to-frame`;
  const fixtureValueRowsRebuiltMetric =
    "nightfall:fixtures-panel.value-rows.rebuilt";
  const fixtureValueRowsReusedMetric =
    "nightfall:fixtures-panel.value-rows.reused";

  await expect
    .poll(() => readPerformanceMeasure(page, fixtureCellMetric), {
      timeout: 10_000,
    })
    .toMatchObject({ unit: "count" });
  await expect
    .poll(() => readPerformanceMeasure(page, fixtureFrameMetric), {
      timeout: 10_000,
    })
    .toMatchObject({ unit: "ms" });
  await expect
    .poll(() => readPerformanceMeasure(page, fixtureValueRowsRebuiltMetric), {
      timeout: 10_000,
    })
    .toMatchObject({ unit: "count" });

  await refreshParameterMapIdentity(page);
  await expect
    .poll(() => readPerformanceMeasure(page, fixtureValueRowsReusedMetric), {
      timeout: 10_000,
    })
    .toMatchObject({ unit: "count" });

  await seedGridData(page);
  await openLayerGrid(page);
  const layerPanel = page.locator(
    `[data-panel-kind="layer"][data-panel-id="${LAYER_PANEL_ID}"]`,
  );
  await expect(layerPanel).toBeVisible();
  await layerPanel
    .getByRole("button", { name: "Expand all layers" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(
    layerPanel.getByRole("gridcell", { name: "rgb(180, 20, 0)" }),
  ).toBeVisible();

  await updateGridData(page);
  await expect(
    layerPanel.getByRole("gridcell", { name: "rgb(42, 84, 0)" }),
  ).toBeVisible();

  const layerCellMetric = `nightfall:data-grid.layers.${LAYER_PANEL_ID}.0.cell-resolves`;

  await expect
    .poll(() => readPerformanceMeasure(page, layerCellMetric), {
      timeout: 10_000,
    })
    .toMatchObject({ unit: "count" });

  const fixtureCellStats = await readPerformanceMeasure(
    page,
    fixtureCellMetric,
  );
  const layerCellStats = await readPerformanceMeasure(page, layerCellMetric);
  expect(fixtureCellStats.lastMs).toBeGreaterThan(0);
  expect(layerCellStats.lastMs).toBeGreaterThan(0);
});
