// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import {
  seedStartupShowfileName,
  waitForDockviewApp,
} from "./showfile-startup";

type ReproSurface = {
  fixturePanelId: string;
  layerPanelId: string;
  timelinePanelId: string;
};

const SAMPLE_DATA_SHOWFILE = "sample";
const REPRO_TIMELINE_ID = 1;
const REPRO_CLIP_IDS = [26, 27, 28] as const;
const REPRO_CLIP_BUTTON_NAMES = [
  /26: Rainbow Cycle/,
  /27: Circle Motion/,
  /28: White Bounce/,
] as const;
const MAX_ACCEPTABLE_DELIVERY_LAG_MS = 22;
const MIN_ACCEPTABLE_FRAME_FPS = 45;

type PerfObservation = {
  fixtureMetrics: Record<string, unknown>;
  layerMetrics: Record<string, unknown>;
  layerStackListenerMetrics: Record<string, unknown>;
  panelMetrics: Record<string, unknown>;
  websocketMetrics: Record<string, unknown>;
  websocketStats: unknown;
  frameStats: unknown;
  statusBarText: string;
  visibleLaggingTextCount: number;
  visibleDegradedTextCount: number;
  engineFps: number | undefined;
  timelineCount: number;
  fixtureCount: number;
  layerCount: number;
  visibleGridCount: number;
  visibleGridCellCount: number;
};

type WebsocketLagSample = {
  timestamp: number;
  backlogLagging: boolean;
  lastDeliveryLagMs: number | undefined;
  avgDeliveryLagMs: number | undefined;
  maxDeliveryLagMs: number | undefined;
  queueDepth: number | undefined;
  frameFps: number | undefined;
  avgFrameTimeMs: number | undefined;
  visibleLaggingTextCount: number;
  visibleDegradedTextCount: number;
  backendFps: number | undefined;
  backendFrameTimeMs: number | undefined;
  framepaceTimeMs: number | undefined;
  framepaceOversleepMs: number | undefined;
  parameterStateBuildMs: number | undefined;
  parameterStateBroadcastMs: number | undefined;
  layerStackBuildMs: number | undefined;
  layerStackTransitionBuildMs: number | undefined;
  layerStackBroadcastMs: number | undefined;
  timelineLayerGenerationMs: number | undefined;
  timelineUpdateMs: number | undefined;
  timelineAudioMs: number | undefined;
  timelineLookaheadSourcesMs: number | undefined;
  timelineLookaheadAssertionsMs: number | undefined;
  timelineLookaheadLayersMs: number | undefined;
  timelineActionsMs: number | undefined;
  timelineParametersMs: number | undefined;
  timelineSeekMs: number | undefined;
};

type ReproScenarioResult = {
  observation: PerfObservation;
  lagSamples: {
    count: number;
    laggingCount: number;
    minFrameFps: number | undefined;
    avgFrameFps: number | undefined;
    maxAvgDeliveryLagMs: number | undefined;
    maxLastDeliveryLagMs: number | undefined;
    minBackendFps: number | undefined;
    avgBackendFps: number | undefined;
    maxBackendFrameTimeMs: number | undefined;
    maxFramepaceTimeMs: number | undefined;
    maxFramepaceOversleepMs: number | undefined;
    maxParameterStateBuildMs: number | undefined;
    maxParameterStateBroadcastMs: number | undefined;
    maxLayerStackBuildMs: number | undefined;
    maxLayerStackTransitionBuildMs: number | undefined;
    maxLayerStackBroadcastMs: number | undefined;
    maxTimelineLayerGenerationMs: number | undefined;
    maxTimelineUpdateMs: number | undefined;
    maxTimelineAudioMs: number | undefined;
    maxTimelineLookaheadSourcesMs: number | undefined;
    maxTimelineLookaheadAssertionsMs: number | undefined;
    maxTimelineLookaheadLayersMs: number | undefined;
    maxTimelineActionsMs: number | undefined;
    maxTimelineParametersMs: number | undefined;
    maxTimelineSeekMs: number | undefined;
    last: WebsocketLagSample | undefined;
    laggingSamples: WebsocketLagSample[];
    lowFpsSamples: WebsocketLagSample[];
    lowBackendFpsSamples: WebsocketLagSample[];
  };
  relevantWarnings: string[];
};

/** Extracts one named metric from an observation bucket. */
function metric(
  observation: PerfObservation,
  bucket: keyof Pick<
    PerfObservation,
    "fixtureMetrics" | "layerMetrics" | "panelMetrics" | "websocketMetrics"
  >,
  suffix: string,
): unknown {
  return Object.entries(observation[bucket]).find(([name]) =>
    name.endsWith(suffix),
  )?.[1];
}

/** Returns whether a metric name is useful for render-invalidation triage. */
function isRenderInvalidationMetric(name: string): boolean {
  return [
    ".cell-provider-changes",
    ".probe.cellProvider.changes",
    ".probe.fixtureValues.changes",
    ".cell-resolves",
    ".visible-cells",
    ".dom-mutation-records",
    ".dom-added-nodes",
    ".dom-removed-nodes",
    ".dom-attribute-changes",
    ".dom-character-data-changes",
  ].some((fragment) => name.includes(fragment));
}

/** Selects metrics whose names include one of the requested fragments. */
function metricsContaining(
  metrics: Record<string, unknown>,
  fragments: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metrics).filter(
      ([name]) =>
        fragments.some((fragment) => name.includes(fragment)) &&
        isRenderInvalidationMetric(name),
    ),
  );
}

/** Produces a compact scenario summary for console inspection. */
function summarizeScenario(result: ReproScenarioResult) {
  const websocketStats = result.observation.websocketStats as any;
  const frameStats = result.observation.frameStats as any;
  return {
    samples: result.lagSamples.count,
    laggingSampleCount: result.lagSamples.laggingCount,
    minFrameFps: result.lagSamples.minFrameFps,
    avgFrameFps: result.lagSamples.avgFrameFps,
    finalFrameFps: frameStats?.fps,
    maxAvgDeliveryLagMs: result.lagSamples.maxAvgDeliveryLagMs,
    maxLastDeliveryLagMs: result.lagSamples.maxLastDeliveryLagMs,
    minBackendFps: result.lagSamples.minBackendFps,
    avgBackendFps: result.lagSamples.avgBackendFps,
    maxBackendFrameTimeMs: result.lagSamples.maxBackendFrameTimeMs,
    maxFramepaceTimeMs: result.lagSamples.maxFramepaceTimeMs,
    maxFramepaceOversleepMs: result.lagSamples.maxFramepaceOversleepMs,
    maxParameterStateBuildMs: result.lagSamples.maxParameterStateBuildMs,
    maxParameterStateBroadcastMs:
      result.lagSamples.maxParameterStateBroadcastMs,
    maxLayerStackBuildMs: result.lagSamples.maxLayerStackBuildMs,
    maxLayerStackTransitionBuildMs:
      result.lagSamples.maxLayerStackTransitionBuildMs,
    maxLayerStackBroadcastMs: result.lagSamples.maxLayerStackBroadcastMs,
    maxTimelineLayerGenerationMs:
      result.lagSamples.maxTimelineLayerGenerationMs,
    maxTimelineUpdateMs: result.lagSamples.maxTimelineUpdateMs,
    maxTimelineAudioMs: result.lagSamples.maxTimelineAudioMs,
    maxTimelineLookaheadSourcesMs:
      result.lagSamples.maxTimelineLookaheadSourcesMs,
    maxTimelineLookaheadAssertionsMs:
      result.lagSamples.maxTimelineLookaheadAssertionsMs,
    maxTimelineLookaheadLayersMs:
      result.lagSamples.maxTimelineLookaheadLayersMs,
    maxTimelineActionsMs: result.lagSamples.maxTimelineActionsMs,
    maxTimelineParametersMs: result.lagSamples.maxTimelineParametersMs,
    maxTimelineSeekMs: result.lagSamples.maxTimelineSeekMs,
    finalAvgDeliveryLagMs: websocketStats?.main?.avgDeliveryLagMs,
    finalLastDeliveryLagMs: websocketStats?.main?.lastDeliveryLagMs,
    backlogLagging: websocketStats?.main?.backlogLagging,
    queueDepth: websocketStats?.worker?.queueDepth,
    statusBarText: result.observation.statusBarText,
    visibleLaggingTextCount: result.observation.visibleLaggingTextCount,
    visibleDegradedTextCount: result.observation.visibleDegradedTextCount,
    parameterStateRate: websocketStats?.byType?.ParameterState?.ratePerSec,
    layerStackRate: websocketStats?.byType?.LayerStack?.ratePerSec,
    timecodeRate: websocketStats?.byType?.TimecodeDefinitions?.ratePerSec,
    activeInstancesRate: websocketStats?.byType?.ActiveInstances?.ratePerSec,
    fixtureUpdateToFrame: metric(
      result.observation,
      "fixtureMetrics",
      ".update-to-frame",
    ),
    layerUpdateToFrame: metric(
      result.observation,
      "layerMetrics",
      ".update-to-frame",
    ),
    layerStackStoreSet: metric(
      result.observation,
      "websocketMetrics",
      ".layer-stack.store-set",
    ),
    layerStackListeners: result.observation.layerStackListenerMetrics,
    layerGridMetrics: metricsContaining(result.observation.layerMetrics, [
      "data-grid.layers.",
    ]),
    fixtureGridMetrics: metricsContaining(result.observation.fixtureMetrics, [
      "data-grid.fixtures.",
    ]),
    panelMetrics: result.observation.panelMetrics,
    workerToMain: metric(
      result.observation,
      "websocketMetrics",
      ".worker-to-main",
    ),
    relevantWarningCount: result.relevantWarnings.length,
    laggingSamplesCount: result.lagSamples.laggingSamples.length,
    lowFpsSamplesCount: result.lagSamples.lowFpsSamples.length,
    lowBackendFpsSamples: result.lagSamples.lowBackendFpsSamples,
  };
}

/** Submits a command through the same header command-line path used by operators. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/** Sets the engine frame target to the repro rate and waits for metrics to update. */
async function setReproFps(page: Page): Promise<number> {
  await submitCommand(page, "fps 44");
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).appStores.engineMetrics.get()?.fps ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  return page.evaluate(
    () => (window as any).appStores.engineMetrics.get()?.fps,
  );
}

/** Waits until the requested sample clips are present before starting the workload. */
async function waitForSampleClips(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (clipIds) => {
            const stores = (window as any).appStores;
            const entries = Object.values(stores.clips?.get?.() ?? {}) as Array<
              [{ identifiers: { id: number } }, boolean]
            >;
            return clipIds.filter((id) =>
              entries.some(([clip]) => clip.identifiers.id === id),
            );
          },
          [...REPRO_CLIP_IDS],
        ),
      { timeout: 45_000 },
    )
    .toEqual([...REPRO_CLIP_IDS]);
}

/** Waits for the initial showfile websocket burst to settle before starting the workload. */
async function waitForWebsocketBacklogSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = (window as any).appStores.wsStats.get();
          return {
            backlogLagging: stats?.main?.backlogLagging ?? false,
            queueDepth: stats?.worker?.queueDepth ?? 0,
          };
        }),
      { timeout: 30_000 },
    )
    .toEqual({ backlogLagging: false, queueDepth: 0 });
}

/** Opens the grid-heavy panel surface used to observe layer workload churn. */
async function openPerfReproSurface(page: Page): Promise<ReproSurface> {
  const surface = await page.evaluate((timelineId) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const timeline = (Object.values(stores.timelines.get()) as any[]).find(
      (entry) => entry?.identifiers?.id === timelineId,
    );
    if (!timeline?.identifiers?.uid) {
      throw new Error(`Timeline ${timelineId} was not loaded`);
    }

    const fixturePanelId = "e2e-perf-repro-fixtures";
    const layerPanelId = "e2e-perf-repro-layers";
    const timelinePanelId = `e2e-perf-repro-timeline-${timeline.identifiers.uid}`;
    for (const panelId of [fixturePanelId, layerPanelId, timelinePanelId]) {
      api.getPanel(panelId)?.api.close();
    }

    api.addPanel({
      id: fixturePanelId,
      component: "FixtureGrid",
      title: "Fixtures",
      params: { initialPanelId: fixturePanelId },
    });
    api.addPanel({
      id: layerPanelId,
      component: "LayerStack",
      title: "Layers",
      params: {},
      position: { referencePanel: fixturePanelId, direction: "right" },
    });
    api.addPanel({
      id: timelinePanelId,
      component: "Timeline",
      title: `Timeline ${timeline.identifiers.id}`,
      params: {
        initialPanelId: timelinePanelId,
        initialTimelineUid: timeline.identifiers.uid,
      },
      position: { referencePanel: fixturePanelId, direction: "below" },
    });

    return { fixturePanelId, layerPanelId, timelinePanelId };
  }, REPRO_TIMELINE_ID);

  await expect(page.locator("main#app")).toBeVisible();
  await expect(
    page.locator(
      `[data-panel-kind="fixtures"][data-panel-id="${surface.fixturePanelId}"]`,
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      `[data-panel-kind="layer"][data-panel-id="${surface.layerPanelId}"]`,
    ),
  ).toBeVisible();
  return surface;
}

/** Clears collected performance samples after the repro surface has settled. */
async function clearPerformanceMetrics(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const module = await import("/lib/performance-measure-collector.ts");
    module.clearPerformanceMeasures();
  });
}

/** Waits until the loaded layout has stopped adding or removing visible grid cells. */
async function waitForStableVisibleGridCells(page: Page): Promise<number> {
  let previousCount = -1;
  let stableSamples = 0;

  await expect
    .poll(async () => {
      const count = await page.evaluate(
        () => document.querySelectorAll('[role="gridcell"]').length,
      );
      if (count === previousCount && count > 0) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
        previousCount = count;
      }
      return stableSamples >= 3 ? count : 0;
    })
    .toBeGreaterThan(0);

  return previousCount;
}

/** Starts the sample clip set through the operator-facing clip cards. */
async function startClipComparisonWorkload(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Open Clips");
  await page.keyboard.press("Enter");

  const clipsTab = page.locator(".dv-tab").filter({ hasText: "Clips" }).first();
  await expect(clipsTab).toBeVisible();
  await clipsTab.click();

  const clipPanel = page.locator('[data-panel-kind="clips"]:visible');
  await expect(clipPanel).toBeVisible();
  for (const [index, buttonName] of REPRO_CLIP_BUTTON_NAMES.entries()) {
    const clipId = REPRO_CLIP_IDS[index];
    const button = clipPanel.getByRole("button", { name: buttonName });
    await expect(button).toBeVisible();
    const initiallyActive = await page.evaluate((id) => {
      const entries = Object.values(
        (window as any).appStores.clips.get(),
      ) as Array<[{ identifiers: { id: number } }, boolean]>;
      return entries.find(([clip]) => clip.identifiers.id === id)?.[1];
    }, clipId);
    if (!initiallyActive) {
      await button.click();
    }
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const entries = Object.values(
            (window as any).appStores.clips.get(),
          ) as Array<[{ identifiers: { id: number } }, boolean]>;
          return entries.find(([clip]) => clip.identifiers.id === id)?.[1];
        }, clipId),
      )
      .toBe(true);
  }
}

/** Waits until the requested sample clips are reflected as active in browser stores. */
async function waitForActiveClips(page: Page): Promise<number[]> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (clipIds) => {
            const stores = (window as any).appStores;
            const clipEntries = Object.values(stores.clips.get()) as Array<
              [{ identifiers: { id: number } }, boolean]
            >;
            const activeInstances = Object.values(
              stores.activeInstances?.get?.() ?? {},
            ) as Array<{ bound_clip_id?: number | null }>;
            return clipIds.filter(
              (id) =>
                clipEntries.some(
                  ([clip, isActive]) => clip.identifiers.id === id && isActive,
                ) ||
                activeInstances.some(
                  (playback) => playback.bound_clip_id === id,
                ),
            );
          },
          [...REPRO_CLIP_IDS],
        ),
      { timeout: 15_000 },
    )
    .toEqual([...REPRO_CLIP_IDS]);

  return [...REPRO_CLIP_IDS];
}

/** Asserts that the observed clip workload stays within interactive UI bounds. */
function expectPerformanceAcceptable(result: ReproScenarioResult): void {
  expect(result.lagSamples.laggingCount).toBe(0);
  expect(result.lagSamples.lowFpsSamples).toHaveLength(0);
  expect(result.lagSamples.maxAvgDeliveryLagMs ?? 0).toBeLessThanOrEqual(
    MAX_ACCEPTABLE_DELIVERY_LAG_MS,
  );
  expect(result.lagSamples.maxLastDeliveryLagMs ?? 0).toBeLessThanOrEqual(
    MAX_ACCEPTABLE_DELIVERY_LAG_MS,
  );
  expect(
    result.lagSamples.minFrameFps ?? MIN_ACCEPTABLE_FRAME_FPS,
  ).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_FRAME_FPS);
  expect(result.observation.visibleLaggingTextCount).toBe(0);
  expect(result.observation.visibleDegradedTextCount).toBe(0);
}

/** Reads the current performance metrics most relevant to grid churn and delivery lag. */
async function readPerfObservation(page: Page): Promise<PerfObservation> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const stats = stores.performanceMeasureStats.get();
    const entries = Object.entries(stats) as [string, unknown][];
    const matching = (fragment: string) =>
      Object.fromEntries(entries.filter(([name]) => name.includes(fragment)));

    return {
      fixtureMetrics: matching("data-grid.fixtures"),
      layerMetrics: matching("data-grid.layers"),
      layerStackListenerMetrics: matching("layer-stack.listener"),
      panelMetrics: {
        ...matching("layer-view."),
        ...matching("layer-panel."),
        ...matching("fixtures-panel."),
      },
      websocketMetrics: matching("websocket"),
      websocketStats: stores.wsStats.get(),
      frameStats: stores.frameStats.get(),
      statusBarText: document.body.innerText
        .split("\n")
        .filter((line) => line.includes("UI ") || line.includes("Degraded"))
        .join(" | "),
      visibleLaggingTextCount: Array.from(
        document.querySelectorAll("*"),
      ).filter(
        (element) =>
          element instanceof HTMLElement &&
          element.offsetParent !== null &&
          element.textContent?.trim() === "Lagging",
      ).length,
      visibleDegradedTextCount: Array.from(
        document.querySelectorAll("*"),
      ).filter(
        (element) =>
          element instanceof HTMLElement &&
          element.offsetParent !== null &&
          element.textContent?.trim() === "Degraded",
      ).length,
      engineFps: stores.engineMetrics.get()?.fps,
      timelineCount: Object.keys(stores.timelines.get()).length,
      fixtureCount: Object.keys(stores.fixtures.get()).length,
      layerCount: stores.layerStack?.get?.()?.length ?? 0,
      visibleGridCount: document.querySelectorAll('[role="grid"]').length,
      visibleGridCellCount:
        document.querySelectorAll('[role="gridcell"]').length,
    };
  });
}

/** Captures websocket lag and frame state repeatedly during a workload window. */
async function sampleWebsocketLag(
  page: Page,
  durationMs: number,
  intervalMs: number,
): Promise<WebsocketLagSample[]> {
  const samples: WebsocketLagSample[] = [];
  const startedAt = Date.now();

  while (Date.now() - startedAt < durationMs) {
    samples.push(
      await page.evaluate(() => {
        const stats = (window as any).appStores.wsStats.get();
        const frameStats = (window as any).appStores.frameStats.get();
        const engineMetrics = (window as any).appStores.engineMetrics.get();
        const visibleTextCount = (text: string) =>
          Array.from(document.querySelectorAll("*")).filter(
            (element) =>
              element instanceof HTMLElement &&
              element.offsetParent !== null &&
              element.textContent?.trim() === text,
          ).length;

        return {
          timestamp: performance.now(),
          backlogLagging: stats?.main.backlogLagging ?? false,
          lastDeliveryLagMs: stats?.main.lastDeliveryLagMs,
          avgDeliveryLagMs: stats?.main.avgDeliveryLagMs,
          maxDeliveryLagMs: stats?.main.maxDeliveryLagMs,
          queueDepth: stats?.worker.queueDepth,
          frameFps: frameStats?.fps,
          avgFrameTimeMs: frameStats?.avgFrameTimeMs,
          visibleLaggingTextCount: visibleTextCount("Lagging"),
          visibleDegradedTextCount: visibleTextCount("Degraded"),
          backendFps: engineMetrics?.fps,
          backendFrameTimeMs: engineMetrics?.frame_time_ms,
          framepaceTimeMs: engineMetrics?.framepace_time_ms,
          framepaceOversleepMs: engineMetrics?.framepace_oversleep_ms,
          parameterStateBuildMs: engineMetrics?.parameter_state_build_ms,
          parameterStateBroadcastMs:
            engineMetrics?.parameter_state_broadcast_ms,
          layerStackBuildMs: engineMetrics?.layer_stack_build_ms,
          layerStackTransitionBuildMs:
            engineMetrics?.layer_stack_transition_build_ms,
          layerStackBroadcastMs: engineMetrics?.layer_stack_broadcast_ms,
          timelineLayerGenerationMs:
            engineMetrics?.timeline_layer_generation_ms,
          timelineUpdateMs: engineMetrics?.timeline_update_ms,
          timelineAudioMs: engineMetrics?.timeline_audio_ms,
          timelineLookaheadSourcesMs:
            engineMetrics?.timeline_lookahead_sources_ms,
          timelineLookaheadAssertionsMs:
            engineMetrics?.timeline_lookahead_assertions_ms,
          timelineLookaheadLayersMs:
            engineMetrics?.timeline_lookahead_layers_ms,
          timelineActionsMs: engineMetrics?.timeline_actions_ms,
          timelineParametersMs: engineMetrics?.timeline_parameters_ms,
          timelineSeekMs: engineMetrics?.timeline_seek_ms,
        };
      }),
    );
    await page.waitForTimeout(intervalMs);
  }

  return samples;
}

/** Runs one timed observation window and summarizes lag/FPS samples. */
async function observeScenario(
  page: Page,
  browserWarnings: string[],
  durationMs: number,
): Promise<ReproScenarioResult> {
  await page.waitForTimeout(500);
  await clearPerformanceMetrics(page);
  await page.waitForTimeout(2_000);
  browserWarnings.length = 0;
  const lagSamples = await sampleWebsocketLag(page, durationMs, 500);
  const observation = await readPerfObservation(page);
  const laggingSamples = lagSamples.filter(
    (sample) =>
      sample.backlogLagging ||
      sample.visibleLaggingTextCount > 0 ||
      sample.visibleDegradedTextCount > 0 ||
      (sample.avgDeliveryLagMs ?? 0) > MAX_ACCEPTABLE_DELIVERY_LAG_MS ||
      (sample.lastDeliveryLagMs ?? 0) > MAX_ACCEPTABLE_DELIVERY_LAG_MS,
  );
  const fpsSamples = lagSamples
    .map((sample) => sample.frameFps)
    .filter((fps): fps is number => typeof fps === "number" && fps > 0);
  const lowFpsSamples = lagSamples.filter(
    (sample) =>
      (sample.frameFps ?? Number.POSITIVE_INFINITY) < MIN_ACCEPTABLE_FRAME_FPS,
  );
  const backendFpsSamples = lagSamples
    .map((sample) => sample.backendFps)
    .filter((fps): fps is number => typeof fps === "number" && fps > 0);
  const numericSampleMax = (
    field: keyof Pick<
      WebsocketLagSample,
      | "backendFrameTimeMs"
      | "framepaceTimeMs"
      | "framepaceOversleepMs"
      | "parameterStateBuildMs"
      | "parameterStateBroadcastMs"
      | "layerStackBuildMs"
      | "layerStackTransitionBuildMs"
      | "layerStackBroadcastMs"
      | "timelineLayerGenerationMs"
      | "timelineUpdateMs"
      | "timelineAudioMs"
      | "timelineLookaheadSourcesMs"
      | "timelineLookaheadAssertionsMs"
      | "timelineLookaheadLayersMs"
      | "timelineActionsMs"
      | "timelineParametersMs"
      | "timelineSeekMs"
    >,
  ) => {
    const values = lagSamples
      .map((sample) => sample[field])
      .filter((value): value is number => typeof value === "number");
    return values.length > 0 ? Math.max(...values) : undefined;
  };
  const lowBackendFpsSamples = lagSamples.filter(
    (sample) => (sample.backendFps ?? Number.POSITIVE_INFINITY) < 40,
  );
  const relevantWarnings = browserWarnings.filter(
    (entry) =>
      entry.includes("long-animation-frame-monitor") ||
      entry.includes("WebSocket worker-to-main delivery lag"),
  );

  return {
    observation,
    lagSamples: {
      count: lagSamples.length,
      laggingCount: laggingSamples.length,
      minFrameFps: fpsSamples.length > 0 ? Math.min(...fpsSamples) : undefined,
      avgFrameFps:
        fpsSamples.length > 0
          ? fpsSamples.reduce((sum, fps) => sum + fps, 0) / fpsSamples.length
          : undefined,
      maxAvgDeliveryLagMs:
        lagSamples.length > 0
          ? Math.max(
              ...lagSamples.map((sample) => sample.avgDeliveryLagMs ?? 0),
            )
          : undefined,
      maxLastDeliveryLagMs:
        lagSamples.length > 0
          ? Math.max(
              ...lagSamples.map((sample) => sample.lastDeliveryLagMs ?? 0),
            )
          : undefined,
      minBackendFps:
        backendFpsSamples.length > 0
          ? Math.min(...backendFpsSamples)
          : undefined,
      avgBackendFps:
        backendFpsSamples.length > 0
          ? backendFpsSamples.reduce((sum, fps) => sum + fps, 0) /
            backendFpsSamples.length
          : undefined,
      maxBackendFrameTimeMs: numericSampleMax("backendFrameTimeMs"),
      maxFramepaceTimeMs: numericSampleMax("framepaceTimeMs"),
      maxFramepaceOversleepMs: numericSampleMax("framepaceOversleepMs"),
      maxParameterStateBuildMs: numericSampleMax("parameterStateBuildMs"),
      maxParameterStateBroadcastMs: numericSampleMax(
        "parameterStateBroadcastMs",
      ),
      maxLayerStackBuildMs: numericSampleMax("layerStackBuildMs"),
      maxLayerStackTransitionBuildMs: numericSampleMax(
        "layerStackTransitionBuildMs",
      ),
      maxLayerStackBroadcastMs: numericSampleMax("layerStackBroadcastMs"),
      maxTimelineLayerGenerationMs: numericSampleMax(
        "timelineLayerGenerationMs",
      ),
      maxTimelineUpdateMs: numericSampleMax("timelineUpdateMs"),
      maxTimelineAudioMs: numericSampleMax("timelineAudioMs"),
      maxTimelineLookaheadSourcesMs: numericSampleMax(
        "timelineLookaheadSourcesMs",
      ),
      maxTimelineLookaheadAssertionsMs: numericSampleMax(
        "timelineLookaheadAssertionsMs",
      ),
      maxTimelineLookaheadLayersMs: numericSampleMax(
        "timelineLookaheadLayersMs",
      ),
      maxTimelineActionsMs: numericSampleMax("timelineActionsMs"),
      maxTimelineParametersMs: numericSampleMax("timelineParametersMs"),
      maxTimelineSeekMs: numericSampleMax("timelineSeekMs"),
      last: lagSamples.at(-1),
      laggingSamples: laggingSamples.slice(-12),
      lowFpsSamples: lowFpsSamples.slice(-12),
      lowBackendFpsSamples: lowBackendFpsSamples.slice(-12),
    },
    relevantWarnings: relevantWarnings.slice(-12),
  };
}

/** Drives the sample-data multi-clip layer workload and checks UI responsiveness. */
test("keeps sample_data multi-clip layer workload responsive", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const browserWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") {
      browserWarnings.push(message.text());
    }
  });

  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
    window.localStorage.setItem(
      "nightfall-crud-panel-view-mode:clips-list",
      "grid",
    );
  });
  await seedStartupShowfileName(page, SAMPLE_DATA_SHOWFILE);
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page, { showfileName: SAMPLE_DATA_SHOWFILE });

  await waitForSampleClips(page);
  await waitForWebsocketBacklogSettled(page);
  await startClipComparisonWorkload(page);
  const activeClipIds = await waitForActiveClips(page);
  const configuredFps = await setReproFps(page);
  const surface = await openPerfReproSurface(page);
  const visibleGridCellsAfterLayout = await waitForStableVisibleGridCells(page);
  const clipWorkload = await observeScenario(page, browserWarnings, 30_000);

  console.info(
    JSON.stringify(
      {
        showfile: SAMPLE_DATA_SHOWFILE,
        surface,
        clipIds: [...REPRO_CLIP_IDS],
        activeClipIds,
        configuredFps,
        visibleGridCellsAfterLayout,
        scenario: summarizeScenario(clipWorkload),
      },
      null,
      2,
    ),
  );

  expect(clipWorkload.observation.timelineCount).toBeGreaterThan(0);
  expect(clipWorkload.observation.fixtureCount).toBeGreaterThan(0);
  expect(clipWorkload.observation.visibleGridCellCount).toBeGreaterThan(0);
  expect(clipWorkload.observation.layerCount).toBeGreaterThan(0);
  expectPerformanceAcceptable(clipWorkload);
});
