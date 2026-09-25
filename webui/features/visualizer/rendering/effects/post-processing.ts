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
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { outline } from "three/addons/tsl/display/OutlineNode.js";
import {
  color,
  Fn,
  float,
  fwidth,
  luminance,
  mix,
  pass,
  renderOutput,
  smoothstep,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import type { Camera, Node, Object3D } from "three/webgpu";
import {
  NodeMaterial,
  QuadMesh,
  RenderPipeline,
  Scene,
  UnsignedByteType,
  type WebGPURenderer,
} from "three/webgpu";
import { type QualityProfile, resolveQualityProfile } from "../quality-profile";
import { GpuBudget, type GpuBudgetSample } from "./gpu-budget";
import { createOpticalRenderContext } from "./optical-render-context";
import { OpticalSurfaceLighting } from "./optical-surface-lighting";

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

/** Atmosphere resolution used by profiles that do not adapt it to GPU headroom. */
const FIXED_ATMOSPHERE_RESOLUTION_SCALE = 0.5;

/** State for post-processing effects */
export interface PostProcessingState {
  profile: QualityProfile;
  renderer: WebGPURenderer;
  scene: Scene;
  camera: Camera;
  /** Adapts soft-effect resolution and optional shadow refreshes to measured frame cost. */
  gpuBudget: GpuBudget;
  /** Only selected cell proxies participate in scene projection and outline depth passes. */
  visibleOutlineProxies: Set<Object3D>;
  surfaceLighting: OpticalSurfaceLighting;
  volumePass: ReturnType<typeof pass>;
  postProcessing: RenderPipeline;
  scenePass: ReturnType<typeof pass>;
  /** Display conversion precedes FXAA edge filtering to preserve HDR coverage. */
  displayPass?: ReturnType<typeof pass>;
  displayMaterial?: NodeMaterial;
  /** Present only when the quality profile blooms. */
  bloomPass?: ReturnType<typeof bloom>;
  /** Renderer hooks replaced by this pipeline, restored when it is disposed. */
  replacedRendererHooks: {
    lighting: WebGPURenderer["lighting"];
    renderObjectFunction: ReturnType<WebGPURenderer["getRenderObjectFunction"]>;
  };
  outlinePass: ReturnType<typeof outline>;
  editSelectionOutlinePass: ReturnType<typeof outline>;
  programmerValueOutlinePass: ReturnType<typeof outline>;
  activeSpanOutlinePass: ReturnType<typeof outline>;
  config: PostProcessingConfig;
}

/**
 * Creates the bloom pass over the lit scene with a bright pass that integrates each
 * pixel's footprint, so thin HDR emitters cannot fall between reduced-resolution samples.
 */
function createBloomPass(
  litColor: Node<"vec4">,
  sceneColor: ReturnType<ReturnType<typeof pass>["getTextureNode"]>,
  volumePass: ReturnType<typeof pass>,
  config: PostProcessingConfig,
): ReturnType<typeof bloom> {
  const bloomPass = bloom(
    litColor,
    config.bloomStrength,
    config.bloomRadius,
    config.bloomThreshold,
  );
  const atmosphereColor = volumePass.getTextureNode("output");
  // BloomNode hands this function its input evaluated at the current UV only. Integrating
  // the footprint needs samples at offset UVs, and the input is a sum of two passes rather
  // than one samplable texture, so both source textures are resampled here directly.
  bloomPass.highPassFn = Fn(
    ({
      threshold,
      smoothWidth,
    }: Parameters<typeof bloomPass.highPassFn>[0]) => {
      const coordinates = uv();
      const footprint = fwidth(coordinates);
      const filtered = vec4(0).toVar();
      for (const y of [-0.25, 0.25]) {
        for (const x of [-0.25, 0.25]) {
          const sampleUV = coordinates.add(footprint.mul(vec2(x, y)));
          filtered.addAssign(
            sceneColor
              .sample(sampleUV)
              .add(atmosphereColor.sample(sampleUV))
              .mul(0.25),
          );
        }
      }
      return mix(
        vec4(0),
        filtered,
        smoothstep(
          threshold,
          threshold.add(smoothWidth),
          luminance(filtered.rgb),
        ),
      );
    },
  );
  return bloomPass;
}

/**
 * Create the post-processing pipeline for a quality profile: the scene and atmosphere
 * passes, optional bloom and FXAA display conversion, and the selection outlines.
 */
export function createPostProcessing(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  options?: {
    profile?: QualityProfile;
    selectedObjects?: Object3D[];
    editSelectionObjects?: Object3D[];
    programmerValueObjects?: Object3D[];
    activeSpanObjects?: Object3D[];
    configOverrides?: Partial<PostProcessingConfig>;
  },
): PostProcessingState {
  const replacedRendererHooks = {
    lighting: renderer.lighting,
    renderObjectFunction: renderer.getRenderObjectFunction(),
  };
  /** Outline passes install their own draw callback; the beauty pass skips invisible selection proxies. */
  renderer.setRenderObjectFunction(
    (...args: Parameters<WebGPURenderer["renderObject"]>) => {
      if (args[0].userData.visualizerOutlineOnly === true) return;
      renderer.renderObject(...args);
    },
  );
  const profile = options?.profile ?? resolveQualityProfile("high");
  const surfaceLighting = new OpticalSurfaceLighting(profile);
  renderer.lighting = surfaceLighting;
  const config = {
    ...defaultPostProcessingConfig,
    ...options?.configOverrides,
  };

  // Preserve subpixel emitter coverage while keeping the atmospheric integration single-sampled.
  const scenePass = pass(scene, camera, { samples: 4 });
  scenePass.getTexture("output").name = "scene";
  const scenePassColor = scenePass.getTextureNode("output");
  const opticalContext = createOpticalRenderContext(
    scene,
    scenePass.getViewZNode(),
    {
      profile,
      surfaceLighting: true,
      goboAtlas: surfaceLighting.goboAtlas,
      shadows: surfaceLighting.shadows,
    },
  );
  const volumePass = pass(opticalContext.scene, camera, {
    samples: 0,
  }).setResolutionScale(FIXED_ATMOSPHERE_RESOLUTION_SCALE);
  volumePass.getTexture("output").name = "atmosphere";
  const litColor = scenePassColor.add(volumePass.getTextureNode("output"));
  const bloomPass = profile.bloom
    ? createBloomPass(litColor, scenePassColor, volumePass, config)
    : undefined;

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
    .add(bloomPass ?? float(0))
    .add(selectionOutlineColor)
    .add(editSelectionOutlineColor)
    .add(programmerValueOutlineColor)
    .add(activeSpanOutlineColor);
  let displayPass: ReturnType<typeof pass> | undefined;
  let displayMaterial: NodeMaterial | undefined;
  if (profile.fxaa) {
    displayMaterial = new NodeMaterial();
    displayMaterial.fragmentNode = renderOutput(
      postProcessing.outputNode,
      renderer.toneMapping,
      renderer.outputColorSpace,
    );
    const quad = new QuadMesh(displayMaterial);
    const displayScene = new Scene();
    displayScene.add(quad);
    displayPass = pass(displayScene, quad.camera, {
      samples: 0,
      type: UnsignedByteType,
      depthBuffer: false,
    });
    postProcessing.outputNode = fxaa(displayPass.getTextureNode("output"));
    postProcessing.outputColorTransform = false;
  }

  const state: PostProcessingState = {
    profile,
    renderer,
    scene,
    camera,
    gpuBudget: new GpuBudget(),
    visibleOutlineProxies: new Set(),
    surfaceLighting,
    volumePass,
    postProcessing,
    scenePass,
    displayPass,
    displayMaterial,
    bloomPass,
    replacedRendererHooks,
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
  if (state.bloomPass && config.bloomStrength !== undefined) {
    state.bloomPass.strength.value = config.bloomStrength;
  }
  if (state.bloomPass && config.bloomRadius !== undefined) {
    state.bloomPass.radius.value = config.bloomRadius;
  }
  // Note: threshold is set at creation time and can't be updated dynamically
  // in the current Three.js bloom implementation

  Object.assign(state.config, config);
}

/** Allocates and compiles GPU work the profile needs before the first frame, such as shadow maps. */
export async function preparePostProcessing(
  state: PostProcessingState,
): Promise<void> {
  await state.surfaceLighting.shadows?.prepare(state.renderer);
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
  const scale = state.gpuBudget.observe(gpu, started);
  const atmosphereScale = state.profile.adaptiveAtmosphereResolution
    ? scale
    : FIXED_ATMOSPHERE_RESOLUTION_SCALE;
  if (state.volumePass.getResolutionScale() !== atmosphereScale)
    state.volumePass.setResolutionScale(atmosphereScale);
  // Preserve native-resolution geometry; only the soft effects trade pixels for GPU headroom.
  if (state.bloomPass && state.bloomPass.getResolutionScale() !== scale)
    state.bloomPass.setResolutionScale(scale);
  const shadows = state.surfaceLighting.shadows;
  if (shadows)
    shadows.update(
      state.renderer,
      state.scene,
      state.camera,
      started,
      state.gpuBudget.canRefreshShadows(updateMs, started),
      state.gpuBudget.shadowRefreshIntervalMs,
    );
  state.postProcessing.render();
  state.gpuBudget.recordRender(performance.now() - started, updateMs);
}

/**
 * Releases every pass's targets and materials, including resources not owned by RenderPipeline,
 * and hands the renderer back its previous lighting and object-draw hooks.
 */
export function disposePostProcessing(
  state: PostProcessingState | null | undefined,
): void {
  if (!state) return;
  const { renderer, replacedRendererHooks } = state;
  if (renderer.lighting === state.surfaceLighting)
    renderer.lighting = replacedRendererHooks.lighting;
  renderer.setRenderObjectFunction(replacedRendererHooks.renderObjectFunction);
  state.surfaceLighting.dispose();
  state.outlinePass.dispose();
  state.editSelectionOutlinePass.dispose();
  state.programmerValueOutlinePass.dispose();
  state.activeSpanOutlinePass.dispose();
  state.bloomPass?.dispose();
  state.volumePass.dispose();
  state.scenePass.dispose();
  state.displayPass?.dispose();
  state.displayMaterial?.dispose();
  state.postProcessing.dispose();
}
