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

/**
 * Opens a blank showfile on the test's isolated backend.
 *
 * Browser storage is cleared only on the first load so persisted keybindings survive reloads.
 */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("e2e-storage-initialized")) return;
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    window.sessionStorage.setItem("e2e-storage-initialized", "true");
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

/** Returns whether a panel with the given title is open in the dock. */
async function isPanelOpen(page: Page, title: string): Promise<boolean> {
  return page.evaluate(
    (title) =>
      (window as any).appStores.dockApi
        .get()
        .panels.some((panel: { title?: string }) => panel.title === title),
    title,
  );
}

/** Closes every open panel with the given title. */
async function closePanels(page: Page, title: string): Promise<void> {
  await page.evaluate((title) => {
    for (const panel of (window as any).appStores.dockApi.get().panels) {
      if (panel.title === title) panel.api.close();
    }
  }, title);
}

/** Opens the Keyboard settings tab. */
async function openKeyboardSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER).fill("Open Settings");
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "Keyboard" }).click();
  await expect(page.locator("[data-keybindings-settings]")).toBeVisible();
}

/** Records a key combination and binds it to the chosen action in Keyboard settings. */
async function addKeybinding(
  page: Page,
  keys: string,
  actionId: string,
  configure?: (settings: ReturnType<Page["locator"]>) => Promise<void>,
): Promise<void> {
  const settings = page.locator("[data-keybindings-settings]");
  await settings.getByRole("button", { name: "Record keys" }).click();
  await page.keyboard.press(keys);
  await settings
    .getByRole("combobox", { name: "Keybinding action" })
    .selectOption(actionId);
  await configure?.(settings);
  await settings.getByRole("button", { name: "Add", exact: true }).click();
}

/** Encodes one OSC message without arguments. */
function oscPulse(address: string): Buffer {
  const pad = (value: string) => {
    const buffer = Buffer.alloc(Math.ceil((value.length + 1) / 4) * 4);
    buffer.write(value, "ascii");
    return buffer;
  };
  return Buffer.concat([pad(address), pad(",")]);
}

/** Sends an argument-free OSC message to the backend's listener. */
async function sendOscPulse(port: number, address: string): Promise<void> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) =>
    socket.send(oscPulse(address), port, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  socket.close();
}

test("keybindings open UI actions and persist across reloads", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await closePanels(page, "MIDI Input");
  await openKeyboardSettings(page);
  await addKeybinding(page, "Alt+Shift+KeyM", "ui.panel-MidiInput");
  await expect(
    page.locator('[data-keybinding="Alt+Shift+KeyM"]'),
  ).toContainText("Open MIDI Input");
  await page.screenshot({
    path: test.info().outputPath("keyboard-settings.png"),
  });
  await page.keyboard.press("Escape");

  await page.locator("main#app").click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("Alt+Shift+KeyM");
  await expect.poll(() => isPanelOpen(page, "MIDI Input")).toBe(true);

  await closePanels(page, "MIDI Input");
  await page.reload();
  await waitForDockviewApp(page);
  await closePanels(page, "MIDI Input");
  await page.locator("main#app").click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("Alt+Shift+KeyM");
  await expect.poll(() => isPanelOpen(page, "MIDI Input")).toBe(true);
});

test("keybindings invoke backend actions with arguments", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER).fill("Open Masters");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await page
    .locator("[data-master-id] select")
    .first()
    .selectOption("toggle-off");
  const masterUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers.uid as string,
  );

  await openKeyboardSettings(page);
  await addKeybinding(
    page,
    "Alt+Shift+KeyT",
    "master.toggle",
    async (settings) => {
      await settings
        .getByRole("combobox", { name: "Master" })
        .selectOption(masterUid.replaceAll("-", "").toLowerCase());
    },
  );
  await page.keyboard.press("Escape");

  await page.locator("main#app").click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("Alt+Shift+KeyT");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Object.values((window as any).appStores.masters.get())[0] as any)
            .mode.data?.active,
      ),
    )
    .toBe(true);
});

test("OSC mappings to UI actions run on opted-in clients only", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscListenerStatus.get()?.is_listening,
      ),
    )
    .toBe(true);
  const port = await page.evaluate(
    () => (window as any).appStores.oscListenerStatus.get().port as number,
  );
  await closePanels(page, "OSC Input");

  // Bind an OSC button to a palette entry in mapping mode.
  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  await sendOscPulse(port, "/e2e/ui/osc-panel");
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    "OSC /e2e/ui/osc-panel",
  );
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER).fill("Open OSC Input");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .map((mapping: any) => mapping.action.id),
      ),
    )
    .toEqual(["ui.panel-OscInput"]);
  expect(await isPanelOpen(page, "OSC Input")).toBe(false);
  // The binding's confirmation toast can cover the banner's Done button.
  await page
    .getByRole("alert")
    .filter({ hasText: "Bound OSC /e2e/ui/osc-panel" })
    .getByRole("button", { name: "Close" })
    .click();
  await page.getByRole("button", { name: "Done" }).click();

  await sendOscPulse(port, "/e2e/ui/osc-panel");
  await expect.poll(() => isPanelOpen(page, "OSC Input")).toBe(true);

  // A client that opts out ignores controller-driven UI actions.
  await closePanels(page, "OSC Input");
  await openKeyboardSettings(page);
  await page
    .getByRole("checkbox", {
      name: "Run UI actions triggered by MIDI and OSC mappings on this screen",
    })
    .uncheck();
  await page.keyboard.press("Escape");
  await sendOscPulse(port, "/e2e/ui/osc-panel");
  await page.waitForTimeout(500);
  expect(await isPanelOpen(page, "OSC Input")).toBe(false);
});
