// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";

import {
  installPerformanceModule,
  PERFORMANCE_CLIP_IDS,
  PERFORMANCE_MODULE_UID,
  PERFORMANCE_TIMECODE_ID,
  PERFORMANCE_TIMECODE_UID,
  PERFORMANCE_TIMELINE_UID,
  seedPerformanceTimeline,
} from "./performance-fixture";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 1920, height: 1080 } });

type ConsumerMode = "hidden" | "layers" | "fixtures" | "all";

type Sample = {
  positionMs: number;
  rafMs: number;
  layers: number;
};
type Probe = {
  samples: Sample[];
  engineSamples: Array<{ positionMs: number; engineMs: number }>;
  deliverySamples: Array<{
    positionMs: number;
    deliveryMs: number;
    queueDepth: number;
  }>;
  moduleTargetCount: number;
  moduleSamples: Array<{ positionMs: number; values: number[] }>;
  activeIds: number[];
  measuring: boolean;
  lastFrame: number;
  timecodeUid: string;
};
declare global {
  interface Window {
    __ownedPerformance?: Probe;
  }
}

/** Mounts real consumers and chooses hidden, Layers-visible, or Fixtures-visible presentation. */
async function mountConsumers(
  page: Page,
  visible: ConsumerMode,
): Promise<void> {
  await page.evaluate(
    ({ visible, timelineUid }) => {
      const api = (window as any).appStores.dockApi.get();
      for (const panel of [...api.panels]) {
        if (panel.id !== "panel-Visualizer") panel.api.close();
      }
      const reference = api.getPanel("panel-Visualizer");
      if (!reference)
        throw new Error(
          "Expected the main visualizer group for performance consumers",
        );
      api.addPanel({
        id: "owned-layers",
        component: "LayerStack",
        title: "Performance Layers",
        inactive: true,
        position: { referencePanel: reference.id, direction: "within" },
      });
      api.addPanel({
        id: "owned-fixtures",
        component: "FixtureGrid",
        title: "Performance Fixtures",
        inactive: true,
        position: {
          referencePanel: visible === "all" ? "owned-layers" : reference.id,
          direction: visible === "all" ? "right" : "within",
        },
      });
      api.addPanel({
        id: "owned-timeline",
        component: "Timeline",
        title: "Performance Timeline",
        inactive: true,
        params: { initialTimelineUid: timelineUid },
        position: {
          referencePanel: reference.id,
          direction: visible === "all" ? "below" : "within",
        },
      });
      reference.api.setActive();
      if (visible === "layers" || visible === "all")
        api.getPanel("owned-layers").api.setActive();
      if (visible === "fixtures" || visible === "all")
        api.getPanel("owned-fixtures").api.setActive();
      if (visible === "all") api.getPanel("owned-timeline").api.setActive();
    },
    { visible, timelineUid: PERFORMANCE_TIMELINE_UID },
  );
  if (visible === "layers" || visible === "all")
    await expect(
      page.locator('[data-panel-kind="layer"]:visible'),
    ).toBeVisible();
  if (visible === "fixtures" || visible === "all")
    await expect(
      page.locator('[data-panel-kind="fixtures"]:visible'),
    ).toBeVisible();
}

/** Samples browser cadence, backend frame cost, delivery lag, and actual activated clips. */
async function installProbe(
  page: Page,
  moduleSelection: Array<{ fixture_uid: string; index: number }>,
): Promise<void> {
  await page.evaluate(
    ({ timecodeUid, moduleUid, moduleSelection }) => {
      const stores = (window as any).appStores;
      const probe: Probe = {
        samples: [],
        engineSamples: [],
        deliverySamples: [],
        moduleTargetCount: moduleSelection.length,
        moduleSamples: [],
        activeIds: [],
        measuring: false,
        lastFrame: performance.now(),
        timecodeUid,
      };
      window.__ownedPerformance = probe;
      /** Reads the websocket clock position associated with each arriving measurement. */
      const positionMs = () => {
        const position =
          stores.timecodes.get()[probe.timecodeUid]?.[1]?.current_time;
        return (
          Number(position?.secs ?? 0) * 1000 +
          Number(position?.nanos ?? 0) / 1_000_000
        );
      };
      /** Captures fresh engine publications instead of repeating the last value on RAF. */
      stores.engineMetrics.subscribe((metrics: any) => {
        if (
          probe.measuring &&
          Number.isFinite(metrics?.frame_time_ms) &&
          metrics.frame_time_ms > 0
        ) {
          probe.engineSamples.push({
            positionMs: positionMs(),
            engineMs: metrics.frame_time_ms,
          });
        }
      });
      /** Captures fresh transport statistics independently from browser rendering cadence. */
      stores.wsStats.subscribe((stats: any) => {
        if (
          probe.measuring &&
          Number.isFinite(stats?.main?.lastDeliveryLagMs)
        ) {
          probe.deliverySamples.push({
            positionMs: positionMs(),
            deliveryMs: stats.main.lastDeliveryLagMs,
            queueDepth: stats.worker?.queueDepth ?? 0,
          });
        }
      });
      /** Proves the WASM layer continuously publishes every requested intensity target. */
      stores.layerStack.subscribe((layers: any[]) => {
        if (!probe.measuring) return;
        const layer = layers.find(
          (entry) =>
            entry.object_ref?.data?.object_type === "FxModule" &&
            entry.object_ref.data.uid?.replaceAll("-", "") === moduleUid,
        );
        const values: number[] = [];
        for (const target of moduleSelection) {
          const fixture = layer?.asserted_absolute_values?.find(
            (entry: any) =>
              entry.fixture_uid.replaceAll("-", "") ===
              target.fixture_uid.replaceAll("-", ""),
          );
          const value = fixture?.parameters?.[target.index - 1]?.Intensity;
          if (
            value?.type === "Absolute" &&
            Number.isFinite(value.data?.value) &&
            value.data.value >= 0 &&
            value.data.value <= 255
          )
            values.push(value.data.value);
        }
        probe.moduleSamples.push({ positionMs: positionMs(), values });
      });
      /** Records one browser frame only during the owned playback measurement. */
      const frame = (now: number) => {
        if (probe.measuring) {
          probe.samples.push({
            positionMs: positionMs(),
            rafMs: now - probe.lastFrame,
            layers: stores.layerStack.get().length,
          });
          for (const playback of Object.values(
            stores.activeInstances.get(),
          ) as any[]) {
            if (!probe.activeIds.includes(playback.bound_clip_id))
              probe.activeIds.push(playback.bound_clip_id);
          }
        }
        probe.lastFrame = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    {
      timecodeUid: PERFORMANCE_TIMECODE_UID,
      moduleUid: PERFORMANCE_MODULE_UID,
      moduleSelection,
    },
  );
}

/** Stops the owned clock and releases all test layers even after failed assertions. */
async function stopPlayback(page: Page): Promise<void> {
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.evaluate(async (id) => {
    const stores = (window as any).appStores;
    if (!stores?.send) return;
    if (window.__ownedPerformance) window.__ownedPerformance.measuring = false;
    await stores.send({
      module: "TimecodeCommand",
      command: { type: "StopTimecode", data: id },
    });
    await stores.send({
      module: "InstanceCommand",
      command: { type: "StopAll" },
    });
  }, PERFORMANCE_TIMECODE_ID);
}

/** Ensures failure paths never leave timeline playback running. */
test.afterEach(async ({ page }) => {
  await stopPlayback(page);
});

/** Waits for loading and layout work to settle before the baseline window begins. */
async function waitForSettledBaseline(page: Page): Promise<void> {
  let stable = 0;
  await expect
    .poll(
      async () => {
        const ready = await page.evaluate(() => {
          const stores = (window as any).appStores;
          const metrics = stores.engineMetrics.get();
          const ws = stores.wsStats.get();
          return (
            Number.isFinite(metrics?.frame_time_ms) &&
            metrics.frame_time_ms > 0 &&
            metrics.frame_time_ms < 35 &&
            !ws?.main?.backlogLagging &&
            Number.isFinite(ws?.main?.lastDeliveryLagMs) &&
            ws.main.lastDeliveryLagMs < 40 &&
            (ws.worker?.queueDepth ?? 0) <= 3
          );
        });
        stable = ready ? stable + 1 : 0;
        return stable;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(4);
}

/** Starts at the exact pre-trigger position and returns a bounded populated observation. */
async function measureWindow(
  page: Page,
  triggerMs: number,
  screenshotPath: string,
  visible: ConsumerMode,
) {
  await stopPlayback(page);
  await page.evaluate(
    async ({ id, triggerMs }) => {
      const stores = (window as any).appStores;
      const positionMs = triggerMs - 1500;
      await stores.send({
        module: "TimecodeCommand",
        command: {
          type: "SeekTimecode",
          data: {
            id,
            position: {
              secs: Math.floor(positionMs / 1000),
              nanos: (positionMs % 1000) * 1_000_000,
            },
          },
        },
      });
    },
    { id: PERFORMANCE_TIMECODE_ID, triggerMs },
  );
  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const time = (window as any).appStores.timecodes.get()[uid]?.[1]
          ?.current_time;
        return time ? time.secs * 1000 + time.nanos / 1_000_000 : -1;
      }, PERFORMANCE_TIMECODE_UID),
    )
    .toBe(triggerMs - 1500);
  await page.evaluate(async (id) => {
    const probe = window.__ownedPerformance!;
    probe.samples = [];
    probe.engineSamples = [];
    probe.deliverySamples = [];
    probe.moduleSamples = [];
    probe.activeIds = [];
    probe.lastFrame = performance.now();
    probe.measuring = true;
    await (window as any).appStores.send({
      module: "TimecodeCommand",
      command: { type: "StartTimecode", data: id },
    });
  }, PERFORMANCE_TIMECODE_ID);
  await expect
    .poll(
      () => page.evaluate(() => window.__ownedPerformance?.activeIds ?? []),
      { timeout: 10_000 },
    )
    .toEqual(expect.arrayContaining([...PERFORMANCE_CLIP_IDS, 412]));
  const assertedParameters = await page.evaluate(() =>
    (window as any).appStores.layerStack
      .get()
      .reduce(
        (sum: number, layer: any) =>
          sum +
          [
            ...layer.asserted_absolute_values,
            ...layer.asserted_relative_values,
          ].reduce(
            (count: number, fixture: any) =>
              count +
              fixture.parameters.reduce(
                (total: number, values: object) =>
                  total + Object.keys(values).length,
                0,
              ),
            0,
          ),
        0,
      ),
  );
  expect(assertedParameters).toBeGreaterThanOrEqual(20_000);
  if (visible === "all") {
    const layers = page.locator(
      '[data-panel-kind="layer"][data-panel-id="owned-layers"]',
    );
    const expand = layers.getByRole("button", { name: "Expand all layers" });
    await expect(expand).toBeEnabled();
    await expand.click();
    await expect(layers.getByRole("gridcell").first()).toBeVisible();
  }
  if (visible === "all") {
    const window = [16500, 29500, 169210].indexOf(triggerMs);
    await expect(
      page.locator(
        `[data-timeline-action="true"][data-action-id="load-0-${window}"]`,
      ),
    ).toBeVisible();
  }
  const activeStartMs = triggerMs + (visible === "all" ? 2500 : 0);
  if (visible === "all") {
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__ownedPerformance?.samples.at(-1)?.positionMs ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(activeStartMs);
  }
  const started = Date.now();
  await page.getByRole("button", { name: "Open command palette" }).click();
  const search = page.getByPlaceholder("Type a command or search...");
  await expect(search).toBeVisible();
  await search.fill("Open Clips");
  await expect(
    page.getByText("Open Clips", { exact: true }).last(),
  ).toBeVisible();
  const inputLatencyMs = Date.now() - started;
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__ownedPerformance?.samples.at(-1)?.positionMs ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(activeStartMs + 3000);
  const {
    samples,
    engineSamples,
    deliverySamples,
    moduleSamples,
    moduleTargetCount,
  } = await page.evaluate(() => window.__ownedPerformance!);
  await writeFile(
    screenshotPath.replace(/\.png$/, "-probe.json"),
    JSON.stringify(
      {
        samples,
        engineSamples,
        deliverySamples,
        moduleSamples,
        moduleTargetCount,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await stopPlayback(page);
  const active = samples.filter(
    (sample) =>
      sample.positionMs >= activeStartMs &&
      sample.positionMs <= activeStartMs + 3000,
  );
  expect(
    samples.filter((sample) => sample.positionMs < triggerMs).length,
  ).toBeGreaterThan(10);
  expect(active.length).toBeGreaterThan(30);
  const activeEngine = engineSamples.filter(
    (sample) =>
      sample.positionMs >= activeStartMs &&
      sample.positionMs <= activeStartMs + 3000,
  );
  const activeDelivery = deliverySamples.filter(
    (sample) =>
      sample.positionMs >= activeStartMs &&
      sample.positionMs <= activeStartMs + 3000,
  );
  expect(
    engineSamples.filter((sample) => sample.positionMs < triggerMs).length,
  ).toBeGreaterThan(0);
  expect(
    deliverySamples.filter((sample) => sample.positionMs < triggerMs).length,
  ).toBeGreaterThan(0);
  expect(activeEngine.length).toBeGreaterThan(0);
  expect(activeDelivery.length).toBeGreaterThan(0);
  /** Computes a nearest-rank percentile without allowing empty measurements to pass. */
  const percentile = (values: number[], fraction: number) =>
    values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const activeModule = moduleSamples.filter(
    (sample) =>
      sample.positionMs >= Math.max(triggerMs + 500, activeStartMs) &&
      sample.positionMs <= activeStartMs + 3000,
  );
  const result = {
    moduleSamples: activeModule,
    moduleTargetCount,
    activeStartMs,
    transitionRafSamples: samples.filter(
      (sample) =>
        sample.positionMs >= triggerMs && sample.positionMs < activeStartMs,
    ),
    samples: active,
    engineSamples: activeEngine,
    deliverySamples: activeDelivery,
    triggerMs,
    sampleCount: active.length,
    assertedParameters,
    inputLatencyMs,
    engineP95Ms: percentile(
      activeEngine.map((sample) => sample.engineMs),
      0.95,
    ),
    engineMaxMs: Math.max(...activeEngine.map((sample) => sample.engineMs)),
    rafP95Ms: percentile(
      active.map((sample) => sample.rafMs),
      0.95,
    ),
    rafMaxMs: Math.max(...active.map((sample) => sample.rafMs)),
    deliveryP95Ms: percentile(
      activeDelivery.map((sample) => sample.deliveryMs),
      0.95,
    ),
    deliveryMaxMs: Math.max(
      ...activeDelivery.map((sample) => sample.deliveryMs),
    ),
    maxLayers: Math.max(...active.map((sample) => sample.layers)),
  };
  await writeFile(
    screenshotPath.replace(/\.png$/, ".json"),
    JSON.stringify(
      {
        baselineEngine: engineSamples.filter(
          (sample) => sample.positionMs < triggerMs,
        ),
        baselineDelivery: deliverySamples.filter(
          (sample) => sample.positionMs < triggerMs,
        ),
        ...result,
      },
      null,
      2,
    ),
  );
  expect(result.moduleSamples.length).toBeGreaterThan(1);
  expect(
    result.moduleSamples.every(
      (sample) => sample.values.length === result.moduleTargetCount,
    ),
  ).toBe(true);
  const firstValues = result.moduleSamples.map((sample) => sample.values[0]);
  expect(Math.max(...firstValues) - Math.min(...firstValues)).toBeGreaterThan(
    1,
  );
  expect(Number.isFinite(result.engineMaxMs)).toBe(true);
  expect(result.engineMaxMs).toBeGreaterThan(0);
  expect(Number.isFinite(result.rafMaxMs)).toBe(true);
  expect(result.rafP95Ms).toBeGreaterThan(0);
  expect(result.engineP95Ms).toBeLessThan(60);
  expect(result.engineMaxMs).toBeLessThan(100);
  expect(result.rafP95Ms).toBeLessThan(visible === "all" ? 75 : 50);
  expect(result.rafMaxMs).toBeLessThan(150);
  expect(result.deliveryP95Ms).toBeLessThan(100);
  expect(result.deliveryMaxMs).toBeLessThan(150);
  expect(result.inputLatencyMs).toBeLessThan(visible === "all" ? 750 : 500);
  expect(result.maxLayers).toBeGreaterThanOrEqual(13);
  return result;
}

for (const scenario of [
  {
    name: "clip 412 at 169.210s with hidden consumers",
    triggerMs: 169210,
    visible: "hidden",
  },
  {
    name: "clip 412 at 169.210s with Layers visible",
    triggerMs: 169210,
    visible: "layers",
  },
  {
    name: "clip 412 at 169.210s with Fixtures visible",
    triggerMs: 169210,
    visible: "fixtures",
  },
  {
    name: "timeline 3 beat 59 layer-stack fanout",
    triggerMs: 29500,
    visible: "all",
  },
  { name: "timeline 4 beat 33 playback lag", triggerMs: 16500, visible: "all" },
] as const) {
  /** Exercises a historical trigger window using only repository-owned data and effects. */
  test(scenario.name, async ({ page, backendSlot }, testInfo) => {
    test.setTimeout(180_000);
    await installPerformanceModule(backendSlot.dataDir);
    await page.goto("/?startup:draftRecovery=false&e2e=owned-performance");
    await waitForDockviewApp(page);
    const workload = await seedPerformanceTimeline(page);
    await mountConsumers(page, scenario.visible);
    const input = page.locator("#header-cmdline");
    await input.fill("fps 44");
    await input.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).appStores.engineMetrics.get()?.fps),
      )
      .toBeGreaterThan(40);
    await waitForSettledBaseline(page);
    await installProbe(page, workload.moduleSelection);
    try {
      const result = await measureWindow(
        page,
        scenario.triggerMs,
        testInfo.outputPath("performance-surface.png"),
        scenario.visible,
      );
      const samplePath = testInfo.outputPath("performance-samples.json");
      await writeFile(
        samplePath,
        JSON.stringify({ workload, ...result }, null, 2),
      );
      await testInfo.attach("performance-samples.json", {
        path: samplePath,
        contentType: "application/json",
      });
    } finally {
      await stopPlayback(page);
    }
  });
}
