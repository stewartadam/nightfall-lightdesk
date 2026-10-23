// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const PANEL_ID = "panel-Instrumentation-status-colors";

/** Opens the instrumentation panel through the dock API, maximized so every section fits. */
async function openInstrumentationPanel(page: Page): Promise<Locator> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const panel = api.addPanel({
      id: panelId,
      component: "Instrumentation",
      title: "Instrumentation",
      params: {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    panel.api.setActive();
    panel.api.maximize();
  }, PANEL_ID);
  const panel = page.locator(
    `[data-component="Instrumentation"][data-panel-id="${PANEL_ID}"]:visible`,
  );
  await expect(panel).toBeVisible();
  return panel;
}

/** Expands one collapsible instrumentation section and returns its content region. */
async function expandSection(panel: Locator, title: RegExp): Promise<Locator> {
  const toggle = panel.getByRole("button", { name: title }).first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  const contentId = await toggle.getAttribute("aria-controls");
  const content = panel.locator(`[id="${contentId}"]`);
  await expect(content).toBeVisible();
  return content;
}

/** Locates the value element of the metric card whose label matches exactly. */
function metricCardValue(section: Locator, label: string): Locator {
  return section
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::*[1]");
}

/**
 * Screenshots the card grids holding the FPS and delivery-lag values,
 * scrolling each into view first, as `<prefix>-fps.png` and `<prefix>-lag.png`.
 */
async function captureCards(
  fps: Locator,
  lag: Locator,
  prefix: string,
): Promise<void> {
  for (const [value, name] of [
    [fps, "fps"],
    [lag, "lag"],
  ] as const) {
    const grid = value.locator("xpath=../..");
    await grid.scrollIntoViewIfNeeded();
    await grid.screenshot({ path: `${prefix}-${name}.png` });
  }
}

/** Reads the rendered text color of an element. */
async function textColor(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

/** Replaces the backend metrics and websocket stats with deterministic samples. */
async function seedMetrics(
  page: Page,
  sample: { fps: number; avgDeliveryLagMs: number },
): Promise<void> {
  await page.evaluate((next) => {
    const stores = (window as any).appStores;
    stores.smoothedEngineMetrics.set({
      ...stores.smoothedEngineMetrics.get(),
      fps: next.fps,
      frameTimeMs: 1000 / next.fps,
    });
    stores.wsStats.set({
      worker: {
        totalMessages: 120,
        droppedMessages: 0,
        avgDecodeMs: 1.25,
        queueDepth: 0,
        lastStagedDeliveryMessageId: 1234,
      },
      main: {
        processedCount: 100,
        droppedCount: 0,
        lastDeliveryLagMs: next.avgDeliveryLagMs,
        avgDeliveryLagMs: next.avgDeliveryLagMs,
        maxDeliveryLagMs: next.avgDeliveryLagMs,
        backlogLagging: next.avgDeliveryLagMs > 66,
        lastSeenDeliveryMessageId: 1229,
      },
      byType: {
        ParameterState: {
          count: 100,
          dropped: 0,
          avgDecodeMs: 1.2,
          avgProcessMs: 5.6,
          ratePerSec: 44,
        },
      },
      timestamp: performance.now(),
    });
  }, sample);
}

/**
 * Verifies FPS and delivery-lag metric cards render in their status colors:
 * a healthy sample and a degraded sample must paint the same card in two
 * different colors, and neither may fall back to the plain value color.
 */
test("instrumentation FPS and delivery lag values use status colors", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const path =
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
      ? "/demo/app/?e2e=1"
      : "/?engine=embedded-demo&e2e=1";
  await page.goto(path);
  await waitForDockviewApp(page);
  await page.evaluate(() => window.__nightfallTest.runtime.disconnect());

  const panel = await openInstrumentationPanel(page);
  await seedMetrics(page, { fps: 44, avgDeliveryLagMs: 8 });
  const backend = await expandSection(panel, /^Backend/);
  const websocket = await expandSection(panel, /WebSocket Messages/);
  const fps = metricCardValue(backend, "FPS");
  const lag = metricCardValue(websocket, "Main delivery EMA");
  const plain = metricCardValue(websocket, "Main delivery max (session)");

  await expect(fps).toHaveText("44.0");
  await expect(lag).toHaveText("8.0 ms");
  await captureCards(fps, lag, testInfo.outputPath("healthy"));
  const plainColor = await textColor(plain);
  const healthyFps = await textColor(fps);
  const healthyLag = await textColor(lag);

  await seedMetrics(page, { fps: 20, avgDeliveryLagMs: 275 });
  await expect(fps).toHaveText("20.0");
  await expect(lag).toHaveText("275.0 ms");
  await captureCards(fps, lag, testInfo.outputPath("degraded"));
  const degradedFps = await textColor(fps);
  const degradedLag = await textColor(lag);

  expect(healthyFps).not.toBe(plainColor);
  expect(healthyLag).not.toBe(plainColor);
  expect(degradedFps).not.toBe(plainColor);
  expect(degradedLag).not.toBe(plainColor);
  expect(degradedFps).not.toBe(healthyFps);
  expect(degradedLag).not.toBe(healthyLag);
});
