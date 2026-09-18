// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

/** Seeds lagging websocket stats through the app store debug surface. */
async function seedLaggingWebsocketStats(page: Page) {
  await page.evaluate(() => {
    (window as any).appStores.wsStats.set({
      worker: {
        totalMessages: 10,
        droppedMessages: 0,
        avgDecodeMs: 0.5,
        queueDepth: 0,
      },
      main: {
        processedCount: 10,
        droppedCount: 0,
        lastDeliveryLagMs: 300,
        avgDeliveryLagMs: 275,
        maxDeliveryLagMs: 350,
        backlogLagging: true,
      },
      byType: {},
      timestamp: performance.now(),
    });
  });
}

/** Seeds status-bar delivery and frame metrics through the app store debug surface. */
async function seedDeliveryAndFrameStats(page: Page) {
  await page.evaluate(() => {
    (window as any).appStores.wsLatency.set(100);
    (window as any).appStores.engineMetrics.set({
      fps: 44.4,
      active_layers: 0,
    });
    (window as any).appStores.frameStats.set({
      fps: 49.6,
      avgFrameTimeMs: 20.2,
      droppedFrames: 0,
    });
    (window as any).appStores.wsStats.set({
      worker: {
        totalMessages: 10,
        droppedMessages: 0,
        avgDecodeMs: 0.5,
        queueDepth: 0,
      },
      main: {
        processedCount: 10,
        droppedCount: 0,
        lastDeliveryLagMs: 14,
        avgDeliveryLagMs: 12.3,
        maxDeliveryLagMs: 20,
        backlogLagging: false,
      },
      byType: {},
      timestamp: performance.now(),
    });
  });
}

/** Keeps seeded metrics present long enough for the status-bar display sample. */
async function holdDeliveryAndFrameStats(page: Page) {
  const endAt = Date.now() + 1250;
  while (Date.now() < endAt) {
    await seedDeliveryAndFrameStats(page);
    await page.waitForTimeout(100);
  }
}

/** Verifies lagging delivery updates the connection indicator and its tooltip. */
test("status bar shows degraded connection while websocket delivery is lagging", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  const statusBar = page.getByRole("region", {
    name: "Application status bar",
  });
  await expect(statusBar).toBeVisible();
  await expect(
    statusBar.getByRole("status", { name: "Connected", exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  });

  await seedLaggingWebsocketStats(page);

  await expect(
    statusBar.getByRole("status", { name: "Degraded" }),
  ).toBeVisible();
  await statusBar.getByRole("status").hover();
  await expect(
    page.getByRole("tooltip", { name: "Degraded", exact: true }),
  ).toBeVisible();
  await expect(statusBar.locator(".bg-yellow-500").first()).toBeVisible();
});

/** Verifies metrics are collapsed initially and can be expanded and collapsed. */
test("status bar shows websocket, backend, and frontend frame metrics", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");

  const statusBar = page.getByRole("region", {
    name: "Application status bar",
  });
  await expect(statusBar).toBeVisible();
  await expect(
    statusBar.getByRole("status", { name: "Connected", exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  });

  const expander = statusBar.getByRole("button", { name: "Show metrics" });
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(statusBar.locator("#status-metrics")).toBeHidden();
  const separator = statusBar.getByTestId("status-metrics-separator");
  await expect(separator).toBeHidden();
  await expander.click();
  await expect(statusBar.locator("#status-metrics")).toBeVisible();
  await expect(separator).toBeVisible();
  await holdDeliveryAndFrameStats(page);

  await expect(statusBar).toContainText(/\d+\.\dms\s*\/\s*\d+\.\dms/);
  await expect(statusBar).toContainText(/\d+\sHz/);
  await expect(statusBar).toContainText(/\d+\sFPS/);
  await expect(statusBar).not.toContainText("Backend");
  await expect(statusBar).not.toContainText("UI");
  await page.screenshot({ path: testInfo.outputPath("metrics-separator.png") });
  await statusBar.getByRole("button", { name: "Hide metrics" }).click();
  await expect(statusBar.locator("#status-metrics")).toBeHidden();
  await expect(separator).toBeHidden();
});

/** Verifies build metadata sits beside undo controls with separators around the control group. */
test("status bar places build name beside undo controls", async ({ page }) => {
  await page.goto("/?e2e=1");

  const statusBar = page.getByRole("region", {
    name: "Application status bar",
  });
  await expect(statusBar).toBeVisible();
  await expect(
    statusBar.getByRole("status", { name: "Connected", exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  });

  const buildNameBox = await statusBar
    .getByTestId("status-build-name")
    .boundingBox();
  const buildSeparatorBox = await statusBar
    .getByTestId("status-build-separator")
    .boundingBox();
  const undoButtonBox = await statusBar
    .getByRole("button", { name: /^(Nothing to undo|Undo:)/ })
    .boundingBox();
  const undoTimelineButtonBox = await statusBar
    .getByRole("button", { name: "Open undo timeline" })
    .boundingBox();
  const undoSeparatorBox = await statusBar
    .getByTestId("status-undo-separator")
    .boundingBox();
  const clockBox = await statusBar.getByTestId("status-clock").boundingBox();

  expect(buildNameBox).not.toBeNull();
  expect(buildSeparatorBox).not.toBeNull();
  expect(undoButtonBox).not.toBeNull();
  expect(undoTimelineButtonBox).not.toBeNull();
  expect(undoSeparatorBox).not.toBeNull();
  expect(clockBox).not.toBeNull();

  expect(buildNameBox!.x + buildNameBox!.width).toBeLessThan(
    buildSeparatorBox!.x,
  );
  expect(buildSeparatorBox!.x + buildSeparatorBox!.width).toBeLessThan(
    undoButtonBox!.x,
  );
  expect(undoTimelineButtonBox!.x + undoTimelineButtonBox!.width).toBeLessThan(
    undoSeparatorBox!.x,
  );
  expect(undoSeparatorBox!.x + undoSeparatorBox!.width).toBeLessThan(
    clockBox!.x,
  );
});

/** Checks compact shell sizing, unframed metadata, and hover-only connection text. */
test("header and status bar keep secondary details compact", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  const header = page.getByRole("navigation", { name: "Global" });
  const statusBar = page.getByRole("region", {
    name: "Application status bar",
  });
  const indicator = statusBar.getByRole("status", {
    name: "Connected",
    exact: true,
  });
  await expect(indicator).toBeVisible({ timeout: 10_000 });
  await expect(header.getByText("nightfall", { exact: true })).toBeVisible();
  await expect(statusBar).not.toContainText("Connected");
  await expect(statusBar).not.toContainText("Nightfall v");
  const clear = header.getByRole("button", {
    name: "Clear programmer",
    exact: true,
  });
  const clearBox = await clear.boundingBox();
  const clearIconBox = await clear.locator("svg").boundingBox();
  expect(clearBox).not.toBeNull();
  expect(clearIconBox).not.toBeNull();
  for (const name of ["Open command palette", "Notification history"]) {
    const action = header.getByRole("button", { name, exact: true });
    const box = await action.boundingBox();
    const iconBox = await action.locator("svg").boundingBox();
    expect(box?.width).toBe(clearBox!.width);
    expect(box?.height).toBe(clearBox!.height);
    expect(iconBox?.width).toBe(clearIconBox!.width);
    expect(iconBox?.height).toBe(clearIconBox!.height);
  }
  for (const testId of ["status-showfile-name", "status-build-name"]) {
    await expect(statusBar.getByTestId(testId)).toHaveCSS(
      "border-top-width",
      "0px",
    );
  }
  await indicator.hover();
  await expect(
    page.getByRole("tooltip", { name: "Connected", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("compact-shell.png") });
  await indicator.focus();
  await expect(
    page.getByRole("tooltip", { name: "Connected", exact: true }),
  ).toBeVisible();
  await header
    .getByRole("button", { name: "Notification history", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Notification history" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await header
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await expect(
    page.getByPlaceholder("Type a command or search..."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await statusBar.getByRole("button", { name: "Show metrics" }).click();
  await expect(statusBar.locator("#status-metrics")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("expanded-shell.png") });
});
