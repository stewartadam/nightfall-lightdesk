// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

/** Seeds a minimal fixture row so the standalone fixture grid mounts. */
async function seedFixtureRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixtureUid = "fixture-visibility-probe-1";
    const stores = (window as any).appStores;
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: {
          id: 1,
          label: "Fixture 1",
          uid: fixtureUid,
        },
        make: "E2E",
        model: "Visibility Probe",
        mode: "Default",
        elements: [],
        placement: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      },
    });
    stores.parameters.set(new Map());
  });
}

/** Updates the seeded fixture model while preserving the rest of its payload. */
async function updateSeededFixtureModel(
  page: Page,
  model: string,
): Promise<void> {
  await page.evaluate((nextModel) => {
    const fixtureUid = "fixture-visibility-probe-1";
    const stores = (window as any).appStores;
    const currentFixtures = stores.fixtures.get();
    const currentFixture = currentFixtures[fixtureUid];
    if (!currentFixture) {
      throw new Error("seeded fixture row is missing");
    }

    stores.fixtures.set({
      ...currentFixtures,
      [fixtureUid]: {
        ...currentFixture,
        model: nextModel,
      },
    });
  }, model);
}

/** Opens the seeded fixture grid beside a same-group hidden-tab probe. */
async function openFixtureGrid(page: Page) {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall-fixtures-panel-settings",
      JSON.stringify({
        expandedFixtures: [],
        showOnlyWithAttributes: false,
        showReleasedOutput: false,
      }),
    );
  });
  await page.goto(
    "/?startup:draftRecovery=false&e2e=fixture-table-visibility-probe",
  );
  await prepareStoreSeededTestApp(page);
  await seedFixtureRows(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const hiddenPanelId = "panel-FixtureVisibilityProbe-hidden";
    api.getPanel(hiddenPanelId)?.api.close();
    api.addPanel({
      id: hiddenPanelId,
      component: "Instrumentation",
      title: "Visibility Probe Hidden",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: { initialPanelId: hiddenPanelId },
    });
    const fixturePanel = api.getPanel("panel-FixtureGrid");
    fixturePanel?.api.setActive();
    fixturePanel?.focus();
  });
  await page.getByText("Fixtures", { exact: true }).first().click();

  const grid = page
    .locator('[data-grid-kind="tanstack"]')
    .filter({ hasText: "Fixture 1" })
    .first();
  await expect(grid).toBeVisible();
  return grid;
}

/** Verifies hidden fixture grids pause cell refreshes until they are visible again. */
test("fixture table pauses cell updates while dock tab is hidden", async ({
  page,
}) => {
  const grid = await openFixtureGrid(page);
  await expect(grid).toContainText("Fixture 1");

  await page
    .locator(".dv-tab")
    .filter({ hasText: "Visibility Probe Hidden" })
    .first()
    .click();
  await expect(grid).not.toBeVisible();

  await updateSeededFixtureModel(page, "Visibility Probe Hidden Update");
  await page.waitForTimeout(250);
  await expect.poll(() => grid.textContent()).not.toContain("Hidden Update");

  await page.locator(".dv-tab").filter({ hasText: "Fixtures" }).first().click();
  await expect(grid).toBeVisible();
  await expect(grid).toContainText("Visibility Probe Hidden Update");
});
