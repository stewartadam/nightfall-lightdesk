// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ParameterMap } from "../state/appStores";
import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const FIXTURE_UID = "33333333333333333333333333333333";

/** Seeds a compact fixture grid row with fanned-timing style value metadata. */
async function seedFannedFixtureState(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds parameter metadata for the requested fixture attribute. */
    const parameter = (attribute: string) => ({
      resolution: "Coarse",
      attribute: { type: attribute },
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: "LTP",
      use_grandmaster: true,
    });

    stores.attributeMetadata.set([
      {
        key: "Green",
        attribute: { type: "Green" },
        label: "Green",
        category: "Color",
        sort_order: 1,
      },
      {
        key: "Tilt",
        attribute: { type: "Tilt" },
        label: "Tilt",
        category: "Position",
        sort_order: 2,
      },
    ]);

    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 601, uid: fixtureUid, label: "Fixture 601" },
        make: "E2E",
        model: "Fanned Timing Fixture",
        mode: "Fanned",
        elements: [
          {
            label: "Tilt Axis",
            parameters: [parameter("Tilt")],
          },
          {
            label: "Emitter 1",
            parameters: [parameter("Green")],
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
            color: "rgb(0, 255, 0)",
            raw: { Green: 128, Tilt: 64 },
            absolute: {
              Green: { type: "Absolute", data: { value: 255 } },
              Tilt: { type: "Absolute", data: { value: 128 } },
            },
            relative: {},
            elements: [
              {
                elementIndex: 1,
                raw: { Tilt: 64 },
                absolute: { Tilt: { type: "Absolute", data: { value: 128 } } },
                relative: {},
              },
              {
                elementIndex: 2,
                raw: { Green: 128 },
                absolute: {
                  Green: { type: "Absolute", data: { value: 255 } },
                },
                relative: {},
              },
            ],
          },
        ],
      ]),
    );

    stores.layerStack.set([
      {
        creator: "Fanned Timing",
        priority: 10,
        is_releasing: false,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              { Tilt: { type: "Absolute", data: { value: 128 } } },
              { Green: { type: "Absolute", data: { value: 255 } } },
            ],
          },
        ],
        asserted_relative_values: [],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Tilt: 64 }, { Green: 128 }],
          },
        ],
        computed_transitioning: [],
      },
    ]);
  }, FIXTURE_UID);
}

/** Activates the store-seeded fixture grid for transition indicator assertions. */
async function openFixtureGrid(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const panel = api.getPanel("panel-FixtureGrid");
    if (!panel) {
      throw new Error("store-seeded fixture grid anchor is missing");
    }
    panel.api.setActive();
    panel.focus();
  });
}

/** Opens an isolated layer stack panel for transition value assertions. */
async function openLayerPanel(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel("panel-FannedTransitionLayer-e2e")?.api.close();
    const panel = api.addPanel({
      id: "panel-FannedTransitionLayer-e2e",
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
  });
}

/** Updates layer-stack transition flags after the grid has rendered. */
async function markFannedValuesTransitioning(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    const [layer] = stores.layerStack.get();
    stores.layerStack.set([
      {
        ...layer,
        computed_transitioning: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Tilt: true }, { Green: true }],
          },
        ],
      },
    ]);
  }, FIXTURE_UID);
}

/** Updates layer-stack values to mimic a clip layer fading out before removal. */
async function markFannedLayerReleasing(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;
    const nextParameters = new Map(stores.parameters.get() as ParameterMap);
    const fixtureParameters = nextParameters.get(fixtureUid);
    if (!fixtureParameters?.elements || fixtureParameters.elements.length < 2) {
      throw new Error("Fanned fixture parameter state is incomplete");
    }
    nextParameters.set(fixtureUid, {
      ...fixtureParameters,
      raw: { ...fixtureParameters.raw, Green: 96, Tilt: 32 },
      elements: [
        {
          ...fixtureParameters.elements[0],
          raw: { ...fixtureParameters.elements[0].raw, Tilt: 32 },
        },
        {
          ...fixtureParameters.elements[1],
          raw: { ...fixtureParameters.elements[1].raw, Green: 96 },
        },
      ],
    });
    stores.parameters.set(nextParameters);

    const [layer] = stores.layerStack.get();
    stores.layerStack.set([
      {
        ...layer,
        is_releasing: true,
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Tilt: 32 }, { Green: 96 }],
          },
        ],
        computed_transitioning: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Tilt: true }, { Green: true }],
          },
        ],
      },
    ]);
  }, FIXTURE_UID);
}

/** Verifies transition text updates when only layer-stack transition metadata changes. */
test("fixture grid refreshes transition text when fanned layer state changes", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedFannedFixtureState(page);
  await openFixtureGrid(page);

  await expect(page.getByRole("gridcell", { name: "601" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Transitioning" })).toHaveCount(0);

  await markFannedValuesTransitioning(page);

  const fixturePanel = page.locator(
    '[data-panel-kind="fixtures"][data-panel-id="panel-FixtureGrid"]',
  );
  const risingCell = fixturePanel.getByRole("gridcell", { name: "64" }).first();
  await expect(risingCell).toBeVisible();
  await expect(risingCell).toHaveCSS("color", "rgb(255, 209, 102)");
  await expect(fixturePanel.getByRole("gridcell", { name: "255" })).toHaveCount(
    0,
  );

  await markFannedLayerReleasing(page);

  await expect(
    fixturePanel.getByRole("img", { name: "Transitioning" }),
  ).toHaveCount(0);
  const releaseCellA = fixturePanel
    .getByRole("gridcell", { name: "32" })
    .first();
  const releaseCellB = fixturePanel
    .getByRole("gridcell", { name: "96" })
    .first();
  await expect(releaseCellA).toBeVisible();
  await expect(releaseCellB).toBeVisible();
  await expect(releaseCellA).toHaveCSS("color", "rgb(255, 209, 102)");
  await expect(releaseCellB).toHaveCSS("color", "rgb(255, 209, 102)");
  await expect(fixturePanel.getByRole("gridcell", { name: "255" })).toHaveCount(
    0,
  );

  await openLayerPanel(page);
  const layerPanel = page.locator(
    '[data-panel-kind="layer"][data-panel-id="panel-FannedTransitionLayer-e2e"]',
  );
  await layerPanel.getByRole("button", { name: "Expand all layers" }).click();
  await expect(
    layerPanel.getByRole("img", { name: "Transitioning" }),
  ).toHaveCount(0);
  await expect(
    layerPanel.getByRole("gridcell", { name: "32" }).first(),
  ).toBeVisible();
  await expect(
    layerPanel.getByRole("gridcell", { name: "96" }).first(),
  ).toBeVisible();
  await expect(layerPanel.getByRole("gridcell", { name: "255" })).toHaveCount(
    0,
  );
});
