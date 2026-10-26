// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/** Master fields the controller mapping specs assert on. */
export interface MasterSnapshot {
  identifiers: { id: number; uid: string; label: string };
  level_percent: number;
  mode: { type: string; data?: { active: boolean } };
}

/**
 * Opens a blank showfile on the test's isolated backend once the action catalog loads.
 *
 * Local storage starts empty apart from the current showfile and any `storage` entries.
 */
export async function openMappingApp(
  page: Page,
  backendPort: number,
  storage: Record<string, string> = {},
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript((entries) => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, value);
    }
  }, storage);
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

/** Opens the command palette from the header, types a query, and runs the top entry. */
export async function runPaletteEntry(
  page: Page,
  query: string,
): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(query);
  await page.keyboard.press("Enter");
}

/** Opens a panel through the command palette. */
export async function openPanel(page: Page, panelName: string): Promise<void> {
  await runPaletteEntry(page, `Open ${panelName}`);
}

/** Enters mapping mode and waits until the backend confirms controller actions are paused. */
export async function enterMapping(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  await expect(
    page.locator("[data-mapping-mode-banner] [data-mapping-pause]"),
  ).toHaveText("MIDI and OSC actions are paused.");
}

/** Leaves mapping mode and waits until the backend resumes controller actions. */
export async function leaveMapping(page: Page): Promise<void> {
  const banner = page.locator("[data-mapping-mode-banner]");
  await expect(async () => {
    if (await banner.isVisible()) await page.keyboard.press("Escape");
    await expect(banner).toBeHidden({ timeout: 500 });
  }).toPass();
  await expect.poll(() => mappingClients(page)).toBe(0);
}

/** Returns how many clients the backend reports as mapping controllers. */
export function mappingClients(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as any).appStores.controllerMappingMode.get()
        .mapping_clients as number,
  );
}

/** Numeric ID of the global intensity master every new show starts with. */
export const GLOBAL_MASTER_ID = 1;

/** Returns the new show's default global intensity master from the frontend store. */
export async function globalMaster(page: Page): Promise<MasterSnapshot> {
  return page.evaluate(
    (id) =>
      Object.values((window as any).appStores.masters.get()).find(
        (master: any) => master.identifiers.id === id,
      ) as never,
    GLOBAL_MASTER_ID,
  );
}

/** Opens the Masters panel and waits for the default global intensity master at full level. */
export async function openGlobalMaster(page: Page): Promise<void> {
  await openPanel(page, "Masters");
  await expect
    .poll(async () => (await globalMaster(page))?.level_percent)
    .toBe(100);
}

/** Switches the default global intensity master to a toggle master that starts off. */
export async function makeGlobalMasterToggle(page: Page): Promise<void> {
  await openGlobalMaster(page);
  await page
    .locator(`[data-master-id="${GLOBAL_MASTER_ID}"] select`)
    .selectOption("toggle-off");
  await expect
    .poll(async () => (await globalMaster(page)).mode.type)
    .toBe("Toggle");
}

/** Sets the global intensity master's level through the backend and waits for it to apply. */
export async function setGlobalMasterLevel(
  page: Page,
  levelPercent: number,
): Promise<void> {
  await page.evaluate(
    ({ id, levelPercent }) =>
      (window as any).appStores.sendAndAwait({
        module: "MasterCommand",
        command: {
          type: "SetMasterLevel",
          data: { id, level_percent: levelPercent },
        },
      }),
    { id: GLOBAL_MASTER_ID, levelPercent },
  );
  await expect
    .poll(async () => (await globalMaster(page)).level_percent)
    .toBeCloseTo(levelPercent, 3);
}
