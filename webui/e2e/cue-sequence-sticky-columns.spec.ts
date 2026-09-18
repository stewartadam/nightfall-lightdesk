// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { gridCellByRowIndex } from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const STICKY_FIXTURE_UID = "111111111111111111111111111111a1";
const STICKY_CUE_UID = "222222222222222222222222222222a2";
const STICKY_SEQUENCE_UID = "333333333333333333333333333333a3";

/** Seeds the fixture, cue, and sequence displayed by sticky-column scenarios. */
async function seedStickyEditorData(page: Page): Promise<void> {
  await page.evaluate(
    ({ cueUid, fixtureUid, sequenceUid }) => {
      const stores = (window as any).appStores;
      const attributes = [
        "Intensity",
        "Red",
        "Green",
        "Blue",
        "Pan",
        "Tilt",
        "Zoom",
        "Iris",
      ];
      const categoryByAttribute: Record<string, string> = {
        Intensity: "Dimmer",
        Red: "Color",
        Green: "Color",
        Blue: "Color",
        Pan: "Position",
        Tilt: "Position",
        Zoom: "Beam",
        Iris: "Beam",
      };

      /** Builds coarse parameter metadata for one seeded fixture attribute. */
      const parameter = (attribute: string) => ({
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
      });

      /** Builds an embedded sequence setup or release cue. */
      const metaCue = (uid: string, label: string) => ({
        identifiers: { id: 0, uid, label },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        tracking_flags: "HTP",
      });

      const values = Object.fromEntries(
        attributes.map((attribute, index) => [
          attribute,
          {
            type: "Inline",
            data: {
              type: "AbsolutePercent",
              data: { value: (index + 1) / attributes.length },
            },
          },
        ]),
      );
      const raw = Object.fromEntries(
        attributes.map((attribute, index) => [
          attribute,
          ((index + 1) / attributes.length) * 255,
        ]),
      );

      stores.attributeMetadata.set(
        attributes.map((attribute, index) => ({
          key: attribute,
          attribute: { type: attribute },
          label: attribute,
          category: categoryByAttribute[attribute] ?? "Other",
          sort_order: index,
        })),
      );
      stores.fixtures.set({
        [fixtureUid]: {
          identifiers: { id: 301, uid: fixtureUid, label: "Sticky Fixture" },
          make: "E2E",
          model: "Sticky Attribute Fixture",
          mode: "Default",
          elements: [
            {
              label: "Main",
              parameters: attributes.map(parameter),
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
              raw,
              relative: {},
              conflicts: new Set(),
              elements: [
                {
                  elementIndex: 1,
                  color: "rgb(0, 0, 0)",
                  raw,
                  relative: {},
                },
              ],
            },
          ],
        ]),
      );
      stores.cues.set({
        [cueUid]: {
          identifiers: {
            id: 101,
            uid: cueUid,
            label: "Cue Sticky Columns E2E",
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
                values,
                transitions: {},
                transitions_by_attribute: {},
                transitions_by_fixture_attribute: [],
              },
            },
          ],
          parts: [],
          tracking_flags: "HTP",
        },
      });
      stores.sequences.set({
        [sequenceUid]: {
          identifiers: {
            id: 201,
            uid: sequenceUid,
            label: "Sequence Sticky Columns E2E",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue("444444444444444444444444444444a4", "Setup"),
          release_cue: metaCue("555555555555555555555555555555a5", "Release"),
          default_timing: {
            delay_in: { type: "Fixed", data: { secs: 0, nanos: 0 } },
            fade_in: { type: "Fixed", data: { secs: 1, nanos: 0 } },
            curve_in: "Linear",
            delay_out: { type: "Fixed", data: { secs: 0, nanos: 0 } },
            fade_out: { type: "Fixed", data: { secs: 1, nanos: 0 } },
            curve_out: "Linear",
          },
          tracking_mode: { type: "Flags", data: { __Composed__: 7 } },
        },
      });
      stores.cueDefinitionsLoaded.set(true);
      stores.sequenceDefinitionsLoaded.set(true);
    },
    {
      cueUid: STICKY_CUE_UID,
      fixtureUid: STICKY_FIXTURE_UID,
      sequenceUid: STICKY_SEQUENCE_UID,
    },
  );
}

/**
 * Opens a cue editor panel backed by scenario-owned cue data.
 */
async function openSeededCueEditor(page: Page): Promise<string> {
  return await page.evaluate((cueUid) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const panelId = "panel-CueEditor-sticky-columns-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: "Cue Sticky Columns E2E",
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
    return panelId;
  }, STICKY_CUE_UID);
}

/**
 * Opens a sequence editor panel backed by scenario-owned sequence data.
 */
async function openSeededSequenceEditor(page: Page): Promise<string> {
  return await page.evaluate((sequenceUid) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const panelId = "panel-SequenceEditor-sticky-columns-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Sticky Columns E2E",
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
  }, STICKY_SEQUENCE_UID);
}

/**
 * Scrolls a data grid horizontally and returns the before and after x position for a cell.
 */
async function cellXAfterHorizontalScroll(
  grid: Locator,
  cell: Locator,
): Promise<{ before: number; after: number; scrollLeft: number }> {
  await grid.evaluate((element) => {
    element.scrollLeft = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBe(0);
  const beforeBox = await cell.boundingBox();
  expect(beforeBox).not.toBeNull();
  await grid.evaluate((element) => {
    element.scrollLeft = 600;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const afterBox = await cell.boundingBox();
  expect(afterBox).not.toBeNull();
  return {
    before: beforeBox!.x,
    after: afterBox!.x,
    scrollLeft: await grid.evaluate((element) => element.scrollLeft),
  };
}

/**
 * Verifies cue editor keeps the cue ID and label columns visible during horizontal scroll.
 */
test("cue editor keeps ID and label sticky while horizontally scrolling", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.setViewportSize({ width: 600, height: 700 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedStickyEditorData(page);
  const panelId = await openSeededCueEditor(page);

  const gridOwner = page
    .locator(`[data-panel-id="${panelId}"]:visible`)
    .locator('[data-grid-owner="cue-editor"]');
  const grid = gridOwner.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  const idCell = gridCellByRowIndex(grid, { columnKey: "id", rowIndex: 0 });
  const labelCell = gridCellByRowIndex(grid, {
    columnKey: "label",
    rowIndex: 0,
  });
  await expect(idCell).toBeVisible();
  await expect(labelCell).toBeVisible();

  const idPositions = await cellXAfterHorizontalScroll(grid, idCell);
  const labelPositions = await cellXAfterHorizontalScroll(grid, labelCell);

  expect(idPositions.scrollLeft).toBeGreaterThan(0);
  expect(labelPositions.scrollLeft).toBeGreaterThan(0);
  expect(Math.abs(idPositions.after - idPositions.before)).toBeLessThan(1.5);
  expect(Math.abs(labelPositions.after - labelPositions.before)).toBeLessThan(
    1.5,
  );
});

/**
 * Verifies sequence editor keeps cue ID and label columns visible during horizontal scroll.
 */
test("sequence editor keeps cue ID and label sticky while horizontally scrolling", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedStickyEditorData(page);
  const panelId = await openSeededSequenceEditor(page);

  const gridOwner = page
    .locator(`[data-panel-id="${panelId}"]:visible`)
    .locator('[data-grid-owner="sequence-editor"]');
  const grid = gridOwner.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  const cueIdCell = gridCellByRowIndex(grid, {
    columnKey: "cue_id",
    rowIndex: 0,
  });
  const labelCell = gridCellByRowIndex(grid, {
    columnKey: "label",
    rowIndex: 0,
  });
  await expect(cueIdCell).toBeVisible();
  await expect(labelCell).toBeVisible();

  const cueIdPositions = await cellXAfterHorizontalScroll(grid, cueIdCell);
  const labelPositions = await cellXAfterHorizontalScroll(grid, labelCell);

  expect(cueIdPositions.scrollLeft).toBeGreaterThan(0);
  expect(labelPositions.scrollLeft).toBeGreaterThan(0);
  expect(Math.abs(cueIdPositions.after - cueIdPositions.before)).toBeLessThan(
    1.5,
  );
  expect(Math.abs(labelPositions.after - labelPositions.before)).toBeLessThan(
    1.5,
  );
});
