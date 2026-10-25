// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  globalMaster,
  makeGlobalMasterToggle,
  openMappingApp,
  openPanel,
} from "./controller-mapping";
import { expect, type Page, test } from "./playwright-fixtures";

/** Device name the bundled Launchpad profile matches; no such port needs to be connected. */
const LAUNCHPAD = "Launchpad";

/** Returns the LED values the backend stored on the only MIDI mapping. */
function storedLed(page: Page): Promise<Record<string, number> | undefined> {
  return page.evaluate(
    () => (window as any).appStores.midiMappings.get()[0]?.led as never,
  );
}

/** Stores a note mapping on an unplugged Launchpad toggling the global master. */
async function storeLaunchpadMapping(page: Page): Promise<void> {
  const masterUid = (await globalMaster(page)).identifiers.uid;
  await page.evaluate(
    ({ deviceName, masterUid }) =>
      (window as any).appStores.sendAndAwait({
        module: "MidiCommand",
        command: {
          type: "UpsertMapping",
          data: {
            id: crypto.randomUUID().replace(/-/g, ""),
            device_name: deviceName,
            source: { type: "Note", data: { channel: 0, note: 0 } },
            behavior: "Press",
            action: { id: "master.toggle", arguments: { master: masterUid } },
          },
        },
      }),
    { deviceName: LAUNCHPAD, masterUid },
  );
}

/**
 * Verifies a mapping on a device with a controller profile shows LED colors by name with
 * swatches, even while the device is unplugged, and that picking a color stores its raw
 * value while Default names the profile's own choice.
 */
test("LED cells offer a profiled controller's colors by name", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  await makeGlobalMasterToggle(page);
  await storeLaunchpadMapping(page);
  await openPanel(page, "MIDI Input");

  const panel = page.locator('[data-panel-id^="panel-MidiInput"]').first();
  const onCell = panel.locator(
    '[data-grid-column-key="led_on"][data-grid-row-index="0"]',
  );
  const heldCell = panel.locator(
    '[data-grid-column-key="led_held"][data-grid-row-index="0"]',
  );
  await onCell.scrollIntoViewIfNeeded();
  await expect(onCell).toContainText("Default (Green)");
  await expect(heldCell).toContainText("Default (Amber flashing)");
  await expect(onCell.getByTestId("dropdown-cell-swatch")).toHaveCount(1);

  // Selecting the row first shows the action editor above the grid, which moves the row.
  await onCell.click();
  await expect(onCell).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Escape");
  await onCell.dblclick();
  const menu = page.locator("[data-hs-select-dropdown].opened");
  await expect(menu).toBeVisible();
  await expect(menu.locator("[data-value]")).toHaveCount(25);
  await page.screenshot({
    path: test.info().outputPath("midi-led-profile-colors.png"),
  });
  await menu
    .locator("[data-value]")
    .filter({ hasText: /^Amber$/ })
    .click();

  await expect.poll(() => storedLed(page)).toEqual({ on: 63 });
  await expect(onCell).toContainText("Amber");
  await page.screenshot({
    path: test.info().outputPath("midi-led-profile-chosen.png"),
  });
});
