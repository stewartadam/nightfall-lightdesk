// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const CLIP_VIEW_MODE_KEY = "nightfall-crud-panel-view-mode:clips-list";
const PATCH_PANEL_ACTIVE_TAB_KEY = "nightfall-patch-panel:active-tab";

/**
 * Returns the visible Clips panel.
 */
function clipsPanel(page: Page): Locator {
  return page.locator('[data-panel-kind="clips"]').last();
}

/**
 * Returns the visible Patch panel.
 */
function patchPanel(page: Page): Locator {
  return page.locator('[data-panel-kind="patch"]').last();
}

/**
 * Returns the Patch fixture TanStack grid by matching its grouped placement header.
 */
function patchFixtureGrid(page: Page): Locator {
  return patchPanel(page)
    .locator('[data-grid-kind="tanstack"]')
    .filter({
      has: page.locator(
        '[data-grid-header-id="tanstack-header-group:Position"]',
      ),
    })
    .last();
}

/**
 * Opens a panel and waits for its data grid to render.
 */
async function openPanel(page: Page, panelName: string) {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Opens the table-filter menu within a panel or grid toolbar.
 */
async function openTableFilterMenu(
  page: Page,
  scope: Locator,
): Promise<Locator> {
  const button = scope.getByRole("button", { name: "Table filters" });
  await expect(button).toBeVisible();
  await button.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Table filters control is not an HTML element");
    }
    element.click();
  });
  const menu = page.locator('[data-menu-kind="datagrid-filter"]:visible');
  await expect(menu).toBeVisible();
  return menu;
}

/** Seeds three minimal fixture rows used by fixture and patch filtering scenarios. */
async function seedFilterFixtures(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    /** Builds a fixture row with no dependency on library-backed sample profiles. */
    const fixture = (id: number) => ({
      identifiers: {
        id,
        uid: `filter-fixture-${id}`,
        label: `Filter Fixture ${id}`,
      },
      make: "E2E",
      model: `Filter Model ${id}`,
      mode: "Default",
      elements: [],
      placement: {
        position: { x: id, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
    });
    stores.fixtures.set({
      "filter-fixture-1": fixture(1),
      "filter-fixture-2": fixture(2),
      "filter-fixture-3": fixture(3),
    });
  });
}

/** Seeds the clip rows exercised by quick and numeric table filters. */
async function seedFilterClips(page: Page): Promise<void> {
  await page.evaluate(() => {
    /** Builds the clip tuple consumed by the clip list store. */
    const clip = (id: number, label: string) => [
      {
        identifiers: { id, uid: `filter-clip-${id}`, label },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      },
      false,
    ];
    (window as any).appStores.clips.set({
      "filter-clip-26": clip(26, "Rainbow Cycle"),
      "filter-clip-27": clip(27, "Filter Clip 27"),
      "filter-clip-28": clip(28, "Filter Clip 28"),
    });
  });
}

/**
 * Seeds a programmer row with color attributes so dynamic filter columns are present.
 */
async function seedProgrammerColorValues(page: Page): Promise<void> {
  await seedFilterFixtures(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.attributeMetadata.set(
      ["Red", "Green"].map((attribute, index) => ({
        key: attribute,
        attribute: { type: attribute },
        label: attribute,
        category: "Color",
        sort_order: index,
      })),
    );
    stores.programmerState.set([
      {
        fixtureUid: "filter-fixture-1",
        attributes: {
          Red: { value: 100, isPercentage: true, isRelative: false },
          Green: { value: 50, isPercentage: true, isRelative: false },
        },
      },
    ]);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores?.programmerState?.get?.().length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
}

/**
 * Verifies an open filter menu preserves native select options across live refreshes.
 */
async function expectFilterColumnOptionsStable(menu: Locator): Promise<void> {
  await menu.getByRole("button", { name: "Add filter" }).evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Add filter control is not an HTML element");
    }
    element.click();
  });
  const filterColumn = menu.getByLabel("Filter column");
  await expect(filterColumn).toHaveValue("id");

  const optionMutations = await filterColumn.evaluate(async (element) => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Filter column is not a native select.");
    }
    const firstOption = element.options[0];
    let mutationCount = 0;
    let firstOptionReplaced = false;
    const observer = new MutationObserver(() => {
      mutationCount += 1;
      firstOptionReplaced ||= element.options[0] !== firstOption;
    });
    observer.observe(element, { childList: true });
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    observer.disconnect();
    return { firstOptionReplaced, mutationCount };
  });
  expect(optionMutations).toEqual({
    firstOptionReplaced: false,
    mutationCount: 0,
  });

  await filterColumn.selectOption("name");
  await expect(filterColumn).toHaveValue("name");
}

test("CRUD list data grid quick filter narrows presented rows", async ({
  page,
}) => {
  await page.addInitScript(
    ([storageKey, storageValue]) => {
      window.localStorage.clear();
      window.localStorage.setItem(storageKey, storageValue);
    },
    [CLIP_VIEW_MODE_KEY, "list"],
  );

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedFilterClips(page);

  await openPanel(page, "Clips");

  const panel = clipsPanel(page);
  await expect(panel).toBeVisible();
  const grid = panel.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const menu = await openTableFilterMenu(page, panel);
  await expect(menu.getByText(/\d+ of \d+ rows/)).toBeVisible();

  await menu.getByLabel("Quick row filter").fill("Rainbow Cycle");
  await expect(menu.getByText(/1 of \d+ rows/)).toBeVisible();

  await expect(grid.locator("#tanstack-cell-1-0")).toHaveText("Rainbow Cycle");

  await menu.getByRole("button", { name: "Clear all" }).click();
  await expect(menu.getByText(/^\d+ of \d+ rows$/)).toBeVisible();
  await expect(menu.getByLabel("Quick row filter")).toHaveValue("");

  await menu.getByRole("button", { name: "Add filter" }).evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Add filter control is not an HTML element");
    }
    element.click();
  });
  await expect(menu.getByLabel("Filter column")).toHaveValue("id");
  await expect(menu.getByLabel("Filter operator")).toHaveValue("equals");
  const filterValue = menu.getByLabel("Filter value");
  await filterValue.click();
  await page.keyboard.type("26");
  await expect(filterValue).toHaveValue("26");
  await expect(filterValue).toBeFocused();

  await expect(menu.getByText(/1 of \d+ rows/)).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveText("26");
  await expect(grid.locator("#tanstack-cell-1-0")).toHaveText("Rainbow Cycle");

  await menu.getByLabel("Filter operator").selectOption("between");
  const secondFilterValue = menu.getByLabel("Second filter value");
  await expect(secondFilterValue).toBeVisible();
  await secondFilterValue.fill("28");
  await expect(menu.getByText(/3 of \d+ rows/)).toBeVisible();
});

/**
 * Verifies Fixtures live refreshes do not rebuild native filter select options.
 */
test("fixtures filter column select options stay stable while open", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedFilterFixtures(page);

  await openPanel(page, "Fixtures");
  await expect(
    page.locator(".dv-tab").filter({ hasText: "Fixtures" }),
  ).toBeVisible();

  const panel = page.locator('[data-panel-kind="fixtures"]').last();
  await expect(panel).toBeVisible();
  const menu = await openTableFilterMenu(page, panel);

  await expectFilterColumnOptionsStable(menu);
});

/**
 * Verifies Programmer live refreshes do not rebuild native filter select options.
 */
test("programmer filter column select options stay stable while open", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedProgrammerColorValues(page);

  await openPanel(page, "Programmer");
  const panel = page.locator('[data-panel-kind="programmer"]:visible');
  await expect(panel).toBeVisible();
  const menu = await openTableFilterMenu(page, panel);

  await expectFilterColumnOptionsStable(menu);
});

test("direct patch fixture grid column filter narrows presented rows", async ({
  page,
}) => {
  await page.addInitScript(
    ([activeTabKey]) => {
      window.localStorage.clear();
      window.localStorage.setItem(activeTabKey, "fixtures");
    },
    [PATCH_PANEL_ACTIVE_TAB_KEY],
  );

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
  await seedFilterFixtures(page);

  await openPanel(page, "Patch");
  const panel = patchPanel(page);
  await expect(
    panel.getByRole("button", { name: "Add fixture" }),
  ).toBeVisible();
  const grid = patchFixtureGrid(page);
  await expect(grid).toBeVisible();
  const firstFixtureIdCell = grid.locator("#tanstack-cell-0-0");
  await expect(firstFixtureIdCell).toHaveText(/^\d+$/);
  const firstFixtureId = (await firstFixtureIdCell.textContent())?.trim() ?? "";
  expect(firstFixtureId).toMatch(/^\d+$/);

  const menu = await openTableFilterMenu(page, panel);

  await menu.getByRole("button", { name: "Add filter" }).click();
  await expect(menu.getByLabel("Filter column")).toHaveValue("id");
  await expect(menu.getByLabel("Filter operator")).toHaveValue("equals");
  await menu.getByLabel("Filter value").fill(firstFixtureId);

  await expect(menu.getByText(/1 of \d+ rows/)).toBeVisible();
  await expect(firstFixtureIdCell).toHaveText(firstFixtureId);
});
