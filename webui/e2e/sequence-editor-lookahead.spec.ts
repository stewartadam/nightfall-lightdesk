// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { gridCellByKey, gridHeaderByColumnKey } from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

type Duration = { secs: number; nanos: number };
type TransitionMode = { type: "Fixed"; data: Duration };

type Cue = {
  identifiers: { id: number; uid: string; label: string };
  trigger: { type: "Manual" };
  transitions: Record<string, unknown>;
  transitions_by_attribute: Record<string, unknown>;
  instructions: unknown[];
  lookahead?: boolean;
  parts?: unknown[];
  tracking_flags: "HTP";
};

type Sequence = {
  identifiers: { id: number; uid: string; label: string };
  steps: string[];
  wrap: boolean;
  release_on_start: boolean;
  setup_cue: Cue;
  release_cue: Cue;
  default_timing: {
    delay_in: TransitionMode;
    fade_in: TransitionMode;
    curve_in: "Linear";
    delay_out: TransitionMode;
    fade_out: TransitionMode;
    curve_out: "Linear";
  };
  tracking_mode: {
    type: "Flags";
    data: { __Composed__: number };
  };
};

type SequenceEditorMibContext = {
  cueOneUid: string;
  cueTwoUid: string;
  panelId: string;
};

type SeedLookaheadSequenceOptions = {
  authoredSourceLookahead?: boolean;
  panelSuffix?: string;
  seedProjection?: boolean;
};

/** Seeds a two-cue Lookahead sequence and opens it in the sequence editor. */
async function seedLookaheadSequence(
  page: Page,
  options: SeedLookaheadSequenceOptions = {},
): Promise<SequenceEditorMibContext> {
  return await page.evaluate(
    (seedOptions) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      const sequenceUid = "91919191919191919191919191919191";
      const cueOneUid = "92929292929292929292929292929292";
      const cueTwoUid = "93939393939393939393939393939393";

      /** Builds an empty cue used by lookahead rows and sequence metadata. */
      const cue = (
        id: number,
        uid: string,
        label: string,
        lookahead?: boolean,
      ): Cue => ({
        identifiers: { id, uid, label },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        lookahead,
        parts: [],
        tracking_flags: "HTP",
      });

      const cueOne: Cue = {
        ...cue(901, cueOneUid, "Lookahead Current"),
        lookahead: false,
      };
      const cueTwo: Cue = {
        ...cue(902, cueTwoUid, "Lookahead Target"),
        lookahead: seedOptions.authoredSourceLookahead,
      };
      const sequence: Sequence = {
        identifiers: {
          id: 901,
          uid: sequenceUid,
          label: "Lookahead Column E2E",
        },
        steps: [cueOneUid, cueTwoUid],
        wrap: false,
        release_on_start: false,
        setup_cue: cue(0, "94949494949494949494949494949494", "Setup"),
        release_cue: cue(0, "95959595959595959595959595959595", "Release"),
        default_timing: {
          delay_in: {
            type: "Fixed",
            data: { secs: 0, nanos: 0 },
          },
          fade_in: {
            type: "Fixed",
            data: { secs: 0, nanos: 0 },
          },
          curve_in: "Linear",
          delay_out: {
            type: "Fixed",
            data: { secs: 0, nanos: 0 },
          },
          fade_out: {
            type: "Fixed",
            data: { secs: 0, nanos: 0 },
          },
          curve_out: "Linear",
        },
        tracking_mode: { type: "Flags", data: { __Composed__: 7 } },
      };

      stores.cues.set({ [cueOneUid]: cueOne, [cueTwoUid]: cueTwo });
      stores.sequences.set({ [sequenceUid]: sequence });
      stores.cueDefinitionsLoaded.set(true);
      stores.sequenceDefinitionsLoaded.set(true);
      if (seedOptions.seedProjection) {
        stores.sequenceLookaheadStates.set({
          [sequenceUid]: {
            sequence_uid: sequenceUid,
            rows: [
              {
                cue_uid: cueOneUid,
                part_id: null,
                lookahead_enabled: false,
                source_cue_ids: [902],
              },
              {
                cue_uid: cueOneUid,
                part_id: 0,
                lookahead_enabled: false,
                source_cue_ids: [],
              },
              {
                cue_uid: cueTwoUid,
                part_id: null,
                lookahead_enabled: true,
                source_cue_ids: [],
              },
              {
                cue_uid: cueTwoUid,
                part_id: 0,
                lookahead_enabled: true,
                source_cue_ids: [],
              },
            ],
          },
        });
      }

      const panelId = `panel-SequenceEditor-lookahead-column-${seedOptions.panelSuffix}-e2e`;
      api.getPanel(panelId)?.api.close();
      const panel = api.addPanel({
        id: panelId,
        component: "SequenceEditor",
        title: "Lookahead Column E2E",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: panelId,
          initialSequenceUid: sequenceUid,
        },
      });
      panel.api.setActive();

      return { cueOneUid, cueTwoUid, panelId };
    },
    {
      authoredSourceLookahead: options.authoredSourceLookahead ?? false,
      panelSuffix: options.panelSuffix ?? "projection",
      seedProjection: options.seedProjection ?? true,
    },
  );
}

/** Verifies the sequence editor shows authored and applied lookahead badges. */
test("sequence editor shows lookahead column badges", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
  const context = await seedLookaheadSequence(page);

  const gridOwner = page.locator(
    `.${context.panelId}:visible [data-grid-owner="sequence-editor"]`,
  );
  const grid = gridOwner.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  const labelHeader = gridHeaderByColumnKey(grid, "label");
  const lookaheadHeader = gridHeaderByColumnKey(grid, "lookahead");
  await expect(lookaheadHeader).toBeVisible();

  await grid.evaluate((element) => {
    element.scrollLeft = 12;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect
    .poll(() => grid.evaluate((element) => element.scrollLeft))
    .toBe(12);
  const labelHeaderBox = await labelHeader.boundingBox();
  const lookaheadTextBox = await lookaheadHeader.locator("span").boundingBox();
  expect(labelHeaderBox).not.toBeNull();
  expect(lookaheadTextBox).not.toBeNull();
  expect(lookaheadTextBox!.x).toBeGreaterThanOrEqual(
    labelHeaderBox!.x + labelHeaderBox!.width + 7,
  );
  await expect(lookaheadHeader.locator("span")).toHaveText("Lookahead");
  await gridOwner.screenshot({
    path: test.info().outputPath("sequence-lookahead-header.png"),
  });

  const currentCueMibCell = gridCellByKey(grid, {
    columnKey: "lookahead",
    rowKey: `${context.cueOneUid}:cue`,
  });
  await expect(currentCueMibCell).toContainText("902");
  await expect(
    currentCueMibCell.locator('input[type="checkbox"]'),
  ).not.toBeChecked();

  const sourceCueLookaheadCell = gridCellByKey(grid, {
    columnKey: "lookahead",
    rowKey: `${context.cueTwoUid}:cue`,
  });
  await expect(sourceCueLookaheadCell).toContainText("LA");
  await expect(
    sourceCueLookaheadCell.locator('input[type="checkbox"]'),
  ).toBeChecked();
});

/** Verifies authored Lookahead badges remain visible before backend projection state arrives. */
test("sequence editor shows authored lookahead badge without projection", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
  const context = await seedLookaheadSequence(page, {
    authoredSourceLookahead: true,
    panelSuffix: "authored",
    seedProjection: false,
  });

  const gridOwner = page.locator(
    `.${context.panelId}:visible [data-grid-owner="sequence-editor"]`,
  );
  const grid = gridOwner.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const currentCueMibCell = gridCellByKey(grid, {
    columnKey: "lookahead",
    rowKey: `${context.cueOneUid}:cue`,
  });
  await expect(currentCueMibCell).not.toContainText("902");

  const sourceCueLookaheadCell = gridCellByKey(grid, {
    columnKey: "lookahead",
    rowKey: `${context.cueTwoUid}:cue`,
  });
  await expect(sourceCueLookaheadCell).toContainText("LA");
  await expect(
    sourceCueLookaheadCell.locator('input[type="checkbox"]'),
  ).toBeChecked();
});
