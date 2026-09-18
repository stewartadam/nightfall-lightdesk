// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

/**
 * Opens the app in an interactive startup state suitable for browser-seeded grid data.
 */
async function openSeededApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
    window.localStorage.setItem("nightfall-patch-panel:active-tab", "fixtures");
  });
  await page.goto("/?e2e=1&scenario=datagrid-sticky-background");
  await prepareStoreSeededTestApp(page);
}

/**
 * Waits until the Dockview API is available through appStores.
 */
async function waitForDockApi(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.dockApi?.get?.()),
  );
}

/**
 * Adds a Patch panel that renders the fixture table tab.
 */
async function addPatchPanel(page: Page): Promise<void> {
  await waitForDockApi(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panelId = "panel-PatchEditor-sticky-background-e2e";
    api.getPanel(panelId)?.api.close();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const panel = api.addPanel({
      id: panelId,
      component: "PatchEditor",
      title: "Patch",
      params: {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    panel.api.setActive();
    panel.focus();
  });
}

/**
 * Seeds enough fixture rows for the Patch grid to render and scroll horizontally.
 */
async function seedFixtureRows(
  page: Page,
  fixtureCount: number,
): Promise<void> {
  await page.evaluate((count) => {
    const stores = (window as any).appStores;
    stores.fixtures.set({});
    for (let index = 0; index < count; index += 1) {
      const uid = `fixture-sticky-background-${index + 1}`;
      stores.fixtures.setKey(uid, {
        identifiers: {
          id: index + 1,
          uid,
          label: `Fixture ${index + 1}`,
        },
        make: "E2E",
        model: "Sticky Background",
        mode: "Default",
        elements: [],
        placement: {
          position: { x: index, y: index + 10, z: index + 20 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      });
    }
  }, fixtureCount);
}

/**
 * Opens a seeded Patch fixture grid and returns its TanStack grid locator.
 */
async function openSeededPatchGrid(page: Page): Promise<Locator> {
  await openSeededApp(page);
  await addPatchPanel(page);
  await seedFixtureRows(page, 20);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys((window as any).appStores.fixtures.get()),
      ),
    )
    .toHaveLength(20);

  const grid = page
    .locator('[data-panel-id="panel-PatchEditor-sticky-background-e2e"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveText("1");
  return grid;
}

/**
 * Verifies a selected sticky cell paints an opaque base layer behind translucent selection color.
 */
async function expectSelectedStickyCellBackground(
  cell: Locator,
): Promise<void> {
  await expect
    .poll(() =>
      cell.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          position: style.position,
        };
      }),
    )
    .toMatchObject({
      backgroundColor: "rgb(22, 22, 27)",
      position: "sticky",
    });
  await expect
    .poll(() =>
      cell.evaluate((element) => getComputedStyle(element).backgroundImage),
    )
    .toContain("linear-gradient");
}

/** Verifies frozen selected columns do not show scrolled cells through their fill. */
test("patch fixture grid paints sticky selected cells opaquely", async ({
  page,
}) => {
  const grid = await openSeededPatchGrid(page);
  await page.setViewportSize({ width: 1100, height: 700 });
  const firstIdCell = grid.locator("#tanstack-cell-0-0");

  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();
  await grid.evaluate((element) => {
    element.scrollLeft = 640;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect
    .poll(() => grid.evaluate((element) => Math.round(element.scrollLeft)))
    .toBeGreaterThan(0);
  await expectSelectedStickyCellBackground(firstIdCell);
});
