// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ telemetryUndecided: true });

/** Reads the host telemetry preferences the backend saved in its data directory. */
async function storedTelemetry(dataDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dataDir, "telemetry.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Loads the app with its default show and waits for the shell to finish connecting. */
async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
}

/** Verifies the first-run prompt links to Privacy, where choices persist on the host and survive a reload. */
test("telemetry prompt opens privacy settings and choices persist on the host", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page);
  const prompt = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Help improve Nightfall" });
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("telemetry-prompt.png") });

  await prompt.getByRole("button", { name: "Details" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("tab", { name: "Privacy" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const usage = settings.getByRole("switch", {
    name: "Share anonymous usage reports",
  });
  const errors = settings.getByRole("switch", { name: "Share error reports" });
  await expect(usage).not.toBeChecked();
  await expect(errors).not.toBeChecked();
  const installId = settings.getByTestId("telemetry-install-id");
  await expect(installId).toHaveText(/^[0-9a-f-]{36}$/);

  await errors.setChecked(true);
  await expect(errors).toBeChecked();
  await expect
    .poll(() => storedTelemetry(backendSlot.dataDir))
    .toMatchObject({
      consent: { decided: true, share_usage: false, share_errors: true },
    });

  const firstId = await installId.textContent();
  await settings.getByRole("button", { name: "Reset ID" }).click();
  await expect(installId).not.toHaveText(firstId ?? "");
  await settings.screenshot({
    path: testInfo.outputPath("privacy-settings.png"),
  });

  // An answered choice is not asked again after reloading.
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.telemetryState.get().available,
      ),
    )
    .toBe(true);
  await expect(
    page
      .locator('[data-component="Toast"]')
      .filter({ hasText: "Help improve Nightfall" }),
  ).toHaveCount(0);
});

/** Verifies declining from the prompt records an answered choice that shares nothing. */
test("declining the telemetry prompt shares nothing", async ({
  page,
  backendSlot,
}) => {
  await openApp(page);
  const prompt = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Help improve Nightfall" });
  await prompt.getByRole("button", { name: "Don't share" }).click();
  await expect
    .poll(() => storedTelemetry(backendSlot.dataDir))
    .toMatchObject({
      consent: { decided: true, share_usage: false, share_errors: false },
    });
  await expect(prompt).toHaveCount(0);
});
