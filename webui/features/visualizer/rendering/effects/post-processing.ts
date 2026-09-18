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
import { PostProcessing, type WebGPURenderer } from "three/webgpu";

/** Post-processing configuration */
export interface PostProcessingConfig {
  /** Bloom strength (default: 0.4) */
  bloomStrength: number;
  /** Bloom radius (default: 0.3) */
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
  bloomStrength: 0.4,
  bloomRadius: 0.3,
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
  postProcessing: PostProcessing;
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
  const config = {
    ...defaultPostProcessingConfig,
    ...options?.configOverrides,
  };

  // Create scene pass
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode("output");

  // Create bloom pass
  const bloomPass = bloom(
    scenePassColor,
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
  const postProcessing = new PostProcessing(renderer);
  postProcessing.outputNode = scenePassColor
    .add(bloomPass)
    .add(selectionOutlineColor)
    .add(editSelectionOutlineColor)
    .add(programmerValueOutlineColor)
    .add(activeSpanOutlineColor);

  return {
    postProcessing,
    scenePass,
    bloomPass,
    outlinePass,
    editSelectionOutlinePass,
    programmerValueOutlinePass,
    activeSpanOutlinePass,
    config,
  };
}

/** Update objects receiving the programmer-selection outline. */
export function setOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.outlinePass.selectedObjects = selectedObjects;
}

/** Update objects receiving the panel edit-selection outline. */
export function setEditSelectionOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.editSelectionOutlinePass.selectedObjects = selectedObjects;
}

/** Update objects receiving the programmer-value outline. */
export function setProgrammerValueOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.programmerValueOutlinePass.selectedObjects = selectedObjects;
}

/** Update objects receiving the prominent active-span outline. */
export function setActiveSpanOutlineSelectedObjects(
  state: PostProcessingState,
  selectedObjects: Object3D[],
): void {
  state.activeSpanOutlinePass.selectedObjects = selectedObjects;
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
export function renderWithPostProcessing(state: PostProcessingState): void {
  state.postProcessing.render();
}

export function disposePostProcessing(
  state: PostProcessingState | null | undefined,
): void {
  if (!state) return;
  state.outlinePass.dispose();
  state.editSelectionOutlinePass.dispose();
  state.programmerValueOutlinePass.dispose();
  state.activeSpanOutlinePass.dispose();
  state.postProcessing.dispose();
}
