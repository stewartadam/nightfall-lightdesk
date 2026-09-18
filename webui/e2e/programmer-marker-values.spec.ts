// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type MarkerValue = "release" | "hold";

const inputSelector = "#header-cmdline";

test.setTimeout(60_000);

/** Opens a blank backend containing the two fixtures used by marker assertions. */
async function openOwnedProgrammerMarkerApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 2200, height: 1200 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(0);

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    for (const fixtureId of [311, 501]) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: "Moving Head RGBW",
            mode: "Spot",
            label: `Programmer Marker Fixture ${fixtureId}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to create programmer marker fixture ${fixtureId}: ${JSON.stringify(result)}`,
        );
      }
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(2);
}

/**
 * Waits for the backend result for a submitted command.
 */
async function waitForCommandSuccess(
  page: Page,
  command: string,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((command) => {
        const entries =
          (
            window as never as { appStores?: any }
          ).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === command,
        );
        const last = matches[matches.length - 1];
        return last
          ? { status: last.status, errorMessage: last.errorMessage }
          : null;
      }, command),
    )
    .toEqual({ status: "success" });
}

/**
 * Submits a command-line command and waits for the input to clear.
 */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await waitForCommandSuccess(page, command);
}

/**
 * Waits until fixture and parameter metadata can resolve command-line fixture IDs.
 */
async function waitForFixtureGridData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      /** Polls browser state until fixture command metadata is available. */
      const tick = () => {
        const stores = (window as never as { appStores?: any }).appStores;
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
}

/**
 * Returns the marker value currently projected into the programmer store.
 */
async function programmerMarker(
  page: Page,
  fixtureId: number,
  attribute: string,
): Promise<MarkerValue | undefined> {
  return page.evaluate(
    ({ fixtureId, attribute }) => {
      const stores = (window as never as { appStores?: any }).appStores;
      const fixtures = Object.values(stores?.fixtures?.get?.() ?? {}) as any[];
      const fixture = fixtures.find(
        (candidate) => String(candidate.identifiers?.id) === String(fixtureId),
      );
      const row = (stores?.programmerState?.get?.() ?? []).find(
        (candidate: any) => candidate.fixtureUid === fixture?.identifiers?.uid,
      );
      return row?.attributes?.[attribute]?.marker;
    },
    { fixtureId, attribute },
  );
}

/**
 * Waits for the programmer value table to be empty.
 */
async function waitForProgrammerValuesCleared(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as never as { appStores?: any }
          ).appStores?.programmerState?.get?.().length ?? 0,
      ),
    )
    .toBe(0);
}

/**
 * Waits for the active programmer selection to be empty.
 */
async function waitForProgrammerSelectionCleared(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as never as { appStores?: any }
          ).appStores?.programmerSelection?.get?.().length ?? 0,
      ),
    )
    .toBe(0);
}

/**
 * Opens the programmer panel and returns its TanStack grid.
 */
async function openProgrammerGrid(page: Page): Promise<Locator> {
  await page.getByText("Programmer", { exact: true }).first().click();
  const panel = page.locator('[data-panel-kind="programmer"]:visible');
  await expect(panel).toBeVisible();
  const grid = panel.locator('[data-grid-kind="tanstack"]').filter({
    has: page.locator('[data-grid-header-id="tanstack-header-category:Color"]'),
  });
  await expect(grid).toBeVisible();
  return grid;
}

/**
 * Resolves a visible leaf-header ID to its rendered column index.
 */
async function columnIndexForLeafHeader(
  grid: Locator,
  headerId: string,
): Promise<number> {
  return grid.evaluate((element, targetHeaderId) => {
    const headers = Array.from(
      element.querySelectorAll<HTMLElement>("[data-grid-header-id]"),
    )
      .map((header) => ({
        header,
        id: header.dataset.gridHeaderId,
        rect: header.getBoundingClientRect(),
      }))
      .filter(
        ({ id, rect }) =>
          id?.startsWith("tanstack-header-") &&
          !id.includes("category:") &&
          !id.includes("group:") &&
          rect.width > 0 &&
          rect.height > 0,
      );
    const leafTop = Math.max(...headers.map(({ rect }) => rect.top));
    const leafHeaders = headers
      .filter(({ rect }) => Math.abs(rect.top - leafTop) < 1)
      .sort((left, right) => left.rect.left - right.rect.left);
    const index = leafHeaders.findIndex(({ id }) => id === targetHeaderId);
    if (index < 0) {
      throw new Error(`No visible leaf header ${targetHeaderId}`);
    }
    return index;
  }, headerId);
}

/**
 * Returns the visible row index for a fixture ID.
 */
async function rowIndexForFixtureId(
  grid: Locator,
  fixtureId: number,
): Promise<number> {
  return grid.evaluate((element, fixtureId) => {
    const idCells = Array.from(
      element.querySelectorAll<HTMLElement>('[id^="tanstack-cell-0-"]'),
    );
    const fixtureIdPattern = new RegExp(`(^|\\s)${fixtureId}(\\s|$)`);
    const cell = idCells.find((candidate) =>
      fixtureIdPattern.test(candidate.textContent?.trim() ?? ""),
    );
    const match = cell?.id.match(/^tanstack-cell-0-(\d+)$/);
    if (!match) throw new Error(`No visible fixture row ${fixtureId}`);
    return Number(match[1]);
  }, fixtureId);
}

/**
 * Returns the grid body cell for a visible leaf header and row.
 */
async function cellForHeader(
  grid: Locator,
  headerId: string,
  rowIndex: number,
): Promise<Locator> {
  const columnIndex = await columnIndexForLeafHeader(grid, headerId);
  return grid.locator(`#tanstack-cell-${columnIndex}-${rowIndex}`);
}

/**
 * Programmer marker values remain visible in attribute value columns.
 */
test("programmer panel displays release and hold marker values", async ({
  backendSlot,
  page,
}) => {
  await openOwnedProgrammerMarkerApp(page, backendSlot.backendPort);
  await waitForFixtureGridData(page);

  await submitCommand(page, "clear values");
  await waitForProgrammerValuesCleared(page);
  await submitCommand(page, "clear selection");
  await waitForProgrammerSelectionCleared(page);
  await submitCommand(page, "fix 311 red @ Release");
  await submitCommand(page, "fix 501 tilt @ Hold");

  await expect.poll(() => programmerMarker(page, 311, "Red")).toBe("release");
  await expect.poll(() => programmerMarker(page, 501, "Tilt")).toBe("hold");

  const grid = await openProgrammerGrid(page);
  const releaseRow = await rowIndexForFixtureId(grid, 311);
  const holdRow = await rowIndexForFixtureId(grid, 501);
  await expect(
    await cellForHeader(grid, "tanstack-header-Red_Value", releaseRow),
  ).toHaveText("R");
  await expect(
    await cellForHeader(grid, "tanstack-header-Tilt_Value", holdRow),
  ).toHaveText("H");
});
