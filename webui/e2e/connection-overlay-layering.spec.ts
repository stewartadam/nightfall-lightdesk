// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./playwright-fixtures";

import { routeShowfileDiscovery, waitForDockviewApp } from "./showfile-startup";

/** Verifies connection loss covers open dialogs and workspace controls without losing draft input. */
test("connection overlay renders above showfile dialogs and dockview sashes", async ({
  page,
}, testInfo) => {
  let hmrSocket: WebSocketRoute | undefined;
  await page.routeWebSocket(
    (url) => url.pathname !== "/ws",
    (socket) => {
      socket.connectToServer();
      hmrSocket = socket;
    },
  );
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });

  await page.goto("/?startup:bypassBackendReadiness=1");
  await waitForDockviewApp(page, {
    createIfMissing: true,
    newShowfileName: "connection-overlay-e2e",
  });
  const overlay = page.locator('[data-overlay-kind="connection"]');
  await expect(overlay).toHaveCount(0);
  await expect(overlay.getByText("Connected")).toHaveCount(0);

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "New Showfile" }).click();
  const showfileDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(showfileDialog).toBeVisible();
  await showfileDialog.getByLabel("Show name").fill("unfinished-show");
  const showfileBounds = await showfileDialog.boundingBox();
  expect(showfileBounds).not.toBeNull();

  const sashPoint = await page
    .locator(".dv-sash")
    .first()
    .evaluate((sash) => {
      const rect = sash.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });

  await page.evaluate(async () => {
    const { EngineRuntimeStatus, engineRuntime } = await import(
      "/lib/engine-runtime.ts"
    );
    engineRuntime.worker?.onmessage?.(
      new MessageEvent("message", {
        data: { type: "status", status: EngineRuntimeStatus.Connected },
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    engineRuntime.stop();
  });

  await expect(overlay).toBeVisible();
  await expect(page.getByText("Connection Lost")).toBeVisible();
  await expect(
    overlay.getByText("Re-establishing connection to nightfall session."),
  ).toBeVisible();
  const surface = overlay.getByRole("dialog");
  await expect(surface).toHaveClass(/nightfall-modal-surface/);
  const bounds = showfileBounds!;
  for (const point of [
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    { x: bounds.x + 20, y: bounds.y + 20 },
    { x: bounds.x + bounds.width - 20, y: bounds.y + bounds.height - 20 },
  ]) {
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(
            document
              .elementFromPoint(x, y)
              ?.closest('[data-overlay-kind="connection"]'),
          ),
        point,
      ),
    ).toBe(true);
  }
  await page.keyboard.type("blocked");
  await expect(showfileDialog.getByLabel("Show name")).toHaveValue(
    "unfinished-show",
  );
  expect(
    await surface.evaluate((element) => getComputedStyle(element).boxShadow),
  ).not.toBe("none");
  const endpoint = await page.evaluate(async () => {
    const { getWebSocketUrl } = await import("/lib/api.ts");
    return getWebSocketUrl();
  });
  await overlay
    .getByRole("button", { name: "Show connection address" })
    .hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(`Connecting to ${endpoint}`);
  await expect(tooltip).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("connection-dialog.png") });

  const dots = overlay.locator(".startup-status-dot");
  await expect(dots).toHaveCount(3);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(dots.first()).toHaveCSS(
    "animation-name",
    "startup-status-dot-chase",
  );
  await expect(dots.nth(1)).toHaveCSS("animation-delay", "0.3s");
  await expect(dots.nth(2)).toHaveCSS("animation-delay", "0.6s");
  await page.evaluate(async () => {
    const { setAppearanceSetting } = await import("/state/appearance.ts");
    setAppearanceSetting("reducedMotion", "on");
  });
  await expect(dots.first()).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(async () => {
    const { setAppearanceSetting } = await import("/state/appearance.ts");
    setAppearanceSetting("reducedMotion", "off");
  });
  await expect(dots.first()).toHaveCSS(
    "animation-name",
    "startup-status-dot-chase",
  );

  await expect.poll(() => Boolean(hmrSocket)).toBe(true);
  const modulePath = "/components/overlays/connection/index.tsx";
  const updated = page.waitForEvent("console", {
    predicate: (message) =>
      message.text().includes(`hot updated: ${modulePath}`),
  });
  hmrSocket!.send(
    JSON.stringify({
      type: "update",
      updates: [
        {
          type: "js-update",
          path: modulePath,
          acceptedPath: modulePath,
          timestamp: Date.now(),
        },
      ],
    }),
  );
  await updated;
  await expect(
    overlay.getByRole("dialog", { name: "Connection Lost" }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(
    page.locator('[data-dialog-kind="command-palette"]'),
  ).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("connection-dialog-after-hmr.png"),
  });

  const topElement = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return {
      className:
        typeof element?.className === "string" ? element.className : "",
      isInsideOverlay: Boolean(
        element?.closest('[data-overlay-kind="connection"]'),
      ),
      isInsideSash: Boolean(element?.closest(".dv-sash")),
    };
  }, sashPoint);

  expect(topElement.isInsideOverlay, topElement.className).toBe(true);
  expect(topElement.isInsideSash, topElement.className).toBe(false);
});
