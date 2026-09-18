// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(60_000);

/** Opens a unique blank showfile containing one Dimmer and RGB fixture. */
async function openOwnedColumnVisibilityFixture(
  page: Page,
  backendPort: number,
): Promise<void> {
  const testInfo = test.info();
  const resetKey = `column-visibility-${testInfo.workerIndex}-${testInfo.retry}`;
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript((storageKey) => {
    if (window.sessionStorage.getItem(storageKey)) return;
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    window.sessionStorage.setItem(storageKey, "1");
  }, resetKey);
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(0);

  const fixtureId = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const id = Math.floor(500_000 + Math.random() * 100_000);
    const result = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Column Visibility Fixture ${id}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to create owned fixture: ${JSON.stringify(result)}`,
      );
    }
    return id;
  });
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as Array<{ identifiers: { id: number; uid: string } }>;
        return (
          fixtures.find((fixture) => fixture.identifiers.id === id)?.identifiers
            .uid ?? null
        );
      }, fixtureId),
    )
    .not.toBeNull();
  const fixtureUid = await page.evaluate((id) => {
    const fixtures = Object.values(
      (window as any).appStores.fixtures.get(),
    ) as Array<{ identifiers: { id: number; uid: string } }>;
    const fixture = fixtures.find((item) => item.identifiers.id === id);
    if (!fixture) throw new Error(`owned fixture ${id} did not load`);
    return fixture.identifiers.uid;
  }, fixtureId);
  await expect
    .poll(() =>
      page.evaluate((fixtureUid) => {
        const raw = (window as any).appStores.parameters
          .get()
          .get(fixtureUid)?.raw;
        const attributes = Object.keys(raw ?? {});
        return ["Blue", "Green", "Intensity", "Red"].every((attribute) =>
          attributes.includes(attribute),
        );
      }, fixtureUid),
    )
    .toBe(true);
}

/**
 * Waits for fixture grid rows before checking column visibility behavior.
 */
async function waitForFixtureGridData(page: Page) {
  await page.evaluate(async () => {
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      /** Polls browser state until the awaited test condition is satisfied. */
      const tick = () => {
        const stores = (window as any).appStores;
        const api = stores?.dockApi?.get?.();
        const fixtures = stores?.fixtures?.get?.() ?? {};
        const parameters = stores?.parameters?.get?.();
        if (api && Object.keys(fixtures).length > 0 && parameters?.size > 0) {
          resolve();
          return;
        }
        if (Date.now() - started > 15_000) {
          reject(new Error("owned fixture data did not load"));
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  });
  await expect(
    page.locator(
      '[data-panel-kind="fixtures"]:visible [data-grid-header-id="tanstack-header-category:Color"]',
    ),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Computes the screen center of a locator for pointer interactions.
 */
async function locatorCenter(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2,
  };
}

/**
 * Opens the fixtures panel and waits until its grid is ready.
 */
async function activateFixturesPanel(page: Page) {
  await page.getByText("Fixtures", { exact: true }).first().click();
  await expect(
    page.locator('[data-panel-kind="fixtures"]:visible'),
  ).toBeVisible();
}

/**
 * Opens the column visibility menu from the active fixture grid toolbar.
 */
async function openColumnVisibilityMenu(page: Page) {
  const fixturePanel = page.locator('[data-panel-kind="fixtures"]:visible');
  await fixturePanel
    .getByRole("button", { name: "Column visibility" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  const menu = page.locator('[data-menu-kind="column-visibility"]:visible');
  await expect(menu).toBeVisible();
  return menu;
}

/** Creates and displays one owned fixture before each visibility scenario. */
test.beforeEach(async ({ backendSlot, page }) => {
  await openOwnedColumnVisibilityFixture(page, backendSlot.backendPort);
  await activateFixturesPanel(page);
  await waitForFixtureGridData(page);
});

test("fixture grid column visibility hides categories and persists settings", async ({
  page,
}) => {
  const colorHeader = page.locator(
    '[data-grid-header-id="tanstack-header-category:Color"]',
  );
  const visibleColorHeadersBefore = await colorHeader.count();
  expect(visibleColorHeadersBefore).toBeGreaterThan(0);

  const menu = await openColumnVisibilityMenu(page);
  const menuBounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(menuBounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(
    viewport!.width,
  );
  const colorCategory = menu.locator('[data-category="Color"]');
  await expect(colorCategory.locator("label").first()).toContainText("Color");
  await expect(menu.locator('[data-column-group="Red"]')).toBeVisible();

  const colorCheckbox = colorCategory.locator("label").first().locator("input");
  await colorCheckbox.click();

  await expect
    .poll(async () => colorHeader.count(), { timeout: 5_000 })
    .toBeLessThan(visibleColorHeadersBefore);

  await expect(colorCheckbox).not.toBeChecked();

  const redValueCheckbox = menu
    .locator('[data-column-group="Red"]')
    .getByLabel("Red");
  await redValueCheckbox.dblclick();
  await expect(redValueCheckbox).not.toBeChecked();
  await redValueCheckbox.click();
  await expect(colorCheckbox).toHaveJSProperty("indeterminate", true);

  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await activateFixturesPanel(page);
  await waitForFixtureGridData(page);

  const reloadedMenu = await openColumnVisibilityMenu(page);
  const reloadedColorCheckbox = reloadedMenu
    .locator('[data-category="Color"]')
    .locator("label")
    .first()
    .locator("input");

  await expect(reloadedColorCheckbox).toHaveJSProperty("indeterminate", true);
  await reloadedMenu.getByRole("button", { name: "Reset" }).click();
  await expect(reloadedColorCheckbox).toBeChecked();
});

test("column visibility checkboxes survive rapid physical clicks", async ({
  page,
}) => {
  const menu = await openColumnVisibilityMenu(page);

  const intensityValueCheckbox = menu
    .locator('[data-column-group="Intensity"] input[type="checkbox"]')
    .first();
  const intensityValueLabel = menu
    .locator('[data-column-group="Intensity"] label')
    .first();
  const { x, y } = await locatorCenter(intensityValueLabel);

  const states: boolean[] = [];
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.click(x, y);
    states.push(await intensityValueCheckbox.isChecked());
  }

  expect(states).toEqual([false, true, false, true, false, true]);
});

test("column visibility checkboxes survive rapid click bursts", async ({
  page,
}) => {
  const menu = await openColumnVisibilityMenu(page);

  const intensityValueCheckbox = menu
    .locator('[data-column-group="Intensity"] input[type="checkbox"]')
    .first();
  const intensityValueLabel = menu
    .locator('[data-column-group="Intensity"] label')
    .first();
  const { x, y } = await locatorCenter(intensityValueLabel);

  for (let index = 0; index < 5; index += 1) {
    await page.mouse.click(x, y);
  }
  await expect(intensityValueCheckbox).not.toBeChecked();

  for (let index = 0; index < 4; index += 1) {
    await page.mouse.click(x, y);
  }
  await expect(intensityValueCheckbox).not.toBeChecked();
});

test("column visibility category checkboxes survive rapid physical clicks", async ({
  page,
}) => {
  const menu = await openColumnVisibilityMenu(page);
  const colorCategory = menu.locator('[data-category="Color"]');
  const colorCheckbox = colorCategory.locator("label").first().locator("input");
  await expect(colorCheckbox).toBeChecked();

  const { x, y } = await locatorCenter(colorCheckbox);

  const states: boolean[] = [];
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.click(x, y);
    states.push(await colorCheckbox.isChecked());
  }

  expect(states).toEqual([false, true, false, true, false, true]);
});

test("column visibility category label double-click toggles twice", async ({
  page,
}) => {
  const menu = await openColumnVisibilityMenu(page);
  const dimmerCategory = menu.locator('[data-category="Dimmer"]');
  const dimmerCheckbox = dimmerCategory
    .locator("label")
    .first()
    .locator("input");
  const dimmerLabelText = dimmerCategory.locator("label span").first();
  await expect(dimmerCheckbox).toBeChecked();

  const { x, y } = await locatorCenter(dimmerLabelText);

  await page.mouse.click(x, y);
  await page.mouse.click(x, y);

  await expect(dimmerCheckbox).toBeChecked();
});

test("column visibility mixed category checkboxes survive rapid physical clicks", async ({
  page,
}) => {
  const menu = await openColumnVisibilityMenu(page);
  const colorCategory = menu.locator('[data-category="Color"]');
  const colorCheckbox = colorCategory.locator("label").first().locator("input");
  await colorCheckbox.click();
  await expect(colorCheckbox).not.toBeChecked();

  const blueValueCheckbox = menu
    .locator('[data-column-group="Blue"] input[type="checkbox"]')
    .first();
  await blueValueCheckbox.click();
  await expect(colorCheckbox).toHaveJSProperty("indeterminate", true);

  const { x, y } = await locatorCenter(colorCheckbox);

  const states: boolean[] = [];
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.click(x, y);
    states.push(await colorCheckbox.isChecked());
  }

  expect(states).toEqual([true, false, true, false, true, false]);
});
