// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { gridCellByKey } from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/** Opens a blank showfile on the test's isolated backend once the action catalog arrives. */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => ((window as any).appStores.actionCatalog.get() as []).length,
      ),
    )
    .toBeGreaterThan(0);
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Returns the diagnostic codes the backend published for OSC mappings. */
async function oscDiagnosticCodes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as any).appStores.oscMappingDiagnostics
      .get()
      .map((diagnostic: any) => diagnostic.error.code),
  );
}

test("an OSC mapping whose master is deleted shows a diagnostic in the OSC panel", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.masters.get()).length,
      ),
    )
    .toBe(1);
  const master = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers as { id: number; uid: string },
  );

  const mappingId = crypto.randomUUID().replaceAll("-", "");
  const upsert = await page.evaluate(
    ({ mappingId, masterUid }) =>
      (window as any).appStores.sendAndAwait({
        module: "OscCommand",
        command: {
          type: "UpsertMapping",
          data: {
            id: mappingId,
            address: "/e2e/diagnostics/fader",
            arg_index: 0,
            action: { id: "master.level", arguments: { master: masterUid } },
          },
        },
      }),
    { mappingId, masterUid: master.uid },
  );
  expect(upsert.outcome).toMatchObject({ type: "Succeeded" });

  await openPanel(page, "OSC Input");
  const grid = page.locator('[data-grid-kind="tanstack"]').filter({
    has: page.locator('[data-grid-header-id="tanstack-header-address"]'),
  });
  const mappingKey = await page.evaluate(
    () => (window as any).appStores.oscMappings.get()[0].id as string,
  );
  const status = gridCellByKey(grid, {
    columnKey: "status",
    rowKey: mappingKey,
  });
  await expect(status).toContainText("OK");
  expect(await oscDiagnosticCodes(page)).toEqual([]);

  const deleted = await page.evaluate(
    (id) =>
      (window as any).appStores.sendAndAwait({
        module: "MasterCommand",
        command: { type: "DeleteMaster", data: id },
      }),
    master.id,
  );
  expect(deleted.outcome).toMatchObject({ type: "Succeeded" });

  await expect
    .poll(() => oscDiagnosticCodes(page))
    .toEqual(["master.not_found"]);
  await expect(status).toContainText("does not exist");
  await expect(
    status.getByRole("img", { name: /Mapping problem: .*does not exist/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).appStores.oscMappings.get().length,
    ),
  ).toBe(1);
  await page.screenshot({
    path: test.info().outputPath("osc-mapping-diagnostic.png"),
  });
});
