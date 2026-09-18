// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { installDiagnosticNativeMock } from "./diagnostics-native";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Selection, paged preview, compact copying and ZIP export work together without large IPC payloads. */
test("collects selected logs and showfile content in a diagnostic ZIP", async ({
  page,
  context,
  backendSlot,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const logPath = testInfo.outputPath("nightfall.log");
  await installDiagnosticNativeMock(page, logPath, backendSlot.backendPort);
  for (let index = 0; index < 300; index++) {
    appendFileSync(
      logPath,
      `${JSON.stringify({ timestamp: "2026-09-05T03:42:43Z", level: index % 10 === 0 ? "WARN" : "INFO", target: "engine", fields: { message: `stored backend entry ${index}`, detail: "x".repeat(1500) } })}\n`,
    );
  }
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(async () => {
    const { getLogger } = await import("/lib/logger.ts");
    const log = getLogger("/e2e/diagnostics");
    log.warn("diagnostic browser warning", { detail: "warning context" });
    log.errorWithCause(
      new Error("diagnostic browser error"),
      "browser error context",
    );
    log.info("diagnostic browser info");
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("diagnostic uncaught error"),
      }),
    );
  });
  await expect
    .poll(() => readFileSync(logPath, "utf8"))
    .toContain("diagnostic uncaught error");
  await page.locator("button[title='Menu']").click();
  await page
    .getByRole("button", { name: "Troubleshooting", exact: true })
    .click();
  await page.getByRole("button", { name: "Report a Bug", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).bugReportUrl))
    .toBeTruthy();
  const issueUrl = new URL(
    await page.evaluate(() => (window as any).bugReportUrl),
  );
  expect(issueUrl.searchParams.get("system-information")).toContain(
    '"runtime": "Desktop"',
  );
  expect(issueUrl.href.length).toBeLessThanOrEqual(6000);
  await page.locator("button[title='Menu']").click();
  await page
    .getByRole("button", { name: "Troubleshooting", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collect Diagnostics", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Collect Diagnostics" });
  const logs = dialog.getByRole("group", { name: "Logs to include" });
  const showfile = dialog.getByRole("group", { name: "Showfile to include" });
  const preview = dialog.getByRole("region", { name: "Log preview" });
  await expect(
    logs.getByRole("radio", { name: "Recent warnings/errors" }),
  ).toBeChecked();
  await expect(
    showfile.getByRole("radio", { name: "None", exact: true }),
  ).toBeChecked();
  await expect(preview).toContainText("diagnostic uncaught error");
  await expect(preview).toContainText("diagnostic browser warning");
  await expect(preview).not.toContainText("diagnostic browser info");
  await expect(
    dialog.getByRole("button", { name: "Refresh", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Report a Bug", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("diagnostics-recent.png"),
  });
  await dialog.getByRole("button", { name: "Copy System Info" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied).application).toBe("Nightfall");
  expect(JSON.parse(copied).logs).toBeUndefined();
  expect(copied).not.toContain("diagnostic browser warning");
  await logs.getByRole("radio", { name: "All logs", exact: true }).check();
  await expect(preview).toContainText("stored backend entry 0");
  await expect(preview).not.toContainText("stored backend entry 299");
  await showfile.getByRole("radio", { name: "All references" }).check();
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect(
    dialog.getByRole("button", { name: "Download Diagnostics" }),
  ).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  const exported = await page.evaluate(() => (window as any).exportedOptions);
  expect(exported.logMode).toBe("all");
  expect(exported.showfileMode).toBe("allReferences");
  expect(exported.logLength).toBeGreaterThan(256 * 1024);
  expect(exported.systemInfo).toBe(copied);
  expect(JSON.stringify(exported).length).toBeLessThan(2000);
  // Exercise native page offsets by scrolling to each newly loaded end.
  for (let index = 0; index < 3; index++) {
    await preview.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(preview).toHaveAttribute("aria-busy", "false");
    if (index === 0)
      await expect(preview).toContainText("stored backend entry 198");
  }
  await expect(preview).toContainText("diagnostic browser info");
  await page.screenshot({ path: testInfo.outputPath("diagnostics-all.png") });
  await showfile
    .getByRole("radio", { name: "Local references", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).exportedOptions.showfileMode),
    )
    .toBe("showfileReferences");
  await page.screenshot({
    path: testInfo.outputPath("diagnostics-showfile-references.png"),
  });
  await showfile.getByRole("radio", { name: "Without references" }).check();
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).exportedOptions.showfileMode),
    )
    .toBe("showfileOnly");
  await logs.getByRole("radio", { name: "None", exact: true }).check();
  await showfile.getByRole("radio", { name: "None", exact: true }).check();
  await expect(preview).toHaveText("No logs selected.");
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).exportedOptions.logMode))
    .toBeNull();
  expect(
    await page.evaluate(() => (window as any).exportedOptions.showfileMode),
  ).toBe("none");
  await page.screenshot({ path: testInfo.outputPath("diagnostics-none.png") });
  await dialog.getByRole("button", { name: "Close diagnostics" }).click();
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Collect Diagnostics");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(
    logs.getByRole("radio", { name: "Recent warnings/errors" }),
  ).toBeChecked();
  await expect(
    showfile.getByRole("radio", { name: "None", exact: true }),
  ).toBeChecked();
});

/** Native failures and omitted assets stay visible while copy and selection controls remain usable. */
test("diagnostic export reports missing files and native save failures", async ({
  page,
  backendSlot,
}, testInfo) => {
  await installDiagnosticNativeMock(
    page,
    testInfo.outputPath("nightfall.log"),
    backendSlot.backendPort,
  );
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    (window as any).failCollection = true;
    (window as any).emitDiagnosticMenu();
  });
  const dialog = page.getByRole("dialog", { name: "Collect Diagnostics" });
  await expect(
    dialog.getByText("The log file is unavailable.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).cancelSave = true;
  });
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect(
    dialog.getByRole("button", { name: "Download Diagnostics" }),
  ).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).saveDialogOpened)).toBe(
    true,
  );
  expect(
    await page.evaluate(() => (window as any).exportedOptions),
  ).toBeUndefined();
  await page.evaluate(() => {
    (window as any).cancelSave = false;
    (window as any).saveDestination = "/chosen/folder/issue-diagnostics.zip";
  });
  await page.evaluate(() => {
    (window as any).exportWarnings = ["Missing referenced audio"];
  });
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "1 file(s) could not be included; see manifest.json",
  );
  await expect(dialog.getByRole("status")).not.toContainText("/chosen/folder/");
  await page.evaluate(() => {
    (window as any).failExport = true;
  });
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Could not save diagnostics: Error: Downloads is read-only",
  );
  await expect(
    dialog.getByRole("button", { name: "Copy System Info" }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("native-export-failure.png"),
  });
});

/** Browser diagnostics download real ZIPs for every showfile selection and keep unavailable logs inside the preview. */
test("downloads browser diagnostics with selected showfile references", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(60_000);
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  const created = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "DeskCommand",
      command: {
        type: "SaveNamedShowfile",
        data: { name: "browser-diagnostics", options: {} },
      },
    }),
  );
  expect(created.outcome.type).toBe("Succeeded");
  await waitForDockviewApp(page);
  const source = join(
    backendSlot.dataDir,
    "drafts",
    "browser-diagnostics.nightfall-show",
  );
  writeFileSync(join(source, "extra.txt"), "local diagnostic reference");
  const changed = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "SettingsCommand",
      command: { type: "SetShowfileBackupRetention", data: 37 },
    }),
  );
  expect(changed.outcome.type).toBe("Succeeded");
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Collect Diagnostics");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Collect Diagnostics" });
  const showfile = dialog.getByRole("group", { name: "Showfile to include" });
  const preview = dialog.getByRole("region", { name: "Log preview" });
  await expect(preview).toHaveText(
    "Log file collection is available in the desktop application.",
  );
  await expect(dialog.getByText("No log preview available.")).toHaveCount(0);
  let warningCount = 0;
  for (const [label, policy] of [
    ["None", "none"],
    ["Without references", "showfileOnly"],
    ["Local references", "showfileReferences"],
    ["All references", "allReferences"],
  ]) {
    await showfile.getByRole("radio", { name: label, exact: true }).check();
    const downloaded = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(
      /^nightfall-diagnostics-.*\.zip$/,
    );
    const path = testInfo.outputPath(`${policy}.zip`);
    await download.saveAs(path);
    const entries = execFileSync("unzip", ["-Z1", path], {
      encoding: "utf8",
    }).split("\n");
    expect(entries).toContain("system-info.json");
    expect(entries).toContain("manifest.json");
    expect(entries).not.toContain("logs/nightfall.log");
    const manifest = JSON.parse(
      execFileSync("unzip", ["-p", path, "manifest.json"], {
        encoding: "utf8",
      }),
    );
    expect(manifest.showfileMode).toBe(policy);
    expect(manifest.logMode).toBeNull();
    const systemInfo = JSON.parse(
      execFileSync("unzip", ["-p", path, "system-info.json"], {
        encoding: "utf8",
      }),
    );
    expect(systemInfo.application).toBe("Nightfall");
    expect(systemInfo.runtime).not.toBe("Desktop");
    expect(entries.includes("showfile.nightfall-show/showfile.json")).toBe(
      policy !== "none",
    );
    expect(entries.includes("showfile.nightfall-show/extra.txt")).toBe(
      policy === "showfileReferences" || policy === "allReferences",
    );
    if (policy !== "none") {
      const snapshot = JSON.parse(
        execFileSync(
          "unzip",
          ["-p", path, "showfile.nightfall-show/showfile.json"],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        ),
      );
      expect(snapshot.settings.showfile_backup_retention).toBe(37);
      expect(manifest.showfileSource).toBe("current engine state");
    }
    warningCount = manifest.warnings.length;
    if (warningCount > 0) {
      await expect(dialog.getByRole("status")).toContainText(
        `${warningCount} file(s) could not be included; see manifest.json`,
      );
    } else {
      await expect(dialog.getByRole("status")).toHaveCount(0);
    }
  }
  await page.screenshot({
    path: testInfo.outputPath("browser-diagnostics.png"),
  });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.screenshot({
    path: testInfo.outputPath("browser-diagnostics-compact.png"),
  });
  symlinkSync("missing-file", join(source, "omitted-link"));
  const warningDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  const warningPath = testInfo.outputPath("warnings.zip");
  await (await warningDownload).saveAs(warningPath);
  const warningManifest = JSON.parse(
    execFileSync("unzip", ["-p", warningPath, "manifest.json"], {
      encoding: "utf8",
    }),
  );
  expect(warningManifest.warnings).toHaveLength(warningCount + 1);
  expect(
    warningManifest.warnings.some((warning: string) =>
      warning.includes("Symbolic link omitted:"),
    ),
  ).toBe(true);
  await expect(dialog.getByRole("status")).toContainText(
    `${warningCount + 1} file(s) could not be included; see manifest.json`,
  );
  await page.route("**/api/diagnostics/export", (route) =>
    route.fulfill({ status: 503, body: "Diagnostic export unavailable" }),
  );
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Could not save diagnostics: Error: Diagnostic export unavailable",
  );
  await expect(
    dialog.getByRole("button", { name: "Download Diagnostics" }),
  ).toBeEnabled();
  await page.unroute("**/api/diagnostics/export");
  await showfile.getByRole("radio", { name: "None", exact: true }).check();
  await dialog
    .getByRole("group", { name: "Logs to include" })
    .getByRole("radio", { name: "None", exact: true })
    .check();
  await expect(preview).toHaveText("No logs selected.");
  const retried = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Diagnostics" }).click();
  await retried;
  await expect(dialog.getByRole("status")).toHaveCount(0);
});
