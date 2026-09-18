// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

type ProbeResult = {
  avgSetMs: number;
  maxSetMs: number;
  p95SetMs: number;
  avgRafMs: number;
  maxRafMs: number;
  layerCount: number;
};

type ProbeMetrics = Record<string, unknown>;
type ProbeMetricStats = {
  p95Ms: number;
};

const PANEL_ID = "layer-stack-delay-probe";
const FIXTURE_COUNT = 120;
const LAYER_COUNT = 6;
const ATTRIBUTES = [
  "Intensity",
  "Red",
  "Green",
  "Blue",
  "Pan",
  "Tilt",
  "Zoom",
  "Gobo",
] as const;

/** Waits until the application stores needed by the probe are available. */
async function waitForAppReady(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return Boolean(stores?.dockApi?.get?.() && stores?.layerStack?.set);
      }),
    )
    .toBe(true);
}

/** Opens or closes the synthetic Layers panel used by this performance probe. */
async function setLayersPanelOpen(page: Page, open: boolean): Promise<void> {
  await page.evaluate(
    ({ panelId, open }) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      for (const panelIdToClose of [
        panelId,
        "panel-FixtureGrid",
        "panel-ProgrammerGrid",
        "panel-LayerStack",
      ]) {
        api.getPanel(panelIdToClose)?.api.close();
      }
      if (!open) return;
      const referencePanel =
        api.getPanel("panel-Visualizer") ??
        api.panels.find(
          (candidate: any) => candidate.api.location.type === "grid",
        );
      api.addPanel({
        id: panelId,
        component: "LayerStack",
        title: "Layers",
        params: {},
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "right",
              },
            }
          : {}),
      });
    },
    { panelId: PANEL_ID, open },
  );

  if (open) {
    await expect(
      page.locator(`[data-panel-kind="layer"][data-panel-id="${PANEL_ID}"]`),
    ).toBeVisible();
  }
}

/** Seeds fixture metadata and returns synthetic layers with multi-element values. */
async function seedSyntheticLayerStack(page: Page): Promise<void> {
  await page.evaluate(
    ({ attributes, fixtureCount, layerCount }) => {
      const stores = (window as any).appStores;
      const parameter = (attribute: string) => ({
        resolution: "Coarse",
        attribute: { type: attribute },
        min: 0,
        max: 255,
        offset: { type: "Absolute", data: { value: 0 } },
        is_inverted: false,
        is_snap: false,
        merge_type: "HTP",
        use_grandmaster: true,
      });
      const fixtures = Object.fromEntries(
        Array.from({ length: fixtureCount }, (_, fixtureIndex) => {
          const uid = `fixture-${fixtureIndex}`;
          return [
            uid,
            {
              identifiers: {
                id: fixtureIndex + 1,
                uid,
                label: `Fixture ${fixtureIndex + 1}`,
              },
              make: "Probe",
              model: "Pixel Bar",
              mode: "RGB",
              elements: Array.from({ length: 3 }, (_, elementIndex) => ({
                label: `Cell ${elementIndex + 1}`,
                parameters: attributes.map(parameter),
              })),
            },
          ];
        }),
      );
      const makeParameters = (seed: number) =>
        Array.from({ length: 3 }, (_, elementIndex) =>
          Object.fromEntries(
            attributes.map((attribute: string, attributeIndex: number) => [
              attribute,
              (seed + elementIndex + attributeIndex) % 255,
            ]),
          ),
        );
      const makeLayer = (layerIndex: number, pulse: number) => ({
        creator: `Probe Layer ${layerIndex}`,
        priority: layerIndex,
        object_ref: null,
        is_releasing: false,
        runtime_position: null,
        asserted_absolute_values: Array.from(
          { length: fixtureCount },
          (_, fixtureIndex) => ({
            fixture_uid: `fixture-${fixtureIndex}`,
            parameters: makeParameters(layerIndex + fixtureIndex + pulse).map(
              (params) =>
                Object.fromEntries(
                  Object.entries(params).map(([attribute, value]) => [
                    attribute,
                    { type: "Absolute", data: { value } },
                  ]),
                ),
            ),
          }),
        ),
        asserted_relative_values: [],
        lookahead_asserted_values: [],
        computed_values: Array.from(
          { length: fixtureCount },
          (_, fixtureIndex) => ({
            fixture_uid: `fixture-${fixtureIndex}`,
            parameters: makeParameters(layerIndex + fixtureIndex + pulse),
          }),
        ),
        computed_transitioning: [],
      });
      (window as any).__layerStackProbeSnapshot = (pulse: number) =>
        Array.from({ length: layerCount }, (_, index) =>
          makeLayer(index, pulse),
        );
      stores.attributeMetadata.set(
        attributes.map((attribute: string, index: number) => ({
          key: attribute,
          attribute: { type: attribute },
          label: attribute,
          category: index < 4 ? "Color" : "Beam",
          sort_order: index,
        })),
      );
      stores.fixtures.set(fixtures);
      stores.layerStack.set((window as any).__layerStackProbeSnapshot(0));
    },
    {
      attributes: [...ATTRIBUTES],
      fixtureCount: FIXTURE_COUNT,
      layerCount: LAYER_COUNT,
    },
  );
}

/** Runs one synchronous layer-stack store update benchmark in the current layout. */
async function runLayerStackProbe(page: Page): Promise<ProbeResult> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const makeSnapshot = (window as any).__layerStackProbeSnapshot as (
      pulse: number,
    ) => unknown[];
    const setDurations: number[] = [];
    const rafDurations: number[] = [];

    stores.layerStack.set(makeSnapshot(0));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    for (let index = 0; index < 20; index += 1) {
      const nextSnapshot = makeSnapshot(index + 1);
      const startedAt = performance.now();
      stores.layerStack.set(nextSnapshot);
      setDurations.push(performance.now() - startedAt);

      const rafStartedAt = performance.now();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      rafDurations.push(performance.now() - rafStartedAt);
    }

    const sortedSetDurations = [...setDurations].sort(
      (left, right) => left - right,
    );
    const avg = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      avgSetMs: avg(setDurations),
      maxSetMs: Math.max(...setDurations),
      p95SetMs: sortedSetDurations[Math.ceil(setDurations.length * 0.95) - 1],
      avgRafMs: avg(rafDurations),
      maxRafMs: Math.max(...rafDurations),
      layerCount: stores.layerStack.get().length,
    };
  });
}

/** Clears collected User Timing metrics before the measured scenarios run. */
async function clearPerformanceMetrics(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const metrics = await import("/lib/performance-measure-collector.ts");
    metrics.clearPerformanceMeasures();
  });
}

/** Reads layer-stack, layer-panel, and layer-view timing metrics collected by the probe. */
async function readProbeMetrics(page: Page): Promise<ProbeMetrics> {
  await page.waitForTimeout(1_200);
  return page.evaluate(() => {
    const stats = (window as any).appStores.performanceMeasureStats.get();
    return Object.fromEntries(
      Object.entries(stats).filter(
        ([name]) =>
          name.includes("layer-stack.") ||
          name.includes("layer-panel.") ||
          name.includes("layer-view."),
      ),
    );
  });
}

/** Expands the first layer so value-map and visible-cell work are included. */
async function expandFirstLayer(page: Page): Promise<void> {
  const panel = page.locator(
    `[data-panel-kind="layer"][data-panel-id="${PANEL_ID}"]`,
  );
  await panel.locator("details").first().locator("summary").click();
  await expect(panel.getByRole("grid").first()).toBeVisible();
}

/** Verifies mounting the Layers panel does not add large per-update store cost. */
test("Layers panel avoids blocking layer-stack updates while mounted", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
  });
  await page.goto("/?e2e=1");
  await waitForAppReady(page);
  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });
  await seedSyntheticLayerStack(page);
  await clearPerformanceMetrics(page);

  await setLayersPanelOpen(page, false);
  const closed = await runLayerStackProbe(page);
  await setLayersPanelOpen(page, true);
  const mounted = await runLayerStackProbe(page);
  await expandFirstLayer(page);
  const expanded = await runLayerStackProbe(page);
  const metrics = await readProbeMetrics(page);

  console.info(JSON.stringify({ closed, mounted, expanded, metrics }, null, 2));

  expect(closed.layerCount).toBe(LAYER_COUNT);
  expect(mounted.layerCount).toBe(LAYER_COUNT);
  expect(expanded.layerCount).toBe(LAYER_COUNT);
  expect(closed.p95SetMs).toBeLessThanOrEqual(5);
  expect(mounted.p95SetMs).toBeLessThanOrEqual(5);
  expect(expanded.p95SetMs).toBeLessThanOrEqual(15);
  expect(
    (
      metrics["nightfall:layer-stack.listener-fanout"] as
        | ProbeMetricStats
        | undefined
    )?.p95Ms,
  ).toBeLessThanOrEqual(15);
});
