// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Post-processing setup for visualizer.
 * Configures bloom effect for enhanced lighting visuals.
 */

import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { outline } from "three/addons/tsl/display/OutlineNode.js";
import { color, float, pass } from "three/tsl";
import type { Camera, Object3D, Scene } from "three/webgpu";
import { RenderPipeline, type WebGPURenderer } from "three/webgpu";
import { AtmosphereBudget, type GpuBudgetSample } from "./atmosphere-budget";
import { createOpticalRenderContext } from "./optical-render-context";
import { OpticalSurfaceLighting } from "./optical-surface-lighting";
import { ShadowRefreshBudget } from "./shadow-refresh-budget";

/** Post-processing configuration */
export interface PostProcessingConfig {
  /** Bloom strength (default: 0.8) */
  bloomStrength: number;
  /** Bloom radius (default: 0.85) */
  bloomRadius: number;
  /** Bloom threshold (default: 0.8) */
  bloomThreshold: number;
  /** Selection outline intensity multiplier */
  outlineStrength: number;
  /** Selection outline edge thickness */
  outlineThickness: number;
  /** Selection outline glow amount */
  outlineGlow: number;
  /** Selection outline visible edge color */
  outlineVisibleColor: string;
  /** Selection outline hidden edge color */
  outlineHiddenColor: string;
  /** Edit-selection outline intensity multiplier */
  editSelectionOutlineStrength: number;
  /** Edit-selection outline edge thickness */
  editSelectionOutlineThickness: number;
  /** Edit-selection outline glow amount */
  editSelectionOutlineGlow: number;
  /** Edit-selection outline visible edge color */
  editSelectionOutlineVisibleColor: string;
  /** Edit-selection outline hidden edge color */
  editSelectionOutlineHiddenColor: string;
  /** Programmer-value outline intensity multiplier */
  programmerValueOutlineStrength: number;
  /** Programmer-value outline edge thickness */
  programmerValueOutlineThickness: number;
  /** Programmer-value outline glow amount */
  programmerValueOutlineGlow: number;
  /** Programmer-value outline visible edge color */
  programmerValueOutlineVisibleColor: string;
  /** Programmer-value outline hidden edge color */
  programmerValueOutlineHiddenColor: string;
  /** Active span outline intensity multiplier */
  activeSpanOutlineStrength: number;
  /** Active span outline edge thickness */
  activeSpanOutlineThickness: number;
  /** Active span outline glow amount */
  activeSpanOutlineGlow: number;
  /** Active span outline visible edge color */
  activeSpanOutlineVisibleColor: string;
  /** Active span outline hidden edge color */
  activeSpanOutlineHiddenColor: string;
}

export const defaultPostProcessingConfig: PostProcessingConfig = {
  bloomStrength: 0.8,
  bloomRadius: 0.85,
  bloomThreshold: 0.8,
  outlineStrength: 1.4,
  outlineThickness: 1.2,
  outlineGlow: 0.0,
  outlineVisibleColor: "#ffffff",
  outlineHiddenColor: "#9ca3af",
  editSelectionOutlineStrength: 1.8,
  editSelectionOutlineThickness: 1.6,
  editSelectionOutlineGlow: 0.02,
  editSelectionOutlineVisibleColor: "#facc15",
  editSelectionOutlineHiddenColor: "#ca8a04",
  programmerValueOutlineStrength: 2.2,
  programmerValueOutlineThickness: 1.8,
  programmerValueOutlineGlow: 0.04,
  programmerValueOutlineVisibleColor: "#ef4444",
  programmerValueOutlineHiddenColor: "#991b1b",
  activeSpanOutlineStrength: 3.2,
  activeSpanOutlineThickness: 2.0,
  activeSpanOutlineGlow: 0.08,
  activeSpanOutlineVisibleColor: "#ffffff",
  activeSpanOutlineHiddenColor: "#9ca3af",
};

/** State for post-processing effects */
export interface PostProcessingState {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: Camera;
  shadowBudget: ShadowRefreshBudget;
  /** Only selected cell proxies participate in scene projection and outline depth passes. */
  visibleOutlineProxies: Set<Object3D>;
  surfaceLighting?: OpticalSurfaceLighting;
  atmosphereBudget: AtmosphereBudget;
  volumePass: ReturnType<typeof pass>;
  postProcessing: RenderPipeline;
  scenePass: ReturnType<typeof pass>;
  bloomPass: ReturnType<typeof bloom>;
  outlinePass: ReturnType<typeof outline>;
  editSelectionOutlinePass: ReturnType<typeof outline>;
  programmerValueOutlinePass: ReturnType<typeof outline>;
  activeSpanOutlinePass: ReturnType<typeof outline>;
  config: PostProcessingConfig;
}

/**
 * Create post-processing pipeline with bloom effect.
 */
export function createPostProcessing(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  options?: {
    selectedObjects?: Object3D[];
    editSelectionObjects?: Object3D[];
    programmerValueObjects?: Object3D[];
    activeSpanObjects?: Object3D[];
    configOverrides?: Partial<PostProcessingConfig>;
  },
): PostProcessingState {
  /** Outline passes install their own draw callback; the beauty pass skips invisible selection proxies. */
  renderer.setRenderObjectFunction(
    (...args: Parameters<WebGPURenderer["renderObject"]>) => {
      if (args[0].userData.visualizerOutlineOnly === true) return;
      renderer.renderObject(...args);
    },
  );
  const surfaceLighting = new OpticalSurfaceLighting();
  renderer.lighting = surfaceLighting;
  const config = {
    ...defaultPostProcessingConfig,
    ...options?.configOverrides,
  };

  // Keep native pixel detail; single-sample offscreen targets avoid the bandwidth cost of MSAA.
  const scenePass = pass(scene, camera, { samples: 0 });
  scenePass.getTexture("output").name = "scene";
  const scenePassColor = scenePass.getTextureNode("output");
  const opticalContext = createOpticalRenderContext(
    scene,
    scenePass.getViewZNode(),
    surfaceLighting !== undefined,
    surfaceLighting?.goboAtlas,
    surfaceLighting?.shadows,
  );
  const volumePass = pass(opticalContext.scene, camera, {
    samples: 0,
  }).setResolutionScale(0.5);
  volumePass.getTexture("output").name = "atmosphere";
  const litColor = scenePassColor.add(volumePass.getTextureNode("output"));

  // Create bloom pass
  const bloomPass = bloom(
    litColor,
    config.bloomStrength,
    config.bloomRadius,
    config.bloomThreshold,
  );

  // Create separate outline passes for programmer, edit, and active-span state.
  const outlinePass = outline(scene, camera, {
    selectedObjects: options?.selectedObjects ?? [],
    edgeThickness: float(config.outlineThickness),
    edgeGlow: float(config.outlineGlow),
  });
  const editSelectionOutlinePass = outline(scene, camera, {
    selectedObjects: options?.editSelectionObjects ?? [],
    edgeThickness: float(config.editSelectionOutlineThickness),
    edgeGlow: float(config.editSelectionOutlineGlow),
  });
  const programmerValueOutlinePass = outline(scene, camera, {
    selectedObjects: options?.programmerValueObjects ?? [],
    edgeThickness: float(config.programmerValueOutlineThickness),
    edgeGlow: float(config.programmerValueOutlineGlow),
  });
  const activeSpanOutlinePass = outline(scene, camera, {
    selectedObjects: options?.activeSpanObjects ?? [],
    edgeThickness: float(config.activeSpanOutlineThickness),
    edgeGlow: float(config.activeSpanOutlineGlow),
  });
  const selectionOutlineColor = outlinePass.visibleEdge
    .mul(color(config.outlineVisibleColor))
    .add(outlinePass.hiddenEdge.mul(color(config.outlineHiddenColor)))
    .mul(float(config.outlineStrength));
  const editSelectionOutlineColor = editSelectionOutlinePass.visibleEdge
    .mul(color(config.editSelectionOutlineVisibleColor))
    .add(
      editSelectionOutlinePass.hiddenEdge.mul(
        color(config.editSelectionOutlineHiddenColor),
      ),
    )
    .mul(float(config.editSelectionOutlineStrength));
  const programmerValueOutlineColor = programmerValueOutlinePass.visibleEdge
    .mul(color(config.programmerValueOutlineVisibleColor))
    .add(
      programmerValueOutlinePass.hiddenEdge.mul(
        color(config.programmerValueOutlineHiddenColor),
      ),
    )
    .mul(float(config.programmerValueOutlineStrength));
  const activeSpanOutlineColor = activeSpanOutlinePass.visibleEdge
    .mul(color(config.activeSpanOutlineVisibleColor))
    .add(
      activeSpanOutlinePass.hiddenEdge.mul(
        color(config.activeSpanOutlineHiddenColor),
      ),
    )
    .mul(float(config.activeSpanOutlineStrength));

  // Create post-processing with combined output.
  const postProcessing = new RenderPipeline(renderer);
  postProcessing.outputNode = litColor
    .add(bloomPass)
    .add(selectionOutlineColor)
    .add(editSelectionOutlineColor)
    .add(programmerValueOutlineColor)
    .add(activeSpanOutlineColor);

  const state: PostProcessingState = {
    renderer,
    scene,
    camera,
    shadowBudget: new ShadowRefreshBudget(),
    visibleOutlineProxies: new Set(),
    surfaceLighting,
    atmosphereBudget: new AtmosphereBudget(),
    volumePass,
    postProcessing,
    scenePass,
    bloomPass,
    outlinePass,
    editSelectionOutlinePass,
    programmerValueOutlinePass,
    activeSpanOutlinePass,
    config,
  };
  syncOutlineProxyVisibility(state);
  return state;
}

/** Keeps invisible selection geometry out of render-list construction until an outline needs it. */
function syncOutlineProxyVisibility(state: PostProcessingState): void {
  for (const object of state.visibleOutlineProxies) object.visible = false;
  state.visibleOutlineProxies.clear();
  for (const pass of [
    state.outlinePass,
    state.editSelectionOutlinePass,
    state.programmerValueOutlinePass,
    state.activeSpanOutlinePass,
  ]) {
    for (const selected of pass.selectedObjects) {
      selected.traverse((object) => {
        if (object.userData.visualizerOutlineOnly !== true) return;
        object.visible = true;
        state.visibleOutlineProxies.add(object);
      });
    }
  }
}

/** Update objects receiving the programmer-selection outline. */
export function setOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.outlinePass.selectedObjects = selectedObjects;
  syncOutlineProxyVisibility(state);
}

/** Update objects receiving the panel edit-selection outline. */
export function setEditSelectionOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.editSelectionOutlinePass.selectedObjects = selectedObjects;
  syncOutlineProxyVisibility(state);
}

/** Update objects receiving the programmer-value outline. */
export function setProgrammerValueOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.programmerValueOutlinePass.selectedObjects = selectedObjects;
  syncOutlineProxyVisibility(state);
}

/** Update objects receiving the prominent active-span outline. */
export function setActiveSpanOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.activeSpanOutlinePass.selectedObjects = selectedObjects;
  syncOutlineProxyVisibility(state);
}

/**
 * Update bloom parameters at runtime.
 */
export function updateBloomConfig(
  state: PostProcessingState,
  config: Partial<PostProcessingConfig>,
): void {
  if (config.bloomStrength !== undefined) {
    state.bloomPass.strength.value = config.bloomStrength;
  }
  if (config.bloomRadius !== undefined) {
    state.bloomPass.radius.value = config.bloomRadius;
  }
  // Note: threshold is set at creation time and can't be updated dynamically
  // in the current Three.js bloom implementation

  Object.assign(state.config, config);
}

/**
 * Render the scene with post-processing.
 */
export function renderWithPostProcessing(
  state: PostProcessingState,
  gpu?: GpuBudgetSample,
  updateMs = 0,
): void {
  const started = performance.now();
  const scale = state.atmosphereBudget.update(gpu, started);
  if (state.volumePass.getResolutionScale() !== scale)
    state.volumePass.setResolutionScale(scale);
  // Preserve native-resolution geometry; only the soft effects trade pixels for GPU headroom.
  if (state.bloomPass.getResolutionScale() !== scale)
    state.bloomPass.setResolutionScale(scale);
  const allowShadowRefresh = state.shadowBudget.canRefresh(gpu, updateMs);
  state.surfaceLighting?.shadows.update(
    state.renderer,
    state.scene,
    state.camera,
    started,
    allowShadowRefresh,
  );
  state.postProcessing.render();
  state.shadowBudget.recordRender(performance.now() - started);
}

/** Releases every pass's targets and materials, including resources not owned by RenderPipeline. */
export function disposePostProcessing(
  state: PostProcessingState | null | undefined,
): void {
  if (!state) return;
  state.surfaceLighting?.dispose();
  state.outlinePass.dispose();
  state.editSelectionOutlinePass.dispose();
  state.programmerValueOutlinePass.dispose();
  state.activeSpanOutlinePass.dispose();
  state.bloomPass.dispose();
  state.volumePass.dispose();
  state.scenePass.dispose();
  state.postProcessing.dispose();
}
