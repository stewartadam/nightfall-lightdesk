// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Browser, Page } from "@playwright/test";
import {
  startPlaywrightTestBackend,
  startPlaywrightWorkerSlot,
  stopPlaywrightTestBackend,
  stopPlaywrightWorkerSlot,
} from "../../scripts/playwright-backend-pool.mjs";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { type BackendSlot, expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the sACN priority from the backend's latest IO settings snapshot. */
async function storedPriority(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as any).appStores.settings.get().io.sacn_priority,
  );
}

/** Returns whether the clip with `id` runs according to the page's clip store. */
async function isClipRunning(page: Page, id: number): Promise<boolean> {
  return page.evaluate((id) => {
    const states = (window as any).appStores.clips.get() as Record<
      string,
      [{ identifiers: { id: number } }, boolean]
    >;
    return Object.values(states).some(
      ([clip, isActive]) => clip.identifiers.id === id && isActive,
    );
  }, id);
}

/** Reads the tempo the page's engine is easing toward. */
async function targetBpm(page: Page): Promise<number | undefined> {
  return page.evaluate(
    () => (window as any).appStores.showTempo.get()?.snapshot.target_bpm,
  );
}

/** Sends one engine command over the page's websocket, as the UI does. */
async function sendCommand(
  page: Page,
  module: string,
  command: object,
): Promise<void> {
  await page.evaluate(
    ({ module, command }) =>
      (window as any).appStores.send({ module, command }),
    { module, command },
  );
}

/** Opens a panel from the Command Palette. */
async function openPanel(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill(`Open ${title}`);
  await page.keyboard.press("Enter");
}

/** Types an sACN priority into the Network settings tab and returns the still-open dialog. */
async function typePriority(page: Page, priority: number) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();
  const field = dialog.getByLabel("sACN priority");
  await field.fill(String(priority));
  await field.press("Enter");
  return dialog;
}

/** Types an sACN priority into the Network settings tab and closes settings again. */
async function enterPriority(page: Page, priority: number): Promise<void> {
  const dialog = await typePriority(page, priority);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/** Opens a browser page on another backend through the run's shared dev server. */
async function openBackendPage(
  browser: Browser,
  baseURL: string,
  backendPort: number,
): Promise<Page> {
  const { hostname } = new URL(baseURL);
  const context = await browser.newContext({
    storageState: {
      cookies: [
        {
          name: "nightfall-playwright-backend",
          value: String(backendPort),
          domain: hostname,
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            { name: "nightfall.e2eAutoOpenStartupShowfile", value: "default" },
            { name: "nightfall.guide.v1.dismissed", value: "true" },
          ],
        },
      ],
    },
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?e2e=1`);
  await waitForDockviewApp(page);
  return page;
}

/** Starts a second backend for the primary, on its own port and data directory. */
async function startPrimary(backup: BackendSlot) {
  const workerSlot = await startPlaywrightWorkerSlot({
    baseURL: backup.baseURL,
    runRoot: backup.runRoot,
    workerIndex: backup.workerIndex + 100,
  });
  try {
    const backend = await startPlaywrightTestBackend({
      seedDataDir: process.env.NIGHTFALL_PLAYWRIGHT_SEED_DATA_DIR,
      testId: `${backup.testId}-primary`,
      workerSlot,
    });
    return { backend, workerSlot };
  } catch (error) {
    stopPlaywrightWorkerSlot(workerSlot);
    throw error;
  }
}

/**
 * A backup follows a primary on this computer, copies a change made on the primary, refuses
 * changes made on itself, and accepts them again once it takes over.
 */
test("backup follows a primary, stays read-only, and takes over", async ({
  page,
  browser,
  backendSlot,
}, testInfo) => {
  test.setTimeout(300_000);
  const primary = await startPrimary(backendSlot);
  try {
    const primaryShow = await prepareFreshBackendShowfile(
      primary.backend.backendPort,
    );
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/?e2e=1");
    await waitForDockviewApp(page);

    await openPanel(page, "I/O Transports");
    const settings = page.getByTestId("backup-server-settings");
    await settings
      .getByTestId("backup-primary-address")
      .fill(`127.0.0.1:${primary.backend.backendPort}`);
    await settings.screenshot({
      path: testInfo.outputPath("1-backup-settings.png"),
    });
    await settings.getByTestId("backup-follow").click();

    const banner = page.getByTestId("backup-banner");
    await expect(banner).toContainText(
      `In step with the primary's show "${primaryShow}"`,
      { timeout: 60_000 },
    );
    await openPanel(page, "I/O Transports");
    await expect(settings.getByTestId("backup-link-status")).toContainText(
      "In step",
    );
    await page.screenshot({ path: testInfo.outputPath("2-backup-synced.png") });

    const primaryPage = await openBackendPage(
      browser,
      backendSlot.baseURL,
      primary.backend.backendPort,
    );
    await enterPriority(primaryPage, 150);
    await expect.poll(() => storedPriority(primaryPage)).toBe(150);
    await expect
      .poll(() => storedPriority(page), { timeout: 60_000 })
      .toBe(150);
    await primaryPage.context().close();

    const settingsDialog = await typePriority(page, 120);
    const refusal = page
      .locator('[data-component="Toast"]')
      .filter({ hasText: "This Nightfall is a backup" });
    await expect(refusal).toBeVisible();
    await expect(settingsDialog.getByLabel("sACN priority")).toHaveValue("150");
    await page.screenshot({
      path: testInfo.outputPath("3-backup-refuses.png"),
    });
    expect(await storedPriority(page)).toBe(150);
    await page.keyboard.press("Escape");
    await expect(settingsDialog).toBeHidden();

    await banner.getByTestId("backup-take-over").click();
    const confirm = page.getByRole("dialog", { name: "Take over output" });
    await expect(confirm).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("4-take-over.png") });
    await confirm.getByRole("button", { name: "Take over" }).click();
    await expect(banner).toBeHidden();
    await openPanel(page, "I/O Transports");
    await expect(settings.getByTestId("backup-follow")).toBeVisible();

    await enterPriority(page, 120);
    await expect.poll(() => storedPriority(page)).toBe(120);
    await page.screenshot({ path: testInfo.outputPath("5-taken-over.png") });
  } finally {
    await stopPlaywrightTestBackend(primary.backend);
    stopPlaywrightWorkerSlot(primary.workerSlot);
  }
});

/**
 * A backup follows the primary's playback: clips the primary starts and stops, and its tempo,
 * reach the backup within a checkpoint or two, and a takeover keeps what was running.
 */
test("backup follows the primary's playback and keeps it on takeover", async ({
  page,
  browser,
  backendSlot,
}, testInfo) => {
  test.setTimeout(300_000);
  const primary = await startPrimary(backendSlot);
  try {
    const primaryPage = await openBackendPage(
      browser,
      backendSlot.baseURL,
      primary.backend.backendPort,
    );
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/?e2e=1");
    await waitForDockviewApp(page);

    await openPanel(page, "I/O Transports");
    const settings = page.getByTestId("backup-server-settings");
    await settings
      .getByTestId("backup-primary-address")
      .fill(`127.0.0.1:${primary.backend.backendPort}`);
    await settings.getByTestId("backup-follow").click();
    const banner = page.getByTestId("backup-banner");
    await expect(banner).toContainText("In step with the primary's", {
      timeout: 60_000,
    });
    await expect.poll(() => isClipRunning(page, 1)).toBe(false);

    await sendCommand(primaryPage, "ClipCommand", {
      type: "StartClip",
      data: { type: "Single", data: 1 },
    });
    await sendCommand(primaryPage, "TempoCommand", {
      type: "SetBpm",
      data: 140,
    });
    await expect.poll(() => isClipRunning(primaryPage, 1)).toBe(true);
    await expect
      .poll(() => isClipRunning(page, 1), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(() => targetBpm(page), { timeout: 30_000 })
      .toBeCloseTo(140, 1);
    await expect(page.getByTestId("startup-splash")).toHaveCount(0, {
      timeout: 30_000,
    });
    await page.screenshot({
      path: testInfo.outputPath("6-backup-follows-playback.png"),
    });

    await sendCommand(primaryPage, "ClipCommand", {
      type: "StopClip",
      data: { type: "Single", data: 1 },
    });
    await sendCommand(primaryPage, "ClipCommand", {
      type: "StartClip",
      data: { type: "Single", data: 2 },
    });
    await expect
      .poll(() => isClipRunning(page, 1), { timeout: 30_000 })
      .toBe(false);
    await expect
      .poll(() => isClipRunning(page, 2), { timeout: 30_000 })
      .toBe(true);
    await primaryPage.context().close();

    await banner.getByTestId("backup-take-over").click();
    await page
      .getByRole("dialog", { name: "Take over output" })
      .getByRole("button", { name: "Take over" })
      .click();
    await expect(banner).toBeHidden();
    await expect.poll(() => isClipRunning(page, 2)).toBe(true);
    await expect.poll(() => targetBpm(page)).toBeCloseTo(140, 1);
    await page.screenshot({
      path: testInfo.outputPath("7-taken-over-with-playback.png"),
    });
    await sendCommand(page, "ClipCommand", {
      type: "StopClip",
      data: { type: "Single", data: 2 },
    });
  } finally {
    await stopPlaywrightTestBackend(primary.backend);
    stopPlaywrightWorkerSlot(primary.workerSlot);
  }
});
