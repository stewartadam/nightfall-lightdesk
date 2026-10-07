// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Close-up frame rate and beam-toggle stalls of the Ayrton Argo 6 FX (the
 * 337-beam fixture behind develop PR #73) at High quality, in the native
 * visualizer on both renderer modes.
 *
 * Runs only with NIGHTFALL_GDTF_BENCH_DIR (the archive cannot be committed)
 * and NIGHTFALL_VISUALIZER_PERF=1, since timings depend on the machine. The
 * measurements are attached as `argo-perf.json` and printed for comparison.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  attachCanvas,
  type BenchFixture,
  benchDir,
  installBenchFixture,
  submitCommand,
} from "./gdtf-bench-support";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.skip(!benchDir, "NIGHTFALL_GDTF_BENCH_DIR is not set");
test.skip(
  process.env.NIGHTFALL_VISUALIZER_PERF !== "1",
  "NIGHTFALL_VISUALIZER_PERF=1 is not set",
);
test.describe.configure({ timeout: 300_000, mode: "serial" });

const ARGO_6_FX: BenchFixture = {
  file: "Ayrton@Argo_6_FX@V1.6_Corrected_Atttribute_Names.gdtf",
  make: "Ayrton",
  model: "Argo 6 FX",
  mode: "Extended_Pixel_2_+_Liquid",
};

/** Close-up of the fixture hanging at 4 m, as the bench captures use. */
const CLOSE_UP = {
  position: { x: 1.1, y: 4.4, z: 1.4 },
  target: { x: 0, y: 3.8, z: 0 },
};

/** Command lighting every pixel of the Argo white. */
const LIGHT = "fix 1.(1>198) int @ 100 red @ 100 green @ 100 blue @ 100";

/** Frame statistics over a sampling window. */
type FrameWindow = {
  fps: number;
  p95Ms: number;
  maxMs: number;
};

/**
 * Samples presented frames on the page for `ms`. With the main-thread
 * renderer every rendered frame, including shader compiles, blocks these
 * callbacks, so their gaps are the visualizer's frame times.
 */
function sampleFrames(page: Page, ms: number): Promise<FrameWindow> {
  return page.evaluate(
    (ms) =>
      new Promise<FrameWindow>((resolve) => {
        const gaps: number[] = [];
        const start = performance.now();
        let last = start;
        const tick = (now: number) => {
          gaps.push(now - last);
          last = now;
          if (now - start < ms) requestAnimationFrame(tick);
          else {
            const sorted = [...gaps].sort((a, b) => a - b);
            resolve({
              fps: (gaps.length * 1000) / (now - start),
              p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
              maxMs: sorted.at(-1) ?? 0,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/**
 * Returns the renderer's published instrumentation (FPS, update, render and
 * GPU times), which the worker reports from its own loop.
 */
function rendererStats(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const stats = (window as any).appStores.visualizerStats.get();
    if (!stats) return null;
    const numeric: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(stats))
      if (typeof value === "number") numeric[key] = value;
    return numeric;
  });
}

/** Counts the fixture's beam geometry nodes by beam type. */
function beamTypes(page: Page, uid: string): Promise<Record<string, number>> {
  return page.evaluate((uid) => {
    const geometry = (window as any).appStores.fixtureGeometries.get()[uid];
    const types: Record<string, number> = {};
    for (const node of geometry?.nodes ?? []) {
      if (node.geometryType !== "beam") continue;
      const type = node.beam?.physical?.beamType ?? "none";
      types[type] = (types[type] ?? 0) + 1;
    }
    return types;
  }, uid);
}

/**
 * Submits a command and measures the page's frames until they settle: the
 * longest frame gap in the following window and the time from submission to
 * the first frame showing the change's stall end.
 */
async function toggle(page: Page, command: string) {
  const started = Date.now();
  await submitCommand(page, command);
  const submittedMs = Date.now() - started;
  const frames = await sampleFrames(page, 3_000);
  return { command, submittedMs, ...frames };
}

/** Counts the fixture's lit apertures on either rendering pipeline. */
function litApertures(page: Page, uid: string): Promise<number> {
  return page.evaluate((uid) => {
    let count = 0;
    (window as any).visualizerApi.getScene().traverse((object: any) => {
      if (!object.visible) return;
      // Clustered pipeline: one surface light per lit aperture (and facet).
      if (object.name?.startsWith(`OpticalSurface:${uid}:`)) count++;
      // Per-beam pipeline: one volumetric cone mesh per lit beam.
      else if (object.isMesh && object.name?.startsWith(`Beam_${uid}`)) count++;
    });
    return count;
  }, uid);
}

/** Opens the show with the visualizer at High quality in the requested renderer mode. */
async function openVisualizer(page: Page, worker: boolean): Promise<void> {
  await page.goto(
    `/?startup:draftRecovery=false&visualizer:offscreenCanvas=${worker}&visualizer:beamQuality=high`,
  );
  await waitForDockviewApp(page);
  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  await page.waitForFunction(
    (worker) =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).visualizerApi) &&
      (worker
        ? (window as any).visualizerApi.isUsingWorker?.() === true
        : Boolean((window as any).visualizerApi.getScene())),
    worker,
  );
  await page.addStyleTag({
    content:
      ".profiler-panel, .profiler-mini-panel { display: none !important; }",
  });
}

for (const worker of [false, true]) {
  const mode = worker ? "worker" : "main-thread";

  /** Measures close-up FPS and beam on/off stalls for the Argo 6 FX at High quality. */
  test(`Argo 6 FX close-up at High quality (${mode})`, async ({
    backendSlot,
    page,
  }, testInfo) => {
    await prepareFreshBackendShowfile(backendSlot.backendPort);
    // Installation inspects the scene, so it always runs on the main thread;
    // the worker variant then reloads the saved show in worker mode.
    await openVisualizer(page, false);
    const uid = await installBenchFixture(
      page,
      backendSlot.dataDir,
      ARGO_6_FX,
      1,
    );
    if (worker) await openVisualizer(page, true);
    await page.evaluate(
      (camera) => (window as any).visualizerApi.setCameraState(camera),
      CLOSE_UP,
    );

    const firstLight = await toggle(page, LIGHT);
    const lit = worker ? undefined : await litApertures(page, uid);
    await page.waitForTimeout(1_000);
    const steady = await sampleFrames(page, 5_000);
    const steadyStats = await rendererStats(page);
    await attachCanvas(page, `argo-${mode}-lit`, testInfo, CLOSE_UP);

    const toggles = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      toggles.push(await toggle(page, "fix 1.(1>198) int @ 0"));
      toggles.push(await toggle(page, "fix 1.(1>198) int @ 100"));
    }
    const beamsOff = await page.evaluate(() =>
      (window as any).visualizerApi.toggleBeams(),
    );
    const beamsToggleOff = await sampleFrames(page, 3_000);
    await page.evaluate(() => (window as any).visualizerApi.toggleBeams());
    const beamsToggleOn = await sampleFrames(page, 3_000);

    const result = {
      mode,
      litApertures: lit,
      firstLight,
      steady,
      steadyStats,
      beamTypes: await beamTypes(page, uid),
      toggles,
      beamsOff,
      beamsToggleOff,
      beamsToggleOn,
    };
    // Printed so runs on different branches can be compared from the terminal.
    console.log(`ARGO_PERF ${JSON.stringify(result)}`);
    await testInfo.attach("argo-perf.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    await submitCommand(page, "clear");
    expect(steady.fps).toBeGreaterThan(0);
  });
}
