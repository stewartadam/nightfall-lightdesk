// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import {
  prepareStoreSeededTestApp,
  waitForDockviewApp,
} from "./showfile-startup";

const COMMAND_SELECTION_FIXTURE_IDS = [311, 390] as const;

/** Open and focus the Selection Inspector panel in the dock layout. */
async function openSelectionInspector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-SelectionVisualizer")?.api.close();
    const panelId = "panel-SelectionVisualizer-e2e";
    if (!api.getPanel(panelId)) {
      api.addPanel({
        id: panelId,
        component: "SelectionVisualizer",
        title: "Selection Inspector",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {},
      });
    }
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
  });
}

/** Opens Selection Inspector scenarios against a fresh blank backend. */
async function openFreshSelectionInspectorApp(
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
      Boolean((window as any).appStores?.programmerSelection?.get) &&
      Boolean((window as any).appStores?.programmerSpatialSelection?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(0);
}

/** Opens a disconnected app with the fixtures referenced by selection scenarios. */
async function prepareSelectionInspectorApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await openFreshSelectionInspectorApp(page, backendPort);
  await prepareStoreSeededTestApp(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;

    /** Builds a fixture that can participate in spatial selections. */
    const fixture = (id: number, uid: string) => ({
      identifiers: { id, uid, label: `Fixture ${id}` },
      make: "E2E",
      model: "Dimmer",
      mode: "1ch",
      elements: [],
    });

    stores.fixtures.set({
      "11111111111111111111111111111111": fixture(
        101,
        "11111111111111111111111111111111",
      ),
      "22222222222222222222222222222222": fixture(
        102,
        "22222222222222222222222222222222",
      ),
      "33333333333333333333333333333333": fixture(
        311,
        "33333333333333333333333333333333",
      ),
      "44444444444444444444444444444444": fixture(
        312,
        "44444444444444444444444444444444",
      ),
    });
  });
}

/** Creates the two real fixtures used by command-line range assertions. */
async function prepareCommandSelectionInspectorApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await openFreshSelectionInspectorApp(page, backendPort);
  await page.evaluate(async (fixtureIds) => {
    const stores = (window as any).appStores;
    for (const fixtureId of fixtureIds) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Owned Selection Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to create selection fixture ${fixtureId}: ${JSON.stringify(result)}`,
        );
      }
    }
  }, COMMAND_SELECTION_FIXTURE_IDS);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Object.values((window as any).appStores.fixtures.get()) as any[])
          .map((fixture) => fixture.identifiers.id)
          .sort((left, right) => left - right),
      ),
    )
    .toEqual([...COMMAND_SELECTION_FIXTURE_IDS]);
}

/** Deletes owned backend fixtures and clears synthetic selection stores. */
async function cleanupSelectionInspectorState(page: Page): Promise<void> {
  const outcomes = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    if (!stores?.fixtures?.get) return [];

    stores.programmerSelection.set([]);
    stores.programmerState.set([]);
    stores.programmerResolvedSelection.set(null);
    stores.programmerSpatialSelection.set(null);
    stores.activeSelectionSpanTargets.set([]);

    const websocket = await import("/lib/engine-runtime.ts");
    const fixtureIds = (
      Object.values(stores.fixtures.get()) as Array<{
        identifiers: { id: number };
      }>
    ).map((fixture) => fixture.identifiers.id);
    const results: unknown[] = [];
    if (
      websocket.connectionStatus() ===
        websocket.EngineRuntimeStatus.Connected &&
      typeof stores.sendAndAwait === "function"
    ) {
      for (const fixtureId of fixtureIds) {
        results.push(
          await stores.sendAndAwait({
            module: "FixtureCommand",
            command: { type: "DeleteFixture", data: fixtureId },
          }),
        );
      }
    }

    stores.fixtures.set({});
    return results;
  });

  for (const outcome of outcomes as Array<{ outcome?: { type?: string } }>) {
    expect(outcome.outcome?.type, JSON.stringify(outcome)).toBe("Succeeded");
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          activeTargets: stores?.activeSelectionSpanTargets?.get?.().length,
          fixtures: Object.keys(stores?.fixtures?.get?.() ?? {}).length,
          programmerSelection: stores?.programmerSelection?.get?.().length,
          programmerState: stores?.programmerState?.get?.().length,
          resolvedSelection:
            stores?.programmerResolvedSelection?.get?.() ?? null,
          spatialSelection: stores?.programmerSpatialSelection?.get?.() ?? null,
        };
      }),
    )
    .toEqual({
      activeTargets: 0,
      fixtures: 0,
      programmerSelection: 0,
      programmerState: 0,
      resolvedSelection: null,
      spatialSelection: null,
    });
}

/** Restores empty fixture and selection stores after every scenario. */
test.afterEach(async ({ page }) => {
  await cleanupSelectionInspectorState(page);
});

/** Verifies Selection Inspector renders and navigates an owned spatial projection. */
test("opens Selection Inspector and steps through a spatial selection grid", async ({
  backendSlot,
  page,
}) => {
  await prepareSelectionInspectorApp(page, backendSlot.backendPort);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.programmerSelection.set([
      "11111111111111111111111111111111",
      "22222222222222222222222222222222",
    ]);
    stores.programmerSpatialSelection.set({
      source: {
        type: "Resolved",
        data: [
          { fixture_uid: "11111111111111111111111111111111", index: undefined },
          { fixture_uid: "22222222222222222222222222222222", index: 2 },
        ],
      },
      clauses: [],
    });
    stores.programmerResolvedSelection.set({
      canonical: [
        { fixture_uid: "11111111111111111111111111111111", index: undefined },
        { fixture_uid: "22222222222222222222222222222222", index: 2 },
      ],
      projection_bounds: {
        min_x: 0,
        max_x: 1,
        min_y: 0,
        max_y: 18,
        min_z: 0,
        max_z: 0,
      },
      invert_attrs: undefined,
      indexes: [
        {
          index: 0,
          invert: false,
          members: [
            {
              fixture: {
                fixture_uid: "11111111111111111111111111111111",
                index: undefined,
              },
              projected_coord: { x: 0, y: 0, z: 0 },
            },
          ],
        },
        {
          index: 1,
          invert: true,
          members: [
            {
              fixture: {
                fixture_uid: "22222222222222222222222222222222",
                index: 2,
              },
              projected_coord: { x: 1, y: 0, z: 0 },
            },
          ],
        },
        ...Array.from({ length: 18 }, (_, index) => ({
          index: index + 2,
          invert: false,
          members: [
            {
              fixture: {
                fixture_uid: "11111111111111111111111111111111",
                index: undefined,
              },
              projected_coord: { x: index % 2, y: index + 1, z: 0 },
            },
          ],
        })),
      ],
    });
  });

  await openSelectionInspector(page);

  await expect(
    page.getByRole("heading", { name: "Selection Inspector" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("2D projection of the active programmer spatial selection."),
  ).toHaveCount(0);
  await expect(
    page.getByPlaceholder("Fixture 1>8 | Grid 4 | Wings 2"),
  ).toBeVisible();
  const selectionEditor = page.getByPlaceholder(
    "Fixture 1>8 | Grid 4 | Wings 2",
  );
  await expect(selectionEditor).toHaveValue("Fixture 101 + Fixture 102.2");
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.programmerSelection.set(["22222222222222222222222222222222"]);
  });
  await expect(selectionEditor).toHaveValue("Fixture 102.2");
  await selectionEditor.fill("Fixture 102");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(selectionEditor).toHaveValue("Fixture 102.2");
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.programmerSpatialSelection.set({
      source: {
        type: "FixtureRange",
        data: {
          start: { fixture_id: 311 },
          end: { fixture_id: 312 },
        },
      },
      clauses: [
        { type: "Blocks", data: { axis: "X", amount: 2 } },
        { type: "Grid", data: { type: "Width", data: 20 } },
      ],
    });
    stores.programmerSelection.set([
      "33333333333333333333333333333333",
      "44444444444444444444444444444444",
    ]);
  });
  await expect(selectionEditor).toHaveValue(
    "Fixture 311>312 | Blocks 2 | Grid 20",
  );
  await expect(page.getByText("X 0")).toBeVisible();
  await expect(
    page.getByRole("button").filter({ hasText: "101" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button").filter({ hasText: "102.2" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("spinbutton")).toHaveValue("2");
  await expect(page.getByText("inverted", { exact: true })).toBeVisible();

  const activeTargets = await page.evaluate(() =>
    (window as any).appStores.activeSelectionSpanTargets.get(),
  );
  expect(activeTargets).toEqual([
    { fixtureUid: "22222222222222222222222222222222", elementIndex: 2 },
  ]);

  const firstCell = page
    .getByTestId("selection-grid-cell")
    .filter({ hasText: "101" })
    .first();
  const yLabel = page
    .getByTestId("selection-grid-y-label")
    .filter({ hasText: "Y 0" })
    .first();
  const firstCellBox = await firstCell.boundingBox();
  const yLabelBox = await yLabel.boundingBox();
  const firstLabelBox = await firstCell
    .locator(".font-medium")
    .first()
    .boundingBox();
  expect(firstCellBox).not.toBeNull();
  expect(yLabelBox).not.toBeNull();
  expect(firstLabelBox).not.toBeNull();
  expect(
    Math.abs((yLabelBox?.y ?? 0) - (firstCellBox?.y ?? 0)),
  ).toBeLessThanOrEqual(2);
  expect((firstLabelBox?.y ?? 0) - (firstCellBox?.y ?? 0)).toBeLessThanOrEqual(
    12,
  );

  const scrollContainer = page.getByTestId("selection-grid-scroll");
  const header = page.getByTestId("selection-grid-header");
  await scrollContainer.evaluate((element) => {
    element.scrollTop = 140;
  });
  const headerStyle = await header.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      position: style.position,
    };
  });
  const scrollBox = await scrollContainer.boundingBox();
  const headerBox = await header.boundingBox();
  expect(headerStyle.position).toBe("sticky");
  expect(headerStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(scrollBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect((headerBox?.y ?? 0) - (scrollBox?.y ?? 0)).toBeGreaterThanOrEqual(10);
  expect((headerBox?.y ?? 0) - (scrollBox?.y ?? 0)).toBeLessThanOrEqual(16);
});

/** Verifies command-line spatial clauses update Selection Inspector text. */
test("syncs Selection Inspector text after command-line spatial clauses", async ({
  backendSlot,
  page,
}) => {
  await prepareCommandSelectionInspectorApp(page, backendSlot.backendPort);

  await openSelectionInspector(page);
  const selectionEditor = page.getByPlaceholder(
    "Fixture 1>8 | Grid 4 | Wings 2",
  );
  await expect(selectionEditor).toBeVisible();

  const commandInput = page.locator("#header-cmdline");
  await commandInput.fill("fix 311>390 | blocks 2");
  await commandInput.press("Enter");
  await expect(commandInput).toHaveValue("");
  await expect(selectionEditor).toHaveValue("Fixture 311>390 | Blocks 2");

  await commandInput.fill("fix 311>390 | blocks 2 | grid 20");
  await commandInput.press("Enter");
  await expect(commandInput).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.programmerSpatialSelection.get(),
      ),
    )
    .toMatchObject({
      clauses: [
        { type: "Blocks", data: { axis: "X", amount: 2 } },
        { type: "Grid", data: { type: "Width", data: 20 } },
      ],
    });

  await expect(selectionEditor).toHaveValue(
    "Fixture 311>390 | Blocks 2 | Grid 20",
  );
});
