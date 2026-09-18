// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

/** Waits until the app has mounted its store bridge and dock API. */
async function waitForApp(page: Page): Promise<void> {
  await prepareStoreSeededTestApp(page);
}

/** Opens the instrumentation panel through the dock API. */
async function openInstrumentationPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-Instrumentation-websocket")?.api.close();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      ) ??
      api.getPanel("panel-FixtureGrid");
    const panel = api.addPanel({
      id: "panel-Instrumentation-websocket",
      component: "Instrumentation",
      title: "Instrumentation",
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
      params: {},
    });
    panel.api.setActive();
    panel.api.maximize();
    panel.focus();
  });
  await expect(instrumentationPanel(page)).toBeVisible();
}

/** Locates the visible instrumentation panel owned by this spec. */
function instrumentationPanel(page: Page) {
  return page.locator(
    '[data-component="Instrumentation"][data-panel-id="panel-Instrumentation-websocket"]:visible',
  );
}

/** Seeds websocket instrumentation stats through the app store debug surface. */
async function seedWebsocketStats(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
    (window as any).appStores.wsStats.set({
      worker: {
        totalMessages: 120,
        droppedMessages: 3,
        avgDecodeMs: 1.25,
        queueDepth: 2,
        lastStagedDeliveryMessageId: 1234,
      },
      main: {
        processedCount: 100,
        droppedCount: 0,
        lastDeliveryLagMs: 310,
        avgDeliveryLagMs: 275,
        maxDeliveryLagMs: 480,
        backlogLagging: true,
        lastSeenDeliveryMessageId: 1229,
        pull: {
          pullsPerSec: 59.7,
          responsesPerSec: 58.9,
          nonEmptyResponsesPerSec: 52.4,
          messagesPerSec: 180.2,
          parameterStatesPerSec: 49.8,
          lastBatchSize: 4,
          cadenceAvgMs: 16.7,
          cadenceMinMs: 15.9,
          cadenceMaxMs: 18.2,
          inFlight: false,
        },
      },
      byType: {
        ParameterState: {
          count: 100,
          dropped: 3,
          avgDecodeMs: 1.2,
          avgProcessMs: 5.6,
          ratePerSec: 44,
        },
      },
      timestamp: performance.now(),
    });
  });
}

/** Verifies stage boundaries, coalescing guidance, and worker/main backlog labels. */
test("instrumentation panel surfaces websocket backlog lag", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");
  await waitForApp(page);

  await openInstrumentationPanel(page);
  await seedWebsocketStats(page);
  const panel = instrumentationPanel(page);
  await panel.getByRole("button", { name: /WebSocket Messages/ }).click();

  await expect(panel.getByText("Lagging")).toBeVisible();
  await expect(panel.getByText("Main delivery EMA")).toBeVisible();
  await expect(panel.getByText("275.0 ms").last()).toHaveClass(/text-red-500/);
  await expect(panel.getByText("Main delivery max (session)")).toBeVisible();
  await expect(panel.getByText("480.0 ms")).toBeVisible();
  await expect(panel.getByText("Pulls/s")).toBeVisible();
  await expect(panel.getByText("59.7")).toBeVisible();
  await expect(panel.getByText("ParameterState/s")).toBeVisible();
  await expect(panel.getByText("49.8")).toBeVisible();
  await expect(panel.getByText("Pull cadence")).toBeVisible();
  await expect(panel.getByText("16.7 ms")).toBeVisible();
  await expect(panel.getByText("Delivery IDs", { exact: true })).toBeVisible();
  await expect(panel.getByText("1229 / 1234")).toBeVisible();
  await expect(
    panel.getByRole("cell", { name: "ParameterState" }),
  ).toBeVisible();
  const messages = panel.getByRole("table", { name: "Worker message totals" });
  await expect(messages).toHaveClass(/nf-table/);
  await expect(messages.getByRole("columnheader").nth(1)).toHaveCSS(
    "text-align",
    "right",
  );
  await messages.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("shared-instrumentation.png"),
    fullPage: true,
  });
});

/** Verifies real rolling collection and exact percentile values in both timing tables. */
test("websocket delivery lag is exposed as Performance measures", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForApp(page);
  await page.evaluate(async () => {
    const { recordExternalPerformanceMeasure, clearPerformanceMeasures } =
      await import("/lib/performance-measure-collector.ts");
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
    clearPerformanceMeasures();
    for (let value = 1; value <= 100; value++) {
      recordExternalPerformanceMeasure(
        "nightfall:websocket.worker-to-main",
        value,
      );
      recordExternalPerformanceMeasure(
        "nightfall:websocket.transport-rtt",
        value / 10,
      );
    }
  });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = (window as any).appStores.performanceMeasureStats.get()[
            "nightfall:websocket.worker-to-main"
          ];
          return stats?.count ?? 0;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const stats = await page.evaluate(
    () =>
      (window as any).appStores.performanceMeasureStats.get()[
        "nightfall:websocket.worker-to-main"
      ],
  );

  expect(stats).toMatchObject({
    count: 100,
    avgMs: 50.5,
    p95Ms: 95,
    p99Ms: 99,
    maxMs: 100,
  });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openInstrumentationPanel(page);
  await seedWebsocketStats(page);
  const panel = instrumentationPanel(page);
  await panel.getByRole("button", { name: /WebSocket Messages/ }).click();
  const timings = panel.getByRole("table", { name: "WebSocket timing stages" });
  const delivery = timings.getByRole("row", { name: /Worker → main delay/ });
  await expect(delivery).toContainText("50.50 ms");
  await expect(delivery).toContainText("95.00 ms");
  await expect(delivery).toContainText("99.00 ms");
  await expect(delivery).toContainText("100.00 ms");
  const transport = timings.getByRole("row", { name: /Transport RTT/ });
  await expect(transport).toContainText("9.90 ms");
  await expect(
    timings.getByRole("row", { name: /Worker processing/ }),
  ).toContainText("—");
  await expect(
    panel.getByText(/ParameterState snapshots are coalesced/),
  ).toBeVisible();
  await expect(panel.getByText(/not one-way delivery/)).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Processing (EMA)" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("websocket-timing-stages.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: /Performance Metrics/ }).click();
  const performanceRow = panel.getByRole("row").filter({
    has: page.getByRole("cell", {
      name: "websocket.worker-to-main",
      exact: true,
    }),
  });
  await expect(performanceRow).toContainText("99.00 ms");
  const measures = panel.getByRole("table", { name: "Performance metrics" });
  await expect(measures).toHaveClass(/nf-table/);
  await expect(
    measures.getByRole("cell", {
      name: "websocket.worker-to-main",
      exact: true,
    }),
  ).toBeVisible();
  await measures
    .getByRole("columnheader", { name: "Scope", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("shared-performance-metrics.png"),
    fullPage: true,
  });
});
