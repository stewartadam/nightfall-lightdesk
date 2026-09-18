// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { installDiagnosticNativeMock } from "./diagnostics-native";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Starts a real show with native menu events and a controllable export destination picker. */
test.beforeEach(async ({ page, backendSlot }, testInfo) => {
  await installDiagnosticNativeMock(
    page,
    testInfo.outputPath("nightfall.log"),
    backendSlot.backendPort,
  );
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).diagnosticListenerCount()))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const desktop = window as any;
    const invoke = desktop.__TAURI_INTERNALS__.invoke;
    desktop.showfileExports = [];
    /** Captures native export arguments and simulates folder cancellation, writes, and failures. */
    desktop.__TAURI_INTERNALS__.invoke = async (
      command: string,
      args: Record<string, unknown>,
    ) => {
      if (command !== "export_showfile") return invoke(command, args);
      desktop.showfileExports.push(args);
      if (desktop.holdShowfileExport)
        await new Promise<void>((resolve) => {
          desktop.finishShowfileExport = resolve;
        });
      if (desktop.cancelShowfileExport) return null;
      if (desktop.failShowfileExport)
        throw new Error(
          "Tour.nightfall-show already exists. Choose a different export name or folder.",
        );
      return {
        path: `/Exports/${args.name}.nightfall-show`,
        warnings: desktop.showfileExportWarnings ?? [],
      };
    };
  });
});

/** Every entry point opens export, all reference choices reach native IPC, and layout accompanies the copy. */
test("exports named copies from the menu, palette, and native File menu", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(
    await page.evaluate(() => new Date(2026, 8, 6, 1, 2, 3).getTime()),
  );
  const exportName = "Tour-20260906-010203";
  await page.locator("button[title='Menu']").click();
  await page
    .getByRole("button", { name: "Export Showfile", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Export Showfile",
    exact: true,
  });
  await expect(
    dialog.getByRole("radio", { name: "All references", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByLabel("Export name")).toHaveValue(/-export$/);
  await dialog.getByLabel("Export name").fill("Tour");
  await page.screenshot({ path: testInfo.outputPath("export-showfile.png") });
  for (const [label, policy] of [
    ["All references", "allReferences"],
    ["Showfile references", "showfileReferences"],
    ["Showfile only", "showfileOnly"],
  ]) {
    await dialog.getByRole("radio", { name: label, exact: true }).check();
    await dialog.getByRole("button", { name: "Choose Folder…" }).click();
    await expect(dialog.getByRole("status")).toContainText(
      `/Exports/${exportName}.nightfall-show`,
    );
    const exported = await page.evaluate(() =>
      (window as any).showfileExports.at(-1),
    );
    expect(exported.name).toBe(exportName);
    expect(exported.policy).toBe(policy);
    expect(exported.saveOptions.activePanelLayout).toBeTruthy();
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Export Showfile");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "All references", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() =>
    (window as any).emitDiagnosticMenu("showfile.export"),
  );
  await expect(dialog).toBeVisible();
});

/** Invalid names, cancellation, busy writes, missing assets, and destination errors remain recoverable. */
test("keeps export state clear during cancellation and failures", async ({
  page,
}, testInfo) => {
  await page.evaluate(() =>
    (window as any).emitDiagnosticMenu("showfile.export"),
  );
  const dialog = page.getByRole("dialog", {
    name: "Export Showfile",
    exact: true,
  });
  const choose = dialog.getByRole("button", { name: "Choose Folder…" });
  await dialog.getByLabel("Export name").fill("../Tour");
  await expect(choose).toBeDisabled();
  await dialog.getByLabel("Export name").fill("Tour");
  await page.evaluate(() => {
    (window as any).cancelShowfileExport = true;
  });
  await choose.click();
  await expect(choose).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).cancelShowfileExport = false;
    (window as any).holdShowfileExport = true;
    (window as any).showfileExportWarnings = [
      "Missing referenced audio: track.wav",
    ];
  });
  await choose.click();
  await expect(
    dialog.getByRole("button", { name: "Exporting…" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("Export name")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).finishShowfileExport());
  await expect(dialog.getByRole("status")).toContainText(
    "Missing referenced audio: track.wav",
  );
  expect(
    await page.evaluate(() => (window as any).showfileExports.length),
  ).toBe(2);
  await page.screenshot({
    path: testInfo.outputPath("export-showfile-warnings.png"),
  });
  await page.evaluate(() => {
    (window as any).holdShowfileExport = false;
    (window as any).failShowfileExport = true;
  });
  await choose.click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(choose).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("export-showfile-error.png"),
  });
});
