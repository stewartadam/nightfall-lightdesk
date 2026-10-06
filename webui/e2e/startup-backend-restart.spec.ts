// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startPlaywrightTestBackend,
  stopPlaywrightTestBackend,
} from "../../scripts/playwright-backend-pool.mjs";
import { expect, test } from "./playwright-fixtures";
import {
  openStartupShowfileIfPrompted,
  waitForDockviewApp,
} from "./showfile-startup";

const SHOWFILE_NAME = "restart";
const SHOWFILE_FOLDER = `${SHOWFILE_NAME}.nightfall-show`;

test.use({ viewport: { width: 1600, height: 900 } });

/**
 * Restarts the backend with an empty world under a running page, then reopens
 * a saved showfile from the startup picker. The splash must clear onto a
 * visible dock instead of holding forever after the backend session reset.
 */
test("reveals the dock after reopening a showfile on a restarted backend", async ({
  page,
  backendSlot,
  workerSlot,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
  });
  await page.goto("/?startup:draftRecovery=false");
  await waitForDockviewApp(page);
  const splash = page.getByTestId("startup-splash");
  await expect(splash).toBeHidden({ timeout: 20_000 });

  await page.evaluate(async (name) => {
    const actions = (await window.__nightfallHarness.load("app"))
      .showfileActions;
    const runtime = window.__nightfallTest.runtime;
    await runtime.engineRuntime.sendCommandAndAwait({
      module: "DeskCommand",
      command: actions.saveNamedShowfileCommand(name),
    });
  }, SHOWFILE_NAME);
  const saved = join(backendSlot.dataDir, SHOWFILE_FOLDER);
  await expect.poll(() => existsSync(saved)).toBe(true);
  const stash = await mkdtemp(join(tmpdir(), "nightfall-restart-"));
  await cp(saved, join(stash, SHOWFILE_FOLDER), { recursive: true });

  await stopPlaywrightTestBackend(backendSlot);
  const restarted = await startPlaywrightTestBackend({
    emptyStartupWorld: true,
    seedDataDir: process.env.NIGHTFALL_PLAYWRIGHT_SEED_DATA_DIR,
    testId: `${testInfo.testId}-restarted`,
    workerSlot,
  });
  try {
    await cp(
      join(stash, SHOWFILE_FOLDER),
      join(restarted.dataDir, SHOWFILE_FOLDER),
      { recursive: true },
    );
    const picker = page.getByRole("dialog", { name: "Open Showfile" });
    await expect(picker.getByText(SHOWFILE_NAME).first()).toBeVisible({
      timeout: 30_000,
    });
    await openStartupShowfileIfPrompted(page, {
      showfileName: SHOWFILE_NAME,
      timeoutMs: 1_000,
    });
    await expect(splash).toBeHidden({ timeout: 20_000 });
    await expect(page.locator(".dv-dockview").first()).toBeVisible();
    await expect(page.getByTestId("showfile-transition-veil")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("after-restart.png") });
  } finally {
    await stopPlaywrightTestBackend(restarted);
    await rm(stash, { recursive: true, force: true });
  }
});
