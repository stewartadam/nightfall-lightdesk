// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Color, type Node, Scene } from "three/webgpu";
import { type QualityProfile, resolveQualityProfile } from "../quality-profile";
import type { GoboAtlas } from "./gobo-atlas";
import type { OpticalShadowPool } from "./optical-shadow-pool";

/** Scene-local resources the post-processing pipeline shares with emitter batches. */
export interface OpticalRenderContext {
  /** Capabilities the owning pipeline was built for; emitter batches draw to match it. */
  profile: QualityProfile;
  /** Separate scene drawn by the atmospheric pass. */
  scene: Scene;
  /** View-space depth of the opaque scene, used to clip beams behind geometry. */
  viewDepth: Node<"float">;
  /** Scene receiving clustered optical surface lights, when surface lighting is installed. */
  surfaceScene?: Scene;
  goboAtlas?: GoboAtlas;
  shadows?: OpticalShadowPool;
}

/** Optional shared resources owned by the pipeline creating an optical render context. */
export interface OpticalRenderContextOptions {
  /** Pipeline capabilities; defaults to the High preset. */
  profile?: QualityProfile;
  /** Routes surface lights into the rendered scene; the pipeline must install matching lighting. */
  surfaceLighting?: boolean;
  goboAtlas?: GoboAtlas;
  shadows?: OpticalShadowPool;
}

const contexts = new WeakMap<Scene, OpticalRenderContext>();

/** Gives emitter batches the opaque-depth input and separate atmospheric scene owned by their pipeline. */
export function createOpticalRenderContext(
  scene: Scene,
  viewDepth: Node<"float">,
  options: OpticalRenderContextOptions = {},
): OpticalRenderContext {
  const atmosphere = new Scene();
  atmosphere.name = "AtmosphericEmitters";
  atmosphere.background = new Color(0);
  const context = {
    profile: options.profile ?? resolveQualityProfile("high"),
    scene: atmosphere,
    viewDepth,
    surfaceScene: options.surfaceLighting ? scene : undefined,
    goboAtlas: options.goboAtlas,
    shadows: options.shadows,
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
