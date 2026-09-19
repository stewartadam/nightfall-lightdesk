// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";

/** Verify the production native worker connects and retains the shared command-parsing bridge. */
test("native distribution connects without the embedded demo engine", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE !== "preview" ||
      process.env.NIGHTFALL_PLAYWRIGHT_VITE_BASE !== "/",
    "Requires the native production artifact",
  );
  const errors: string[] = [];
  const wasmRequests: string[] = [];
  const diagnostics: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("requestfailed", (request) =>
    diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      diagnostics.push(`${response.status()}: ${response.url()}`);
  });
  page.on("request", (request) => {
    if (request.url().includes(".wasm")) wasmRequests.push(request.url());
  });
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript((port) => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
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
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  try {
    await expect
      .poll(async () => {
        expect(errors).toEqual([]);
        return page.getByRole("navigation", { name: "Global" }).isVisible();
      })
      .toBe(true);
    await page
      .getByRole("button", { name: "Open command palette", exact: true })
      .click();
    const input = page.getByPlaceholder("Type a command or search...");
    await input.fill("fixture 1");
    await expect(input).toBeVisible();
    await expect
      .poll(() =>
        wasmRequests.some((url) => url.includes("nightfall_wasm_bridge")),
      )
      .toBe(true);
    expect(
      wasmRequests.some((url) => url.includes("nightfall_browser_runtime")),
    ).toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("native-distribution.png"),
    });
  } finally {
    await testInfo.attach("page-errors", {
      body: JSON.stringify({ errors, diagnostics }),
      contentType: "application/json",
    });
  }
});
