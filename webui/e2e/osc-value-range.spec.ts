// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSocket } from "node:dgram";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { gridCellByKey } from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const FADER_ADDRESS = "/e2e/range/fader";

/** Opens a blank showfile on the test's isolated backend once the action catalog arrives. */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => ((window as any).appStores.actionCatalog.get() as []).length,
      ),
    )
    .toBeGreaterThan(0);
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Encodes a string as a null-terminated, four-byte-aligned OSC string. */
function oscString(value: string): Buffer {
  const length = Math.ceil((value.length + 1) / 4) * 4;
  const buffer = Buffer.alloc(length);
  buffer.write(value, "ascii");
  return buffer;
}

/** Sends one OSC message carrying a single 32-bit integer argument over UDP. */
async function sendOscInt(
  port: number,
  address: string,
  value: number,
): Promise<void> {
  const argument = Buffer.alloc(4);
  argument.writeInt32BE(value);
  const message = Buffer.concat([
    oscString(address),
    oscString(",i"),
    argument,
  ]);
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) =>
    socket.send(message, port, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  socket.close();
}

/** Returns the port the backend's OSC listener is bound to. */
async function oscPort(page: Page): Promise<number> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscListenerStatus.get()?.is_listening,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () => (window as any).appStores.oscListenerStatus.get().port as number,
  );
}

/** Returns the only master's level percentage. */
function masterLevel(page: Page): Promise<number | undefined> {
  return page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        ?.level_percent as number | undefined,
  );
}

/** Returns the stored value range of the only OSC mapping. */
function storedRange(page: Page): Promise<unknown> {
  return page.evaluate(
    () => (window as any).appStores.oscMappings.get()[0]?.range ?? null,
  );
}

/** Replaces a grid cell's text through its inline editor, opened from the keyboard. */
async function editCellText(cell: Locator, value: string): Promise<void> {
  await cell.click();
  await cell.page().keyboard.press("Enter");
  const editor = cell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await editor.press("Enter");
  await expect(editor).toBeHidden();
}

/** Verifies an OSC fader sending 0..127 integers reaches full level once its range is set. */
test("an explicit OSC value range maps integer faders across a master's full level", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  const port = await oscPort(page);
  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect.poll(() => masterLevel(page)).toBe(100);
  const masterUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers.uid as string,
  );

  const upsert = await page.evaluate(
    ({ address, masterUid }) =>
      (window as any).appStores.sendAndAwait({
        module: "OscCommand",
        command: {
          type: "UpsertMapping",
          data: {
            id: crypto.randomUUID(),
            address,
            arg_index: 0,
            action: { id: "master.level", arguments: { master: masterUid } },
          },
        },
      }),
    { address: FADER_ADDRESS, masterUid },
  );
  expect(upsert.outcome).toMatchObject({ type: "Succeeded" });

  // Without a range, integers read as percents, so 64 of 127 reads as 64%.
  await sendOscInt(port, FADER_ADDRESS, 64);
  await expect.poll(() => masterLevel(page)).toBeCloseTo(64, 0);

  await openPanel(page, "OSC Input");
  // Maximize the panel so the mapping grid has room for inline editors.
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().activePanel.api.maximize(),
  );
  const grid = page.locator('[data-grid-kind="tanstack"]').filter({
    has: page.locator('[data-grid-header-id="tanstack-header-range_max"]'),
  });
  const mappingKey = await page.evaluate(
    () => (window as any).appStores.oscMappings.get()[0].id as string,
  );
  const minCell = gridCellByKey(grid, {
    columnKey: "range_min",
    rowKey: mappingKey,
  });
  const maxCell = gridCellByKey(grid, {
    columnKey: "range_max",
    rowKey: mappingKey,
  });
  await expect(minCell).toHaveText("");
  await expect(maxCell).toHaveText("");
  // Selecting the row reveals the action picker above the grid, so select it before editing.
  await maxCell.click();
  await expect(page.getByText("Selected action")).toBeVisible();

  await editCellText(maxCell, "127");
  await expect.poll(() => storedRange(page)).toEqual({ min: 0, max: 127 });
  await expect(minCell).toHaveText("0");
  await expect(maxCell).toHaveText("127");

  await sendOscInt(port, FADER_ADDRESS, 127);
  await expect.poll(() => masterLevel(page)).toBeCloseTo(100, 0);
  await sendOscInt(port, FADER_ADDRESS, 64);
  await expect.poll(() => masterLevel(page)).toBeCloseTo(50.4, 0);

  // An empty range is rejected client-side and the stored range is kept.
  await editCellText(minCell, "127");
  await expect(
    page.getByText(
      "OSC value range minimum and maximum must differ (both are 127)",
    ),
  ).toBeVisible();
  expect(await storedRange(page)).toEqual({ min: 0, max: 127 });

  await page.screenshot({
    path: test.info().outputPath("osc-value-range-columns.png"),
  });

  // Clearing an end restores inferred units.
  await editCellText(maxCell, "");
  await expect.poll(() => storedRange(page)).toBeNull();
});
