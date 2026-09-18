// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  cueGridAttributeValueColumnKey,
  gridCellByIdentifier,
  gridHeaderByColumnKey,
} from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Waits for the app shell stores needed by cue editor tests.
 */
async function waitForCueEditorStores(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.cues?.get),
  );
}

/** Opens a blank backend for the owned cue invalid-edit scenario. */
async function openOwnedCueInvalidEditApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForCueEditorStores(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, fixtures: 0 });
}

/** Stores the canonical fixture and cue used by the invalid-edit assertions. */
async function storeOwnedCueInvalidEditData(
  page: Page,
): Promise<{ cueUid: string; fixtureId: number; panelId: string }> {
  const context = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const fixtureId = Math.floor(900_000 + Math.random() * 50_000);
    const fixtureResult = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Cue Invalid Edit Fixture ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (fixtureResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to create cue invalid-edit fixture: ${JSON.stringify(fixtureResult)}`,
      );
    }

    let fixture: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      fixture = Object.values(stores.fixtures.get()).find(
        (candidate: any) => candidate.identifiers.id === fixtureId,
      );
      if (fixture) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (!fixture)
      throw new Error("owned cue invalid-edit fixture did not load");

    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const cueResult = await stores.sendAndAwait({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          identifiers: {
            id: fixtureId,
            uid: cueUid,
            label: "Cue Invalid Value Edit E2E",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [
            {
              selection: {
                source: {
                  type: "Resolved",
                  data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
                },
                clauses: [],
              },
              cue_instruction: {
                values: {
                  Intensity: {
                    type: "Inline",
                    data: { type: "Absolute", data: { value: 128 } },
                  },
                },
                transitions: {},
                transitions_by_attribute: {},
                transitions_by_fixture_attribute: [],
              },
            },
          ],
          parts: [],
          tracking_flags: "HTP",
        },
      },
    });
    if (cueResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to store cue invalid-edit cue: ${JSON.stringify(cueResult)}`,
      );
    }

    return {
      cueUid,
      fixtureId,
      panelId: "panel-CueEditor-invalid-value-edit-e2e",
    };
  });

  await expect
    .poll(() =>
      page.evaluate(({ cueUid, fixtureId }) => {
        const stores = (window as any).appStores;
        return {
          cue: Boolean(stores.cues.get()[cueUid]),
          fixture: Object.values(stores.fixtures.get()).some(
            (candidate: any) => candidate.identifiers.id === fixtureId,
          ),
        };
      }, context),
    )
    .toEqual({ cue: true, fixture: true });

  await page.evaluate(({ cueUid, panelId }) => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: "Cue Invalid Value Edit E2E",
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
  }, context);

  return context;
}

/**
 * Verifies the owned Intensity cue value is still stored as an absolute value.
 */
async function expectIntensityAbsoluteStored(
  page: Page,
  cueUid: string,
  expectedValue: number,
): Promise<void> {
  await page.waitForFunction(
    ({ cueUid: targetCueUid, expected }) => {
      const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
      const value =
        cue?.instructions?.[0]?.cue_instruction?.values?.Intensity?.data;
      return value?.type === "Absolute" && value.data.value === expected;
    },
    { cueUid, expected: expectedValue },
    { timeout: 5_000 },
  );
}

/**
 * Verifies invalid cue value edits do not clear the value's attribute column.
 */
test("cue editor invalid value edit preserves attribute column", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await openOwnedCueInvalidEditApp(page, backendSlot.backendPort);
  const context = await storeOwnedCueInvalidEditData(page);
  await expectIntensityAbsoluteStored(page, context.cueUid, 128);

  const cuePanel = page.locator(`[data-panel-id="${context.panelId}"]:visible`);
  const grid = cuePanel
    .locator('[data-grid-owner="cue-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const intensityColumnKey = cueGridAttributeValueColumnKey("Intensity");
  await expect(gridHeaderByColumnKey(grid, intensityColumnKey)).toBeVisible();

  const intensityCell = await gridCellByIdentifier(grid, {
    columnKey: intensityColumnKey,
    identifierColumnKey: "id",
    identifierText: String(context.fixtureId),
  });
  await expect(intensityCell).toContainText("128");

  await intensityCell.dblclick();
  const editor = intensityCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("not-a-value");
  await editor.press("Enter");

  await expectIntensityAbsoluteStored(page, context.cueUid, 128);
  await expect(gridHeaderByColumnKey(grid, intensityColumnKey)).toBeVisible();
  await expect(intensityCell).toContainText("128");
});
