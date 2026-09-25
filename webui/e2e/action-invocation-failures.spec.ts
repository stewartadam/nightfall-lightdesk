// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSocket } from "node:dgram";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

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

/** Returns the failure codes recorded in the invocation failure store, newest first. */
async function failureCodes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as any).appStores.actionInvocationFailures
      .get()
      .map((failure: any) => failure.error.code),
  );
}

/** Pads an OSC string to a four-byte boundary with at least one terminator. */
function oscString(value: string): Buffer {
  const buffer = Buffer.alloc(Math.ceil((value.length + 1) / 4) * 4);
  buffer.write(value, "ascii");
  return buffer;
}

/** Encodes one OSC message with an optional float argument. */
function oscMessage(address: string, value?: number): Buffer {
  if (value === undefined) {
    return Buffer.concat([oscString(address), oscString(",")]);
  }
  const argument = Buffer.alloc(4);
  argument.writeFloatBE(value);
  return Buffer.concat([oscString(address), oscString(",f"), argument]);
}

/** Sends one OSC message to the backend's listener. */
async function sendOsc(
  port: number,
  address: string,
  value?: number,
): Promise<void> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) =>
    socket.send(oscMessage(address, value), port, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  socket.close();
}

/** Waits for the OSC listener and returns its bound port. */
async function oscListenerPort(page: Page): Promise<number> {
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

/**
 * Creates an OSC mapping from an address to a backend action through the mapping command.
 *
 * `argIndex` makes the mapping read that argument as a level, as a fader does.
 */
async function mapOscAddress(
  page: Page,
  address: string,
  action: { id: string; arguments: Record<string, unknown> },
  argIndex?: number,
): Promise<void> {
  const result = await page.evaluate(
    ({ address, action, argIndex }) =>
      (window as any).appStores.sendAndAwait({
        module: "OscCommand",
        command: {
          type: "UpsertMapping",
          data: {
            id: crypto.randomUUID(),
            address,
            action,
            ...(argIndex === undefined ? {} : { arg_index: argIndex }),
          },
        },
      }),
    { address, action, argIndex },
  );
  expect(result.outcome).toMatchObject({ type: "Succeeded" });
}

test("a failing keybinding shows one labelled toast and records the failure", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER).fill("Open Masters");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.masters.get()).length,
      ),
    )
    .toBe(1);
  await page
    .locator("[data-master-id] select")
    .first()
    .selectOption("AlwaysOn");
  const masterUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers.uid as string,
  );

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER).fill("Open Settings");
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "Keyboard" }).click();
  const settings = page.locator("[data-keybindings-settings]");
  await settings.getByRole("button", { name: "Record keys" }).click();
  await page.keyboard.press("Alt+Shift+KeyT");
  await settings
    .getByRole("combobox", { name: "Keybinding action" })
    .selectOption("master.on");
  await settings
    .getByRole("combobox", { name: "Master" })
    .selectOption(masterUid.replaceAll("-", "").toLowerCase());
  await settings.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");

  await page.locator("main#app").click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("Alt+Shift+KeyT");

  const toast = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Master on failed" });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("is not a toggle master");
  await expect.poll(() => failureCodes(page)).toEqual(["master.not_toggle"]);
  const failure = await page.evaluate(
    () => (window as any).appStores.actionInvocationFailures.get()[0],
  );
  expect(failure.command_id).toBeTruthy();
  expect(failure.error.details).toBeTruthy();
  await page.waitForTimeout(500);
  await expect(
    page
      .locator('[data-component="Toast"]')
      .filter({ hasText: "is not a toggle master" }),
  ).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath("keybinding-failure-toast.png"),
  });
});

test("OSC mappings to missing targets surface failures without flooding", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  const port = await oscListenerPort(page);
  const missingUid = crypto.randomUUID();
  await mapOscAddress(page, "/e2e/fail/clip", {
    id: "clip.start",
    arguments: { clip: missingUid },
  });
  await mapOscAddress(
    page,
    "/e2e/fail/fader",
    { id: "master.level", arguments: { master: missingUid } },
    0,
  );

  await sendOsc(port, "/e2e/fail/clip");
  const clipToast = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Start clip failed" });
  await expect(clipToast).toBeVisible();
  await expect(clipToast).toContainText("does not exist");
  await expect.poll(() => failureCodes(page)).toEqual(["clip.not_found"]);

  for (const value of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    await sendOsc(port, "/e2e/fail/fader", value);
  }
  await expect
    .poll(() => failureCodes(page))
    .toEqual(["master.not_found", "clip.not_found"]);
  await page.waitForTimeout(500);
  expect(await failureCodes(page)).toEqual([
    "master.not_found",
    "clip.not_found",
  ]);
  await expect(
    page
      .locator('[data-component="Toast"]')
      .filter({ hasText: "Master level failed" }),
  ).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath("osc-failure-toasts.png"),
  });
});
