// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { cp } from "node:fs/promises";
import { join } from "node:path";
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
import {
  seedStartupShowfileName,
  waitForDockviewApp,
} from "./showfile-startup";

const cueUid = "7ee293f49ce745c198aed2f022343001";
const fixtureUid = "7ee293f49ce745c198aed2f022341001";
const panelId = "single-element-cue-editor";

/** Opens the seeded cue through the normal editor panel. */
async function openCue(page: Page): Promise<void> {
  await waitForDockviewApp(page);
  await page.evaluate(
    ({ cueUid, panelId }) => {
      const api = (window as any).appStores.dockApi.get();
      const existing = api.getPanel(panelId);
      if (existing) api.removePanel(existing);
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Single-element cue",
        params: { initialPanelId: panelId, initialCueUid: cueUid },
        position: { referencePanel: "panel-FixtureGrid", direction: "within" },
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
    VirtualIntensity: "220",
    Red: "25",
    Green: "70",
    Blue: "255",
  })) {
    const cell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey(attribute),
      identifierColumnKey: "id",
      identifierText: "1",
    });
    await expect(cell).toHaveText(value);
  }
  await panel.screenshot({
    path: testInfo.outputPath("single-element-values.png"),
  });
  let red = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: "1",
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
        { cueUid, fixtureUid },
      ),
    )
    .toEqual([
      {
        refs: Array.from({ length: 6 }, (_, index) => ({
          fixture_uid: `7ee293f49ce745c198aed2f02234100${index + 1}`,
          index: 1,
        })),
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
    identifierText: "1",
  });
  await expect(red).toHaveText("50%");
  const otherRed = await gridCellByIdentifier(grid, {
    columnKey: cueGridAttributeValueColumnKey("Red"),
    identifierColumnKey: "id",
    identifierText: "2",
  });
  await expect(otherRed).toHaveText("25");
  for (const [id, attribute, value] of [
    ["1", "VirtualIntensity", "60%"],
    ["6", "Blue", "80%"],
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
        page.evaluate(() => {
          const parameters = (window as any).appStores.parameters.get();
          const first = parameters.get("7ee293f49ce745c198aed2f022341001")?.raw;
          const second = parameters.get(
            "7ee293f49ce745c198aed2f022341002",
          )?.raw;
          const last = parameters.get("7ee293f49ce745c198aed2f022341006")?.raw;
          return Boolean(
            first?.Red > second?.Red * 2 &&
              last?.Blue > 0 &&
              last?.Blue < second?.Blue,
          );
        }),
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

/** Exercises the tracked test showfile in the WASM runtime. */
frontendOnlyTest(
  "embedded demo displays and edits single-element cue values",
  async ({ page }, testInfo) => {
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await verifySingleElementValues(page, testInfo);
  },
);

/** Loads a separate copy of the tracked test showfile through the native showfile lifecycle. */
test("native runtime displays and edits single-element cue values", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await cp(
    "test-fixtures/browser-show",
    join(backendSlot.dataDir, "cue-editor-demo.nightfall-show"),
    { recursive: true },
  );
  await seedStartupShowfileName(page, "cue-editor-demo");
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page, { showfileName: "cue-editor-demo" });
  await verifySingleElementValues(page, testInfo);
});
