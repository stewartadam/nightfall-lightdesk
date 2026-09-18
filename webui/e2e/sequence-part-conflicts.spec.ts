// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const SEQUENCE_EDITOR_PANEL_ID = "panel-SequenceEditor-part-conflict-e2e";

/** Returns the grid owned by the conflict spec's dedicated sequence editor. */
function sequenceConflictGrid(page: Page) {
  return page
    .locator(
      `[data-component="SequenceEditor"][data-panel-id="${SEQUENCE_EDITOR_PANEL_ID}"]`,
    )
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
}

/** Seeds the complete fixture, cue, and sequence graph for a conflict scenario. */
async function seedSequenceConflictScenario(
  page: Page,
  variant: "conflicting" | "projected-non-conflicting",
): Promise<{ cueId: number; sequenceUid: string }> {
  return await page.evaluate((scenarioVariant) => {
    const stores = (window as any).appStores;
    const cueUid = "81818181818181818181818181818181";
    const sequenceUid = "82828282828282828282828282828282";
    const fixtureUids = [
      "91919191919191919191919191919191",
      "92929292929292929292929292929292",
      "93939393939393939393939393939393",
    ];
    const [fixtureAUid, fixtureBUid, fixtureCUid] = fixtureUids;
    const refA = { fixture_uid: fixtureAUid, index: null };
    const refB = { fixture_uid: fixtureBUid, index: null };
    const refC = { fixture_uid: fixtureCUid, index: null };

    /** Builds a fixed transition mode for seeded cue and sequence timings. */
    const fixed = (secs: number) => ({
      type: "Fixed",
      data: { secs, nanos: 0 },
    });

    /** Builds an inline absolute-percent value source for seeded cue parts. */
    const percent = (value: number) => ({
      type: "Inline",
      data: { type: "AbsolutePercent", data: { value } },
    });

    /** Builds an empty embedded cue used by sequence editor meta rows. */
    const embeddedCue = (label: string, uid: string) => ({
      identifiers: {
        id: 0,
        uid,
        label,
      },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    /** Builds one Red-capable fixture for spatial-selection projection. */
    const fixture = (id: number, uid: string, label: string) => ({
      identifiers: { id, uid, label },
      make: "E2E",
      model: "Sequence Conflict",
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
    });

    /** Builds a red-writing cue instruction for one spatial selection. */
    const instruction = (selection: any, value: number) => ({
      selection,
      cue_instruction: {
        values: { Red: percent(value) },
        transitions: {},
        transitions_by_attribute: {},
        transitions_by_fixture_attribute: [],
      },
    });

    /** Builds a spatial selection with resolved fixture refs and optional clauses. */
    const resolvedSelection = (data: any[], clauses: any[] = []) => ({
      source: { type: "Resolved", data },
      clauses,
    });

    const fixtures = Object.fromEntries(
      fixtureUids.map((uid, index) => [
        uid,
        fixture(201 + index, uid, `Conflict Fixture ${index + 1}`),
      ]),
    );
    stores.attributeMetadata.set([
      {
        key: "Red",
        attribute: { type: "Red" },
        label: "Red",
        category: "Color",
        sort_order: 0,
      },
    ]);
    stores.fixtures.set(fixtures);
    stores.parameters.set(
      new Map(
        fixtureUids.map((uid) => [
          uid,
          {
            uid,
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
        ]),
      ),
    );

    const projectedNonConflict =
      scenarioVariant === "projected-non-conflicting";
    const parts = projectedNonConflict
      ? [
          {
            identifiers: {
              id: 1,
              uid: "85858585858585858585858585858585",
              label: "Subtracts B",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [
              instruction(
                {
                  source: {
                    type: "Sub",
                    data: {
                      lhs: { type: "Resolved", data: [refA, refB] },
                      rhs: { type: "Resolved", data: [refB] },
                    },
                  },
                  clauses: [],
                },
                0,
              ),
            ],
            tracking_flags: "HTP",
          },
          {
            identifiers: {
              id: 2,
              uid: "86868686868686868686868686868686",
              label: "Takes C",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [
              instruction(
                resolvedSelection([refC, refB], [{ type: "Take", data: 1 }]),
                0,
              ),
            ],
            tracking_flags: "HTP",
          },
        ]
      : [
          {
            identifiers: {
              id: 1,
              uid: "85858585858585858585858585858585",
              label: "Red Zero",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [instruction(resolvedSelection([refA]), 0)],
            tracking_flags: "HTP",
          },
        ];

    stores.cues.set({
      [cueUid]: {
        identifiers: {
          id: 401,
          uid: cueUid,
          label: projectedNonConflict
            ? "Sequence Projected Non Conflict"
            : "Sequence Conflict Cue",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          instruction(
            resolvedSelection([projectedNonConflict ? refB : refA]),
            1,
          ),
        ],
        parts,
        tracking_flags: "HTP",
        tracking_mode: { type: "Flags", data: { __Composed__: 1 } },
      },
    });
    stores.sequences.set({
      [sequenceUid]: {
        identifiers: {
          id: 301,
          uid: sequenceUid,
          label: projectedNonConflict
            ? "Sequence Projected Non Conflict E2E"
            : "Sequence Part Conflict E2E",
        },
        steps: [cueUid],
        wrap: false,
        release_on_start: false,
        setup_cue: embeddedCue("Setup", "83838383838383838383838383838383"),
        release_cue: embeddedCue("Release", "84848484848484848484848484848484"),
        default_timing: {
          delay_in: fixed(0),
          fade_in: fixed(0),
          curve_in: "Linear",
          delay_out: fixed(0),
          fade_out: fixed(0),
          curve_out: "Linear",
        },
        tracking_mode: { type: "Flags", data: { __Composed__: 7 } },
      },
    });
    stores.cueDefinitionsLoaded.set(true);
    stores.sequenceDefinitionsLoaded.set(true);

    return { cueId: 401, sequenceUid };
  }, variant);
}

/** Opens the seeded sequence in the sequence editor panel. */
async function openSequenceEditor(
  page: Page,
  sequenceUid: string,
): Promise<void> {
  await page.evaluate((sequenceUid) => {
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-SequenceEditor-part-conflict-e2e";
    api.getPanel(panelId)?.api.close();
    const referencePanel =
      api.getPanel("panel-FixtureGrid") ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Sequence Part Conflict E2E",
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequenceUid,
      },
    });
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
  }, sequenceUid);
}

/** Verifies conflicting cue parts are marked in the sequence editor label column. */
test("sequence editor labels conflicting cue parts with warning icons", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  const seeded = await seedSequenceConflictScenario(page, "conflicting");
  await openSequenceEditor(page, seeded.sequenceUid);

  const grid = sequenceConflictGrid(page);
  await expect(grid).toBeVisible();

  const cueIdCell = grid
    .locator('[role="gridcell"]')
    .filter({ hasText: new RegExp(`▶\\s*${seeded.cueId}`) })
    .first();
  await expect(cueIdCell).toBeVisible();
  await cueIdCell.click();

  const cueLabelCell = grid.locator("#tanstack-cell-1-1");
  await expect(cueLabelCell).toContainText("Sequence Conflict Cue");
  await expect(cueLabelCell).not.toContainText("⚠️");
  await cueLabelCell.hover();
  const cueTooltip = page.getByRole("tooltip");
  await expect(cueTooltip).toContainText(
    "This cue has parts with fixture values that conflict.",
  );

  const baseLabelCell = grid.locator("#tanstack-cell-1-2");
  await expect(baseLabelCell).toContainText("Sequence Conflict Cue");
  await expect(baseLabelCell).not.toContainText("⚠️");
  await baseLabelCell.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(
    "This cue part has fixture values that conflict with another part.",
  );
  await expect(tooltip).toContainText("Open the cue for details.");
  const pointer = tooltip.locator('[data-slot="pointer"]');
  await expect(pointer).toBeVisible();
  await expect
    .poll(() =>
      pointer.evaluate((element) => window.getComputedStyle(element).filter),
    )
    .not.toBe("none");
  const pointerBox = await pointer.boundingBox();
  const baseLabelBox = await baseLabelCell.boundingBox();
  expect(pointerBox).not.toBeNull();
  expect(baseLabelBox).not.toBeNull();
  const pointerCenterX = (pointerBox?.x ?? 0) + (pointerBox?.width ?? 0) / 2;
  const iconCenterX = (baseLabelBox?.x ?? 0) + 16;
  const cellCenterX = (baseLabelBox?.x ?? 0) + (baseLabelBox?.width ?? 0) / 2;
  expect(Math.abs(pointerCenterX - iconCenterX)).toBeLessThan(16);
  expect(Math.abs(pointerCenterX - iconCenterX)).toBeLessThan(
    Math.abs(pointerCenterX - cellCenterX),
  );
  const transitionStyles = await tooltip.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      duration: style.transitionDuration,
      property: style.transitionProperty,
    };
  });
  expect(transitionStyles.property).toContain("opacity");
  expect(transitionStyles.duration).not.toBe("0s");

  const redZeroCell = grid.locator("#tanstack-cell-1-3");
  await expect(redZeroCell).toContainText("Red Zero");
  await expect(redZeroCell).not.toContainText("⚠️");
});

/** Verifies projected selections do not create false conflict warnings. */
test("sequence editor respects selection projection before conflict warnings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  const seeded = await seedSequenceConflictScenario(
    page,
    "projected-non-conflicting",
  );
  await openSequenceEditor(page, seeded.sequenceUid);

  const grid = sequenceConflictGrid(page);
  await expect(grid).toBeVisible();

  const cueIdCell = grid
    .locator('[role="gridcell"]')
    .filter({ hasText: new RegExp(`▶\\s*${seeded.cueId}`) })
    .first();
  await expect(cueIdCell).toBeVisible();
  await cueIdCell.click();

  const cueLabelCell = grid.locator("#tanstack-cell-1-1");
  await expect(cueLabelCell).toContainText("Sequence Projected Non Conflict");
  await cueLabelCell.hover();
  await page.waitForTimeout(700);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const subtractsBCell = grid.locator("#tanstack-cell-1-3");
  await expect(subtractsBCell).toContainText("Subtracts B");
  await subtractsBCell.hover();
  await page.waitForTimeout(700);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const takesCCell = grid.locator("#tanstack-cell-1-4");
  await expect(takesCCell).toContainText("Takes C");
  await takesCCell.hover();
  await page.waitForTimeout(700);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
