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

/** Builds the latency repro command for the sequence available in the fixture. */
function buildStoreSequenceCommand(sequenceId: number): string {
  return (
    `group 3>10 int @ 100; sleep 0.5; store cue ${sequenceId}.1p0; sleep 1; group 3>10 int @ 80; sleep 0.5; store cue ${sequenceId}.1p1; sleep 0.1; ` +
    `group 3>10 int @ 100; sleep 0.1; store cue ${sequenceId}.2p0; sleep 1; group 3>10 int @ 80; sleep 0.1; store cue ${sequenceId}.2p1; sleep 0.1; ` +
    `group 3>10 int @ 100; sleep 0.1; store cue ${sequenceId}.3p0; sleep 1; group 3>10 int @ 80; sleep 0.1; store cue ${sequenceId}.3p1; sleep 0.1; ` +
    `group 3>10 int @ 100; sleep 0.1; store cue ${sequenceId}.4p0; sleep 1; group 3>10 int @ 80; sleep 0.1; store cue ${sequenceId}.4p1; sleep 0.1;`
  );
}

interface LongFrameSample {
  durationMs: number;
  blockingDurationMs: number;
  scripts: Array<{
    durationMs: number;
    sourceURL: string;
    sourceFunctionName: string;
    invoker: string;
  }>;
}

interface StoreLatencySummary {
  sequenceCount: number;
  cueCount: number;
  longFrameCount: number;
  maxLongFrameMs: number;
  maxBlockingMs: number;
  cueDefinitionDispatchCount: number;
  websocketDispatch: Record<string, unknown>;
  cueStoreListeners: Record<string, unknown>;
  worstLongFrames: LongFrameSample[];
}

declare global {
  interface Window {
    __sequenceStoreLatencyFrames?: LongFrameSample[];
    __clearSequenceStoreLatencyFrames?: () => void;
  }
}

/** Submits an operator command through the shared header command line. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/** Waits until the app shell and websocket-backed stores are available. */
async function waitForAppStores(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stores = (window as any).appStores;
          return Boolean(stores?.dockApi?.get?.() && stores?.sendAndAwait);
        }),
      { timeout: 45_000 },
    )
    .toBe(true);
}

/** Waits until websocket lag has settled after loading the default showfile. */
async function waitForWebsocketSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = (window as any).appStores?.wsStats?.get?.();
          return {
            lagging: Boolean(stats?.main?.backlogLagging),
            queueDepth: stats?.worker?.queueDepth ?? 0,
            lastLagMs: stats?.main?.lastDeliveryLagMs ?? 0,
          };
        }),
      { timeout: 45_000 },
    )
    .toMatchObject({
      lagging: false,
      queueDepth: 0,
    });
}

/** Finds the current fixture sequence used by the store-command latency repro. */
async function findLatencyTargetSequenceId(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sequences = Object.values(
      (window as any).appStores.sequences.get(),
    ) as any[];
    const target =
      sequences.find(
        (sequence) =>
          sequence.identifiers?.label?.trim?.() === "Cue Parts Demo",
      ) ??
      [...sequences].sort(
        (left, right) => (right.steps?.length ?? 0) - (left.steps?.length ?? 0),
      )[0];
    const id = target?.identifiers?.id;
    if (typeof id !== "number") {
      throw new Error("No sequence available for latency repro");
    }
    return id;
  });
}

/** Opens the default showfile sequence that the repro stores into. */
async function openSequenceEditor(
  page: Page,
  sequenceId: number,
): Promise<void> {
  await page.evaluate((targetSequenceId) => {
    const stores = (window as any).appStores;
    const sequence = Object.values(stores.sequences.get()).find(
      (entry: any) => entry?.identifiers?.id === targetSequenceId,
    ) as any;
    if (!sequence) {
      throw new Error(`sequence ${targetSequenceId} not found`);
    }

    const api = stores.dockApi.get();
    const panelId = `panel-SequenceEditor-latency-${targetSequenceId}`;
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: `Sequence ${targetSequenceId} Latency`,
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequence.identifiers.uid,
      },
    });
    api.getPanel(panelId)?.api.setActive();
  }, sequenceId);

  await expect(
    page.locator(
      `.panel-SequenceEditor-latency-${sequenceId} [data-grid-owner="sequence-editor"]`,
    ),
  ).toBeVisible({ timeout: 20_000 });
}

/** Clears app performance measures and the repro's long-frame buffer. */
async function clearLatencyMetrics(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const module = await import("/lib/performance-measure-collector.ts");
    module.clearPerformanceMeasures();
    window.__clearSequenceStoreLatencyFrames?.();
  });
}

/** Reads performance measurements collected during the store command window. */
async function readLatencySummary(page: Page): Promise<StoreLatencySummary> {
  return page.evaluate(() => {
    const measureCount = (value: unknown): number => {
      if (typeof value !== "object" || value === null || !("count" in value)) {
        return 0;
      }
      return Number((value as { count?: unknown }).count ?? 0);
    };
    const stores = (window as any).appStores;
    const stats = stores.performanceMeasureStats.get();
    const websocketDispatch = Object.fromEntries(
      Object.entries(stats).filter(([name]) =>
        name.includes("websocket-main.dispatch"),
      ),
    );
    const cueStoreListeners = Object.fromEntries(
      Object.entries(stats)
        .filter(([name]) => name.includes("nightfall:cues."))
        .sort(([, left], [, right]) => {
          const leftMax =
            typeof left === "object" && left && "maxMs" in left
              ? Number((left as any).maxMs)
              : 0;
          const rightMax =
            typeof right === "object" && right && "maxMs" in right
              ? Number((right as any).maxMs)
              : 0;
          return rightMax - leftMax;
        })
        .slice(0, 20),
    );
    const cueDefinitionDispatchCount = Object.entries(websocketDispatch)
      .filter(([name]) => name.includes("CueDefinition"))
      .reduce((total, [, value]) => total + measureCount(value), 0);
    const longFrames = window.__sequenceStoreLatencyFrames ?? [];
    const worstLongFrames = [...longFrames]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 8);

    return {
      sequenceCount: Object.keys(stores.sequences.get()).length,
      cueCount: Object.keys(stores.cues.get()).length,
      longFrameCount: longFrames.length,
      maxLongFrameMs: Math.max(
        0,
        ...longFrames.map((frame) => frame.durationMs),
      ),
      maxBlockingMs: Math.max(
        0,
        ...longFrames.map((frame) => frame.blockingDurationMs),
      ),
      cueDefinitionDispatchCount,
      websocketDispatch,
      cueStoreListeners,
      worstLongFrames,
    };
  });
}

/** Installs a browser-side long animation frame collector for this repro window. */
async function installLongFrameCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__sequenceStoreLatencyFrames = [];
    window.__clearSequenceStoreLatencyFrames = () => {
      window.__sequenceStoreLatencyFrames = [];
    };

    if (
      !("PerformanceObserver" in window) ||
      !PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")
    ) {
      return;
    }

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        window.__sequenceStoreLatencyFrames?.push({
          durationMs: entry.duration ?? 0,
          blockingDurationMs: entry.blockingDuration ?? 0,
          scripts: [...(entry.scripts ?? [])]
            .sort((left, right) => (right.duration ?? 0) - (left.duration ?? 0))
            .slice(0, 5)
            .map((script) => ({
              durationMs: script.duration ?? 0,
              sourceURL: script.sourceURL ?? "",
              sourceFunctionName: script.sourceFunctionName ?? "",
              invoker: script.invoker ?? "",
            })),
        });
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: true });
  });
}

/** Verifies the default showfile sequence-store repro stays interactive. */
test("default showfile sequence store command avoids multi-second main-thread stalls", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installLongFrameCollector(page);
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall-ui-layouts");
  });

  await seedStartupShowfileName(page, "sample");
  await page.goto(
    "/?e2e=1&scenario=sequence-store-latency&startup:draftRecovery=false",
  );
  await waitForDockviewApp(page);
  await waitForAppStores(page);
  await waitForWebsocketSettled(page);
  const sequenceId = await findLatencyTargetSequenceId(page);
  await openSequenceEditor(page, sequenceId);
  await waitForWebsocketSettled(page);
  await clearLatencyMetrics(page);

  await submitCommand(page, buildStoreSequenceCommand(sequenceId));
  await page.waitForTimeout(15_000);
  await waitForWebsocketSettled(page);

  const summary = await readLatencySummary(page);
  console.info(JSON.stringify({ sequenceStoreLatency: summary }, null, 2));

  expect(summary.sequenceCount).toBeGreaterThan(0);
  expect(summary.cueCount).toBeGreaterThanOrEqual(90);
  expect(summary.cueDefinitionDispatchCount).toBeGreaterThan(0);
  expect(summary.maxLongFrameMs).toBeLessThan(1000);
  expect(summary.maxBlockingMs).toBeLessThan(750);
});
