// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Color, type Node, Scene } from "three/webgpu";
import type { VisualizerBeamQuality } from "../../../../lib/feature-flags";
import type { GoboAtlas } from "./gobo-atlas";
import type { OpticalShadowPool } from "./optical-shadow-pool";

export interface OpticalRenderContext {
  quality: VisualizerBeamQuality;
  scene: Scene;
  viewDepth: Node<"float">;
  surfaceScene?: Scene;
  goboAtlas?: GoboAtlas;
  shadows?: OpticalShadowPool;
}

const contexts = new WeakMap<Scene, OpticalRenderContext>();

/** Gives emitter batches the opaque-depth input and separate atmospheric scene owned by their pipeline. */
export function createOpticalRenderContext(
  scene: Scene,
  viewDepth: Node<"float">,
  surfaceLighting = false,
  goboAtlas?: GoboAtlas,
  shadows?: OpticalShadowPool,
  quality: VisualizerBeamQuality = "high",
): OpticalRenderContext {
  const atmosphere = new Scene();
  atmosphere.name = "AtmosphericEmitters";
  atmosphere.background = new Color(0);
  const context = {
    quality,
    scene: quality === "medium" ? scene : atmosphere,
    viewDepth,
    surfaceScene: surfaceLighting ? scene : undefined,
    goboAtlas,
    shadows,
  };
  contexts.set(scene, context);
  return context;
}

/** Looks up a scene-local pipeline without global renderer or camera ownership. */
export function getOpticalRenderContext(
  scene: Scene,
): OpticalRenderContext | undefined {
  return contexts.get(scene);
}
