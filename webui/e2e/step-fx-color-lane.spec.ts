// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const GREEN_BLUEPRINT_UID = "c0104000000000000000000000000001";

/** Opens an isolated app session with RGBW fixtures and one green color Blueprint. */
async function openColorLaneApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    const initializationKey = "step-fx-color-e2e-storage-initialized";
    if (window.sessionStorage.getItem(initializationKey) !== "true") {
      window.localStorage.clear();
      window.sessionStorage.setItem(initializationKey, "true");
    }
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.stepFx?.get),
  );
  await page.evaluate(async (blueprintUid) => {
    const stores = (window as any).appStores;
    for (const fixtureId of [1, 2, 3, 4]) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Color Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`fixture creation failed: ${JSON.stringify(result)}`);
      }
    }
    const blueprintResult = await stores.sendAndAwait({
      module: "BlueprintCommand",
      command: {
        type: "StoreBlueprint",
        data: {
          identifiers: { id: 7, uid: blueprintUid, label: "Green" },
          values: {
            Red: {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value: 0 } },
            },
            Green: {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value: 1 } },
            },
            Blue: {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value: 0 } },
            },
          },
          inclusion_settings: {
            inclusion_mode: "REFERENCE",
            inclusion_filters: [],
            exclusion_filters: [],
          },
          references: { palettes: [], fx: [] },
        },
      },
    });
    if (blueprintResult.outcome.type !== "Succeeded") {
      throw new Error(
        `blueprint creation failed: ${JSON.stringify(blueprintResult)}`,
      );
    }
  }, GREEN_BLUEPRINT_UID);
}

/** Returns the sole stored Step FX definition from the browser store. */
async function storedStepFx(page: Page): Promise<any | undefined> {
  return page.evaluate(
    () => Object.values((window as any).appStores.stepFx.get())[0],
  );
}

/** Opens Properties, commits a selection expression, and refocuses the editor. */
async function setEditorSelection(
  page: Page,
  editor: Locator,
  selection: string,
): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const editorPanel = api.panels.find((candidate: any) =>
      candidate.id.startsWith("step-fx-editor-"),
    );
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
      });
    }
    editorPanel.api.setActive();
    editorPanel.focus();
  });
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  const properties = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]:visible',
  );
  await properties.getByLabel("Selection").fill(selection);
  await properties.getByRole("button", { name: "Apply" }).click();
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const editorPanel = api.panels.find((candidate: any) =>
      candidate.id.startsWith("step-fx-editor-"),
    );
    editorPanel.api.setActive();
    editorPanel.focus();
  });
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(editor).toBeVisible();
}

/** Adds one attribute lane through the editor's attribute search. */
async function addAttributeLane(editor: Locator, name: string): Promise<void> {
  const search = editor.getByRole("searchbox", { name: "Search attributes" });
  await search.fill(name);
  await editor
    .getByRole("menu", { name: "Attributes" })
    .getByRole("menuitemcheckbox", { name, exact: true })
    .click();
  await search.press("Escape");
  await expect(
    editor.getByRole("button", { name: `Remove ${name} lane`, exact: true }),
  ).toBeVisible();
}

/** Verifies the color lane replaces RGB lanes, shadows White, and builds steps from Blueprints. */
test("Step FX color lane replaces RGB lanes and adds Blueprint color steps", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await openColorLaneApp(page, backendSlot.backendPort);
  await page.getByRole("tab", { name: "Fx" }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Step FX", exact: true }).click();

  const editor = page.locator("[data-step-fx-editor]");
  await expect(editor).toBeVisible();
  await setEditorSelection(page, editor, "Fixture 1>4");
  await expect(
    editor
      .getByRole("group", { name: "Waveform preview" })
      .locator("[data-step-fx-preview-index]"),
  ).toHaveCount(4);
  await addAttributeLane(editor, "Red");
  await addAttributeLane(editor, "White");

  await editor.locator("[data-step-fx-add-color-lane]").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Replace the Red lane with a Color lane?");
  await page.screenshot({
    path: testInfo.outputPath("color-lane-replace-confirm.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Replace" }).click();

  await expect(
    editor.getByRole("button", { name: "Remove Red lane", exact: true }),
  ).toHaveCount(0);
  await expect(editor.locator("[data-step-fx-color-lane-tab]")).toBeVisible();
  await expect(editor.locator("[data-step-fx-color-step]")).toHaveCount(2);
  await expect(
    editor.locator('[data-step-fx-color-shadow="White"]'),
  ).toContainText("No effect");
  await expect(editor.locator("[data-step-fx-color-preview-row]")).toHaveCount(
    4,
  );

  await editor.locator('[data-step-fx-color-blueprint="7"]').click();
  await expect(editor.locator("[data-step-fx-color-step]")).toHaveCount(3);
  await expect(
    editor.locator('[data-step-fx-color-step="2"] [data-step-fx-color-swatch]'),
  ).toHaveAttribute("data-step-fx-color-swatch", "#00FF00");

  await editor
    .getByRole("combobox", { name: "Color interpolation space" })
    .selectOption("Hsv");
  await expect(
    editor.getByRole("combobox", { name: "Hue direction" }),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const stored = await storedStepFx(page);
      return {
        lanes: stored?.lanes.map((lane: any) => lane.attribute.type),
        steps: stored?.color?.steps.length,
        space: stored?.color?.interpolation_space,
        blueprint: stored?.color?.steps[2]?.blueprint_uid,
      };
    })
    .toEqual({
      lanes: ["Intensity", "White"],
      steps: 3,
      space: "Hsv",
      blueprint: GREEN_BLUEPRINT_UID,
    });

  const startPreview = editor.getByRole("button", {
    name: "Preview",
    exact: true,
  });
  if (await startPreview.isVisible()) await startPreview.click();
  await expect(
    editor.getByRole("button", { name: "Stop preview" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        const parameters = stores.parameters.get();
        const colors = Object.values(stores.fixtures.get())
          .filter((fixture: any) => fixture.identifiers.id <= 4)
          .map((fixture: any) => {
            const raw = parameters.get(fixture.identifiers.uid)?.raw;
            return [raw?.Red, raw?.Green, raw?.Blue, raw?.White];
          });
        const distinct = new Set(colors.map((color) => color.join(",")));
        return (
          colors.length === 4 &&
          colors.flat().every((value) => typeof value === "number") &&
          distinct.size > 1
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("color-lane-editor.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Stop preview" }).click();
});
