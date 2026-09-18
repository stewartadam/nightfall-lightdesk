// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type CapturedCommandWindow = Window & {
  __programmerContextCommands?: unknown[];
  appStores?: {
    programmerState?: { get: () => unknown[] };
  };
};

const inputSelector = "#header-cmdline";
const ownedFixtureId = 311;

/**
 * Captures websocket command envelopes posted to the websocket worker.
 */
async function installCommandCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as CapturedCommandWindow).__programmerContextCommands = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transfer?: Transferable[],
    ) {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "send"
      ) {
        (window as CapturedCommandWindow).__programmerContextCommands?.push(
          (message as { data?: unknown }).data,
        );
      }
      return originalPostMessage.call(this, message, transfer as never);
    } as Worker["postMessage"];
  });
}

/**
 * Clears the captured command list after scenario setup.
 */
async function clearCapturedCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as CapturedCommandWindow).__programmerContextCommands = [];
  });
}

/**
 * Reads programmer release commands captured by the worker shim.
 */
async function capturedReleaseCommands(page: Page): Promise<
  Array<{
    command?: {
      type?: string;
      data?: {
        selection?: { type?: string; data?: unknown[] };
        attributes?: Array<{ type?: string; data?: { label?: string } }>;
      };
    };
    module?: string;
  }>
> {
  return page.evaluate(() => {
    const commands =
      (window as CapturedCommandWindow).__programmerContextCommands ?? [];
    return commands.filter((envelope) => {
      const candidate = envelope as {
        command?: { type?: unknown };
        module?: unknown;
      };
      return (
        candidate.module === "ProgrammerCommand" &&
        candidate.command?.type === "ReleaseProgrammerValues"
      );
    }) as never;
  });
}

/**
 * Submits a command-line command and waits for its connected backend result.
 */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submittedCommand,
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
 * Waits until programmer state contains rendered fixture rows.
 */
async function waitForProgrammerRows(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as CapturedCommandWindow).appStores?.programmerState?.get?.()
            .length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
}

/**
 * Seeds two color values into the programmer through the command line.
 */
async function seedProgrammerColorValues(page: Page): Promise<void> {
  await submitCommand(page, `fix ${ownedFixtureId} red @ 100`);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rows =
          (
            window as CapturedCommandWindow
          ).appStores?.programmerState?.get?.() ?? [];
        return rows.some((row) =>
          Object.hasOwn(
            (row as { attributes?: object }).attributes ?? {},
            "Red",
          ),
        );
      }),
    )
    .toBe(true);
  await submitCommand(page, `fix ${ownedFixtureId} green @ 50`);
  await waitForProgrammerRows(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rows =
          (
            window as CapturedCommandWindow
          ).appStores?.programmerState?.get?.() ?? [];
        return Array.from(
          new Set(
            rows.flatMap((row) =>
              Object.keys((row as { attributes?: object }).attributes ?? {}),
            ),
          ),
        ).sort();
      }),
    )
    .toEqual(["Green", "Red"]);
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
 * Creates the exact RGBW fixture exercised by the programmer scenarios.
 */
async function createOwnedProgrammerFixture(
  page: Page,
  multiElement = false,
): Promise<void> {
  const result = await page.evaluate(
    async ({ fixtureId, multiElement }) => {
      return (window as any).appStores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id: fixtureId,
            make: "Generic",
            model: multiElement ? "12-segment RGBW Bar" : "Moving Head RGBW",
            mode: multiElement ? "RGBW" : "Spot",
            label: "Owned Programmer Context Fixture",
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
    },
    { fixtureId: ownedFixtureId, multiElement },
  );
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate(
        ({ fixtureId, multiElement }) => {
          const stores = (window as any).appStores;
          const fixture = (
            Object.values(stores.fixtures.get()) as Array<any>
          ).find((candidate) => candidate.identifiers.id === fixtureId);
          if (!fixture) return [];
          const parameters = stores.parameters
            .get()
            .get(fixture.identifiers.uid);
          if (multiElement && (parameters?.elements?.length ?? 0) <= 1)
            return [];
          return Object.keys(parameters?.raw ?? {});
        },
        { fixtureId: ownedFixtureId, multiElement },
      ),
    )
    .toEqual(
      expect.arrayContaining(
        multiElement ? ["Blue", "Green", "Red"] : ["Green", "Intensity", "Red"],
      ),
    );
}

/**
 * Opens the programmer panel in a blank backend after seeding owned color data.
 */
async function openOwnedProgrammer(
  page: Page,
  backendPort: number,
  multiElement = false,
): Promise<Locator> {
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
  await createOwnedProgrammerFixture(page, multiElement);
  await waitForFixtureGridData(page);
  await seedProgrammerColorValues(page);

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
 * Deletes the fixture owned by the current scenario and proves empty cleanup.
 */
async function deleteOwnedProgrammerFixture(page: Page): Promise<void> {
  const result = await page.evaluate(async (fixtureId) => {
    const stores = (window as any).appStores;
    if (
      typeof stores?.sendAndAwait !== "function" ||
      typeof stores?.fixtures?.get !== "function"
    ) {
      return null;
    }
    const fixture = (Object.values(stores.fixtures.get()) as Array<any>).find(
      (candidate) => candidate.identifiers.id === fixtureId,
    );
    if (!fixture) return null;
    return stores.sendAndAwait({
      module: "FixtureCommand",
      command: { type: "DeleteFixture", data: fixtureId },
    });
  }, ownedFixtureId);
  if (result) {
    expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores?.fixtures?.get?.() ?? {})
            .length,
      ),
    )
    .toBe(0);
}

/** Removes all backend fixture data owned by each programmer scenario. */
test.afterEach(async ({ page }) => {
  await deleteOwnedProgrammerFixture(page);
});

/**
 * Opens a visible grid header's context menu by dispatching the browser event.
 */
async function openHeaderContextMenu(
  grid: Locator,
  headerId: string,
): Promise<void> {
  await grid.evaluate((element, targetHeaderId) => {
    const headers = Array.from(
      element.querySelectorAll<HTMLElement>("[data-grid-header-id]"),
    ).filter(
      (header) =>
        header.dataset.gridHeaderId === targetHeaderId &&
        header.getBoundingClientRect().width > 0 &&
        header.getBoundingClientRect().height > 0,
    );
    const target = headers[headers.length - 1];
    if (!target) throw new Error(`Header ${targetHeaderId} was not visible`);
    const rect = target.getBoundingClientRect();
    target.click();
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      }),
    );
  }, headerId);
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
 * Programmer context menus emit scoped release commands for attributes and rows.
 */
test("programmer context menus and Delete release selected values", async ({
  backendSlot,
  page,
}) => {
  await installCommandCapture(page);
  const grid = await openOwnedProgrammer(page, backendSlot.backendPort);
  await clearCapturedCommands(page);

  await openHeaderContextMenu(grid, "tanstack-header-Red_Value");
  await page.getByRole("menuitem", { name: "Clear Red" }).click();
  await expect.poll(() => capturedReleaseCommands(page)).toHaveLength(1);
  let releases = await capturedReleaseCommands(page);
  expect(releases[0]?.command?.data?.selection).toBeUndefined();
  expect(releases[0]?.command?.data?.attributes).toEqual([{ type: "Red" }]);
  await seedProgrammerColorValues(page);
  await clearCapturedCommands(page);

  await openHeaderContextMenu(grid, "tanstack-header-category:Color");
  await page.getByRole("menuitem", { name: "Clear Color" }).click();
  await expect.poll(() => capturedReleaseCommands(page)).toHaveLength(1);
  releases = await capturedReleaseCommands(page);
  expect(
    releases[0]?.command?.data?.attributes?.map((attribute) => attribute.type),
  ).toEqual(["Green", "Red"]);
  await seedProgrammerColorValues(page);
  await clearCapturedCommands(page);

  const redCell = await cellForHeader(grid, "tanstack-header-Red_Value", 0);
  await redCell.click();
  await redCell.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Clear row" }).click();
  await expect.poll(() => capturedReleaseCommands(page)).toHaveLength(1);
  releases = await capturedReleaseCommands(page);
  expect(releases[0]?.command?.data?.selection?.type).toBe("Resolved");
  expect(releases[0]?.command?.data?.selection?.data).toHaveLength(1);
  expect(releases[0]?.command?.data?.attributes).toEqual([]);
  await seedProgrammerColorValues(page);
  await clearCapturedCommands(page);

  const refreshedRedCell = await cellForHeader(
    grid,
    "tanstack-header-Red_Value",
    0,
  );
  await refreshedRedCell.click();
  await page.keyboard.press("Delete");
  await expect.poll(() => capturedReleaseCommands(page)).toHaveLength(1);
  releases = await capturedReleaseCommands(page);
  expect(releases[0]?.command?.data?.selection?.type).toBe("Resolved");
  expect(releases[0]?.command?.data?.attributes).toEqual([{ type: "Red" }]);
});

/**
 * Programmer Intensity clear actions emit the concrete Intensity command attribute.
 */
test("programmer context menu preserves displayed Intensity commands", async ({
  backendSlot,
  page,
}) => {
  await installCommandCapture(page);
  const grid = await openOwnedProgrammer(page, backendSlot.backendPort);

  await submitCommand(page, `fix ${ownedFixtureId} intensity @ 75`);
  await waitForProgrammerRows(page);
  await clearCapturedCommands(page);
  await expect(
    grid.locator(
      '[data-grid-header-id="tanstack-header-Intensity_Value"]:visible',
    ),
  ).toBeVisible();

  await openHeaderContextMenu(grid, "tanstack-header-Intensity_Value");
  await page.getByRole("menuitem", { name: "Clear Intensity" }).click();

  await expect.poll(() => capturedReleaseCommands(page)).toHaveLength(1);
  const releases = await capturedReleaseCommands(page);
  expect(releases[0]?.command?.data?.attributes).toEqual([
    { type: "Intensity" },
  ]);
});

/** Programmer value edits committed with Enter update both the grid and backend state. */
test("programmer value cells commit percentage edits", async ({
  backendSlot,
  page,
}, testInfo) => {
  const grid = await openOwnedProgrammer(page, backendSlot.backendPort);
  await submitCommand(page, `fix ${ownedFixtureId} red @ 25`);
  const redCell = await cellForHeader(grid, "tanstack-header-Red_Value", 0);
  await expect(redCell).toHaveText("25%");

  await redCell.dblclick();
  const editor = redCell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill("100%");
  await editor.press("Enter");

  await expect(editor).toBeHidden();
  await expect(redCell).toHaveText("100%");
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const stores = (window as CapturedCommandWindow).appStores as any;
        const fixture = (Object.values(stores.fixtures.get()) as any[]).find(
          (candidate) => candidate.identifiers.id === fixtureId,
        );
        const row = (stores.programmerState.get() as any[]).find(
          (candidate) => candidate.fixtureUid === fixture?.identifiers.uid,
        );
        return row?.attributes?.Red;
      }, ownedFixtureId),
    )
    .toEqual({
      value: 1,
      isPercentage: true,
      isRelative: false,
    });

  const screenshotPath = testInfo.outputPath("programmer-value-edit.png");
  await grid.screenshot({ path: screenshotPath });
  await testInfo.attach("programmer-value-edit", {
    path: screenshotPath,
    contentType: "image/png",
  });
});

/** Multi-element subset edits retain one complete normalized fixture hierarchy. */
test("programmer subset edits keep multi-element fixture rows normalized", async ({
  backendSlot,
  page,
}, testInfo) => {
  const grid = await openOwnedProgrammer(page, backendSlot.backendPort, true);
  await submitCommand(page, `fix ${ownedFixtureId} blue @ 40`);

  const fixtureCell = grid.locator("#tanstack-cell-0-0");
  await expect(fixtureCell).toContainText(`▶ ${ownedFixtureId}`);
  await fixtureCell.click();
  await expect(fixtureCell).toContainText(`▼ ${ownedFixtureId}`);

  for (const rowIndex of [1, 2]) {
    const redCell = await cellForHeader(
      grid,
      "tanstack-header-Red_Value",
      rowIndex,
    );
    await redCell.dblclick();
    const editor = redCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.fill("30%");
    await editor.press("Enter");
    await expect(editor).toBeHidden();
    await expect(redCell).toHaveText("30.0%");
  }

  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const stores = (window as CapturedCommandWindow).appStores as any;
        const fixture = (Object.values(stores.fixtures.get()) as any[]).find(
          (candidate) => candidate.identifiers.id === fixtureId,
        );
        const rows = (stores.programmerState.get() as any[]).filter(
          (candidate) => candidate.fixtureUid === fixture?.identifiers.uid,
        );
        return {
          fixtureRows: rows.length,
          incompleteElements:
            rows[0]?.elements?.filter(
              (element: any) =>
                element.attributes.Red === undefined ||
                element.attributes.Blue === undefined,
            ).length ?? -1,
        };
      }, ownedFixtureId),
    )
    .toEqual({ fixtureRows: 1, incompleteElements: 0 });

  await expect(grid.locator('[id^="tanstack-cell-0-"]')).toHaveCount(13);
  const screenshotPath = testInfo.outputPath("normalized-programmer-rows.png");
  await grid.screenshot({ path: screenshotPath });
  await testInfo.attach("normalized-programmer-rows", {
    path: screenshotPath,
    contentType: "image/png",
  });
});
