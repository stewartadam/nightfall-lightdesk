// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { WebSocketRoute } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Exercises Vite's real update handler without editing shared worktree files. */
test("design lab controls survive repeated hot updates", async ({
  page,
}, testInfo) => {
  let hmrSocket: WebSocketRoute | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.routeWebSocket(/.*/, (socket) => {
    socket.connectToServer();
    hmrSocket = socket;
  });
  await page.goto("/design-lab.html");
  await expect(
    page.getByRole("region", { name: "Group library" }),
  ).toBeVisible();
  await expect.poll(() => Boolean(hmrSocket)).toBe(true);

  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Buttons/ })
    .click();
  const buttons = page.getByRole("region", { name: "Button examples" });
  await expect(buttons).toBeVisible();
  const sash = page
    .locator(".dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled")
    .first();
  const bounds = (await sash.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 80, bounds.y + 100, { steps: 12 });
  await page.mouse.up();
  const panelWidth = (await buttons.boundingBox())!.width;

  for (let update = 0; update < 3; update += 1) {
    const timestamp = Date.now();
    const updated = page.waitForEvent("console", {
      predicate: (message) =>
        message.text().includes("hot updated: /design-lab/main.tsx"),
    });
    hmrSocket!.send(
      JSON.stringify({
        type: "update",
        updates: [
          {
            type: "js-update",
            path: "/design-lab/main.tsx",
            acceptedPath: "/design-lab/main.tsx",
            timestamp,
          },
        ],
      }),
    );
    await updated;
    await expect(buttons).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await buttons.boundingBox())!.width - panelWidth),
      )
      .toBeLessThan(16);
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    await expect(page.locator(".design-lab")).toHaveClass(/compact/);
    await page.getByRole("button", { name: "Comfort", exact: true }).click();
    await expect(page.locator(".design-lab")).not.toHaveClass(/compact/);
    await page.keyboard.press("ControlOrMeta+Shift+P");
    const palette = page.locator('[data-dialog-kind="command-palette"]');
    const search = palette.getByPlaceholder("Type a command or search...");
    await expect(search).toBeFocused();
    await search.fill("density");
    await expect(
      palette.locator('[data-command-id="design-lab.toggle-density"]'),
    ).toHaveCount(1);
    await search.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.locator(".design-lab")).toHaveClass(/compact/);
    expect(errors).toEqual([]);
  }
  await page.screenshot({
    path: testInfo.outputPath("design-lab-after-hmr.png"),
  });
  await page.reload();
  await expect(buttons).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs((await buttons.boundingBox())!.width - panelWidth),
    )
    .toBeLessThan(16);
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Group library" }),
  ).toBeVisible();
  await expect(
    page.locator(".dv-tab").filter({ hasText: /^Buttons$/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Group library" }),
  ).toBeVisible();
  await expect(
    page.locator(".dv-tab").filter({ hasText: /^Buttons$/ }),
  ).toHaveCount(0);
});
