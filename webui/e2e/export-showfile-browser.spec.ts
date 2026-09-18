// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Browser downloads use the real headless backend, preserve unsaved state, and package selected assets. */
test("downloads a live showfile ZIP from the browser footer menu", async ({
  page,
  backendSlot,
}, testInfo) => {
  const exportName = "Tour-20260906-010203";
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  const created = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "DeskCommand",
      command: { type: "NewNamedShowfile", data: "browser-export-test" },
    }),
  );
  expect(created.outcome.type).toBe("Succeeded");
  await waitForDockviewApp(page);
  await page.clock.setFixedTime(
    await page.evaluate(() => new Date(2026, 8, 6, 1, 2, 3).getTime()),
  );
  const source = join(
    backendSlot.dataDir,
    "drafts",
    "browser-export-test.nightfall-show",
  );
  const before = readFileSync(join(source, "showfile.json"), "utf8");
  writeFileSync(join(source, "extra.txt"), "showfile reference");
  const result = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "SettingsCommand",
      command: { type: "SetShowfileBackupRetention", data: 37 },
    }),
  );
  expect(result.outcome.type).toBe("Succeeded");
  await page.locator("button[title='Menu']").click();
  const menuItems = await page.getByRole("button").allTextContents();
  expect(menuItems.findIndex((text) => text.trim() === "Export Showfile")).toBe(
    menuItems.findIndex((text) => text.includes("Save Showfile")) + 1,
  );
  await page
    .getByRole("button", { name: "Export Showfile", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Export Showfile",
    exact: true,
  });
  await dialog.getByLabel("Export name").fill("Tour.nightfall-show");
  await expect(
    dialog.getByText("Download a ZIP", { exact: false }),
  ).toBeVisible();
  for (const [label, policy] of [
    ["Showfile only", "showfileOnly"],
    ["Showfile references", "showfileReferences"],
    ["All references", "allReferences"],
  ]) {
    await dialog.getByRole("radio", { name: label, exact: true }).check();
    const downloaded = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download Showfile" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(
      `${exportName}.nightfall-show.zip`,
    );
    const path = testInfo.outputPath(`${policy}.zip`);
    await download.saveAs(path);
    const loaded = JSON.parse(
      execFileSync(
        "unzip",
        ["-p", path, `${exportName}.nightfall-show/showfile.json`],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
    expect(loaded.settings.showfile_backup_retention).toBe(37);
    expect(loaded.settings.active_panel_layout.panels.length).toBeGreaterThan(
      0,
    );
    const entries = execFileSync("unzip", ["-Z1", path], {
      encoding: "utf8",
    }).split("\n");
    expect(entries).toContain(
      `${exportName}.nightfall-show/showfile-manifest.json`,
    );
    expect(entries.includes(`${exportName}.nightfall-show/extra.txt`)).toBe(
      policy !== "showfileOnly",
    );
    expect(entries).not.toContain("export-warnings.json");
    await expect(dialog.getByRole("status")).toContainText(
      `Download started: ${exportName}.nightfall-show.zip`,
    );
    expect(readFileSync(join(source, "showfile.json"), "utf8")).toBe(before);
  }
  await page.screenshot({
    path: testInfo.outputPath("browser-export-complete.png"),
  });
  symlinkSync("missing-file", join(source, "omitted-link"));
  const warningDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Showfile" }).click();
  const warningZip = testInfo.outputPath("warnings.zip");
  await (await warningDownload).saveAs(warningZip);
  const warnings = JSON.parse(
    execFileSync("unzip", ["-p", warningZip, "export-warnings.json"], {
      encoding: "utf8",
    }),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Symbolic link omitted:");
  await expect(dialog.getByRole("status")).toContainText(
    "1 export warning(s).",
  );
  await page.screenshot({
    path: testInfo.outputPath("browser-export-warnings.png"),
  });
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
});

/** HTTP errors leave the browser export dialog usable, and invalid names are rejected by the backend. */
test("browser export reports backend failures and can retry", async ({
  page,
  request,
  backendSlot,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  const invalid = await request.post(
    `http://127.0.0.1:${backendSlot.backendPort}/api/showfiles/current/export`,
    {
      data: { name: "../outside", policy: "showfileOnly" },
    },
  );
  expect(invalid.status()).toBe(400);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await page.locator("button[title='Menu']").click();
  await page
    .getByRole("button", { name: "Export Showfile", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Export Showfile",
    exact: true,
  });
  await page.route("**/api/showfiles/current/export", (route) =>
    route.fulfill({ status: 503, body: "No showfile is available to export" }),
  );
  await dialog.getByRole("button", { name: "Download Showfile" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "No showfile is available to export",
  );
  await expect(
    dialog.getByRole("button", { name: "Download Showfile" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 900, height: 600 });
  await dialog
    .getByRole("button", { name: "Download Showfile" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("browser-export-error.png"),
  });
  await page.unroute("**/api/showfiles/current/export");
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Showfile" }).click();
  await downloaded;
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText("Download started:");
});
