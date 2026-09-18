// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type OwnedUndoFixture = {
  id: number;
  uid: string;
};

type UndoStateSnapshot = {
  undo_depth: number;
  redo_depth: number;
  undo_stack: Array<{
    description: string;
    entry_count: number;
    order: number;
  }>;
  redo_stack: Array<{
    description: string;
    entry_count: number;
    order: number;
  }>;
};

/**
 * Waits until the application exposes the dock API and websocket send helper.
 */
async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator("main#app")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return Boolean(
          stores?.dockApi?.get?.() &&
            stores?.sendAndAwait &&
            (window as any).nightfallShowPalette,
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as any).appStores?.wsLatency?.get?.() ?? null,
      ),
    )
    .not.toBeNull();
}

/**
 * Executes a command from the command palette by exact visible name.
 */
async function openCommandPaletteCommand(
  page: Page,
  commandName: string,
): Promise<void> {
  await page.evaluate(() => {
    (window as any).nightfallShowPalette();
  });

  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(commandName);
  await page.locator(".command-item").filter({ hasText: commandName }).click();
}

/**
 * Sends an undo-stack command through the normal websocket command path.
 */
async function sendUndoCommand(
  page: Page,
  type: "Undo" | "Redo" | "ClearHistory",
): Promise<void> {
  await page.evaluate(async (commandType) => {
    const result = await (window as any).appStores.sendAndAwait({
      module: "UndoCommand",
      command: { type: commandType, data: {} },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `undo command ${commandType} failed: ${JSON.stringify(result)}`,
      );
    }
  }, type);
}

/**
 * Stores the complete fixture used to create deterministic undo entries.
 */
async function storeOwnedUndoFixture(page: Page): Promise<OwnedUndoFixture> {
  const fixture = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const id = Math.floor(700_000 + Math.random() * 100_000);
    const uid = crypto.randomUUID().replaceAll("-", "");
    const result = await stores.sendAndAwait({
      module: "FixtureCommand",
      command: {
        type: "StoreFixture",
        data: {
          identifiers: { id, uid, label: "Owned Undo Stack Fixture" },
          make: "E2E",
          model: "Undo Stack Fixture",
          mode: "Intensity",
          elements: [
            {
              label: "Main",
              parameters: [
                {
                  resolution: "Coarse",
                  attribute: { type: "Intensity" },
                  min: 0,
                  max: 255,
                  offset: { type: "Absolute", data: { value: 0 } },
                  is_inverted: false,
                  is_snap: false,
                  merge_type: "HTP",
                  use_grandmaster: true,
                },
              ],
            },
          ],
          placement: {
            position: { x: 1, y: 2, z: 3 },
            rotation: { x: 0, y: 0, z: 0 },
          },
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`owned fixture store failed: ${JSON.stringify(result)}`);
    }
    return { id, uid };
  });

  await expect
    .poll(() =>
      page.evaluate(
        (uid) => Boolean((window as any).appStores.fixtures.get()[uid]),
        fixture.uid,
      ),
    )
    .toBe(true);
  return fixture;
}

/**
 * Deletes the owned fixture using its current ID after undo cleanup.
 */
async function deleteOwnedUndoFixture(
  page: Page,
  fixture: OwnedUndoFixture,
): Promise<void> {
  await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    const stored = stores.fixtures.get()[uid];
    if (!stored) return;
    const result = await stores.sendAndAwait({
      module: "FixtureCommand",
      command: {
        type: "DeleteFixture",
        data: stored.identifiers.id,
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`owned fixture delete failed: ${JSON.stringify(result)}`);
    }
  }, fixture.uid);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => !(window as any).appStores.fixtures.get()[uid],
        fixture.uid,
      ),
    )
    .toBe(true);
}

/**
 * Renames the requested fixture so the backend records a deterministic undo entry.
 */
async function renameFixture(
  page: Page,
  fixtureId: number,
): Promise<{ fixtureId: number; renamedId: number }> {
  return page.evaluate(async (fixtureId) => {
    const stores = (window as any).appStores;
    const fixtures = Object.values(stores.fixtures.get() ?? {}) as Array<{
      identifiers: { id: number };
    }>;
    if (!fixtures.some((fixture) => fixture.identifiers.id === fixtureId)) {
      throw new Error(`Owned fixture ${fixtureId} was not found`);
    }

    const existingIds = new Set(
      fixtures.map((fixture) => fixture.identifiers.id),
    );
    let renamedId = fixtureId + 900_000;
    while (existingIds.has(renamedId)) {
      renamedId += 1;
    }

    const result = await stores.sendAndAwait({
      module: "FixtureCommand",
      command: {
        type: "RenameFixture",
        data: { id: fixtureId, new_id: renamedId },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`owned fixture rename failed: ${JSON.stringify(result)}`);
    }

    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const currentIds = new Set(
        (
          Object.values(stores.fixtures.get() ?? {}) as Array<{
            identifiers: { id: number };
          }>
        ).map((fixture) => fixture.identifiers.id),
      );
      if (currentIds.has(renamedId) && !currentIds.has(fixtureId)) {
        return { fixtureId, renamedId };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }

    throw new Error(`Fixture ${fixtureId} did not rename to ${renamedId}`);
  }, fixtureId);
}

/**
 * Waits until fixture IDs reflect a completed rename in the frontend store.
 */
async function waitForFixtureRename(
  page: Page,
  fixtureId: number,
  renamedId: number,
): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        ({ fixtureId, renamedId }) => {
          const stores = (window as any).appStores;
          const currentIds = new Set(
            (
              Object.values(stores.fixtures.get() ?? {}) as Array<{
                identifiers: { id: number };
              }>
            ).map((fixture) => fixture.identifiers.id),
          );
          return currentIds.has(renamedId) && !currentIds.has(fixtureId);
        },
        { fixtureId, renamedId },
      ),
    )
    .toBe(true);
}

/**
 * Reads the frontend undo state store for Playwright polling.
 */
async function currentUndoState(page: Page): Promise<UndoStateSnapshot> {
  return page.evaluate(() => (window as any).appStores.undoState.get());
}

/**
 * Verifies the undo stack panel opens from the command palette and tracks stack mutations.
 */
test("undo stack panel displays live undo and redo entries", async ({
  backendSlot,
  page,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=undo-stack-panel");
  await waitForDockviewApp(page);
  await waitForAppReady(page);
  const fixture = await storeOwnedUndoFixture(page);
  let undoCleanupCount = 0;

  try {
    await sendUndoCommand(page, "ClearHistory");
    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 0,
        redo_depth: 0,
        undo_stack: [],
        redo_stack: [],
      });

    await openCommandPaletteCommand(page, "Open Undo Stack");
    await expect(
      page.locator(".dv-tab").filter({ hasText: "Undo Stack" }),
    ).toBeVisible();
    await expect(page.getByText("Undo stack is empty")).toBeVisible();
    await expect(page.getByText("Redo stack is empty")).toBeVisible();

    const rename = await renameFixture(page, fixture.id);
    undoCleanupCount = 1;
    const renameLabel = `Rename Fixture ${rename.fixtureId} → ${rename.renamedId}`;

    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 1,
        redo_depth: 0,
        undo_stack: [
          {
            description: renameLabel,
            entry_count: 1,
            order: 0,
          },
        ],
        redo_stack: [],
      });
    await expect(page.getByText("Undo stack is empty")).not.toBeVisible();
    await expect(page.locator('[data-stack-top-marker="undo"]')).toBeVisible();
    await expect(page.locator('[data-stack-next="undo"]')).toContainText(
      renameLabel,
    );
    await expect(
      page.locator('[data-stack-kind="undo"]').first(),
    ).toContainText(renameLabel);

    await sendUndoCommand(page, "Undo");
    undoCleanupCount = 0;

    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 0,
        redo_depth: 1,
        undo_stack: [],
        redo_stack: [
          {
            description: renameLabel,
            entry_count: 1,
            order: 0,
          },
        ],
      });
    await expect(page.getByText("Undo stack is empty")).toBeVisible();
    await expect(page.locator('[data-stack-top-marker="redo"]')).toBeVisible();
    await expect(page.locator('[data-stack-next="redo"]')).toContainText(
      renameLabel,
    );

    await sendUndoCommand(page, "Redo");
    await waitForFixtureRename(page, rename.fixtureId, rename.renamedId);
    undoCleanupCount = 1;

    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 1,
        redo_depth: 0,
        undo_stack: [
          {
            description: renameLabel,
            entry_count: 1,
            order: 0,
          },
        ],
        redo_stack: [],
      });
    await expect(page.getByText("Redo stack is empty")).toBeVisible();

    const secondRename = await renameFixture(page, rename.renamedId);
    undoCleanupCount = 2;
    const secondRenameLabel = `Rename Fixture ${secondRename.fixtureId} → ${secondRename.renamedId}`;

    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 2,
        redo_depth: 0,
        undo_stack: [
          {
            description: secondRenameLabel,
            order: 0,
          },
          {
            description: renameLabel,
            order: 1,
          },
        ],
      });

    await page.getByRole("button", { name: "Open undo timeline" }).click();
    await expect(
      page.getByRole("menu", { name: "Undo timeline" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menu", { name: "Undo timeline" }),
    ).toContainText("2 total");
    await expect(page.getByLabel("Current undo state")).toBeVisible();
    await expect(
      page.locator('[data-undo-timeline-kind="undo"]').first(),
    ).toHaveText(/UNDO \[1x\].*(ago|now)/);
    await testInfo.attach("undo-timeline-popout", {
      body: await page.screenshot({
        path: testInfo.outputPath("shared-undo-timeline.png"),
      }),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menu", { name: "Undo timeline" }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open undo timeline" }),
    ).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Open undo timeline" }).click();
    await page.locator('[data-undo-timeline-kind="undo"]').nth(1).click();
    undoCleanupCount = 0;

    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 0,
        redo_depth: 2,
        redo_stack: [
          {
            description: renameLabel,
            order: 0,
          },
          {
            description: secondRenameLabel,
            order: 1,
          },
        ],
      });

    await page.getByRole("button", { name: "Open undo timeline" }).click();
    await expect(
      page.getByRole("menu", { name: "Undo timeline" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menu", { name: "Undo timeline" }),
    ).toContainText("2 total");
    await expect(page.getByLabel("Current undo state")).toBeVisible();
    await expect(
      page.locator('[data-undo-timeline-kind="redo"]').first(),
    ).toContainText(secondRenameLabel);
    await expect(
      page.locator('[data-undo-timeline-kind="redo"]').first(),
    ).toHaveText(/REDO \[1x\].*(ago|now)/);
    await page.locator('[data-undo-timeline-kind="redo"]').first().click();
    undoCleanupCount = 2;

    await expect
      .poll(async () => currentUndoState(page))
      .toMatchObject({
        undo_depth: 2,
        redo_depth: 0,
        undo_stack: [
          {
            description: secondRenameLabel,
            order: 0,
          },
          {
            description: renameLabel,
            order: 1,
          },
        ],
      });

    await testInfo.attach("undo-stack-panel", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    for (let step = 0; step < undoCleanupCount; step += 1) {
      await sendUndoCommand(page, "Undo").catch(() => undefined);
    }
    await sendUndoCommand(page, "ClearHistory").catch(() => undefined);
    await deleteOwnedUndoFixture(page, fixture);
  }
});
