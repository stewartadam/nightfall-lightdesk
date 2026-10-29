// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { dockFixturesInMainGrid, waitForDockviewApp } from "./showfile-startup";

test.setTimeout(150_000);

/** Opens a fresh backend with two dimmable fixtures for macros to set. */
async function openMacroApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await dockFixturesInMainGrid(page);

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (const fixtureId of [311, 312]) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Macro Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`failed to create fixture ${fixtureId}`);
      }
    }
  });
}

/**
 * Opens the Macros panel through the command palette, with Properties docked beside it and
 * the Programmer below it, closing Timelines so the macro cards have room.
 */
async function openMacrosPanel(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Macros");
  await page.keyboard.press("Enter");
  const panel = page.locator('[data-panel-kind="macro-list"]:visible');
  await expect(panel).toBeVisible();

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-TimelinesPanel")?.api.close();
    api.getPanel("panel-PropertiesInspector")?.api.close();
    api.addPanel({
      id: "panel-PropertiesInspector",
      component: "PropertiesInspector",
      title: "Properties",
      params: {},
      position: { referencePanel: "panel-Macros", direction: "right" },
    });
    api.getPanel("panel-ProgrammerGrid")?.api.close();
    api.addPanel({
      id: "panel-ProgrammerGrid",
      component: "ProgrammerGrid",
      title: "Programmer",
      params: {},
      position: { referencePanel: "panel-Macros", direction: "below" },
    });
    api.getPanel("panel-Macros")?.api.setActive();
  });
  const gridView = panel.getByRole("radio", { name: "Grid view" });
  if (await gridView.isVisible()) await gridView.click();
  return panel;
}

/** Reads the stored macro with numeric ID `id` from the engine's macro store. */
async function storedMacro(page: Page, id: number): Promise<any> {
  return page.evaluate(
    (macroId) =>
      Object.values((window as any).appStores.macros.get()).find(
        (macro: any) => macro.identifiers.id === macroId,
      ) ?? null,
    id,
  );
}

/** Returns how many programmer rows hold values, which grows as the macro sets fixtures. */
async function programmedFixtureCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as any).appStores.programmerState.get().length,
  );
}

/**
 * Walks the Macros panel end to end: add a macro, type commands with a typo the editor
 * flags, run it and watch its progress, see the stage change, and see a failing line named
 * in a toast.
 */
test("macros panel creates, edits and runs a macro", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openMacroApp(page, backendSlot.backendPort);
  const panel = await openMacrosPanel(page);
  await expect(panel.getByText("No macros yet")).toBeVisible();

  await panel.getByRole("button", { name: "Add macro" }).click();
  const card = panel.locator('[data-macro-card="1"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Macro 1");

  const properties = page.locator("[data-macro-properties]:visible");
  await expect(properties).toContainText("Macro 1");
  const commands = properties.getByLabel("Macro commands");
  await commands.fill("fixtur 311 @ 100");
  const problems = properties.locator(
    '[data-macro-body-problems="Macro commands"]',
  );
  await expect(problems).toContainText("Line 1 (fixtur 311 @ 100)");
  await problems.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("macro-line-error.png") });

  await commands.fill("fixture 311 @ 100\nsleep 2s\nfixture 312 @ 100");
  await expect(problems).toHaveCount(0);
  await properties.getByLabel("Macro label").fill("Specials up");
  await properties.getByLabel("Macro label").press("Enter");
  await expect
    .poll(async () => (await storedMacro(page, 1))?.commands)
    .toBe("fixture 311 @ 100\nsleep 2s\nfixture 312 @ 100");
  await expect(card).toContainText("Specials up");
  await expect(card).toContainText("fixture 311 @ 100");

  await card.click();
  await expect(card).toHaveAttribute("data-running", "");
  await expect(card.locator("[data-macro-run-state]")).toContainText(
    "Running line 2 (step 2 of 3)",
  );
  await expect(
    properties.locator("[data-macro-properties-state]"),
  ).toContainText("Running line 2");
  await page.screenshot({ path: testInfo.outputPath("macro-running.png") });

  await expect(card).not.toHaveAttribute("data-running", "", {
    timeout: 10_000,
  });
  await expect(card.locator("[data-macro-run-state]")).toHaveText("Idle");
  await expect.poll(() => programmedFixtureCount(page)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("macro-finished.png") });

  await commands.fill("clip 99 start");
  await properties.getByRole("button", { name: "Run" }).click();
  const failureToast = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Macro 1 stopped at line 1 (clip 99 start)" });
  await expect(failureToast).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("macro-failed.png") });

  await page.keyboard.press("ControlOrMeta+P");
  const objectSearch = page.getByPlaceholder("Search showfile objects...");
  await expect(objectSearch).toBeFocused();
  await objectSearch.fill("macro specials");
  await expect(page.getByText("Specials up").last()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("row").filter({ hasText: "Specials up" }),
  ).toHaveAttribute("data-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("macro-revealed.png") });
});
