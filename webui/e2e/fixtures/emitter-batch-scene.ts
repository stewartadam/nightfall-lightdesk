// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { pass } from "three/tsl";
import {
  Color,
  Object3D,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
} from "three/webgpu";
import { EmitterVolumeBatch } from "../../features/visualizer/rendering/effects/emitter-volume-batch";
import { createOpticalRenderContext } from "../../features/visualizer/rendering/effects/optical-render-context";
import {
  createTestRenderer,
  readPixels,
  renderFrames,
  retainCanvas,
} from "./optics-harness";

/** Canvas size shared by every batched-emitter scenario. */
const WIDTH = 800;
const HEIGHT = 600;

/** Narrow round beam used by the batched-emitter scenarios. */
export const BATCH_OPTICS = {
  shape: "round" as const,
  radius: 0.02,
  slopeX: 0.08,
  slopeY: 0.08,
  halfPowerRatio: 0.5,
  distributionPower: 4,
  lumens: 1000,
};

/** Saturated red emitter color bright enough to dominate the atmosphere pass. */
export const BATCH_RED = { red: 1, green: 0, blue: 0, intensity: 10 };

/** Red/blue totals of a capture and the horizontal gradient energy of its red channel. */
export type BatchCapture = { red: number; blue: number; edgeEnergy: number };

/**
 * Builds the production opaque + half-resolution atmosphere pipeline around an
 * `EmitterVolumeBatch`, viewed obliquely so beams cross the frame. `capture` renders
 * fresh instance data and measures it; `dispose` releases every GPU resource.
 */
export async function createBatchScene(forceWebGL: boolean) {
  const { renderer } = await createTestRenderer({
    forceWebGL,
    width: WIDTH,
    height: HEIGHT,
  });
  const scene = new Scene();
  scene.background = new Color(0);
  const camera = new PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(4, 2, 4);
  camera.lookAt(0, 0, -8);
  const opaque = pass(scene, camera);
  const context = createOpticalRenderContext(scene, opaque.getViewZNode());
  const atmosphere = pass(context.scene, camera).setResolutionScale(0.5);
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = opaque
    .getTextureNode()
    .add(atmosphere.getTextureNode());
  const batch = new EmitterVolumeBatch(scene);
  const parent = new Object3D();

  /**
   * Renders four frames so the pipeline submits the latest instance data, then sums
   * the red and blue channels and the red channel's horizontal edge energy. When
   * `retain` is given the frame is kept for failure diagnostics.
   */
  const capture = async (retain?: string): Promise<BatchCapture> => {
    await renderFrames(renderer, 4, () => pipeline.render());
    if (retain) retainCanvas(retain, renderer.domElement);
    const data = readPixels(renderer.domElement);
    let red = 0;
    let blue = 0;
    let edgeEnergy = 0;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i];
      blue += data[i + 2];
      if ((i / 4) % WIDTH !== 0) edgeEnergy += Math.abs(data[i] - data[i - 4]);
    }
    return { red, blue, edgeEnergy };
  };

  /** Releases the batch, passes, pipeline and renderer. */
  const dispose = () => {
    renderer.setAnimationLoop(null);
    batch.dispose();
    opaque.dispose();
    atmosphere.dispose();
    pipeline.dispose();
    renderer.dispose();
  };

  return { renderer, scene, camera, context, batch, parent, capture, dispose };
}
