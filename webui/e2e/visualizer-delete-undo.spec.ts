// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const OWNED_VISUALIZER_FIXTURE_ID = 911_001;

type DeleteTarget = {
  fixtureId: number;
  fixtureUid: string;
  fixtureSelectionUid: string;
  bindingCount: number;
};

/** Opens the visualizer against a blank backend with one owned fixture. */
async function openOwnedVisualizerDeleteUndoApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false&e2e=visualizer-delete-undo",
  );
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.bindings?.get) &&
      Boolean((window as any).appStores?.fixtures?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        const bindings = stores.bindings.get();
        return {
          bindings:
            bindings.input.length +
            bindings.output.length +
            bindings.disabled.length,
          fixtures: Object.keys(stores.fixtures.get()).length,
        };
      }),
    )
    .toEqual({ bindings: 0, fixtures: 0 });

  const result = await page.evaluate(async (fixtureId) => {
    return (window as any).appStores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: "Owned Visualizer Delete Fixture",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
  }, OWNED_VISUALIZER_FIXTURE_ID);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Object.values((window as any).appStores.fixtures.get()) as any[]).map(
          (fixture) => fixture.identifiers.id,
        ),
      ),
    )
    .toEqual([OWNED_VISUALIZER_FIXTURE_ID]);

  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  const visualizerPanel = page.locator('[data-panel-id="panel-Visualizer"]');
  await expect(visualizerPanel).toBeVisible();
  await expect(visualizerPanel.locator("canvas").first()).toBeVisible();
  await expect(visualizerPanel.locator(".fps-label")).toBeVisible({
    timeout: 15_000,
  });
  await waitForAppStores(page);
}

/**
 * Deletes a selected visualizer fixture and verifies a single undo restores it.
 */
test("visualizer delete can be undone in one step", async ({
  backendSlot,
  page,
}, testInfo) => {
  await installCommandCapture(page);
  await openOwnedVisualizerDeleteUndoApp(page, backendSlot.backendPort);

  const target = await findFixtureDeleteTarget(
    page,
    OWNED_VISUALIZER_FIXTURE_ID,
  );
  expect(target.bindingCount).toBe(0);
  try {
    await createBackendOutputBinding(page, target.fixtureId);
    await expect
      .poll(() => bindingReferenceCount(page, target))
      .toBeGreaterThan(0);
    target.bindingCount = await bindingReferenceCount(page, target);
    expect(target.bindingCount).toBeGreaterThan(0);

    await selectFixture(page, target.fixtureSelectionUid);
    await expect
      .poll(() => selectedFixtureUids(page))
      .toContain(target.fixtureUid);
    await clearUndoHistory(page);

    const deleteButton = page.getByRole("button", {
      name: "Delete selected (1) (Del/Backspace)",
    });
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    const dialog = page.getByRole("dialog", {
      name: "Delete selected visualizer objects",
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("This can be undone in one step."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect.poll(() => fixtureExists(page, target.fixtureId)).toBe(false);
    await expect.poll(() => bindingReferenceCount(page, target)).toBe(0);
    await expect.poll(() => selectedFixtureUids(page)).toEqual([]);
    await expectDeleteCommandsToShareBatch(page, target.fixtureId);
    await page.waitForTimeout(500);

    await undo(page);

    await expect.poll(() => fixtureExists(page, target.fixtureId)).toBe(true);
    await expect
      .poll(() => bindingReferenceCount(page, target))
      .toBe(target.bindingCount);
    await expect
      .poll(() => selectedFixtureUids(page))
      .toContain(target.fixtureUid);

    await testInfo.attach("visualizer-delete-undo-restored", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await deleteOwnedVisualizerTarget(page, target);
  }
});

/** Deletes any restored owned fixture and proves blank backend teardown. */
async function deleteOwnedVisualizerTarget(
  page: Page,
  target: DeleteTarget,
): Promise<void> {
  if (await fixtureExists(page, target.fixtureId)) {
    if (!(await selectedFixtureUids(page)).includes(target.fixtureUid)) {
      await selectFixture(page, target.fixtureSelectionUid);
      await expect
        .poll(() => selectedFixtureUids(page))
        .toContain(target.fixtureUid);
    }

    const deleteButton = page.getByRole("button", {
      name: "Delete selected (1) (Del/Backspace)",
    });
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    const dialog = page.getByRole("dialog", {
      name: "Delete selected visualizer objects",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();
  }

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        const bindings = stores.bindings.get();
        return {
          bindings:
            bindings.input.length +
            bindings.output.length +
            bindings.disabled.length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          selection: stores.programmerSelection.get().length,
        };
      }),
    )
    .toEqual({ bindings: 0, fixtures: 0, selection: 0 });
}

/**
 * Captures websocket command envelopes posted to the worker.
 */
async function installCommandCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__visualizerDeleteCommands = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transfer?: Transferable[],
    ) {
      if (
        message &&
        typeof message === "object" &&
        (message as any).type === "send"
      ) {
        (window as any).__visualizerDeleteCommands.push((message as any).data);
      }
      return originalPostMessage.call(this, message, transfer as never);
    } as Worker["postMessage"];
  });
}

/**
 * Sends an undo command through the websocket command path.
 */
async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).appStores.send({
      module: "UndoCommand",
      command: { type: "Undo", data: {} },
    });
  });
}

/**
 * Clears existing undo history so the delete operation is the next undo target.
 */
async function clearUndoHistory(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).appStores.send({
      module: "UndoCommand",
      command: { type: "ClearHistory", data: {} },
    });
  });
  await page.waitForTimeout(500);
}

/**
 * Waits for the app shell stores and owned fixture data to hydrate.
 */
async function waitForAppStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.send === "function" &&
      Object.keys((window as any).appStores?.fixtures?.get?.() ?? {}).length >
        0,
  );
}

/**
 * Finds the exact owned fixture used for delete/undo validation.
 */
async function findFixtureDeleteTarget(
  page: Page,
  fixtureId: number,
): Promise<DeleteTarget> {
  return page.evaluate((fixtureId) => {
    /** Normalizes UUIDs serialized either as strings or byte maps. */
    const uuidToString = (value: unknown): string | null => {
      if (typeof value === "string") {
        return value.toLowerCase().replaceAll("-", "");
      }

      if (!value || typeof value !== "object") {
        return null;
      }

      const bytes = Array.isArray(value)
        ? value
        : Array.from(
            { length: 16 },
            (_, index) => (value as Record<string, unknown>)[String(index)],
          );
      if (
        bytes.length !== 16 ||
        !bytes.every((byte) => typeof byte === "number")
      ) {
        return null;
      }

      const hex = (bytes as number[]).map((byte) =>
        byte.toString(16).padStart(2, "0"),
      );
      return hex.join("");
    };

    /** Formats a canonical UUID string with hyphen separators. */
    const hyphenateUuid = (uid: string): string =>
      `${uid.slice(0, 8)}-${uid.slice(8, 12)}-${uid.slice(
        12,
        16,
      )}-${uid.slice(16, 20)}-${uid.slice(20)}`;

    /** Recursively tests structured binding data for a fixture reference. */
    const objectReferencesFixture = (
      value: unknown,
      uid: string,
      id: number,
    ): boolean => {
      if (!value || typeof value !== "object") {
        return false;
      }
      if (Array.isArray(value)) {
        return value.some((item) => objectReferencesFixture(item, uid, id));
      }

      const record = value as Record<string, unknown>;
      if (
        Array.isArray(record.uids) &&
        record.uids.some((item) => uuidToString(item) === uid)
      ) {
        return true;
      }
      if (Array.isArray(record.ids) && record.ids.some((item) => item === id)) {
        return true;
      }

      return Object.values(record).some((item) =>
        objectReferencesFixture(item, uid, id),
      );
    };

    /** Counts binding entries whose nested source or target data references a fixture. */
    const countBindingsForFixture = (
      bindings: any,
      uid: string,
      id: number,
    ): number => {
      const entries = [
        ...(bindings.input ?? []),
        ...(bindings.output ?? []),
        ...(bindings.disabled ?? []),
      ];
      return entries.filter((entry) => objectReferencesFixture(entry, uid, id))
        .length;
    };

    const stores = (window as any).appStores;
    const fixtures = stores.fixtures.get();
    const fixture = (Object.values(fixtures) as any[]).find(
      (candidate) => candidate.identifiers.id === fixtureId,
    );
    if (!fixture) {
      throw new Error(`expected owned fixture ${fixtureId}`);
    }

    const fixtureUid = fixture.identifiers.uid as string;
    const normalizedFixtureUid = uuidToString(fixtureUid);
    if (!normalizedFixtureUid) {
      throw new Error("expected fixture UID to be serializable");
    }

    return {
      fixtureId: fixture.identifiers.id as number,
      fixtureUid: normalizedFixtureUid,
      fixtureSelectionUid: hyphenateUuid(normalizedFixtureUid),
      bindingCount: countBindingsForFixture(
        stores.bindings.get(),
        normalizedFixtureUid,
        fixture.identifiers.id as number,
      ),
    };
  }, fixtureId);
}

/**
 * Creates a real backend output binding for the fixture under test.
 */
async function createBackendOutputBinding(
  page: Page,
  fixtureId: number,
): Promise<void> {
  await page.evaluate(async (id) => {
    await (window as any).appStores.send({
      module: "FixtureCommand",
      command: {
        type: "UpdateFixturePatch",
        data: {
          id,
          universe: 999,
          address: 1,
          transport: {
            type: "Sacn",
            data: { mode: { type: "Multicast" } },
          },
        },
      },
    });
  }, fixtureId);
}

/**
 * Selects a fixture through the backend programmer selection command.
 */
async function selectFixture(page: Page, fixtureUid: string): Promise<void> {
  await page.evaluate(async (uid) => {
    await (window as any).appStores.send({
      module: "ProgrammerCommand",
      command: {
        type: "SetProgrammerSelection",
        data: {
          type: "Resolved",
          data: [{ fixture_uid: uid }],
        },
      },
    });
  }, fixtureUid);
}

/**
 * Reads the current visualizer fixture selection.
 */
async function selectedFixtureUids(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    /** Normalizes UUIDs serialized either as strings or byte maps. */
    const uuidToString = (value: unknown): string | null => {
      if (typeof value === "string") {
        return value.toLowerCase().replaceAll("-", "");
      }

      if (!value || typeof value !== "object") {
        return null;
      }

      const bytes = Array.isArray(value)
        ? value
        : Array.from(
            { length: 16 },
            (_, index) => (value as Record<string, unknown>)[String(index)],
          );
      if (
        bytes.length !== 16 ||
        !bytes.every((byte) => typeof byte === "number")
      ) {
        return null;
      }

      return (bytes as number[])
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    };

    return ((window as any).appStores.programmerSelection.get() as unknown[])
      .map(uuidToString)
      .filter((uid): uid is string => uid !== null);
  });
}

/**
 * Checks whether a fixture still exists in the frontend fixture store.
 */
async function fixtureExists(page: Page, fixtureId: number): Promise<boolean> {
  return page.evaluate(
    (id) =>
      Object.values((window as any).appStores.fixtures.get()).some(
        (fixture: any) => fixture.identifiers.id === id,
      ),
    fixtureId,
  );
}

/**
 * Counts patch bindings that reference a fixture UID.
 */
async function bindingReferenceCount(
  page: Page,
  target: DeleteTarget,
): Promise<number> {
  return page.evaluate(({ fixtureUid, fixtureId }) => {
    /** Normalizes UUIDs serialized either as strings or byte maps. */
    const uuidToString = (value: unknown): string | null => {
      if (typeof value === "string") {
        return value.toLowerCase().replaceAll("-", "");
      }

      if (!value || typeof value !== "object") {
        return null;
      }

      const bytes = Array.isArray(value)
        ? value
        : Array.from(
            { length: 16 },
            (_, index) => (value as Record<string, unknown>)[String(index)],
          );
      if (
        bytes.length !== 16 ||
        !bytes.every((byte) => typeof byte === "number")
      ) {
        return null;
      }

      const hex = (bytes as number[]).map((byte) =>
        byte.toString(16).padStart(2, "0"),
      );
      return hex.join("");
    };

    /** Recursively tests structured binding data for a fixture reference. */
    const objectReferencesFixture = (value: unknown): boolean => {
      if (!value || typeof value !== "object") {
        return false;
      }
      if (Array.isArray(value)) {
        return value.some((item) => objectReferencesFixture(item));
      }

      const record = value as Record<string, unknown>;
      if (
        Array.isArray(record.uids) &&
        record.uids.some((item) => uuidToString(item) === fixtureUid)
      ) {
        return true;
      }
      if (
        Array.isArray(record.ids) &&
        record.ids.some((item) => item === fixtureId)
      ) {
        return true;
      }

      return Object.values(record).some((item) =>
        objectReferencesFixture(item),
      );
    };

    const bindings = (window as any).appStores.bindings.get();
    const entries = [
      ...(bindings.input ?? []),
      ...(bindings.output ?? []),
      ...(bindings.disabled ?? []),
    ];
    return entries.filter((entry) => objectReferencesFixture(entry)).length;
  }, target);
}

/**
 * Verifies visualizer delete sends related commands under one undo group.
 */
async function expectDeleteCommandsToShareBatch(
  page: Page,
  fixtureId: number,
): Promise<void> {
  const commands = await page.evaluate(() =>
    ((window as any).__visualizerDeleteCommands ?? []).filter(
      (envelope: any) =>
        envelope?.command?.type === "RemovePatchBinding" ||
        envelope?.command?.type === "DeleteFixture" ||
        envelope?.command?.type === "ClearProgrammerSelection",
    ),
  );

  const removeBinding = commands.find(
    (envelope: any) => envelope.command.type === "RemovePatchBinding",
  );
  const deleteFixture = commands.find(
    (envelope: any) =>
      envelope.command.type === "DeleteFixture" &&
      envelope.command.data === fixtureId,
  );
  const clearSelection = commands.find(
    (envelope: any) => envelope.command.type === "ClearProgrammerSelection",
  );

  expect(removeBinding).toBeTruthy();
  expect(deleteFixture).toBeTruthy();
  expect(clearSelection).toBeTruthy();
  expect(removeBinding.undo_id).toBe(deleteFixture.undo_id);
  expect(clearSelection.undo_id).toBe(deleteFixture.undo_id);
}
