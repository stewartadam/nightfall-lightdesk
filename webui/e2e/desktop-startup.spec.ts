// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Desktop HTTP requests bypass Vite and complete discovery, draft saves, and ranged reads. */
test("desktop startup can access a backend on another origin", async ({
  page,
  request,
  backendSlot,
}, testInfo) => {
  const backendUrl = `http://localhost:${backendSlot.backendPort}`;
  await page.addInitScript((port) => {
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
    const desktop = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
      __NIGHTFALL_BACKEND_PORT__?: number;
    };
    desktop.__NIGHTFALL_BACKEND_PORT__ = port;
    desktop.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      /** Supplies the callback handle required by native menu registration. */
      transformCallback() {
        return 1;
      },
      /** Acknowledges native event listeners while HTTP and WebSocket use the real backend. */
      async invoke(command: string) {
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:event|unlisten") return;
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
    desktop.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      /** Releases mock native subscriptions when the test page disposes its shell. */
      unregisterListener() {},
    };
  }, backendSlot.backendPort);

  const discovery = page.waitForResponse(`${backendUrl}/api/showfiles`);
  await page.goto("/?e2e=1");
  expect((await discovery).status()).toBe(200);
  const picker = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(picker).toBeVisible();
  await expect(picker.getByText("Loading showfiles...")).toBeHidden();
  await expect(picker.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("desktop-showfile-picker.png"),
  });
  await waitForDockviewApp(page, { createIfMissing: true });
  await expect(page.getByTestId("startup-splash")).toBeHidden();

  const results = await page.evaluate(async (baseUrl) => {
    const draft = await fetch(`${baseUrl}/api/showfiles/default/draft`);
    const draftBody = await draft.json();
    const save = await fetch(`${baseUrl}/api/showfiles/current/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const invalidSave = await fetch(`${baseUrl}/api/showfiles/current/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid JSON",
    });
    const resource = await fetch(
      `${baseUrl}/api/showfiles/current/showfile.json`,
      {
        headers: { Range: "bytes=0-31" },
      },
    );
    const missing = await fetch(
      `${baseUrl}/api/showfiles/current/missing-resource`,
    );
    return {
      draftStatus: draft.status,
      hasDraftMetadata: "draft" in draftBody,
      saveStatus: save.status,
      invalidSaveStatus: invalidSave.status,
      resourceStatus: resource.status,
      contentRange: resource.headers.get("Content-Range"),
      resourceLength: (await resource.arrayBuffer()).byteLength,
      missingStatus: missing.status,
    };
  }, backendUrl);
  expect(results).toEqual({
    draftStatus: 200,
    hasDraftMetadata: true,
    saveStatus: 202,
    invalidSaveStatus: 400,
    resourceStatus: 206,
    contentRange: expect.stringMatching(/^bytes 0-31\/\d+$/),
    resourceLength: 32,
    missingStatus: 404,
  });

  for (const origin of [
    "http://localhost:3031",
    "tauri://localhost",
    "http://tauri.localhost",
  ]) {
    const response = await request.get(`${backendUrl}/api/showfiles`, {
      headers: { Origin: origin },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
  }
  await page.screenshot({
    path: testInfo.outputPath("desktop-startup-complete.png"),
  });
});
