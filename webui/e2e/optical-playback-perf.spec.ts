// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { TimestampRenderer } from "../features/visualizer/rendering/gpu-frame-timer";
import { annotateBackend, openOpticsFixture } from "./optics-harness";
import {
  expectPresentationWithinBudget,
  MAX_LATE_SUBMISSION_RATIO,
  MAX_SKIPPED_FRAME_RATIO,
  P99_FRAME_INTERVAL_MS,
  percentile,
  ratio,
} from "./perf-budgets";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { summarizePresentationTrace } from "./visualizer-presentation-report";
import { startVisualizerPresentationTrace } from "./visualizer-presentation-trace";

/** Measured frames after the 120-frame warm-up; twelve seconds span a full five-second Chromium tracker window. */
const MEASURED_FRAMES = 720;

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
  const stopTrace = await startVisualizerPresentationTrace(page);
  let presentationTrace: string | undefined;
  const result = await page
    .evaluate(async () => {
      const THREE = await import("/e2e/fixtures/three-api.ts");
      const { createRenderer } = await import(
        "/features/visualizer/rendering/renderer.ts"
      );
      const {
        createPostProcessing,
        preparePostProcessing,
        renderWithPostProcessing,
        disposePostProcessing,
      } = await import(
        "/features/visualizer/rendering/effects/post-processing.ts"
      );
      const { EmitterVolumeBatch } = await import(
        "/features/visualizer/rendering/effects/emitter-volume-batch.ts"
      );
      const { GpuFrameTimer } = await import(
        "/features/visualizer/rendering/gpu-frame-timer.ts"
      );
      const { FramePacing } = await import(
        "/features/visualizer/services/frame-pacing.ts"
      );
      const renderer = createRenderer({
        canvas: document.querySelector("canvas")!,
        devicePixelRatio: 1,
      });
      renderer.setSize(800, 700);
      await renderer.init();
      const { verifyBackend } = await import("/e2e/fixtures/optics-harness.ts");
      const backend = await verifyBackend(renderer, undefined);
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
      try {
        await new Promise<void>((resolve, reject) => {
          renderer.setAnimationLoop((scheduledAt: number) => {
            try {
              if (frame === 120)
                performance.mark("nightfall-playback-measure-start");
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
              if (frame >= 120) {
                pacing.record(
                  completed,
                  updateMs,
                  undefined,
                  started,
                  scheduledAt,
                );
                samples.push({
                  interval: completed - previous,
                  cpuMs: completed - started,
                  gpu: readGpu(),
                  scale: pipeline.gpuBudget.resolutionScale,
                  sceneScale: pipeline.scenePass.getResolutionScale(),
                });
              }
              previous = completed;
              // Twelve seconds contain a complete five-second Chromium tracker window.
              if (++frame === 840) {
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
    })
    .finally(async () => {
      presentationTrace = await stopTrace();
      // This benchmark is opt-in, so its reports are always retained for review.
      await testInfo.attach("optical-stress-presentation.json", {
        body: presentationTrace,
        contentType: "application/json",
      });
    });
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
  expectPresentationWithinBudget(presentation, "CanvasAnimation");
  expect(result.samples).toHaveLength(MEASURED_FRAMES);
  const scheduling = result.pacing.scheduling;
  expect(
    scheduling?.frames,
    "Every measured frame must include scheduler timing",
  ).toBe(MEASURED_FRAMES);
  const intervals = result.samples
    .map((sample) => sample.interval)
    .sort((a, b) => a - b);
  expect(
    percentile(intervals, 0.99),
    "p99 frame interval under optical load",
  ).toBeLessThanOrEqual(P99_FRAME_INTERVAL_MS);
  expect(
    ratio(scheduling?.over25Ms, scheduling?.frames),
    "Share of refreshes skipped under optical load",
  ).toBeLessThanOrEqual(MAX_SKIPPED_FRAME_RATIO);
  expect(
    ratio(scheduling?.lateSubmissions, scheduling?.frames),
    "Share of submissions after their 60 Hz frame budget",
  ).toBeLessThanOrEqual(MAX_LATE_SUBMISSION_RATIO);
});
