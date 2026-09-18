// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { appendFileSync } from "node:fs";
import { installDiagnosticNativeMock } from "./diagnostics-native";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Native diagnostics remain usable above the splash when the configured backend is offline. */
test("collects native diagnostics before the backend connects", async ({
  page,
  context,
  workerSlot,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installDiagnosticNativeMock(
    page,
    testInfo.outputPath("nightfall.log"),
    workerSlot.backendPort,
  );

  for (const level of ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]) {
    appendFileSync(
      testInfo.outputPath("nightfall.log"),
      `${JSON.stringify({ timestamp: "2026-09-05T08:38:10.610201Z frame=34", level, target: "nightfall_cues::websocket", fields: { message: `${level.toLowerCase()} diagnostic message`, state_count: 4 } })}\n`,
    );
  }

  await page.goto("/");
  const splash = page.getByTestId("startup-splash");
  await expect(splash).toBeVisible();
  await expect(splash).toContainText("Initializing");
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
  const urls = await page.evaluate(async () => {
    const api = await import("/lib/api.ts");
    return [api.getBackendUrl(), api.getWebSocketUrl()];
  });
  expect(urls).toEqual([
    `http://localhost:${workerSlot.backendPort}`,
    `ws://localhost:${workerSlot.backendPort}/ws`,
  ]);
  await expect
    .poll(() => page.evaluate(() => (window as any).diagnosticListenerCount()))
    .toBe(1);
  await page.evaluate(() => (window as any).emitDiagnosticMenu());
  const dialog = page.getByRole("dialog", { name: "Collect Diagnostics" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Download Diagnostics" }),
  ).toBeFocused();
  const preview = dialog.getByRole("region", { name: "Log preview" });
  await expect(preview).toContainText("WARN engine: stored backend warning");
  const logs = dialog.getByRole("group", { name: "Logs to include" });
  const showfile = dialog.getByRole("group", { name: "Showfile to include" });
  expect(await logs.locator("label").allTextContents()).toEqual([
    "None",
    "Recent warnings/errors",
    "All logs",
  ]);
  expect(await showfile.locator("label").allTextContents()).toEqual([
    "None",
    "Without references",
    "Local references",
    "All references",
  ]);
  await logs.getByRole("radio", { name: "All logs" }).check();
  await expect(preview).toContainText("trace diagnostic message");
  const colors = await preview
    .locator("[data-log-level]")
    .evaluateAll((rows) =>
      Object.fromEntries(
        rows.map((row) => [
          row.getAttribute("data-log-level"),
          getComputedStyle(row.querySelector(".font-semibold")!).color,
        ]),
      ),
    );
  expect(new Set(Object.values(colors)).size).toBe(5);
  await expect(preview.locator(".italic").first()).toHaveText("state_count");
  await dialog.getByText("System info", { exact: true }).click();
  const layout = await dialog.evaluate((element) => {
    const body = element.querySelector("details")!.parentElement!;
    return {
      height: element.getBoundingClientRect().height,
      viewport: innerHeight,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      first: body.firstElementChild?.tagName,
    };
  });
  expect(layout.height).toBe(layout.viewport - 32);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
  expect(layout.first).toBe("DETAILS");
  await expect(
    dialog.getByRole("textbox", { name: "System info" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("diagnostics-system-info.png"),
  });
  await dialog.getByText("System info", { exact: true }).click();
  await dialog.getByRole("button", { name: "Copy System Info" }).click();
  await expect(page.getByRole("tooltip")).toHaveText("System info copied.");
  await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("diagnostics-copy-tooltip.png"),
  });
  await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: 4000 });
  await expect(dialog.getByRole("status")).toHaveCount(0);
  const info = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(info.backendVersion).toBe("Unavailable");
  expect(info.runtime).toBe("Desktop");
  expect(info.connection).not.toBe("connected");
  expect(info.logs).toBeUndefined();
  await preview.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).saveDialogOpened))
    .toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Download Diagnostics" }),
  ).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).exportedOptions.showfileMode),
  ).toBe("none");
  await page.screenshot({
    path: testInfo.outputPath("startup-diagnostics.png"),
  });
  const downloadBounds = await dialog
    .getByRole("button", { name: "Download Diagnostics" })
    .boundingBox();
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  expect((await cancel.boundingBox())!.x).toBeLessThan(downloadBounds!.x);
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(splash).toBeVisible();
  await page.evaluate(() =>
    (window as any).emitDiagnosticMenu("app.report_bug"),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).bugReportUrl))
    .toBeTruthy();
  const issueUrl = new URL(
    await page.evaluate(() => (window as any).bugReportUrl),
  );
  expect(issueUrl.searchParams.get("system-information")).toContain(
    '"backendVersion": "Unavailable"',
  );
});
