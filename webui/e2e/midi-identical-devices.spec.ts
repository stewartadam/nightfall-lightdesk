// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

/** Saved first APC mini, connected. */
const APC_1 = "000000000000000000000000000a0c01";
/** Saved second APC mini, not plugged in. */
const APC_2 = "000000000000000000000000000a0c02";
/** Third APC mini unit, connected but not saved yet. */
const APC_NEW = "000000000000000000000000000a0c03";

/** Opens the app with stores the spec seeds instead of a live backend show. */
async function openSeededApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
  });
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
  await expect(page.locator("main#app")).toBeVisible();
}

/**
 * Seeds two saved APC minis, one of them unplugged, a connected third unit the show does not
 * save yet, and one mapping on each saved unit's first pad.
 */
async function seedIdenticalControllers(page: Page): Promise<void> {
  await page.evaluate(
    ({ apc1, apc2, apcNew }) => {
      const stores = (window as any).appStores;
      const device = (
        id: string,
        number: number,
        saved: boolean,
        connected: boolean,
      ) => ({
        id,
        name: number > 1 ? `APC mini (${number})` : "APC mini",
        model: "APC mini",
        number,
        saved,
        connected,
        hasOutput: connected,
        feedback: true,
      });
      stores.midiDevices.set([
        device(apc1, 1, true, true),
        device(apc2, 2, true, false),
        device(apcNew, 3, false, true),
      ]);
      stores.midiMappings.set(
        [apc1, apc2].map((id, index) => ({
          id: `0000000000000000000000000000000${index + 1}`,
          device: id,
          source: { type: "Note", data: { channel: 0, note: 0 } },
          behavior: "Press",
          action: { id: "clip.start", arguments: { clip: "1" } },
        })),
      );
    },
    { apc1: APC_1, apc2: APC_2, apcNew: APC_NEW },
  );
}

/** Records submitted commands instead of sending them, answering each as succeeded. */
async function captureSubmittedCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { engineRuntime } = window.__nightfallTest.runtime;
    const submitted: unknown[] = [];
    (window as any).__submittedCommands = submitted;
    (engineRuntime as any).sendCommandAndAwait = async (payload: unknown) => {
      submitted.push(payload);
      return { outcome: { type: "Succeeded", data: {} } };
    };
  });
}

/** Opens the MIDI Input panel through the dock API. */
async function openMidiPanel(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).appStores?.dockApi?.get?.())),
    )
    .toBe(true);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "panel-MidiInput-identical",
      component: "MidiInput",
      title: "MIDI Input",
      params: {},
      position: { referencePanel: "panel-Visualizer", direction: "within" },
    });
  });
}

/**
 * Verifies identical controllers are listed under numbered names with their state, each
 * mapping names its own unit, and a new unit can be assigned to the unplugged saved unit.
 */
test("identical MIDI controllers are numbered and a new unit can be assigned", async ({
  page,
}) => {
  await openSeededApp(page);
  await seedIdenticalControllers(page);
  await captureSubmittedCommands(page);
  await openMidiPanel(page);

  const devices = page.getByTestId("midi-device");
  await expect(devices).toHaveCount(3);
  await expect(devices.nth(0)).toContainText("APC mini");
  await expect(devices.nth(0)).not.toContainText("Not connected");
  await expect(devices.nth(1)).toContainText("APC mini (2)");
  await expect(devices.nth(1)).toContainText("Not connected");
  await expect(devices.nth(2)).toContainText("APC mini (3)");
  await expect(devices.nth(2)).toContainText("New");

  const grid = page.locator('[data-panel-id="panel-MidiInput-identical"]');
  await expect(
    grid.locator('[data-grid-column-key="device"][data-grid-row-index="0"]'),
  ).toHaveText("APC mini");
  await expect(
    grid.locator('[data-grid-column-key="device"][data-grid-row-index="1"]'),
  ).toHaveText("APC mini (2) (not connected)");
  await page.screenshot({
    path: test.info().outputPath("midi-identical-devices.png"),
  });

  await devices.nth(2).getByRole("button", { name: "Assign to…" }).click();
  const menu = page.getByRole("menu", {
    name: "Saved devices APC mini (3) can be",
  });
  const items = menu.locator('[data-component="DropdownMenuItem"]');
  await expect(items).toHaveText(["APC mini (2)"]);
  await page.screenshot({
    path: test.info().outputPath("midi-identical-devices-assign.png"),
  });
  await items.filter({ hasText: "APC mini (2)" }).click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        ((window as any).__submittedCommands as any[])
          .filter((message) => message.module === "MidiCommand")
          .map((message) => message.command),
      ),
    )
    .toEqual([
      { type: "AssignDevice", data: { unit: APC_NEW, device: APC_2 } },
    ]);
});
