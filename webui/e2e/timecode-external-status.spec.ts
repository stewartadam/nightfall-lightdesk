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

/** Reads the source settings the engine reports for the test timecode. */
async function readTimecodeSettings(page: Page) {
  return page.evaluate((id) => {
    const entry = Object.values((window as any).appStores.timecodes.get()).find(
      (value: any) => value?.[0]?.identifiers.id === id,
    ) as any;
    const timecode = entry?.[0];
    return {
      source: timecode?.source,
      rate: timecode?.rate,
      audio_input: timecode?.audio_input,
      freewheel: timecode?.freewheel,
    };
  }, TIMECODE_ID);
}

/**
 * Selecting a timecode in the Timecodes panel shows its source, rate, audio
 * input and freewheel in Properties, and edits there reach the engine.
 */
test("timecode properties edit source, rate, audio input and freewheel", async ({
  backendSlot,
  page,
}) => {
  await openApp(page, backendSlot.backendPort);
  await storeMtcTimecode(page);
  await openPanel(page, "Timecodes");

  const panel = page.locator('[data-component="TimecodesPanel"]');
  await panel.getByRole("radio", { name: "Grid view" }).click();
  await panel
    .locator("button[data-timecode-uid]")
    .filter({ hasText: TIMECODE_LABEL })
    .click();
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
  });

  const source = page.getByLabel("Timecode source");
  await expect(source).toHaveValue("MidiMtc");
  await page.getByLabel("Timecode rate").selectOption("Fps25");
  await expect
    .poll(() => readTimecodeSettings(page))
    .toEqual({
      source: "MidiMtc",
      rate: "Fps25",
      audio_input: undefined,
      freewheel: undefined,
    });

  await expect(page.getByLabel("Timecode audio input")).toHaveCount(0);
  await source.selectOption("SmpteLtc");
  await expect(page.getByLabel("Timecode audio input")).toHaveValue("");
  await page.getByLabel("Timecode audio channel").selectOption({ label: "2" });
  const freewheel = page.getByLabel("Timecode freewheel (ms)");
  await expect(freewheel).toHaveValue("");
  await freewheel.fill("250");
  await freewheel.press("Enter");
  await expect
    .poll(() => readTimecodeSettings(page))
    .toEqual({
      source: "SmpteLtc",
      rate: "Fps25",
      audio_input: { channel: 1 },
      freewheel: { secs: 0, nanos: 250_000_000 },
    });
  await expect(page.getByLabel("Timecode audio channel")).toHaveValue("1");
  await expect(freewheel).toHaveValue("250");
  await page.screenshot({
    path: test.info().outputPath("timecode-ltc-properties.png"),
  });

  await freewheel.fill("-100");
  await freewheel.press("Enter");
  await expect(freewheel).toHaveValue("250");

  await freewheel.fill("");
  await freewheel.press("Enter");
  await expect
    .poll(async () => (await readTimecodeSettings(page)).freewheel)
    .toBeUndefined();

  await source.selectOption("Internal");
  await expect(freewheel).toHaveCount(0);
  await expect(page.getByLabel("Timecode audio input")).toHaveCount(0);
});
