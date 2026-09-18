// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Waits for the loaded showfile layout and backend-backed stores to settle. */
async function waitForApplicationShell(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("region", { name: "Application status bar" })
      .getByRole("status", { name: "Connected", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const stores = (window as Window & { appStores?: Record<string, any> })
      .appStores;
    return Boolean(
      stores?.dockApi?.get?.() &&
        stores?.cueDefinitionsLoaded?.get?.() === true &&
        stores?.sequenceDefinitionsLoaded?.get?.() === true &&
        stores?.timelineDefinitionsLoaded?.get?.() === true &&
        stores?.fxModules?.get?.(),
    );
  });
  await page.waitForTimeout(500);
}

/** Opens the FX panel against a blank backend with no stored effects. */
async function openOwnedFxModuleMutationApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await waitForApplicationShell(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          fx: Object.keys(stores.fx.get()).length,
          fxModules: Object.keys(stores.fxModules.get()).length,
        };
      }),
    )
    .toEqual({ fx: 0, fxModules: 0 });
}

/** Sends a command through the E2E application bridge. */
async function sendCommand(
  page: Page,
  module: string,
  command: object,
): Promise<void> {
  await page.evaluate(
    async ({ commandModule, commandPayload }) => {
      const stores = (
        window as unknown as Window & {
          appStores: { send: (data: object) => Promise<void> };
        }
      ).appStores;
      await stores.send({
        module: commandModule,
        command: commandPayload,
      });
    },
    { commandModule: module, commandPayload: command },
  );
}

/** Finds a module FX numeric ID by label in the E2E store bridge. */
async function moduleFxIdByLabel(
  page: Page,
  label: string,
): Promise<number | undefined> {
  return page.evaluate((targetLabel) => {
    const modules = (
      window as unknown as Window & {
        appStores: {
          fxModules: {
            get: () => Record<
              string,
              { identifiers: { id: number; label: string } }
            >;
          };
        };
      }
    ).appStores.fxModules.get();
    return Object.values(modules).find(
      (moduleFx) => moduleFx.identifiers.label === targetLabel,
    )?.identifiers.id;
  }, label);
}

/** Reports whether a regular FX with the requested label remains in the E2E store bridge. */
async function hasRegularFxLabel(page: Page, label: string): Promise<boolean> {
  return page.evaluate((targetLabel) => {
    const regularFx = (
      window as unknown as Window & {
        appStores: {
          fx: {
            get: () => Record<string, { identifiers: { label: string } }>;
          };
        };
      }
    ).appStores.fx.get();
    return Object.values(regularFx).some(
      (fxEntry) => fxEntry.identifiers.label === targetLabel,
    );
  }, label);
}

/** Verifies stored module FX can move through generic FX commands and be deleted in the FX list. */
test("stored module fx can be moved and removed", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openOwnedFxModuleMutationApp(page, backendSlot.backendPort);

  const fxTab = page.getByRole("tab", { name: "Fx" });
  await fxTab.click();
  await expect(fxTab).toHaveAttribute("aria-selected", "true");
  const fxPanel = page.locator(".panel-FxList");

  await sendCommand(page, "FxModuleCommand", {
    type: "StoreFxModule",
    data: {
      identifiers: {
        id: 990,
        uid: "99000000-0000-0000-0000-000000000001",
        label: "Module Mutation Spec",
      },
      module_name: "mutation-spec",
      selection: {
        source: { type: "Resolved", data: [] },
        clauses: [],
      },
      config: {},
      merge: false,
    },
  });
  await expect(
    fxPanel.getByRole("button", { name: /990: Module Mutation Spec/i }),
  ).toBeVisible();

  await sendCommand(page, "FxCommand", {
    type: "RenameFx",
    data: { id: 990, new_id: 991 },
  });
  await expect
    .poll(() => moduleFxIdByLabel(page, "Module Mutation Spec"))
    .toBe(991);
  const movedModule = fxPanel.getByRole("button", {
    name: /991: Module Mutation Spec/i,
  });
  await expect(movedModule).toBeVisible();
  await movedModule.scrollIntoViewIfNeeded();

  await sendCommand(page, "FxCommand", {
    type: "StoreFx",
    data: {
      identifiers: {
        id: 991,
        uid: "99100000-0000-0000-0000-000000000002",
        label: "Regular Collision Spec",
      },
      selection: {
        source: { type: "Resolved", data: [] },
        clauses: [],
      },
      attributes: {},
    },
  });
  await expect
    .poll(() => hasRegularFxLabel(page, "Regular Collision Spec"))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("fx-module-moved.png"),
    fullPage: true,
  });

  await fxPanel.getByRole("button", { name: "Switch to list view" }).click();
  await fxPanel.getByText("Module Mutation Spec", { exact: true }).click();
  const deleteButton = fxPanel.getByRole("button", {
    name: "Delete selected effects",
  });
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Delete selected effects",
  });
  await deleteDialog.getByRole("button", { name: "Delete" }).click();

  await expect
    .poll(() => moduleFxIdByLabel(page, "Module Mutation Spec"))
    .toBeUndefined();
  await expect
    .poll(() => hasRegularFxLabel(page, "Regular Collision Spec"))
    .toBe(true);
  await expect(
    fxPanel.getByText("Module Mutation Spec", { exact: true }),
  ).toHaveCount(0);
});
