// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Open a visible authoring timeline and capture detection commands without invoking inference. */
async function authoringPage(page: Page) {
  await page.goto(
    "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1&visualizer:defaultPanel=false",
  );
  await waitForDockviewApp(page);
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const uid = Object.keys(stores.timelines.get())[0];
    const api = stores.dockApi.get();
    api.clear();
    api.addPanel({
      id: "model-test-timeline",
      component: "Timeline",
      title: "Model test",
      params: { initialTimelineUid: uid },
    });
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    const send = engineRuntime.sendCommand.bind(engineRuntime);
    (window as any).modelDetectionCommands = 0;
    engineRuntime.sendCommand = (command: any) => {
      if (command.command?.type === "RequestBeatgridDetection") {
        (window as any).modelDetectionCommands++;
        return null;
      }
      return send(command);
    };
  });
}

/** Open the actual timeline detection action, which must check model availability before dispatch. */
async function detect(page: Page) {
  await page.getByRole("button", { name: "BPM controls" }).click();
  await page.getByRole("button", { name: "Detect", exact: true }).click();
}

/** Require explicit consent, expose licenses before transfer, and dispatch detection only once verified. */
test("first detection offers a licensed model download and reuses the installed model", async ({
  page,
}, testInfo) => {
  let phase = "missing";
  let downloads = 0;
  let requests = 0;
  await page.route("**/api/beat-detection/model", async (route) => {
    requests++;
    if (route.request().method() === "POST") {
      downloads++;
      phase = "downloading";
    }
    await route.fulfill({
      json: {
        phase,
        received_bytes: phase === "downloading" ? 10000000 : 0,
        total_bytes: 83077778,
        error: null,
      },
    });
  });
  await authoringPage(page);
  expect(requests).toBe(0);
  await detect(page);
  const dialog = page.getByRole("dialog", {
    name: "Beat detection model",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await expect(
    page.getByRole("button", { name: "BPM controls" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.locator('[data-menu-kind="beatgrid-controls"]'),
  ).toBeHidden();
  await dialog
    .getByText("Beat This license and attribution (MIT)", { exact: true })
    .click();
  await expect(dialog.locator("pre")).toHaveCSS("border-top-width", "1px");
  await expect(dialog.locator("pre")).toContainText(
    "Copyright (c) 2024 Institute of Computational Perception",
  );
  await expect(dialog.locator("pre")).toContainText(
    "Copyright (c) 2025 Masaki Ono",
  );
  await expect(
    dialog.getByRole("link", { name: "Beat This project", exact: true }),
  ).toHaveAttribute("href", "https://github.com/CPJKU/beat_this");
  await dialog.screenshot({
    path: testInfo.outputPath("model-download-license.png"),
  });
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await expect(
    dialog.getByRole("progressbar", { name: "Model download progress" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).modelDetectionCommands),
  ).toBe(0);
  phase = "ready";
  await expect(dialog).toBeHidden();
  expect(downloads).toBe(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).modelDetectionCommands))
    .toBe(1);
  await authoringPage(page);
  await detect(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).modelDetectionCommands))
    .toBe(1);
  await expect(dialog).toBeHidden();
  expect(downloads).toBe(1);
});

/** Failed and cancelled downloads remain retryable, and Settings can prepare offline use without detection. */
test("settings supports download failure, cancellation, retry, and offline readiness", async ({
  page,
}, testInfo) => {
  let phase = "missing";
  let downloads = 0;
  await page.route("**/api/beat-detection/model", async (route) => {
    if (route.request().method() === "POST") {
      downloads++;
      phase = downloads === 1 ? "failed" : "downloading";
    }
    if (route.request().method() === "DELETE") phase = "cancelled";
    await route.fulfill({
      json: {
        phase,
        received_bytes: 0,
        total_bytes: 83077778,
        error: phase === "failed" ? "Download connection lost" : null,
      },
    });
  });
  await authoringPage(page);
  await page.evaluate(() => {
    const store = (window as any).appStores.runtimeCapabilities;
    store.set({ ...store.get(), runtime_mode: "Native" });
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "Editors", exact: true }).click();
  await expect(
    settings.getByRole("heading", { name: "Timeline", exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Download", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Beat detection model",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Download connection lost",
  );
  await dialog.getByRole("button", { name: "Retry download" }).click();
  await dialog.getByRole("button", { name: "Cancel download" }).click();
  await expect(
    dialog.getByRole("button", { name: "Retry download" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Retry download" }).click();
  phase = "ready";
  await expect(
    settings.getByRole("button", { name: "Delete model", exact: true }),
  ).toBeEnabled();
  await dialog.screenshot({
    path: testInfo.outputPath("model-ready-settings.png"),
  });
  expect(
    await page.evaluate(() => (window as any).modelDetectionCommands),
  ).toBe(0);
  expect(downloads).toBe(3);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settings).toBeVisible();
  await settings.screenshot({
    path: testInfo.outputPath("timeline-settings.png"),
  });
});

/** Cold availability checks and installed-model detection never mount the consent dialog. */
test("installed detection remains silent while availability is checked", async ({
  page,
}) => {
  let checks = 0;
  await page.route("**/api/beat-detection/model", async (route) => {
    checks++;
    await route.fulfill({
      json: {
        phase: checks < 3 ? "checking" : "ready",
        received_bytes: 0,
        total_bytes: 83077778,
        error: null,
      },
    });
  });
  await authoringPage(page);
  await page.evaluate(() => {
    (window as any).modelDialogMounts = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('[aria-label="Beat detection model"]') ||
              node.querySelector('[aria-label="Beat detection model"]'))
          ) {
            (window as any).modelDialogMounts++;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await detect(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).modelDetectionCommands))
    .toBe(1);
  expect(checks).toBe(3);
  expect(await page.evaluate(() => (window as any).modelDialogMounts)).toBe(0);
});

/** Settings exposes installed weights without a dialog and deletes the cache before offering a new download. */
test("settings displays and deletes an installed model inline", async ({
  page,
}, testInfo) => {
  let phase = "ready";
  let deletions = 0;
  await page.route("**/api/beat-detection/model", async (route) => {
    await route.fulfill({
      json: { phase, received_bytes: 0, total_bytes: 83077778, error: null },
    });
  });
  await page.route("**/api/beat-detection/model/cache", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    deletions++;
    phase = "missing";
    await route.fulfill({
      json: {
        phase: "deleting",
        received_bytes: 0,
        total_bytes: 83077778,
        error: null,
      },
    });
  });
  await authoringPage(page);
  await page.evaluate(() => {
    const store = (window as any).appStores.runtimeCapabilities;
    store.set({ ...store.get(), runtime_mode: "Native" });
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "Editors", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Delete model", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("dialog", { name: "Beat detection model", exact: true }),
  ).toHaveCount(0);
  // Let the Settings tab transition settle before capturing its complete layout.
  await page.waitForTimeout(500);
  await settings.screenshot({
    path: testInfo.outputPath("installed-model-settings.png"),
  });
  await settings
    .getByRole("button", { name: "Delete model", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Download", exact: true }),
  ).toBeEnabled();
  await expect(
    settings.getByRole("button", { name: "Delete model", exact: true }),
  ).toHaveCount(0);
  expect(deletions).toBe(1);
  await settings.screenshot({
    path: testInfo.outputPath("deleted-model-settings.png"),
  });
});
