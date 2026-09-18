// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(60_000);

/** Opens a blank backend containing one fixture for color-path default tests. */
async function openOwnedFixtureColorPathApp(
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
  await expect
    .poll(() =>
      page.evaluate(() => ({
        colorPathDefaults: (window as any).appStores.colorPathDefaults.get()
          .length,
        fixtures: Object.keys((window as any).appStores.fixtures.get()).length,
      })),
    )
    .toEqual({ colorPathDefaults: 0, fixtures: 0 });

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const fixtureId = Math.floor(600_000 + Math.random() * 100_000);
    const result = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Color Path Default Fixture ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to create color-path fixture: ${JSON.stringify(result)}`,
      );
    }
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        const colorPath = Object.values(stores.colorPaths.get()).find(
          (candidate: any) => candidate.identifiers.id === 3,
        ) as any;
        return {
          colorPathLabel: colorPath?.identifiers.label,
          fixtures: Object.keys(stores.fixtures.get()).length,
        };
      }),
    )
    .toEqual({ colorPathLabel: "CMY", fixtures: 1 });
}

/** Waits until app stores and owned fixture/color path data are available. */
async function waitForFixtureColorPathData(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Object.keys((window as any).appStores?.fixtures?.get?.() ?? {}).length >
        0 &&
      Object.keys((window as any).appStores?.colorPaths?.get?.() ?? {}).length >
        0,
  );
}

/** Opens Visualizer and Properties panels, then activates Visualizer properties. */
async function openVisualizerProperties(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    if (!api.getPanel("panel-Visualizer-color-path-default")) {
      api.addPanel({
        id: "panel-Visualizer-color-path-default",
        component: "Visualizer",
        title: "3D Visualizer",
        params: {},
      });
    }
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    api.getPanel("panel-Visualizer-color-path-default")?.focus();
    api.getPanel("panel-PropertiesInspector")?.focus();
  });

  await expect(page.getByText("3D Visualizer Properties")).toBeVisible();
}

/** Selects the first known fixture with at least one element in the visualizer selection store. */
async function selectFirstFixture(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const stores = (window as any).appStores;
    const fixture = Object.values(stores.fixtures.get()).find(
      (item: any) => item.elements?.length > 0,
    ) as any;
    if (!fixture) throw new Error("expected a fixture with elements");
    const fixtureUid = fixture.identifiers.uid;
    stores.programmerSelection.set([fixtureUid]);
    return fixtureUid;
  });
}

/** Reads the selected fixture's whole-fixture color path default from the UI store. */
async function fixtureDefaultColorPath(
  page: Page,
  fixtureUid: string,
): Promise<number | undefined> {
  return await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const normalizedUid = uid.replaceAll("-", "").toLowerCase();
    return (stores.colorPathDefaults.get() as any[]).find(
      (entry) =>
        String(entry.fixture.fixture_uid).replaceAll("-", "").toLowerCase() ===
          normalizedUid && entry.fixture.index == null,
    )?.color_path_id;
  }, fixtureUid);
}

/** Reads an element-scoped color path default from the UI store. */
async function fixtureElementDefaultColorPath(
  page: Page,
  fixtureUid: string,
  elementIndex: number,
): Promise<number | undefined> {
  return await page.evaluate(
    ({ uid, elementIndex }) => {
      const stores = (window as any).appStores;
      const normalizedUid = uid.replaceAll("-", "").toLowerCase();
      return (stores.colorPathDefaults.get() as any[]).find(
        (entry) =>
          String(entry.fixture.fixture_uid)
            .replaceAll("-", "")
            .toLowerCase() === normalizedUid &&
          entry.fixture.index === elementIndex,
      )?.color_path_id;
    },
    { uid: fixtureUid, elementIndex },
  );
}

/** Verifies fixture properties can assign a default color path through the backend. */
test("visualizer properties assigns fixture color path default", async ({
  backendSlot,
  page,
}) => {
  await openOwnedFixtureColorPathApp(page, backendSlot.backendPort);
  await waitForFixtureColorPathData(page);

  const fixtureUid = await selectFirstFixture(page);
  await openVisualizerProperties(page);

  const propertiesPanel = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]',
  );
  const colorPathSelect = propertiesPanel.getByLabel("Fixture Color Path");
  await expect(colorPathSelect).toBeVisible();
  await colorPathSelect.selectOption("");
  await expect
    .poll(() => fixtureDefaultColorPath(page, fixtureUid))
    .toBeUndefined();

  await colorPathSelect.selectOption("3");

  await expect.poll(() => fixtureDefaultColorPath(page, fixtureUid)).toBe(3);
  const x = propertiesPanel
    .getByRole("spinbutton", { name: "X", exact: true })
    .first();
  const original = await x.inputValue();
  await x.fill("99");
  await x.press("Escape");
  await expect(x).toHaveValue(original);
  await x.fill("1.25");
  await x.press("Enter");
  await expect
    .poll(() =>
      page.evaluate((uid) => {
        return (window as any).appStores.fixtures.get()[uid]?.placement
          ?.position.x;
      }, fixtureUid),
    )
    .toBe(1.25);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
  });
  await expect(x).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("shared-visualizer-properties.png"),
  });
});

/** Verifies fixture properties can assign an element-scoped color path default. */
test("visualizer properties assigns element color path default", async ({
  backendSlot,
  page,
}) => {
  await openOwnedFixtureColorPathApp(page, backendSlot.backendPort);
  await waitForFixtureColorPathData(page);

  const fixtureUid = await selectFirstFixture(page);
  await openVisualizerProperties(page);

  const propertiesPanel = page.locator(
    '[data-panel-id="panel-PropertiesInspector"]',
  );
  const elementColorPathSelect = propertiesPanel.getByLabel(
    "Element 1 Color Path",
  );
  await expect(elementColorPathSelect).toBeVisible();
  await elementColorPathSelect.selectOption("");
  await expect
    .poll(() => fixtureElementDefaultColorPath(page, fixtureUid, 1))
    .toBeUndefined();

  await elementColorPathSelect.selectOption("3");

  await expect
    .poll(() => fixtureElementDefaultColorPath(page, fixtureUid, 1))
    .toBe(3);
});
