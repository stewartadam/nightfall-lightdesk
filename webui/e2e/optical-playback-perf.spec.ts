// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { TimestampRenderer } from "../features/visualizer/rendering/gpu-frame-timer";
import {
  annotateBackend,
  evaluateOnBackend,
  openOpticsFixture,
} from "./optics-harness";
import {
  expectPresentationWithinBudget,
  frameSkipThresholdMs,
  MAX_LATE_SUBMISSION_RATIO,
  MAX_SKIPPED_FRAME_RATIO,
  measureRefreshIntervalMs,
  minimumPresentedFrames,
  percentile,
  ratio,
} from "./perf-budgets";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { summarizePresentationTrace } from "./visualizer-presentation-report";
import { startVisualizerPresentationTrace } from "./visualizer-presentation-trace";

/** Frames rendered before measuring, so shader compilation and first uploads settle. */
const WARMUP_FRAMES = 120;

/**
 * Measured wall-clock duration after the warm-up. Twelve seconds span a full five-second
 * Chromium tracker window at any refresh rate.
 */
const MEASURED_MS = 12_000;

// Performance measurements must not include the test runner's video encoder.
test.use({ video: "off" });

/** Exercises hundreds of moving apertures through the production fog, surface, shadow, and bloom pipeline. */
test("300 active optical sources sustain frame pacing", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_OPTICAL_PLAYBACK_PERF !== "1",
    "Opt-in synthetic GPU performance workload; set NIGHTFALL_OPTICAL_PLAYBACK_PERF=1",
  );
  test.setTimeout(60_000);
  const errors = await openOpticsFixture(page);
  const refreshIntervalMs = await measureRefreshIntervalMs(page);
  const stopTrace = await startVisualizerPresentationTrace(page);
  let presentationTrace: string | undefined;
  /** Renders the measured workload in the page and returns its per-frame samples. */
  const runWorkload = () =>
    evaluateOnBackend(
      page,
      async ({ warmupFrames, measuredMs }) => {
        const THREE = await window.__nightfallHarness.load("three");
        const { createRenderer } = (
          await window.__nightfallHarness.load("visualizer")
        ).renderer;
        const {
          createPostProcessing,
          preparePostProcessing,
          renderWithPostProcessing,
          disposePostProcessing,
        } = (await window.__nightfallHarness.load("visualizer")).postProcessing;
        const { EmitterVolumeBatch } = (
          await window.__nightfallHarness.load("visualizer")
        ).emitterVolumeBatch;
        const { GpuFrameTimer } = (
          await window.__nightfallHarness.load("visualizer")
        ).gpuFrameTimer;
        const { FramePacing } = (
          await window.__nightfallHarness.load("visualizer")
        ).framePacing;
        const renderer = createRenderer({
          canvas: document.querySelector("canvas")!,
          devicePixelRatio: 1,
        });
        renderer.setSize(800, 700);
        await renderer.init();
        const { verifyBackend } =
          await window.__nightfallHarness.load("optics");
        const backend = await verifyBackend(renderer, false);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0);
        const camera = new THREE.PerspectiveCamera(50, 800 / 700, 0.1, 80);
        camera.position.set(12, 8, 14);
        camera.lookAt(0, 2, -6);
        const wall = new THREE.Mesh(
          new THREE.PlaneGeometry(20, 12),
          new THREE.MeshStandardNodeMaterial({ color: 0x808080, roughness: 1 }),
        );
        wall.position.set(0, 2, -15);
        scene.add(wall);
        const pipeline = createPostProcessing(renderer, scene, camera);
        await preparePostProcessing(pipeline);
        const batch = new EmitterVolumeBatch(scene);
        const optics = {
          shape: "round" as const,
          radius: 0.02,
          slopeX: 0.025,
          slopeY: 0.025,
          halfPowerRatio: 0.5,
          distributionPower: 4,
          lumens: 1000,
        };
        const sources = Array.from({ length: 300 }, (_, i) => {
          const parent = new THREE.Object3D();
          parent.position.set(
            ((i % 20) - 9.5) * 0.5,
            1 + Math.floor(i / 20) * 0.25,
            0,
          );
          return {
            id: `source:${i}`,
            parent,
            color: {
              red: i % 3 === 0 ? 1 : 0.1,
              green: i % 3 === 1 ? 1 : 0.1,
              blue: i % 3 === 2 ? 1 : 0.1,
              intensity: 1,
            },
          };
        });
        const timer = new GpuFrameTimer();
        const pacing = new FramePacing();
        const timedRenderer = renderer as unknown as TimestampRenderer;
        const samples: {
          interval: number;
          /** Animation-frame timestamp the callback was scheduled for. */
          scheduledAt: number;
          /** Delay from the scheduled timestamp to the completed submission. */
          latencyMs: number;
          cpuMs: number;
          gpu: ReturnType<typeof readGpu>;
          scale: number;
          sceneScale: number;
        }[] = [];
        /** Retains completed GPU samples without synchronizing the animation loop. */
        function readGpu() {
          return timer.sample;
        }
        let frame = 0;
        let previous = 0;
        let measureStart = Number.POSITIVE_INFINITY;
        try {
          await new Promise<void>((resolve, reject) => {
            renderer.setAnimationLoop((scheduledAt: number) => {
              try {
                if (frame === warmupFrames) {
                  performance.mark("nightfall-playback-measure-start");
                  measureStart = performance.now();
                }
                const started = performance.now();
                for (let i = 0; i < sources.length; i++) {
                  const source = sources[i];
                  source.parent.rotation.y =
                    Math.sin(frame / 120 + i / 20) * 0.08;
                  batch.update(source.id, source.parent, {
                    optics,
                    color: source.color,
                    length: 20,
                  });
                }
                const updateMs = performance.now() - started;
                timer.begin(timedRenderer);
                renderWithPostProcessing(pipeline, timer.sample, updateMs);
                timer.end(timedRenderer);
                const completed = performance.now();
                if (frame >= warmupFrames) {
                  pacing.record(
                    completed,
                    updateMs,
                    undefined,
                    started,
                    scheduledAt,
                  );
                  samples.push({
                    interval: completed - previous,
                    scheduledAt,
                    latencyMs: completed - scheduledAt,
                    cpuMs: completed - started,
                    gpu: readGpu(),
                    scale: pipeline.gpuBudget.resolutionScale,
                    sceneScale: pipeline.scenePass.getResolutionScale(),
                  });
                }
                previous = completed;
                frame++;
                if (completed - measureStart >= measuredMs) {
                  performance.mark("nightfall-playback-measure-end");
                  renderer.setAnimationLoop(null);
                  resolve();
                }
              } catch (error) {
                renderer.setAnimationLoop(null);
                reject(error);
              }
            });
          });
          const copy = document.createElement("canvas");
          copy.width = 800;
          copy.height = 700;
          copy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
          return {
            backend,
            samples,
            pacing: pacing.snapshot(),
            image: copy.toDataURL("image/png"),
          };
        } finally {
          renderer.setAnimationLoop(null);
          await timer.dispose();
          batch.dispose();
          disposePostProcessing(pipeline);
          wall.geometry.dispose();
          wall.material.dispose();
          renderer.dispose();
        }
      },
      { warmupFrames: WARMUP_FRAMES, measuredMs: MEASURED_MS },
    );
  const outcome = await runWorkload().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    presentationTrace = await stopTrace();
  } catch (stopError) {
    // A crashed page also breaks the trace session; keep the workload's own error.
    if (outcome.ok) throw stopError;
  }
  // This benchmark is opt-in, so its reports are retained for review unless it was skipped.
  if (presentationTrace && testInfo.expectedStatus !== "skipped")
    await testInfo.attach("optical-stress-presentation.json", {
      body: presentationTrace,
      contentType: "application/json",
    });
  if (!outcome.ok) throw outcome.error;
  const result = outcome.value;
  annotateBackend(testInfo, result.backend);
  await testInfo.attach("optical-stress.json", {
    body: JSON.stringify(result.samples),
    contentType: "application/json",
  });
  await testInfo.attach("optical-stress-pacing.json", {
    body: JSON.stringify(result.pacing),
    contentType: "application/json",
  });
  await testInfo.attach("optical-stress.png", {
    body: Buffer.from(result.image.split(",")[1], "base64"),
    contentType: "image/png",
  });
  expect(errors).toEqual([]);
  const presentation = summarizePresentationTrace(
    JSON.parse(presentationTrace!),
  );
  await testInfo.attach("optical-stress-presentation-summary.json", {
    body: JSON.stringify(presentation),
    contentType: "application/json",
  });
  testInfo.annotations.push({
    type: "refresh-interval",
    description: `${refreshIntervalMs.toFixed(2)}ms`,
  });
  expectPresentationWithinBudget(
    presentation,
    "CanvasAnimation",
    refreshIntervalMs,
  );
  expect(
    result.samples.length,
    "Rendered frames over the measured interval at the display refresh rate",
  ).toBeGreaterThanOrEqual(
    minimumPresentedFrames(MEASURED_MS, refreshIntervalMs),
  );
  const skipThresholdMs = frameSkipThresholdMs(refreshIntervalMs);
  const intervals = result.samples
    .map((sample) => sample.interval)
    .sort((a, b) => a - b);
  const scheduledIntervals = result.samples
    .slice(1)
    .map((sample, i) => sample.scheduledAt - result.samples[i].scheduledAt);
  expect(
    percentile(intervals, 0.99),
    "p99 frame interval under optical load",
  ).toBeLessThanOrEqual(skipThresholdMs);
  expect(
    ratio(
      scheduledIntervals.filter((interval) => interval > skipThresholdMs)
        .length,
      scheduledIntervals.length,
    ),
    "Share of refreshes skipped under optical load",
  ).toBeLessThanOrEqual(MAX_SKIPPED_FRAME_RATIO);
  expect(
    ratio(
      result.samples.filter((sample) => sample.latencyMs > refreshIntervalMs)
        .length,
      result.samples.length,
    ),
    "Share of submissions after their frame deadline",
  ).toBeLessThanOrEqual(MAX_LATE_SUBMISSION_RATIO);
});
