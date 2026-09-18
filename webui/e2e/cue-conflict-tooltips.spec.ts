// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  cueGridAttributeValueColumnKey,
  gridCellByIdentifier,
  gridHeaderByColumnKey,
} from "./data-grid-selectors";
import { expect, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

test.setTimeout(120_000);

/**
 * Verifies cue part conflict cells explain their writers on lingering hover.
 */
test("cue part conflict value cells show explanatory hover tooltip", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);

  const context = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const cueUid = "61616161616161616161616161616161";
    const fixtureUid = "62626262626262626262626262626262";

    /** Builds an inline absolute-percent value source for seeded cue parts. */
    const percent = (value: number) => ({
      type: "Inline",
      data: { type: "AbsolutePercent", data: { value } },
    });

    /** Builds one resolved-fixture cue instruction for the seeded cue part. */
    const instruction = (value: number) => ({
      selection: {
        source: {
          type: "Resolved",
          data: [{ fixture_uid: fixtureUid, index: null }],
        },
        clauses: [],
      },
      cue_instruction: {
        values: { Red: percent(value) },
        transitions: {},
        transitions_by_attribute: {},
        transitions_by_fixture_attribute: [],
      },
    });

    stores.attributeMetadata.set([
      {
        key: "Red",
        attribute: { type: "Red" },
        label: "Red",
        category: "Color",
        sort_order: 0,
      },
    ]);
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: {
          id: 201,
          uid: fixtureUid,
          label: "Conflict Fixture",
        },
        make: "E2E",
        model: "Conflict",
        mode: "Default",
        elements: [
          {
            label: "Main",
            parameters: [
              {
                resolution: "Coarse",
                attribute: { type: "Red" },
                value_polarity: "Unsigned",
                min: 0,
                max: 255,
                offset: { type: "Absolute", data: { value: 0 } },
                is_inverted: false,
                is_snap: false,
                merge_type: "LTP",
                use_grandmaster: false,
              },
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
            color: "rgb(128, 0, 0)",
            raw: { Red: 128 },
            relative: {},
            conflicts: new Set(),
            elements: [
              {
                elementIndex: 1,
                color: "rgb(128, 0, 0)",
                raw: { Red: 128 },
                relative: {},
              },
            ],
          },
        ],
      ]),
    );

    const cue = {
      identifiers: {
        id: 101,
        uid: cueUid,
        label: "Cue Conflict Tooltip E2E",
      },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [
        {
          identifiers: {
            id: 1,
            uid: "63636363636363636363636363636363",
            label: "Red Full",
          },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [instruction(1)],
          tracking_flags: "HTP",
        },
        {
          identifiers: {
            id: 2,
            uid: "64646464646464646464646464646464",
            label: "Red Zero",
          },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [instruction(0)],
          tracking_flags: "HTP",
        },
      ],
      tracking_flags: "HTP",
      tracking_mode: { type: "Flags", data: { __Composed__: 1 } },
    };

    stores.cues.set({ [cueUid]: cue });
    stores.cueDefinitionsLoaded.set(true);

    const api = stores.dockApi.get();
    const panelId = "panel-CueEditor-conflict-tooltip-e2e";
    const referencePanel = api.getPanel("panel-FixtureGrid");
    const panel = api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: "Cue Conflict Tooltip E2E",
      params: {
        initialPanelId: panelId,
        initialCueUid: cueUid,
        initialPartId: 1,
      },
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

    return { fixtureId: 201 };
  });

  const grid = page
    .locator(
      '[data-cue-editor-panel-id="panel-CueEditor-conflict-tooltip-e2e"]:visible',
    )
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await expect(
    gridHeaderByColumnKey(grid, cueGridAttributeValueColumnKey("Red")),
  ).toBeVisible();

  const redCell = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: String(context.fixtureId),
  });
  await expect(redCell).toContainText("100%");
  await redCell.hover();

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Red is asserted by");
  await expect(tooltip).toContainText("p1 @ 100%");
  await expect(tooltip).toContainText(/p2 @ (?:B )?0%/);
  await expect(tooltip).toContainText("with p2 winning");
  await expect(tooltip).toContainText("Cue parts fire together");
  const pointer = tooltip.locator('[data-slot="pointer"]');
  await expect(pointer).toBeVisible();
  await expect
    .poll(() =>
      pointer.evaluate((element) => window.getComputedStyle(element).filter),
    )
    .not.toBe("none");
  const transitionStyles = await tooltip.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      duration: style.transitionDuration,
      property: style.transitionProperty,
    };
  });
  expect(transitionStyles.property).toContain("opacity");
  expect(transitionStyles.duration).not.toBe("0s");
});
