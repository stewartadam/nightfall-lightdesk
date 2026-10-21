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
const TIMECODE_ID = 41;
const TIMECODE_LABEL = "Deck MTC";

/** Opens a blank showfile on the test's isolated backend. */
async function openApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Stores a timecode that follows MIDI timecode at 30 fps. */
async function storeMtcTimecode(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, label }) =>
      (window as any).appStores.sendAndAwait({
        module: "TimecodeCommand",
        command: {
          type: "StoreTimecode",
          data: {
            identifiers: {
              id,
              uid: crypto.randomUUID().replace(/-/g, ""),
              label,
            },
            rate: "Fps30",
            source: "MidiMtc",
          },
        },
      }),
    { id: TIMECODE_ID, label: TIMECODE_LABEL },
  );
}

/**
 * A timecode following MIDI timecode stays idle until started, then waits
 * for a sender and says so instead of running on the engine clock.
 */
test("a timecode following MIDI timecode waits for signal once started", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await storeMtcTimecode(page);
  await openPanel(page, "Timecodes");

  const panel = page.locator('[data-component="TimecodesPanel"]');
  await panel.getByRole("radio", { name: "Grid view" }).click();
  const card = panel.locator("button[data-timecode-uid]").filter({
    hasText: TIMECODE_LABEL,
  });
  await expect(card).toContainText("Idle");
  await card.click();
  await panel.getByRole("button", { name: "Start timecode" }).click();

  await expect(card).toContainText("No signal");
  await expect(card).toContainText("00:00:00:00");
  await page.screenshot({
    path: test.info().outputPath("timecode-mtc-no-signal.png"),
  });

  await panel.getByRole("button", { name: "Stop timecode" }).click();
  await expect(card).toContainText("Idle");
});
