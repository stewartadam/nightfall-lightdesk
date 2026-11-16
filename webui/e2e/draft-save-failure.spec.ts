// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Longest wait for the backend's one-minute periodic draft autosave to run. */
const AUTOSAVE_WAIT_MS = 75_000;

/** Loads the app with its default show and waits for the shell to finish connecting. */
async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
}

/**
 * Verifies a failing draft autosave keeps a warning up and makes the browser confirm before the
 * page closes, and that both go away once drafts save again.
 */
test("failed draft saves warn until a save works", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(4 * AUTOSAVE_WAIT_MS);
  await openApp(page);
  const drafts = join(backendSlot.dataDir, "drafts");
  await rm(drafts, { force: true, recursive: true });
  await writeFile(drafts, "not a folder");

  const warning = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Couldn't save the show's draft" });
  await expect(warning).toBeVisible({ timeout: AUTOSAVE_WAIT_MS });
  await page.screenshot({
    path: testInfo.outputPath("draft-save-warning.png"),
  });
  await page.waitForTimeout(8_000);
  await expect(warning).toBeVisible();

  // Chrome only asks before unloading a page the user has interacted with.
  await page.mouse.click(800, 500);
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const leavePrompt = await dialog;
  expect(leavePrompt.type()).toBe("beforeunload");
  await leavePrompt.dismiss();
  expect(page.isClosed()).toBe(false);

  await rm(drafts, { force: true });
  await mkdir(drafts);
  await expect(warning).toHaveCount(0, { timeout: AUTOSAVE_WAIT_MS });
  expect(await leavingIsBlocked(page)).toBe(false);
});

/** Returns whether the page's leave handlers would ask the browser to confirm closing. */
async function leavingIsBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
