// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
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

/** Locates the first-run sharing notice. */
function sharingNotice(page: Page): Locator {
  return page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Help improve Nightfall" });
}

/** Waits for the Settings dialog to show the Privacy tab, as Customize opens it. */
async function privacyTab(page: Page): Promise<Locator> {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("tab", { name: "Privacy" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return settings;
}

/** Verifies nothing is shared before the operator answers and the notice cannot be closed without a choice. */
test("telemetry notice shares nothing until the operator chooses", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page);
  const notice = sharingNotice(page);
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(
    notice.getByRole("button", { name: "OK", exact: true }),
  ).toBeVisible();
  await expect(notice.getByRole("button", { name: "Customize" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("telemetry-notice.png") });
  expect(
    await page.evaluate(
      () => (window as any).appStores.telemetryState.get().consent,
    ),
  ).toMatchObject({ decided: false, share_usage: false, share_errors: false });
  expect(await storedTelemetry(backendSlot.dataDir)).toBeNull();
});

/** Verifies OK shares both kinds of reports, closes the notice, and is not asked again. */
test("OK on the telemetry notice shares both kinds of reports", async ({
  page,
  backendSlot,
}) => {
  await openApp(page);
  const notice = sharingNotice(page);
  await notice.getByRole("button", { name: "OK", exact: true }).click();
  await expect
    .poll(() => storedTelemetry(backendSlot.dataDir))
    .toMatchObject({
      consent: { decided: true, share_usage: true, share_errors: true },
    });
  await expect(notice).toHaveCount(0);

  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.telemetryState.get().available,
      ),
    )
    .toBe(true);
  await expect(sharingNotice(page)).toHaveCount(0);
});

/** Verifies Customize lets the operator turn one kind off, links the policy, and saves to the host. */
test("customizing the telemetry notice saves each choice", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page);
  await sharingNotice(page).getByRole("button", { name: "Customize" }).click();
  const settings = await privacyTab(page);
  // The tab strip overflows the dialog, so the selected tab must be scrolled into view.
  await expect(settings.getByRole("tab", { name: "Privacy" })).toBeInViewport({
    ratio: 1,
  });
  const usage = settings.getByRole("switch", {
    name: "Share usage statistics",
  });
  const errors = settings.getByRole("switch", { name: "Share error reports" });
  await expect(usage).toBeChecked();
  await expect(errors).toBeChecked();

  await usage.setChecked(false);
  await expect
    .poll(() => storedTelemetry(backendSlot.dataDir))
    .toMatchObject({
      consent: { decided: true, share_usage: false, share_errors: true },
    });
  await settings.screenshot({
    path: testInfo.outputPath("telemetry-customize.png"),
  });
  await expect(sharingNotice(page)).toHaveCount(0);
});

/** Verifies closing Settings without a choice records nothing and leaves the notice up. */
test("closing settings from Customize keeps the telemetry notice", async ({
  page,
  backendSlot,
}) => {
  await openApp(page);
  await sharingNotice(page).getByRole("button", { name: "Customize" }).click();
  const settings = await privacyTab(page);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(sharingNotice(page)).toBeVisible();
  expect(await storedTelemetry(backendSlot.dataDir)).toBeNull();
});

/** Verifies Settings > Privacy links the policy, changes choices on the host, and resets the ID. */
test("privacy settings change sharing choices on the host", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openApp(page);
  await sharingNotice(page)
    .getByRole("button", { name: "OK", exact: true })
    .click();
  // Let the host record OK first, so its broadcast cannot revert the switch changed below.
  await expect
    .poll(() => storedTelemetry(backendSlot.dataDir))
    .toMatchObject({ consent: { decided: true, share_usage: true } });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: "Privacy", exact: true }).click();
  await expect(
    settings.getByRole("link", { name: "privacy policy" }),
  ).toHaveAttribute("href", "https://nightfall.live/privacy");
  const usage = settings.getByRole("switch", {
    name: "Share usage statistics",
  });
  await expect(usage).toBeChecked();
  await usage.setChecked(false);
  await expect
    .poll(() => storedTelemetry(backendSlot.dataDir))
    .toMatchObject({
      consent: { decided: true, share_usage: false, share_errors: true },
    });

  const installId = settings.getByTestId("telemetry-install-id");
  await expect(installId).toHaveText(/^[0-9a-f-]{36}$/);
  const firstId = await installId.textContent();
  const resetId = settings.getByRole("button", { name: "Reset ID" });
  // Centre the button so the scroll area's edge blur, which swallows clicks, does not cover it.
  await resetId.evaluate((button) =>
    button.scrollIntoView({ block: "center" }),
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await resetId.click();
  await expect(installId).not.toHaveText(firstId ?? "");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    firstId,
  );
  // The tooltip fades in, so wait until it is opaque before capturing it.
  await expect(
    page.getByRole("tooltip", { name: "✅ Prior ID copied to clipboard" }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("privacy-settings.png"),
  });
  // The flash ends on its own and the tooltip fades out and unmounts.
  await expect(
    page.getByRole("tooltip", { name: "✅ Prior ID copied to clipboard" }),
  ).toHaveCount(0, { timeout: 5000 });
});

/** Verifies uncaught page failures reach the engine, which decides whether to report them. */
test("uncaught page errors are forwarded to the engine", async ({ page }) => {
  await openApp(page);
  const forwarded = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/telemetry/client-error"),
  );
  await page.evaluate(() =>
    setTimeout(() => {
      throw new TypeError("Forwarded test failure");
    }),
  );
  const request = await forwarded;
  expect(request.postDataJSON()).toMatchObject({
    source: "app",
    kind: "error",
    name: "TypeError",
    message: "Forwarded test failure",
    fatal: false,
  });
  expect((await request.response())?.status()).toBe(204);
});
