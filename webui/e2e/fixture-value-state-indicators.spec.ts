// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const FIXTURE_UID = "22222222222222222222222222222222";

/** Opens an isolated frontend shell for local fixture seeding. */
async function openFixtureValueTestApp(page: Page): Promise<void> {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
}

/**
 * Seeds one fixture with manual, shadowed manual, and transitioning value states.
 */
async function seedFixtureValueStates(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds coarse parameter metadata for seeded fixture value data. */
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
      {
        key: "Blue",
        attribute: { type: "Blue" },
        label: "Blue",
        category: "Color",
        sort_order: 3,
      },
      {
        key: "White",
        attribute: { type: "White" },
        label: "White",
        category: "Beam",
        sort_order: 4,
      },
      {
        key: "Yellow",
        attribute: { type: "Yellow" },
        label: "Yellow",
        category: "Color",
        sort_order: 5,
      },
    ]);

    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 7, uid: fixtureUid, label: "Fixture 7" },
        make: "E2E",
        model: "State Bar",
        mode: "RGB",
        elements: [
          {
            label: "Cell 1",
            parameters: [
              parameter("Red"),
              parameter("Green"),
              parameter("Blue"),
              parameter("White"),
              parameter("Yellow"),
            ],
          },
          {
            label: "Cell 2",
            parameters: [parameter("White")],
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
            color: "rgb(100, 32, 64)",
            raw: { Red: 100, Green: 32, Blue: 64, White: 128, Yellow: 84 },
            absolute: {
              Red: { type: "AbsolutePercent", data: { value: 0.9 } },
              Green: { type: "Absolute", data: { value: 32 } },
              White: { type: "AbsolutePercent", data: { value: 0.5 } },
              Yellow: { type: "AbsolutePercent", data: { value: 0.33 } },
            },
            relative: {
              Blue: { type: "RelativePercent", data: { offset: 0.42 } },
            },
            conflicts: new Set(["White"]),
            elements: [
              {
                elementIndex: 1,
                raw: { Red: 100, Green: 32, Blue: 64, White: 64, Yellow: 84 },
                absolute: {
                  Red: { type: "AbsolutePercent", data: { value: 0.9 } },
                  Green: { type: "Absolute", data: { value: 32 } },
                  White: { type: "AbsolutePercent", data: { value: 0.25 } },
                  Yellow: { type: "AbsolutePercent", data: { value: 0.33 } },
                },
                relative: {
                  Blue: { type: "RelativePercent", data: { offset: 0.42 } },
                },
              },
              {
                elementIndex: 2,
                raw: { White: 192 },
                absolute: {
                  White: { type: "AbsolutePercent", data: { value: 0.75 } },
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
        creator: "Programmer",
        priority: -127,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Red: { type: "AbsolutePercent", data: { value: 0.9 } },
                Yellow: { type: "AbsolutePercent", data: { value: 0.33 } },
              },
            ],
          },
        ],
        asserted_relative_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Blue: { type: "RelativePercent", data: { offset: 0.42 } },
              },
            ],
          },
        ],
        computed_values: [
          { fixture_uid: fixtureUid, parameters: [{ Red: 255, Blue: 64 }] },
        ],
        computed_transitioning: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Blue: true }],
          },
        ],
      },
      {
        creator: "Cue 1",
        priority: 10,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Red: { type: "AbsolutePercent", data: { value: 0.9 } },
                Green: { type: "Absolute", data: { value: 32 } },
              },
            ],
          },
        ],
        asserted_relative_values: [],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Red: 100, Green: 32, Blue: 64 }],
          },
        ],
        computed_transitioning: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Green: true }],
          },
        ],
      },
    ]);
  }, FIXTURE_UID);
}

/**
 * Seeds sequence-owned absolute intensity values with tracked relative parameter noise.
 */
async function seedSequenceFixtureIntensityValues(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds coarse intensity metadata for seeded fixture value data. */
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
    ]);
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
    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(0, 0, 0)",
            raw: { Intensity: 255 },
            relative: {
              Intensity: { type: "Relative", data: { offset: 0 } },
            },
            conflicts: new Set(["Intensity"]),
            elements: [
              {
                elementIndex: 1,
                color: "rgb(0, 0, 0)",
                raw: { Intensity: 127.5 },
                relative: {
                  Intensity: { type: "Relative", data: { offset: 0 } },
                },
              },
              {
                elementIndex: 2,
                color: "rgb(0, 0, 0)",
                raw: { Intensity: 255 },
                relative: {
                  Intensity: { type: "Relative", data: { offset: 0 } },
                },
              },
            ],
          },
        ],
      ]),
    );
    stores.layerStack.set([
      {
        creator: "sparkles int",
        object_ref: {
          type: "ByUid",
          data: {
            object_type: "Sequence",
            uid: "33333333333333333333333333333333",
          },
        },
        priority: 10,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "AbsolutePercent", data: { value: 0.5 } },
              },
              {
                Intensity: { type: "AbsolutePercent", data: { value: 1 } },
              },
            ],
          },
        ],
        asserted_relative_values: [],
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
 * Seeds a parent fixture assertion with varied child element display values.
 */
async function seedParentAssertedFixtureIntensityValues(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds coarse intensity metadata for seeded fixture value data. */
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
    ]);
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
    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(0, 0, 0)",
            raw: { Intensity: 255 },
            absolute: {
              Intensity: { type: "AbsolutePercent", data: { value: 1 } },
            },
            elements: [
              {
                elementIndex: 1,
                color: "rgb(0, 0, 0)",
                raw: { Intensity: 127.5 },
                absolute: {
                  Intensity: {
                    type: "AbsolutePercent",
                    data: { value: 0.5 },
                  },
                },
              },
              {
                elementIndex: 2,
                color: "rgb(0, 0, 0)",
                raw: { Intensity: 255 },
                absolute: {
                  Intensity: { type: "AbsolutePercent", data: { value: 1 } },
                },
              },
            ],
          },
        ],
      ]),
    );
    stores.layerStack.set([]);
  }, FIXTURE_UID);
}

/**
 * Seeds a fixture whose visible Intensity column is backed by VirtualIntensity metadata.
 */
async function seedVirtualDimmerFixtureValues(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds coarse parameter metadata for virtual dimmer fixture value data. */
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
    ]);
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 320, uid: fixtureUid, label: "Fixture 320" },
        make: "E2E",
        model: "Virtual Dimmer Bar",
        mode: "VDim",
        elements: [
          {
            label: "Pixel 1",
            parameters: [parameter("VirtualIntensity"), parameter("Red")],
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
            color: "rgb(128, 0, 0)",
            raw: { VirtualIntensity: 127.5, Red: 128 },
            absolute: {
              VirtualIntensity: {
                type: "AbsolutePercent",
                data: { value: 0.5 },
              },
            },
            elements: [
              {
                elementIndex: 1,
                color: "rgb(128, 0, 0)",
                raw: { VirtualIntensity: 127.5, Red: 128 },
                absolute: {
                  VirtualIntensity: {
                    type: "AbsolutePercent",
                    data: { value: 0.5 },
                  },
                },
              },
            ],
          },
        ],
      ]),
    );
    stores.layerStack.set([]);
  }, FIXTURE_UID);
}

/**
 * Opens an isolated Fixtures panel instance for fixture value-cell assertions.
 */
async function openFixturesPanel(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel("panel-FixtureValueStates-e2e")?.api.close();
    const panel = api.addPanel({
      id: "panel-FixtureValueStates-e2e",
      component: "FixtureGrid",
      title: "Fixture Value States",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: { initialPanelId: "panel-FixtureValueStates-e2e" },
    });
    panel.api.setActive();
    panel.focus();
  });
}

test("fixture value cells render source and transition color hints", async ({
  page,
}) => {
  await openFixtureValueTestApp(page);

  await seedFixtureValueStates(page);
  await openFixturesPanel(page);

  await expect(page.getByRole("gridcell", { name: "State Bar" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Manual assertion" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("img", { name: "Manual hold shadowed" }),
  ).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Transitioning" })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Aggregate" })).toHaveCount(0);

  const panel = page.locator('[data-panel-id="panel-FixtureValueStates-e2e"]');
  const shadowedManualCell = panel
    .getByRole("gridcell", { name: "90%", exact: true })
    .first();
  const transitioningCell = panel
    .getByRole("gridcell", { name: "64", exact: true })
    .first();
  const transitioningCellId = await transitioningCell.getAttribute("id");
  if (!transitioningCellId) {
    throw new Error("expected transitioning cell id");
  }
  const manualCell = panel
    .getByRole("gridcell", { name: "33%", exact: true })
    .first();
  const aggregateBadge = panel
    .getByRole("img", { name: "Varied element values" })
    .first();
  const aggregateCell = aggregateBadge.locator(
    "xpath=ancestor::*[@role='gridcell'][1]",
  );

  await expect(manualCell).toHaveCSS("color", "rgb(183, 28, 28)");
  await expect(shadowedManualCell).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(transitioningCell).toHaveCSS("color", "rgb(183, 28, 28)");
  await expect(transitioningCell).toHaveCSS(
    "background-color",
    "rgb(89, 74, 0)",
  );
  await expect(manualCell).toHaveCSS("background-color", "rgb(26, 26, 31)");
  await expect(aggregateBadge).toContainText("V");
  await expect(aggregateCell).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(aggregateCell).toContainText("V");

  await expect(shadowedManualCell).toContainText("90%");
  await expect(manualCell).toContainText("33%");
  await expect
    .poll(async () => (await shadowedManualCell.boundingBox())?.width ?? 0)
    .toBe(88);
  await expect
    .poll(async () => (await manualCell.boundingBox())?.width ?? 0)
    .toBe(88);

  await panel.getByLabel("Show DMX").check({ force: true });
  const transitioningOutputCell = panel.locator(`#${transitioningCellId}`);
  await expect(page.getByRole("img", { name: "Transitioning" })).toHaveCount(0);
  await expect(transitioningOutputCell).toHaveCSS("color", "rgb(183, 28, 28)");
  await expect(transitioningOutputCell).toHaveCSS(
    "background-color",
    "rgb(89, 74, 0)",
  );
  await expect(transitioningOutputCell).toContainText("64");
});

test("fixture value cells display top layer sequence intensity values", async ({
  page,
}) => {
  await openFixtureValueTestApp(page);

  await seedSequenceFixtureIntensityValues(page);
  await openFixturesPanel(page);

  const panel = page.locator('[data-panel-id="panel-FixtureValueStates-e2e"]');
  await expect(
    panel.getByRole("gridcell", { name: "RGBPixelTape 120ch" }),
  ).toBeVisible();
  const parentIntensityCell = panel.locator(
    `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}"]`,
  );
  await expect(parentIntensityCell).toContainText("V");
  await expect(parentIntensityCell).not.toContainText("~ 0");

  const fixtureParentCell = panel.locator(
    `[data-grid-column-key="id"][data-grid-row-key="${FIXTURE_UID}"]`,
  );
  await fixtureParentCell.click();
  await expect(fixtureParentCell).toContainText("▼ 310");

  await expect(
    panel.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-1"]`,
    ),
  ).toContainText("50%");
  await expect(
    panel.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-2"]`,
    ),
  ).toContainText("100%");

  await panel.getByLabel("Show DMX").check({ force: true });
  await expect(
    panel.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-1"]`,
    ),
  ).toContainText("127.5");
  await expect(
    panel.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-2"]`,
    ),
  ).toContainText("255");
});

test("fixture parent value cell badges varied children while preserving assertion", async ({
  page,
}) => {
  await openFixtureValueTestApp(page);

  await seedParentAssertedFixtureIntensityValues(page);
  await openFixturesPanel(page);

  const panel = page.locator('[data-panel-id="panel-FixtureValueStates-e2e"]');
  const parentIntensityCell = panel.locator(
    `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}"]`,
  );
  await expect(parentIntensityCell).toContainText("V");
  await expect(parentIntensityCell).toContainText("100%");

  const fixtureParentCell = panel.locator(
    `[data-grid-column-key="id"][data-grid-row-key="${FIXTURE_UID}"]`,
  );
  await fixtureParentCell.click();

  await expect(
    panel.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-1"]`,
    ),
  ).toContainText("50%");
  await expect(
    panel.locator(
      `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}-2"]`,
    ),
  ).toContainText("100%");
});

test("fixture intensity cell badges virtual dimmer parameters", async ({
  page,
}) => {
  await openFixtureValueTestApp(page);

  await seedVirtualDimmerFixtureValues(page);
  await openFixturesPanel(page);

  const panel = page.locator('[data-panel-id="panel-FixtureValueStates-e2e"]');
  const parentIntensityCell = panel.locator(
    `[data-grid-column-key="Intensity_Value"][data-grid-row-key="${FIXTURE_UID}"]`,
  );
  await expect(parentIntensityCell).toContainText("50%");
  await expect(
    parentIntensityCell.getByRole("img", { name: "Virtual dimmer" }),
  ).toBeVisible();
});

/** Verifies right-click exposes the asserting-layer action. */
test("fixture value context menu exposes asserting-layer action", async ({
  page,
}) => {
  await openFixtureValueTestApp(page);

  await seedFixtureValueStates(page);
  await openFixturesPanel(page);

  const panel = page.locator('[data-panel-id="panel-FixtureValueStates-e2e"]');
  await panel.getByRole("gridcell", { name: "33%", exact: true }).click({
    button: "right",
  });
  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Show asserting layer" }),
  ).toBeVisible();
});
