// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Three.js renderer setup for Visualizer.
 * Uses WebGPU renderer with built-in inspector support.
 *
 * This module provides both:
 * - Low-level building blocks for custom setups (worker, preview, etc.)
 * - High-level `initRenderer` for main thread with all features
 */

import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Inspector } from "three/examples/jsm/inspector/Inspector.js";
import {
  ACESFilmicToneMapping,
  InspectorBase,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from "three/webgpu";
import {
  isVisualizerInspectorEnabled,
  type VisualizerBeamQuality,
} from "../../../lib/feature-flags";
import {
  cancelControlsInteraction,
  createControls,
  DEFAULT_CAMERA_ROTATION_MODE,
  disposeControlsBehavior,
  setControlsRotationMode,
} from "../interactions/camera-controls";
import { zoomCameraToGroups } from "../model/camera-fit";
import {
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_TARGET,
  getCameraState,
  loadCameraState,
  saveCameraState,
} from "../model/camera-state";
import { setupInspectorParams } from "../model/inspector-params";
import {
  createPostProcessing,
  disposePostProcessing,
  type PostProcessingState,
  renderWithPostProcessing,
} from "./effects/post-processing";
import { consumeDueFrame } from "./frame-rate-limiter";
import {
  GpuFrameTimer,
  type InspectorGpuFrame,
  readInspectorGpuSample,
  type TimestampRenderer,
} from "./gpu-frame-timer";
import {
  createSceneEnvironment,
  type SceneEnvironment,
  updateFloorTransparency,
  updateOrbitTargetIndicator,
} from "./scene-environment";

export {
  cancelControlsInteraction,
  createControls,
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_ROTATION_MODE,
  DEFAULT_CAMERA_TARGET,
  loadCameraState,
  saveCameraState,
  setControlsRotationMode,
  zoomCameraToGroups,
};

/**
 * Frame timing state for framerate limiting.
 */
interface FrameTiming {
  lastTime: number;
  accumulator: number;
}

// ============================================================================
// Reusable Building Blocks (for worker and main thread)
// ============================================================================

/**
 * Configuration for creating a WebGPU renderer.
 */
export interface RendererConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  devicePixelRatio?: number;
  clearColor?: number;
}

/**
 * Create a WebGPU renderer.
 * Works with both HTMLCanvasElement and OffscreenCanvas.
 */
export function createRenderer(config: RendererConfig): WebGPURenderer {
  const renderer = new WebGPURenderer({
    canvas: config.canvas as HTMLCanvasElement, // Cast for Three.js types
    // The scene pass owns multisampling; fullscreen composition and outline filters do not need it.
    antialias: false,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(config.devicePixelRatio ?? 2, 2));
  renderer.setClearColor(config.clearColor ?? 0x1a1a2e, 1);
  renderer.toneMapping = ACESFilmicToneMapping;
  return renderer;
}

/**
 * Create a new scene with optional name.
 */
export function createScene(name = "VisualizerScene"): Scene {
  const scene = new Scene();
  scene.name = name;
  return scene;
}

/**
 * Create a perspective camera with default settings.
 */
export function createCamera(
  aspectRatio: number,
  position = DEFAULT_CAMERA_POSITION,
  target = DEFAULT_CAMERA_TARGET,
): PerspectiveCamera {
  const camera = new PerspectiveCamera(55, aspectRatio, 0.1, 500);
  camera.name = "MainCamera";
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(target.x, target.y, target.z);
  return camera;
}

/**
 * Core renderer state shared between main thread and worker.
 */
interface CoreRendererState {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  environment: SceneEnvironment;
  isPaused: boolean;
  frameTiming: FrameTiming;
}

// ============================================================================
// Main Thread Only (full-featured renderer with Inspector)
// ============================================================================

/**
 * Renderer state containing all Three.js objects.
 */
export interface RendererState extends CoreRendererState {
  inspector?: Inspector;
  /** Bounded timing for normal playback; the developer inspector owns its own queries. */
  gpuTimer?: GpuFrameTimer;
  /** Post-processing state (optional, enabled by default) */
  postProcessing: PostProcessingState | null;
  updateInspector?: () => void;
}

/**
 * Initialize the Three.js WebGPU renderer and scene.
 * Main thread only - includes Inspector and post-processing.
 */
export async function initRenderer(
  canvas: HTMLCanvasElement,
  quality: VisualizerBeamQuality = "high",
): Promise<RendererState> {
  // Create WebGPU renderer (falls back to WebGL if WebGPU unavailable)
  const renderer = createRenderer({
    canvas,
    devicePixelRatio: window.devicePixelRatio,
  });

  let inspector: Inspector | undefined;
  if (isVisualizerInspectorEnabled()) {
    const { Inspector } = await import(
      "three/examples/jsm/inspector/Inspector.js"
    );
    inspector = new Inspector();
    renderer.inspector = inspector;
  }

  // Create scene
  const scene = new Scene();
  scene.name = "VisualizerScene";

  // Create camera
  const camera = new PerspectiveCamera(
    55, // FOV
    canvas.clientWidth / canvas.clientHeight, // Aspect ratio
    0.1, // Near plane
    500, // Far plane
  );
  camera.name = "MainCamera";

  // Create orbit controls with configurable rotation mode and dolly-through zoom
  const controls = createControls(camera, canvas);

  // Load saved camera state or use defaults
  const savedState = loadCameraState();
  if (savedState) {
    camera.position.set(
      savedState.position.x,
      savedState.position.y,
      savedState.position.z,
    );
    controls.target.set(
      savedState.target.x,
      savedState.target.y,
      savedState.target.z,
    );
  } else {
    camera.position.set(
      DEFAULT_CAMERA_POSITION.x,
      DEFAULT_CAMERA_POSITION.y,
      DEFAULT_CAMERA_POSITION.z,
    );
    controls.target.set(
      DEFAULT_CAMERA_TARGET.x,
      DEFAULT_CAMERA_TARGET.y,
      DEFAULT_CAMERA_TARGET.z,
    );
  }
  camera.lookAt(controls.target);

  // Save camera state when controls change
  controls.addEventListener("change", () => {
    saveCameraState(getCameraState(camera, controls));
  });

  // Setup scene with basic environment
  const environment = createSceneEnvironment(scene);

  // Setup post-processing with bloom
  await renderer.init();
  const postProcessing = createPostProcessing(renderer, scene, camera, {
    quality,
  });
  if (quality === "high")
    await postProcessing.surfaceLighting?.shadows.prepare(renderer);

  // Setup inspector parameters
  const updateInspector = inspector
    ? setupInspectorParams(
        renderer,
        inspector,
        camera,
        controls,
        environment,
        postProcessing,
      )
    : undefined;

  return {
    renderer,
    scene,
    camera,
    controls,
    inspector,
    gpuTimer: inspector ? undefined : new GpuFrameTimer(),
    environment,
    isPaused: false,
    frameTiming: { lastTime: 0, accumulator: 0 },
    postProcessing,
    updateInspector,
  };
}

/**
 * Frame timing metrics passed to instrumentation callback.
 */
interface FrameTimingMetrics {
  /** Actual animation callback entry and submission completion, using the performance clock. */
  startedAt: number;
  completedAt: number;
  /** Completed asynchronous GPU query sample from the active timing owner. */
  gpu?: { id: number; milliseconds: number; passes?: Record<string, number> };
  /** Current frame timestamp (ms) */
  time: number;
  /** Time spent in update callback (ms) */
  updateMs: number;
  /** Time spent rendering (ms) */
  renderMs: number;
}

/**
 * Render loop callbacks.
 */
export interface RenderLoopCallbacks {
  /** Called each frame for custom updates (e.g., emitter updates) */
  onUpdate?: () => void;
  /** Called each frame with timing metrics for instrumentation */
  onFrame?: (metrics: FrameTimingMetrics) => void;
}

/**
 * Start the render loop using WebGPU's setAnimationLoop.
 * Uses accumulator-based timing to cap at 60 FPS for consistent performance.
 * @param callbacks Optional callbacks for updates and instrumentation
 */
export function startRenderLoop(
  state: RendererState,
  callbacks?: RenderLoopCallbacks,
): void {
  state.isPaused = false;
  state.frameTiming.lastTime = 0;
  state.frameTiming.accumulator = 0;

  state.renderer.setAnimationLoop((time: number) => {
    const startedAt = performance.now();
    if (state.isPaused) {
      return;
    }

    // Calculate delta time
    const deltaTime =
      state.frameTiming.lastTime === 0 ? 0 : time - state.frameTiming.lastTime;
    state.frameTiming.lastTime = time;
    state.frameTiming.accumulator += deltaTime;

    // Only render when enough time has accumulated (60 FPS cap)
    const remainingFrameTime = consumeDueFrame(state.frameTiming.accumulator);
    if (remainingFrameTime === null) return;
    state.frameTiming.accumulator = remainingFrameTime;

    // Update controls
    state.controls.update();

    // Update floor transparency based on camera position
    updateFloorTransparency(state.environment, state.camera);
    updateOrbitTargetIndicator(
      state.environment,
      state.camera,
      state.controls.target,
    );

    // Update inspector stats after controls settle
    state.updateInspector?.();

    // Track update timing
    const updateStart = performance.now();
    callbacks?.onUpdate?.();
    const updateEnd = performance.now();

    // Render scene and track timing
    const gpu = state.inspector
      ? readInspectorGpuSample(
          (state.inspector as unknown as { frames: InspectorGpuFrame[] })
            .frames,
          (state.renderer as unknown as TimestampRenderer).backend
            .timestampQueryPool,
        )
      : state.gpuTimer?.sample;
    const renderStart = performance.now();
    const timedRenderer = state.renderer as unknown as TimestampRenderer;
    state.gpuTimer?.begin(timedRenderer);
    if (state.postProcessing) {
      // Render with post-processing (bloom, etc.)
      renderWithPostProcessing(
        state.postProcessing,
        gpu,
        updateEnd - updateStart,
      );
    } else {
      // Direct rendering without post-processing
      state.renderer.render(state.scene, state.camera);
    }
    state.gpuTimer?.end(timedRenderer);
    const renderEnd = performance.now();

    // Report timing metrics
    callbacks?.onFrame?.({
      startedAt,
      completedAt: renderEnd,
      time,
      updateMs: updateEnd - updateStart,
      renderMs: renderEnd - renderStart,
      gpu,
    });
  });
}

/**
 * Stop the render loop.
 */
export function stopRenderLoop(state: RendererState): void {
  state.isPaused = true;
  state.renderer.setAnimationLoop(null);
}

/**
 * Handle canvas resize.
 */
export function handleResize(
  state: RendererState,
  width: number,
  height: number,
  devicePixelRatio?: number,
): void {
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  if (devicePixelRatio !== undefined) {
    state.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  }
  state.renderer.setSize(width, height, false);
}

/**
 * Dispose all renderer resources.
 */
export async function disposeRenderer(state: RendererState): Promise<void> {
  stopRenderLoop(state);
  try {
    // The addon's declaration omits this public method. Its scheduled query
    // readback must finish before the renderer destroys the mapped buffers.
    if (state.inspector) {
      await (
        state.inspector as unknown as { resolveTimestamp(): Promise<void> }
      ).resolveTimestamp();
    }
    await state.gpuTimer?.dispose();
  } finally {
    state.renderer.inspector = new InspectorBase();
    disposeControlsBehavior(state.controls);
    state.controls.dispose();
    disposePostProcessing(state.postProcessing);
    state.scene.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry?.dispose();
        if (Array.isArray(object.material)) {
          for (const mat of object.material) mat.dispose();
        } else if (object.material) {
          object.material.dispose();
        }
      }
    });
    state.renderer.dispose();
  }
}
