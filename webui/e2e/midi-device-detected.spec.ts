// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { openMappingApp } from "./controller-mapping";
import { expect, type Page } from "./playwright-fixtures";
import { test } from "./virtual-midi";

/** Returns the toast announcing newly connected MIDI devices. */
function detectedToast(page: Page) {
  return page
    .locator('[data-component="Toast"]')
    .filter({ hasText: /New MIDI devices?/ });
}

/** Delivers a backend announcement of newly connected MIDI devices to the client. */
async function announceDevices(page: Page, devices: string[]): Promise<void> {
  await page.evaluate((names) => {
    (window as any).appStores.midiDetectedDevices.set(names);
  }, devices);
}

/**
 * Returns the titles in notification history once the notification queue has published every
 * notification pushed so far. The queue publishes on a 50ms timer, so a later timer runs after it.
 */
async function notifiedTitlesAfterFlush(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return (
      (window as any).appStores.notificationHistory.get() as {
        title?: string;
      }[]
    ).map((entry) => entry.title ?? "");
  });
}

/** Returns the MIDI Input panel's tab, present once the panel is open. */
function midiPanelTab(page: Page) {
  return page.locator(".dv-default-tab").filter({ hasText: "MIDI Input" });
}

/**
 * Plugging a controller in while the app runs names it in a toast, and the toast's action opens
 * the MIDI Input panel.
 */
test("plugging in a MIDI controller offers to open the MIDI Input panel", async ({
  page,
  backendSlot,
  plugInVirtualMidi,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  await expect(midiPanelTab(page)).toHaveCount(0);

  const midi = await plugInVirtualMidi();
  const toast = detectedToast(page);
  await expect(toast).toContainText(`${midi.name} is connected.`, {
    timeout: 20_000,
  });

  await toast.getByRole("button", { name: "Open MIDI Input" }).click();
  await expect(midiPanelTab(page)).toBeVisible();
  await expect(toast).toHaveCount(0);
});

/**
 * "Don't show this again" stops later announcements, and Settings brings them back, saying how
 * many prompts are hidden.
 */
test("don't show this again hides the prompt until settings resets it", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openMappingApp(page, backendSlot.backendPort);

  await announceDevices(page, ["Launchpad Mini MK3", "APC mini mk2"]);
  const toast = detectedToast(page);
  await expect(toast).toContainText(
    "Launchpad Mini MK3 and APC mini mk2 are connected.",
  );
  await page.screenshot({
    path: testInfo.outputPath("midi-device-detected-toast.png"),
  });

  await toast.getByLabel("Don't show this again").check();
  await page.screenshot({
    path: testInfo.outputPath("midi-device-detected-dont-show.png"),
  });
  await toast.getByRole("button", { name: "Close" }).click();
  await expect(toast).toHaveCount(0);

  await announceDevices(page, ["X-Touch"]);
  expect(await notifiedTitlesAfterFlush(page)).not.toContain("New MIDI device");
  await expect(detectedToast(page)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  const row = settings.locator(".nf-settings-row", {
    hasText: "Hidden prompts",
  });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText("1 is hidden.");
  await page.screenshot({
    path: testInfo.outputPath("settings-hidden-prompts.png"),
  });
  await row.getByRole("button", { name: "Show again" }).click();
  await expect(row).toContainText("None are hidden.");
  await expect(row.getByRole("button", { name: "Show again" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  await announceDevices(page, ["X-Touch"]);
  const shownAgain = detectedToast(page);
  await expect(shownAgain).toContainText("X-Touch is connected.");
  await shownAgain.getByRole("button", { name: "Open MIDI Input" }).click();
  await expect(midiPanelTab(page)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("midi-settings-opened.png"),
  });
});
