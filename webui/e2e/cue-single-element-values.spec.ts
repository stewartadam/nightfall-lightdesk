// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  cueGridAttributeValueColumnKey,
  gridCellByIdentifier,
} from "./data-grid-selectors";
import {
  expect,
  frontendOnlyTest,
  type Page,
  type TestInfo,
  test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const cueUid = "5e1ec7ed0000400080000000000c0e01";
const panelId = "single-element-cue-editor";
/** Fixture IDs patched by this spec; chosen outside the sample rig's ID ranges. */
const fixtureIds = [9001, 9002, 9003, 9004, 9005, 9006];

/**
 * Patches six single-element RGB fixtures from the built-in library and stores one cue
 * that sets the same inline values on all of them, returning the fixture UIDs in ID order.
 */
async function seedSingleElementCue(page: Page): Promise<string[]> {
  await waitForDockviewApp(page);
  return page.evaluate(
    async ({ cueUid, fixtureIds }) => {
      const stores = (window as any).appStores;
      const created = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixturesFromLibrary",
          data: {
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            fixtures: fixtureIds.map((id: number) => ({
              id,
              label: `Single Element ${id}`,
            })),
          },
        },
      });
      if (created.outcome.type !== "Succeeded") {
        throw new Error(`Unable to patch fixtures: ${JSON.stringify(created)}`);
      }
      const deadline = Date.now() + 10_000;
      let fixtureUids: string[] = [];
      while (Date.now() < deadline) {
        const fixtures = Object.values(stores.fixtures.get()) as any[];
        fixtureUids = fixtureIds
          .map(
            (id: number) =>
              fixtures.find((fixture) => fixture.identifiers.id === id)
                ?.identifiers.uid,
          )
          .filter(Boolean);
        if (fixtureUids.length === fixtureIds.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (fixtureUids.length !== fixtureIds.length) {
        throw new Error("Patched fixtures never reached the fixture store");
      }
      const inline = (value: number) => ({
        type: "Inline",
        data: { type: "Absolute", data: { value } },
      });
      const noTransitions = {
        delay_in: null,
        fade_in: null,
        curve_in: null,
        delay_out: null,
        fade_out: null,
        curve_out: null,
      };
      const stored = await stores.sendAndAwait({
        module: "CueCommand",
        command: {
          type: "StoreCue",
          data: {
            identifiers: { id: 9001, uid: cueUid, label: "Single Element" },
            trigger: { type: "Manual" },
            transitions: noTransitions,
            transitions_by_attribute: {},
            instructions: [
              {
                selection: {
                  source: {
                    type: "Resolved",
                    data: fixtureUids.map((fixture_uid) => ({
                      fixture_uid,
                      index: 1,
                    })),
                  },
                  clauses: [],
                },
                cue_instruction: {
                  values: {
                    Intensity: inline(220),
                    Red: inline(25),
                    Green: inline(70),
                    Blue: inline(255),
                  },
                  transitions_by_attribute: {},
                  transitions_by_fixture_attribute: [],
                  color_path_id: null,
                  transitions: noTransitions,
                },
              },
            ],
            lookahead: null,
            parts: [],
            tracking_flags: { __Composed__: 7 },
            tracking_mode: null,
          },
        },
      });
      if (stored.outcome.type !== "Succeeded") {
        throw new Error(`Unable to store cue: ${JSON.stringify(stored)}`);
      }
      return fixtureUids;
    },
    { cueUid, fixtureIds },
  );
}

/** Opens the seeded cue through the normal editor panel. */
async function openCue(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  await page.evaluate(
    ({ cueUid, panelId }) => {
      const api = (window as any).appStores.dockApi.get();
      // Replace the show's saved layout so no collapsed edge group can hide the editor.
      api.clear();
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Single-element cue",
        params: { initialPanelId: panelId, initialCueUid: cueUid },
      });
      panel.api.setActive();
    },
    { cueUid, panelId },
  );
}

/** Checks visible values, edits one fixture, and verifies the stored selection survives reopening. */
async function verifySingleElementValues(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const fixtureUids = await seedSingleElementCue(page);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => Boolean((window as any).appStores?.cues?.get?.()[uid]),
        cueUid,
      ),
    )
    .toBe(true);
  await openCue(page);
  const panel = page.locator(`[data-cue-editor-panel-id="${panelId}"]:visible`);
  const grid = panel.locator(
    '[data-grid-owner="cue-editor"] [data-grid-kind="tanstack"]',
  );
  await expect(grid).toBeVisible();
  for (const [attribute, value] of Object.entries({
    Intensity: "220",
    Red: "25",
    Green: "70",
    Blue: "255",
  })) {
    const cell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(attribute),
      identifierColumnKey: "id",
      identifierText: String(fixtureIds[0]),
    });
    await expect(cell).toHaveText(value);
  }
  await panel.screenshot({
    path: testInfo.outputPath("single-element-values.png"),
  });
  let red = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: String(fixtureIds[0]),
  });
  await red.click();
  await page.keyboard.press("Enter");
  await red.locator("input").fill("50%");
  await red.locator("input").press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        ({ cueUid, fixtureUid }) => {
          const cue = (window as any).appStores.cues.get()[cueUid];
          return cue.instructions
            .filter((instruction: any) =>
              instruction.selection.source.data.some(
                (ref: any) => ref.fixture_uid === fixtureUid,
              ),
            )
            .map((instruction: any) => ({
              refs: instruction.selection.source.data,
              red: instruction.cue_instruction.values.Red,
              blue: instruction.cue_instruction.values.Blue,
            }));
        },
        { cueUid, fixtureUid: fixtureUids[0] },
      ),
    )
    .toEqual([
      {
        refs: fixtureUids.map((fixture_uid) => ({ fixture_uid, index: 1 })),
        red: {
          type: "Fanned",
          data: {
            values: [
              { type: "AbsolutePercent", data: { value: 0.5 } },
              ...Array.from({ length: 5 }, () => ({
                type: "Absolute",
                data: { value: 25 },
              })),
            ],
          },
        },
        blue: {
          type: "Inline",
          data: { type: "Absolute", data: { value: 255 } },
        },
      },
    ]);
  await openCue(page);
  red = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: String(fixtureIds[0]),
  });
  await expect(red).toHaveText("50%");
  const otherRed = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: String(fixtureIds[1]),
  });
  await expect(otherRed).toHaveText("25");
  for (const [id, attribute, value] of [
    [String(fixtureIds[0]), "Intensity", "60%"],
    [String(fixtureIds[5]), "Blue", "80%"],
  ]) {
    const cell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(attribute),
      identifierColumnKey: "id",
      identifierText: id,
    });
    await cell.click();
    await page.keyboard.press("Enter");
    await cell.locator("input").fill(value);
    await cell.locator("input").press("Enter");
    await expect
      .poll(async () => Number.parseFloat(await cell.innerText()))
      .toBe(Number.parseFloat(value));
    await expect(cell).toContainText("%");
  }
  await panel.screenshot({
    path: testInfo.outputPath("single-element-edited.png"),
  });
  const preview = panel.getByRole("button", { name: "Toggle cue preview" });
  await preview.click();
  try {
    await expect
      .poll(() =>
        page.evaluate((uids) => {
          const parameters = (window as any).appStores.parameters.get();
          const first = parameters.get(uids[0])?.raw;
          const second = parameters.get(uids[1])?.raw;
          const last = parameters.get(uids[uids.length - 1])?.raw;
          return Boolean(
            first?.Red > second?.Red * 2 &&
              last?.Blue > 0 &&
              last?.Blue < second?.Blue,
          );
        }, fixtureUids),
      )
      .toBe(true);
  } finally {
    await testInfo.attach("cue-preview-output", {
      body: JSON.stringify(
        await page.evaluate(() =>
          Array.from((window as any).appStores.parameters.get().entries()),
        ),
      ),
      contentType: "application/json",
    });
    await preview.click();
  }
}

/** Exercises the cue editor against the embedded demo show in the WASM runtime. */
frontendOnlyTest(
  "embedded demo displays and edits single-element cue values",
  async ({ page }, testInfo) => {
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await verifySingleElementValues(page, testInfo);
  },
);

/** Exercises the same cue editor flow against the native engine's sample show. */
test("native runtime displays and edits single-element cue values", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await verifySingleElementValues(page, testInfo);
});
