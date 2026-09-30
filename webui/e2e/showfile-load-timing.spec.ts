// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 1920, height: 1080 } });

const RUNS = Number(process.env.NIGHTFALL_LOAD_TIMING_RUNS ?? 4);
/** Time allowed after a load for panels to finish mounting before a run ends. */
const SETTLE_WINDOW_MS = 7_000;

type LoadTiming = {
  /** Milliseconds from the load request to each observed phase. */
  marks: Record<string, number>;
  /** Total main-thread time spent in long tasks during the run. */
  blockedMs: number;
  /** Long tasks relative to the load request. */
  longTasks: { start: number; duration: number }[];
};

/**
 * Measures the browser-visible phases of reloading the sample showfile.
 *
 * Opt-in diagnostic: set NIGHTFALL_LOAD_TIMING=1. Each run records when the
 * websocket dropped and returned (older backends restart it per load), when
 * the post-swap resync completed, when Dockview restored the showfile layout,
 * when the loading veil covered and revealed the dock (builds that have it),
 * and when the last long task ended.
 * The final run also writes a CPU profile (`load.cpuprofile`) that opens in
 * Chrome DevTools' Performance panel.
 */
test("showfile load timing", async ({ page }, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_LOAD_TIMING !== "1",
    "Set NIGHTFALL_LOAD_TIMING=1 to run the showfile load timing probe",
  );
  test.setTimeout(60_000 + RUNS * 15_000);
  await page.goto("/?startup:draftRecovery=false");
  await waitForDockviewApp(page);

  await page.evaluate(async () => {
    const api = (window as any).appStores.dockApi.get();
    const reference = api.panels[0];
    api.addPanel({
      id: "timing-fixtures",
      component: "FixtureGrid",
      title: "Fixtures",
      position: { referencePanel: reference.id, direction: "right" },
    });
    api.addPanel({
      id: "timing-layers",
      component: "LayerStack",
      title: "Layers",
      position: { referencePanel: "timing-fixtures", direction: "below" },
    });
    const actions = await import(/* @vite-ignore */ "/lib/showfile-actions.ts");
    const runtime = await import(/* @vite-ignore */ "/lib/engine-runtime.ts");
    await runtime.engineRuntime.sendCommandAndAwait({
      module: "DeskCommand",
      command: actions.saveNamedShowfileCommand("load-timing"),
    });
  });
  await waitForDockviewApp(page);
  await page.waitForTimeout(2_000);

  const runs: LoadTiming[] = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  for (let i = 0; i < RUNS; i++) {
    const profiled = i === RUNS - 1;
    if (profiled) await cdp.send("Profiler.start");
    const result: LoadTiming = await page.evaluate(async (settleWindowMs) => {
      const runtime = await import(/* @vite-ignore */ "/lib/engine-runtime.ts");
      const actions = await import(
        /* @vite-ignore */ "/lib/showfile-actions.ts"
      );
      const layout = await import(
        /* @vite-ignore */ "/components/shell/docking/layout-readiness.ts"
      );
      const marks: Record<string, number> = {};
      const longTasks: { start: number; duration: number }[] = [];
      const t0 = performance.now();
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          longTasks.push({
            start: Math.round(entry.startTime - t0),
            duration: Math.round(entry.duration),
          });
      });
      observer.observe({ type: "longtask", buffered: false });
      const layoutRevision = layout.dockviewLayoutShowfileRevision.get();
      const resyncGeneration = runtime.resyncGeneration();
      actions.loadShowfileName("load-timing");
      await new Promise<void>((resolve) => {
        /** Samples connection, resync, layout, and veil state once per frame. */
        const tick = () => {
          const elapsed = performance.now() - t0;
          const connected =
            runtime.connectionStatus() ===
            runtime.EngineRuntimeStatus.Connected;
          if (marks.disconnected === undefined && !connected)
            marks.disconnected = elapsed;
          if (
            marks.disconnected !== undefined &&
            marks.reconnected === undefined &&
            connected
          )
            marks.reconnected = elapsed;
          if (
            marks.resync === undefined &&
            runtime.resyncComplete() &&
            runtime.resyncGeneration() > resyncGeneration
          )
            marks.resync = elapsed;
          if (
            marks.layout === undefined &&
            layout.dockviewLayoutShowfileRevision.get() !== layoutRevision
          )
            marks.layout = elapsed;
          // The loading veil, when the build has one, marks when the dock is revealed.
          const veil = document.querySelector(
            '[data-testid="showfile-transition-veil"]:not(.opacity-0)',
          );
          if (marks.veiled === undefined && veil) marks.veiled = elapsed;
          if (
            marks.veiled !== undefined &&
            marks.revealed === undefined &&
            !veil
          )
            marks.revealed = elapsed;
          if (
            (marks.resync !== undefined && elapsed > settleWindowMs) ||
            elapsed > 30_000
          ) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      observer.disconnect();
      const lastTask = longTasks.at(-1);
      if (lastTask) marks.lastLongTaskEnd = lastTask.start + lastTask.duration;
      for (const key of Object.keys(marks)) marks[key] = Math.round(marks[key]);
      const blockedMs = longTasks.reduce((sum, task) => sum + task.duration, 0);
      return { marks, blockedMs, longTasks };
    }, SETTLE_WINDOW_MS);
    runs.push(result);
    if (profiled) {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(
        testInfo.outputPath("load.cpuprofile"),
        JSON.stringify(profile),
      );
    }
    console.log(
      `run ${i}: ${JSON.stringify(result.marks)} blocked=${result.blockedMs}ms`,
    );
    await page.waitForTimeout(1_500);
  }
  await writeFile(
    testInfo.outputPath("load-timing.json"),
    JSON.stringify(runs, null, 2),
  );
});
