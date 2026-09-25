// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import type { VisualizerStats } from "../state/appStores";
import { expect, type Page, test } from "./playwright-fixtures";
import {
  seedStartupShowfileName,
  waitForDockviewApp,
} from "./showfile-startup";
import { summarizePresentationTrace } from "./visualizer-presentation-report";
import { startVisualizerPresentationTrace } from "./visualizer-presentation-trace";
import {
  disableVisualizerGpuTiming,
  startVisualizerMainProfile,
  startVisualizerWorkerProfile,
} from "./visualizer-worker-profile";

/** Opt-in until nightfall-lightdesk-ocx replaces the operator's show with owned data. */
const enabled = process.env.NIGHTFALL_VISUALIZER_PLAYBACK_PERF === "1";
const workerMode = process.env.NIGHTFALL_VISUALIZER_RENDER_MODE === "worker";
const quality = process.env.NIGHTFALL_VISUALIZER_QUALITY ?? "high";
const gpuTimingDisabled =
  process.env.NIGHTFALL_VISUALIZER_DISABLE_GPU_TIMING === "1";

// Continuous video encoding adds work absent from normal playback. Retain the
// explicit post-measurement screenshots and opt-in profiles/traces instead.
test.use({ video: "off" });

type PlaybackTarget = {
  timelineUid: string;
  timecodeUid: string;
  timecodeId: number;
  positionMs: number;
};

/** Sends an authoritative transport command to the disposable test backend. */
async function transport(page: Page, target: PlaybackTarget, playing: boolean) {
  await page.evaluate(
    async ({ target, playing }) => {
      /** Bounds acknowledgements so cleanup cannot hide a failed transport command. */
      const send = async (command: object) => {
        const result = await Promise.race([
          (window as any).appStores.sendAndAwait(command),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Transport acknowledgement timed out: ${JSON.stringify(command)}`,
                  ),
                ),
              10_000,
            ),
          ),
        ]);
        if (result?.error) throw new Error(JSON.stringify(result));
      };
      await send({
        module: "TimecodeCommand",
        command: { type: "StopTimecode", data: target.timecodeId },
      });
      if (playing) {
        await send({
          module: "TimecodeCommand",
          command: {
            type: "SeekTimecode",
            data: {
              id: target.timecodeId,
              position: {
                secs: Math.floor(target.positionMs / 1000),
                nanos: Math.round((target.positionMs % 1000) * 1e6),
              },
            },
          },
        });
        await send({
          module: "TimecodeCommand",
          command: { type: "StartTimecode", data: target.timecodeId },
        });
      }
    },
    { target, playing },
  );
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.timecodes.get()[uid]?.[1]?.is_active,
        target.timecodeUid,
      ),
    )
    .toBe(playing);
}

/** Resolves beat 47 using the same grid conversion as the operator's jump command. */
async function openWorkload(page: Page): Promise<PlaybackTarget> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await seedStartupShowfileName(page, "default");
  // `visualizer:inspector` publishes the frame-pacing diagnostics this benchmark reports.
  await page.goto(
    `/?e2e=1&startup:draftRecovery=false&visualizer:beamQuality=${quality}&visualizer:offscreenCanvas=${workerMode}&visualizer:inspector=true`,
  );
  // Let the app-owned automatic open finish before the general readiness helper
  // can click the showfile picker and enqueue a second load of the same show.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          localStorage.getItem("nightfall.e2eAutoOpenStartupShowfile"),
        ),
      { timeout: 60_000 },
    )
    .toBe("0");
  await waitForDockviewApp(page, { showfileName: "default" });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.getVisualizerApi?.())), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).appStores.visualizerStats.get()?.fps ?? 0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  await waitForDockviewApp(page, { showfileName: "default" });
  return page.evaluate(async () => {
    const { resolveTimelineJumpTarget } = await import(
      "/features/timeline/model/timeline-jump.ts"
    );
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (t: any) => t.identifiers.id === 4,
    ) as any;
    if (!timeline)
      throw new Error(
        "Benchmark requires default showfile timeline 4; do not substitute sample data",
      );
    const timecode = stores.timecodes.get()[timeline.timecode_uid]?.[0];
    if (!timecode) throw new Error("Timeline 4 has no linked timecode");
    const jump = resolveTimelineJumpTarget("b 47", {
      bpm: timeline.bpm,
      beatsPerBar: timeline.beats_per_bar,
      markers: timeline.use_beat_grid ? timeline.beatgrid?.markers : undefined,
    });
    if (!jump) throw new Error("Cannot resolve beat 47");
    const api = stores.dockApi.get();
    const visualizer = api.panels.find(
      (panel: any) => panel.api.component === "Visualizer",
    );
    if (!visualizer) throw new Error("Benchmark requires a visualizer panel");
    visualizer.api.setActive();
    const offset = timeline.timecode_start;
    return {
      timelineUid: timeline.identifiers.uid,
      timecodeUid: timeline.timecode_uid,
      timecodeId: timecode.identifiers.id,
      positionMs:
        jump.positionMs +
        (offset?.secs ?? 0) * 1000 +
        (offset?.nanos ?? 0) / 1e6,
    };
  });
}

/** Pins the render workload after saved-layout restoration and sibling constraints have settled. */
async function sizeBenchmarkCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.panels.find(
      (entry: any) => entry.api.component === "Visualizer",
    );
    if (!panel) throw new Error("Benchmark visualizer disappeared");
    if (panel.api.location.type !== "floating") {
      api.addFloatingGroup(panel, {
        x: 400,
        y: 80,
        width: 802,
        height: 800,
        dragHandle: "titlebar",
      });
    }
  });
  // Wait for the renderer's resize observer before deriving the floating window's
  // chrome size. Retrying incremental setSize calls can outrun the DOM and grow it.
  await expect
    .poll(() =>
      page
        .locator('canvas[aria-label="3D visualizer viewport"]')
        .evaluate((canvas) => {
          const rect = canvas.getBoundingClientRect();
          const container = canvas.parentElement!.getBoundingClientRect();
          return (
            rect.width === container.width && rect.height === container.height
          );
        }),
    )
    .toBe(true);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.panels.find(
      (entry: any) => entry.api.component === "Visualizer",
    );
    const canvas = document.querySelector<HTMLCanvasElement>(
      'canvas[aria-label="3D visualizer viewport"]',
    );
    if (!panel || !canvas) throw new Error("Benchmark visualizer disappeared");
    const rect = canvas.getBoundingClientRect();
    const groupRect = panel.group.element.getBoundingClientRect();
    panel.group.api.setSize({
      width: groupRect.width + 800 - rect.width,
      height: groupRect.height + 700 - rect.height,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          'canvas[aria-label="3D visualizer viewport"]',
        );
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    )
    .toEqual({ width: 800, height: 700 });
  await expect(
    page.locator('canvas[aria-label="3D visualizer viewport"]'),
  ).toBeInViewport({ ratio: 1 });
}

/** Records animation callback intervals together with authoritative playback and delivery metrics. */
async function samplePlayback(page: Page, target: PlaybackTarget) {
  return page.evaluate(async (target) => {
    const samples: {
      time: number;
      sourceMs: number;
      engineFps: number;
      deliveryLagMs: number;
      queueDepth: number;
      visualizer: VisualizerStats | null;
    }[] = [];
    const stores = (window as any).appStores;
    const started = performance.now();
    performance.mark("nightfall-playback-measure-start");
    await new Promise<void>((resolve) => {
      /** Samples without DOM traversal or synchronous GPU readback in the measured interval. */
      function sample(time: number) {
        const source =
          stores.timecodes.get()[target.timecodeUid]?.[1]?.current_time;
        const ws = stores.wsStats.get();
        samples.push({
          time,
          sourceMs: (source?.secs ?? 0) * 1000 + (source?.nanos ?? 0) / 1e6,
          engineFps: stores.engineMetrics.get()?.fps ?? 0,
          deliveryLagMs: ws?.main?.lastDeliveryLagMs ?? 0,
          queueDepth: ws?.worker?.queueDepth ?? 0,
          visualizer: stores.visualizerStats.get(),
        });
        if (time - started >= 12_000) resolve();
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    performance.mark("nightfall-playback-measure-end");
    return samples;
  }, target);
}

/** Compares the same timeline segment with and without rendering, retaining tail latency and images. */
test("default timeline 4 beat 47 visualizer playback benchmark", async ({
  page,
}, testInfo) => {
  test.skip(
    !enabled,
    "Set NIGHTFALL_VISUALIZER_PLAYBACK_PERF=1 with the operator's copied default showfile",
  );
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const target = await openWorkload(page);
  if (process.env.NIGHTFALL_VISUALIZER_WASH_STRESS === "1") {
    const ids = await page.evaluate(() =>
      Object.values((window as any).appStores.fixtures.get())
        .filter((fixture: any) => fixture.layout === "rotating-wash-beam")
        .map((fixture: any) => fixture.identifiers.id),
    );
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) {
      const input = page.locator("#header-cmdline");
      await input.fill(
        `fix ${id} int @ 100 white @ 100 zoom @ ${process.env.NIGHTFALL_VISUALIZER_WASH_ZOOM ?? "0"}`,
      );
      await input.press("Enter");
      await expect(input).toHaveValue("");
    }
  }
  try {
    await page.addStyleTag({
      content:
        ".profiler-panel, .profiler-mini-panel { display: none !important; }",
    });
    await page.evaluate(() => window.getVisualizerApi?.()?.zoomToFit());
    await page.waitForTimeout(3000);
    await expect
      .poll(() =>
        page.evaluate(() => window.getVisualizerApi?.()?.isUsingWorker()),
      )
      .toBe(workerMode);
    for (const visible of [false, true]) {
      // Startup and the first transport seek can restore the saved layout.
      // Finish warming before sizing, then pause the resulting renderer instance.
      await waitForDockviewApp(page, { showfileName: "default" });
      const stopWarmupProfile =
        !visible && process.env.NIGHTFALL_VISUALIZER_WARMUP_PROFILE === "1"
          ? await (workerMode
              ? startVisualizerWorkerProfile(page)
              : startVisualizerMainProfile(page))
          : undefined;
      try {
        await transport(page, target, true);
        await page.waitForTimeout(5000);
      } finally {
        if (stopWarmupProfile) {
          const result = (await stopWarmupProfile()) as { profile: unknown };
          const profile = JSON.stringify(result.profile);
          const name = `visualizer-warmup-${workerMode ? "worker" : "main"}.cpuprofile`;
          await writeFile(testInfo.outputPath(name), profile);
          await testInfo.attach(name, {
            body: profile,
            contentType: "application/json",
          });
        }
      }
      await waitForDockviewApp(page, { showfileName: "default" });
      await sizeBenchmarkCanvas(page);
      await page.evaluate(() => window.getVisualizerApi?.()?.zoomToFit());
      await page.waitForTimeout(1000);
      await page.evaluate((visible) => {
        const apis = Object.values(window.visualizerApis ?? {});
        if (apis.length === 0)
          throw new Error(
            "Benchmark requires the default show's visualizer panel",
          );
        for (const api of apis) {
          if (visible) api.resume();
          else api.pause();
        }
      }, visible);
      if (visible) {
        await expect
          .poll(
            () =>
              page.evaluate(
                () => (window as any).appStores.visualizerStats.get()?.fps ?? 0,
              ),
            { timeout: 60_000 },
          )
          .toBeGreaterThan(0);
      }
      await transport(page, target, true);
      await page.waitForTimeout(1000);
      await expect(
        page.locator('canvas[aria-label="3D visualizer viewport"]'),
      ).toHaveJSProperty("width", 800);
      await expect(
        page.locator('canvas[aria-label="3D visualizer viewport"]'),
      ).toHaveJSProperty("height", 700);
      if (visible && gpuTimingDisabled)
        await disableVisualizerGpuTiming(page, workerMode);
      if (process.env.NIGHTFALL_VISUALIZER_MESSAGE_PROFILE === "1") {
        await page.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(
            MessageEvent.prototype,
            "data",
          );
          if (!descriptor?.get)
            throw new Error("MessageEvent data getter missing");
          const original = descriptor.get;
          const totals: Record<
            string,
            { count: number; totalMs: number; maxMs: number }
          > = {};
          Object.defineProperty(MessageEvent.prototype, "data", {
            ...descriptor,
            /** Measures lazy structured-clone decoding without retaining payloads. */
            get() {
              const start = performance.now();
              const value = original.call(this);
              const duration = performance.now() - start;
              const key =
                typeof value?.type === "string" ? value.type : "other";
              totals[key] ??= {
                count: 0,
                totalMs: 0,
                maxMs: 0,
              };
              const entry = totals[key];
              entry.count++;
              entry.totalMs += duration;
              entry.maxMs = Math.max(entry.maxMs, duration);
              return value;
            },
          });
          /** Restores native message access before publishing the diagnostic totals. */
          (window as any).__finishMessageProfile = () => {
            Object.defineProperty(MessageEvent.prototype, "data", descriptor);
            delete (window as any).__finishMessageProfile;
            return totals;
          };
        });
      }
      const profileWorker =
        workerMode &&
        process.env.NIGHTFALL_VISUALIZER_CPU_PROFILE_TARGET !== "main";
      const stopProfile =
        visible && process.env.NIGHTFALL_VISUALIZER_CPU_PROFILE === "1"
          ? await (profileWorker
              ? startVisualizerWorkerProfile(page)
              : startVisualizerMainProfile(page))
          : undefined;
      const stopTrace =
        visible && process.env.NIGHTFALL_VISUALIZER_PRESENTATION_TRACE === "1"
          ? await startVisualizerPresentationTrace(page)
          : undefined;
      let samples: Awaited<ReturnType<typeof samplePlayback>>;
      try {
        samples = await samplePlayback(page, target);
      } finally {
        if (process.env.NIGHTFALL_VISUALIZER_MESSAGE_PROFILE === "1") {
          const totals = await page.evaluate(() =>
            (window as any).__finishMessageProfile(),
          );
          await testInfo.attach(
            `message-deserialization-${visible ? "rendering" : "paused"}.json`,
            {
              body: JSON.stringify(totals),
              contentType: "application/json",
            },
          );
          await writeFile(
            testInfo.outputPath(
              `message-deserialization-${visible ? "rendering" : "paused"}.json`,
            ),
            JSON.stringify(totals),
          );
        }
        try {
          if (stopTrace) {
            const trace = await stopTrace();
            const name = `visualizer-presentation-${workerMode ? "worker" : "main"}.json`;
            await writeFile(testInfo.outputPath(name), trace);
            await testInfo.attach(name, {
              body: trace,
              contentType: "application/json",
            });
            const presentation = summarizePresentationTrace(JSON.parse(trace));
            await testInfo.attach("presentation-summary.json", {
              body: JSON.stringify(presentation),
              contentType: "application/json",
            });
            expect.soft(presentation.presentedAll).toBeGreaterThan(600);
            expect.soft(presentation.droppedAffectingSmoothness).toBe(0);
            expect.soft(presentation.presentationIntervalsOver25Ms).toBe(0);
            // Chromium reports the offscreen worker's page animation under RAF;
            // CanvasAnimation is emitted for the main-thread canvas path only.
            const requiredSequence = workerMode ? "RAF" : "CanvasAnimation";
            const animationSequences = presentation.sequences.filter(
              (sequence) => sequence.name === requiredSequence,
            );
            expect.soft(animationSequences.length).toBeGreaterThan(0);
            for (const sequence of presentation.sequences) {
              expect.soft(sequence.expected).toBeGreaterThan(0);
              expect.soft(sequence.droppedV3, sequence.name).toBe(0);
              expect.soft(sequence.droppedV4, sequence.name).toBe(0);
            }
          }
        } finally {
          if (stopProfile) {
            const result = (await stopProfile()) as { profile: unknown };
            const profile = JSON.stringify(result.profile);
            const profileName = profileWorker
              ? "visualizer-worker.cpuprofile"
              : "visualizer-main.cpuprofile";
            await writeFile(testInfo.outputPath(profileName), profile);
            await testInfo.attach(profileName, {
              body: profile,
              contentType: "application/json",
            });
          }
        }
      }
      const intervals = samples
        .slice(1)
        .map((s, i) => s.time - samples[i].time)
        .sort((a, b) => a - b);
      const scenario = visible ? "rendering" : "paused";
      const pacing = samples
        .map((sample) => sample.visualizer?.framePacing)
        .filter((value) => value !== undefined);
      const firstSchedule = pacing[0]?.scheduling;
      const lastSchedule = pacing.at(-1)?.scheduling;
      const renderPacing = pacing.length
        ? {
            submittedFrames: pacing.at(-1)!.frames - pacing[0]!.frames,
            intervalsOver25Ms: pacing.at(-1)!.over25Ms - pacing[0]!.over25Ms,
            worstPublishedIntervalMs: Math.max(
              ...pacing.map((value) => value.windowMaxMs),
            ),
            scheduling:
              firstSchedule && lastSchedule
                ? {
                    frames: lastSchedule.frames - firstSchedule.frames,
                    intervalsOver25Ms:
                      lastSchedule.over25Ms - firstSchedule.over25Ms,
                    lateSubmissions:
                      lastSchedule.lateSubmissions -
                      firstSchedule.lateSubmissions,
                  }
                : undefined,
          }
        : undefined;
      const canvases = await page.locator("canvas").evaluateAll((elements) =>
        elements.map((canvas) => {
          const rect = canvas.getBoundingClientRect();
          return {
            width: (canvas as HTMLCanvasElement).width,
            height: (canvas as HTMLCanvasElement).height,
            displayWidth: rect.width,
            displayHeight: rect.height,
          };
        }),
      );
      const report = JSON.stringify({
        target,
        workerMode,
        quality,
        washStress: process.env.NIGHTFALL_VISUALIZER_WASH_STRESS === "1",
        washZoom: process.env.NIGHTFALL_VISUALIZER_WASH_ZOOM ?? "0",
        gpuTimingDisabled,
        detailedTrace: process.env.NIGHTFALL_VISUALIZER_DETAILED_TRACE === "1",
        canvases,
        frames: samples.length,
        p50: intervals[Math.floor(intervals.length * 0.5)],
        p95: intervals[Math.floor(intervals.length * 0.95)],
        p99: intervals[Math.floor(intervals.length * 0.99)],
        max: intervals.at(-1),
        over25Ms: intervals.filter((ms) => ms > 25).length,
        renderPacing,
        samples,
      });
      await writeFile(testInfo.outputPath(`${scenario}-playback.json`), report);
      await testInfo.attach(`${scenario}-playback.json`, {
        body: report,
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath(`${scenario}.png`) });
      await expect(
        page.locator('canvas[aria-label="3D visualizer viewport"]'),
      ).toHaveJSProperty("width", 800);
      await expect(
        page.locator('canvas[aria-label="3D visualizer viewport"]'),
      ).toHaveJSProperty("height", 700);
      expect
        .soft(samples.at(-1)!.sourceMs - samples[0].sourceMs)
        .toBeGreaterThan(10_000);
      if (visible) {
        expect
          .soft(renderPacing, "Renderer must publish raw submission timing")
          .toBeDefined();
        expect
          .soft(
            renderPacing?.submittedFrames,
            "Renderer must continue submitting throughout playback",
          )
          .toBeGreaterThan(600);
        expect
          .soft(
            renderPacing?.scheduling?.frames,
            "Every submitted frame must include scheduler timing",
          )
          .toBe(renderPacing?.submittedFrames);
        expect
          .soft(
            renderPacing?.scheduling?.intervalsOver25Ms,
            "Renderer skips refreshes during timeline playback",
          )
          .toBe(0);
        expect
          .soft(
            renderPacing?.scheduling?.lateSubmissions,
            "Renderer submits after its 60 Hz frame budget",
          )
          .toBe(0);
        expect
          .soft(
            intervals.filter((ms) => ms > 25).length,
            "UI stalls during timeline playback",
          )
          .toBe(0);
      } else {
        expect(
          renderPacing?.submittedFrames ?? 0,
          "Paused baseline must not submit visualizer frames",
        ).toBe(0);
      }
      await transport(page, target, false);
    }
    expect(errors).toEqual([]);
  } catch (error) {
    const diagnostics = await page
      .evaluate(async () => {
        const runtime = await import("/lib/engine-runtime.ts");
        const stores = (window as any).appStores;
        return {
          connectionStatus: runtime.connectionStatus(),
          resyncComplete: runtime.resyncComplete(),
          websocket: stores.wsStats.get(),
          engine: stores.engineMetrics.get(),
          visualizer: stores.visualizerStats.get(),
        };
      })
      .catch(() => null);
    await testInfo.attach("playback-failure-diagnostics.json", {
      body: JSON.stringify(diagnostics),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await page.evaluate(async (id) => {
      await (window as any).appStores.send({
        module: "TimecodeCommand",
        command: { type: "StopTimecode", data: id },
      });
    }, target.timecodeId);
  }
});
