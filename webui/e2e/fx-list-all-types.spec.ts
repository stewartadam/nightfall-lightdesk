// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const DIALOG_MODULE_ID = 901;
const FIXTURE_IDS = [1, 2] as const;
const INITIAL_MODULE_ID = 900;
const REGULAR_FX_ID = 903;
const REGULAR_FX_UID = "90300000-0000-0000-0000-000000000001";
const STEP_FX_ID = 904;
const STEP_FX_UID = "90400000-0000-0000-0000-000000000001";

/** Opens the FX list scenario against a fresh, empty backend showfile. */
async function openOwnedFxListApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.fx?.get) &&
      Boolean((window as any).appStores?.fxModules?.get) &&
      Boolean((window as any).appStores?.stepFx?.get),
    undefined,
    { timeout: 20_000 },
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          fixtures: Object.keys(stores.fixtures.get()).length,
          fx: Object.keys(stores.fx.get()).length,
          fxModules: Object.keys(stores.fxModules.get()).length,
          stepFx: Object.keys(stores.stepFx.get()).length,
        };
      }),
    )
    .toEqual({ fixtures: 0, fx: 0, fxModules: 0, stepFx: 0 });
}

/** Sends an application command and requires its terminal success result. */
async function sendCommand(
  page: Page,
  module: string,
  command: object,
): Promise<void> {
  await page.evaluate(
    async ({ commandModule, commandPayload }) => {
      const stores = (window as any).appStores;
      const result = await stores.sendAndAwait({
        module: commandModule,
        command: commandPayload,
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`FX list command failed: ${JSON.stringify(result)}`);
      }
    },
    { commandModule: module, commandPayload: command },
  );
}

/** Stores the two exact fixture targets referenced by module selection edits. */
async function storeOwnedFixtures(page: Page): Promise<void> {
  for (const fixtureId of FIXTURE_IDS) {
    await sendCommand(page, "FixtureLibraryCommand", {
      type: "CreateFixtureFromLibrary",
      data: {
        id: fixtureId,
        make: "Generic",
        model: "Moving Head RGBW",
        mode: "Spot",
        label: `Owned FX List Fixture ${fixtureId}`,
        update_existing_ids: [],
        update_existing_only: false,
      },
    });
  }
  await expect
    .poll(() =>
      page.evaluate((fixtureIds) => {
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as Array<{ identifiers: { id: number } }>;
        return fixtureIds.every((fixtureId) =>
          fixtures.some((fixture) => fixture.identifiers.id === fixtureId),
        );
      }, FIXTURE_IDS),
    )
    .toBe(true);
}

/** Seeds list-only regular and step FX records without inheriting sample effects. */
async function seedOwnedListFx(page: Page): Promise<void> {
  await page.evaluate(
    ({ regularFxId, regularFxUid, stepFxId, stepFxUid }) => {
      const stores = (window as any).appStores;
      stores.fx.set({
        [regularFxUid]: {
          identifiers: {
            id: regularFxId,
            uid: regularFxUid,
            label: "Owned Regular FX",
          },
          selection: {
            source: { type: "Fixture", data: { fixture_id: 1 } },
            clauses: [],
          },
          attributes: {},
        },
      });
      stores.stepFx.set({
        [stepFxUid]: {
          identifiers: {
            id: stepFxId,
            uid: stepFxUid,
            label: "Owned Step FX",
          },
          selection: {
            source: { type: "Fixture", data: { fixture_id: 1 } },
            clauses: [],
          },
          timing: { beat_duration: { secs: 1, nanos: 0 } },
          phase: { waypoints: [0, 1] },
          direction: "Forward",
          cycle_scale: { type: "Auto" },
          lanes: [
            {
              attribute: { type: "Intensity" },
              absolute: {
                steps: [1, 0].map((value) => ({
                  uid: crypto.randomUUID(),
                  target: { type: "AbsolutePercent", data: { value } },
                  width_beats: 1,
                  transition: { start: 0, end: 1 },
                  curve: { type: "Snap", data: {} },
                })),
              },
            },
          ],
        },
      });
    },
    {
      regularFxId: REGULAR_FX_ID,
      regularFxUid: REGULAR_FX_UID,
      stepFxId: STEP_FX_ID,
      stepFxUid: STEP_FX_UID,
    },
  );
}

/** Stores the module FX shown before the add-module dialog flow. */
async function storeInitialModuleFx(page: Page): Promise<void> {
  await sendCommand(page, "FxModuleCommand", {
    type: "StoreFxModule",
    data: {
      identifiers: {
        id: INITIAL_MODULE_ID,
        uid: "90000000-0000-0000-0000-000000000001",
        label: "Spec Module",
      },
      module_name: "sparkle",
      selection: {
        source: { type: "Fixture", data: { fixture_id: 1 } },
        clauses: [],
      },
      config: { seed: "5" },
      merge: false,
    },
  });
}

/** Returns the stored UID for an exact module FX numeric ID. */
async function moduleUidById(
  page: Page,
  moduleId: number,
): Promise<string | undefined> {
  return page.evaluate((targetId) => {
    const modules = Object.values(
      (window as any).appStores.fxModules.get(),
    ) as Array<{ identifiers: { id: number; uid: string } }>;
    return modules.find((moduleFx) => moduleFx.identifiers.id === targetId)
      ?.identifiers.uid;
  }, moduleId);
}

/** Removes backend records and browser-only FX seeds owned by this scenario. */
async function cleanupOwnedFxListData(page: Page): Promise<void> {
  const owned = await page.evaluate(
    ({ fixtureIds, moduleIds }) => {
      const stores = (window as any).appStores;
      const fixtures = Object.values(stores.fixtures.get()) as Array<{
        identifiers: { id: number };
      }>;
      const modules = Object.values(stores.fxModules.get()) as Array<{
        identifiers: { id: number };
      }>;
      return {
        fixtureIds: fixtureIds.filter((id) =>
          fixtures.some((fixture) => fixture.identifiers.id === id),
        ),
        moduleIds: moduleIds.filter((id) =>
          modules.some((moduleFx) => moduleFx.identifiers.id === id),
        ),
      };
    },
    {
      fixtureIds: [...FIXTURE_IDS],
      moduleIds: [INITIAL_MODULE_ID, DIALOG_MODULE_ID],
    },
  );
  for (const moduleId of owned.moduleIds) {
    await sendCommand(page, "FxModuleCommand", {
      type: "DeleteFxModule",
      data: moduleId,
    });
  }
  for (const fixtureId of owned.fixtureIds) {
    await sendCommand(page, "FixtureCommand", {
      type: "DeleteFixture",
      data: fixtureId,
    });
  }
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.fx.set({});
    stores.stepFx.set({});
    stores.availableFxModules.set([]);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          fixtures: Object.keys(stores.fixtures.get()).length,
          fx: Object.keys(stores.fx.get()).length,
          fxModules: Object.keys(stores.fxModules.get()).length,
          stepFx: Object.keys(stores.stepFx.get()).length,
        };
      }),
    )
    .toEqual({ fixtures: 0, fx: 0, fxModules: 0, stepFx: 0 });
}

/** Verifies owned regular, step, and module FX across grid, list, and properties views. */
test("fx list shows regular, step, and module fx in grid and list views", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await openOwnedFxListApp(page, backendSlot.backendPort);
  await storeOwnedFixtures(page);
  await seedOwnedListFx(page);
  await storeInitialModuleFx(page);

  try {
    const fxTab = page.getByRole("tab", { name: "Fx" });
    await expect(fxTab).toBeVisible();
    await fxTab.click();

    await expect(
      page.getByRole("button", {
        name: new RegExp(`${STEP_FX_ID}: Owned Step FX`, "i"),
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`${REGULAR_FX_ID}: Owned Regular FX`, "i"),
      }),
    ).toBeVisible();

    const gridCard = page.getByRole("button", {
      name: new RegExp(`${INITIAL_MODULE_ID}: Spec Module`, "i"),
    });
    await expect(gridCard).toBeVisible();
    await expect(gridCard.locator("svg")).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath("fx-list-grid.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Add effect" }).click();
    await expect(
      page.getByRole("button", { name: "Regular FX", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Step FX", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Module FX", exact: true }).click();
    const moduleDialog = page.getByRole("dialog", { name: "Add Module FX" });
    await expect(
      moduleDialog.getByRole("heading", { name: "Add Module FX" }),
    ).toBeVisible();

    await page.evaluate(() => {
      const stores = (
        window as unknown as Window & {
          appStores: {
            availableFxModules: {
              set: (modules: Array<{ name: string; filename: string }>) => void;
            };
          };
        }
      ).appStores;
      stores.availableFxModules.set([
        { name: "dialog-module", filename: "dialog-module.wasm" },
      ]);
    });
    await moduleDialog.getByLabel("Module").selectOption("dialog-module");

    await moduleDialog
      .getByRole("textbox", { name: "ID" })
      .fill(String(DIALOG_MODULE_ID));
    await moduleDialog
      .getByRole("textbox", { name: "Label" })
      .fill("Dialog Module");
    await moduleDialog.getByLabel("Config").fill("speed=4\nseed=8");
    await moduleDialog.getByRole("button", { name: "Create" }).click();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`${DIALOG_MODULE_ID}: Dialog Module`, "i"),
      }),
    ).toBeVisible();
    await expect
      .poll(() => moduleUidById(page, DIALOG_MODULE_ID))
      .not.toBeUndefined();
    const dialogModuleUid = await moduleUidById(page, DIALOG_MODULE_ID);
    if (!dialogModuleUid) {
      throw new Error("dialog module did not hydrate with an owned UID");
    }
    await sendCommand(page, "FxModuleCommand", {
      type: "StoreFxModule",
      data: {
        identifiers: {
          id: DIALOG_MODULE_ID,
          uid: dialogModuleUid,
          label: "Dialog Module",
        },
        module_name: "dialog-module",
        selection: {
          source: {
            type: "Add",
            data: {
              lhs: {
                type: "FixtureMap",
                data: {
                  fixtures: { start: 323, end: 323 },
                  elements: { type: "Range", data: { start: 20, end: 1 } },
                },
              },
              rhs: {
                type: "FixtureMap",
                data: {
                  fixtures: { start: 322, end: 322 },
                  elements: { type: "Range", data: { start: 20, end: 1 } },
                },
              },
            },
          },
          clauses: [
            { type: "Blocks", data: { axis: "X", amount: 4 } },
            { type: "Mirror", data: "X" },
            { type: "Grid", data: { type: "Width", data: 30 } },
          ],
        },
        config: {
          speed: "4",
          seed: "8",
        },
        merge: false,
      },
    });

    await page.getByRole("button", { name: "Switch to list view" }).click();
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const api = (
        window as unknown as Window & {
          appStores: {
            dockApi: { get: () => any };
          };
        }
      ).appStores.dockApi.get();
      if (!api.getPanel("panel-PropertiesInspector")) {
        api.addPanel({
          id: "panel-PropertiesInspector",
          component: "PropertiesInspector",
          title: "Properties",
        });
      }
      const fxPanel = api.getPanel("panel-FxList");
      const propertiesPanel = api.getPanel("panel-PropertiesInspector");
      propertiesPanel?.api.moveTo({
        group: fxPanel?.api.group,
        position: "center",
      });
    });

    await page.getByRole("tab", { name: "Fx" }).click();
    await page
      .getByRole("gridcell", { name: "Dialog Module", exact: true })
      .click();
    await page.getByRole("tab", { name: "Properties" }).click();
    const propertiesPanel = page.locator(
      '[data-panel-id="panel-PropertiesInspector"]:visible',
    );
    await expect(
      propertiesPanel.getByText("dialog-module", { exact: true }),
    ).toBeVisible();
    const mappedSelectionButton = propertiesPanel.getByRole("button", {
      name: /Fixture 323\.\(20>1\) \+ Fixture 322\.\(20>1\) \| Blocks 4 \| Mirror \| Grid 30/,
    });
    await expect(mappedSelectionButton).toBeVisible();
    await mappedSelectionButton.click();
    await page
      .getByPlaceholder("Fixture 1, Fixture 1>10, or Group 1")
      .fill("Fixture 2");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () =>
        page.evaluate((moduleId) => {
          const modules = (
            window as unknown as Window & {
              appStores: { fxModules: { get: () => Record<string, any> } };
            }
          ).appStores.fxModules.get();
          return Object.values(modules).find(
            (fxModule: any) => fxModule.identifiers.id === moduleId,
          )?.selection.source;
        }, DIALOG_MODULE_ID),
      )
      .toEqual({
        type: "Fixture",
        data: { fixture_id: 2, element_index: null },
      });
    await expect(
      propertiesPanel.getByRole("button", { name: "Fixture 2", exact: true }),
    ).toBeVisible();

    const configEditor = propertiesPanel.getByLabel("Config");
    await expect(configEditor).toHaveValue("seed=8\nspeed=4");
    await configEditor.fill("speed=7\nseed=9");
    await propertiesPanel.getByRole("button", { name: "Save Config" }).click();

    await expect
      .poll(async () =>
        page.evaluate((moduleId) => {
          const modules = (
            window as unknown as Window & {
              appStores: { fxModules: { get: () => Record<string, any> } };
            }
          ).appStores.fxModules.get();
          return Object.values(modules).find(
            (fxModule: any) => fxModule.identifiers.id === moduleId,
          )?.config;
        }, DIALOG_MODULE_ID),
      )
      .toEqual({ speed: "7", seed: "9" });

    await page.screenshot({
      path: testInfo.outputPath("fx-list-list.png"),
      fullPage: true,
    });
  } finally {
    await cleanupOwnedFxListData(page);
  }
});
