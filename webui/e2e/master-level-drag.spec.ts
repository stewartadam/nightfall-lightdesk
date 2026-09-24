// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

type WorkerSubmit = {
  type?: string;
  data?: {
    module?: string;
    update?: { type?: string };
    command?: {
      type?: string;
      data?: { from_percent?: number; level_percent?: number };
    };
  };
};

/** Opens a blank backend showfile with worker messages recorded for inspection. */
async function openInstrumentedApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    const instrumented = window as Window & { __workerMessages?: unknown[] };
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    instrumented.__workerMessages = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      optionsOrTransfer?: StructuredSerializeOptions | Transferable[],
    ) {
      instrumented.__workerMessages?.push(message);
      return originalPostMessage.call(
        this,
        message,
        optionsOrTransfer as never,
      );
    };
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.masters?.get),
  );
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Returns recorded websocket submissions for one backend module. */
async function submissionsFor(
  page: Page,
  module: string,
): Promise<WorkerSubmit["data"][]> {
  return page.evaluate(
    (module) =>
      (((window as any).__workerMessages as WorkerSubmit[] | undefined) ?? [])
        .filter((message) => message?.data?.module === module)
        .map((message) => message.data),
    module,
  );
}

/** Returns the stored level of the only master in the showfile. */
async function masterLevel(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const masters = Object.values(
      (window as any).appStores.masters.get(),
    ) as Array<{ level_percent: number }>;
    return masters[0]?.level_percent;
  });
}

test("dragging a master level streams updates and commits one undoable change", async ({
  backendSlot,
  page,
}) => {
  await openInstrumentedApp(page, backendSlot.backendPort);
  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect.poll(() => masterLevel(page)).toBe(100);

  const slider = page.locator('[data-master-id] input[type="range"]').first();
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + box!.width - 2, y);
  await page.mouse.down();
  for (const fraction of [0.8, 0.6, 0.4, 0.25]) {
    await page.mouse.move(box!.x + box!.width * fraction, y, { steps: 3 });
  }
  await page.mouse.up();

  await expect.poll(() => masterLevel(page)).toBeLessThan(40);
  const updates = await submissionsFor(page, "MasterUpdate");
  expect(updates.length).toBeGreaterThan(1);
  expect(updates.every((update) => update?.update?.type === "SetLevel")).toBe(
    true,
  );
  const commits = (await submissionsFor(page, "MasterCommand")).filter(
    (submission) => submission?.command?.type === "CommitMasterLevel",
  );
  expect(commits).toHaveLength(1);
  expect(commits[0]?.command?.data?.from_percent).toBe(100);

  // One undo reverts the whole drag back to its starting level.
  await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "UndoCommand",
      command: { type: "Undo", data: {} },
    }),
  );
  await expect.poll(() => masterLevel(page)).toBe(100);
});
