// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Main thread renderer for Visualizer.
 *
 * Implements IVisualizerRenderer for direct rendering on the main thread.
 * Used as fallback when OffscreenCanvas is not available, or when forced via props.
 */

import type { Scene } from "three/webgpu";
import { createLogger } from "../../../../lib/logger";
import type { VisualizerStats } from "../../../../state/appStores";
import {
  fixtures as fixturesStore,
  getParametersImmediate,
} from "../../../../state/appStores";
import type { DebugOverlayRegistry } from "../../components/debug-overlays";
import { Instrumentation } from "../../services/instrumentation";
import {
  setActiveSpanOutlineSelectedObjects,
  setEditSelectionOutlineSelectedObjects,
  setOutlineSelectedObjects,
  setProgrammerValueOutlineSelectedObjects,
} from "../effects/post-processing";
import { FixtureDmxSnapshot } from "../fixture-dmx-snapshot";
import { resolveQualityProfile } from "../quality-profile";
import {
  cancelControlsInteraction,
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_ROTATION_MODE,
  DEFAULT_CAMERA_TARGET,
  disposeRenderer,
  handleResize,
  initRenderer,
  type RendererState,
  type RenderLoopCallbacks,
  setControlsRotationMode,
  startRenderLoop,
  stopRenderLoop,
  zoomCameraToGroups,
} from "../renderer";
import { setSceneDarkness } from "../scene-environment";
import { SceneManager } from "../scene-manager";
import { BaseVisualizerRenderer } from "./base-renderer";
import type {
  CameraState,
  Vec3,
  VisualizerCameraRotationMode,
  VisualizerInitConfig,
  VisualizerInteractionMode,
  VisualizerScreenPoint,
  VisualizerScreenRect,
} from "./renderer-api";

const log = createLogger("visualizer:main-thread-renderer");

/**
 * Main thread renderer for Visualizer.
 *
 * Provides direct access to the scene and supports all features including
 * post-processing and inspector.
 */
export class MainThreadRenderer extends BaseVisualizerRenderer {
  private readonly dmxSnapshot = new FixtureDmxSnapshot();
  private rendererState: RendererState | undefined;
  private instrumentation: Instrumentation | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private interactionMode: VisualizerInteractionMode = "camera";
  private cameraRotationMode: VisualizerCameraRotationMode =
    DEFAULT_CAMERA_ROTATION_MODE;
  private cameraDragEnabled = true;
  private orbitTargetIndicatorEnabled = false;

  // ============================================================================
  // IVisualizerRenderer Implementation
  // ============================================================================

  async init(config: VisualizerInitConfig): Promise<void> {
    const canvas = config.canvas as HTMLCanvasElement;

    const profile = resolveQualityProfile(config.beamQuality);
    this.rendererState = await initRenderer(
      canvas,
      profile,
      config.initialCameraState,
    );
    this.sceneManager = new SceneManager(this.rendererState.scene, profile);
    if (this.rendererState.postProcessing) {
      setOutlineSelectedObjects(
        this.rendererState.postProcessing,
        this.sceneManager.getSelectionOutlineObjects(),
      );
      setEditSelectionOutlineSelectedObjects(
        this.rendererState.postProcessing,
        this.sceneManager.getEditSelectionOutlineObjects(),
      );
      setProgrammerValueOutlineSelectedObjects(
        this.rendererState.postProcessing,
        this.sceneManager.getProgrammerValueOutlineObjects(),
      );
      setActiveSpanOutlineSelectedObjects(
        this.rendererState.postProcessing,
        this.sceneManager.getActiveSelectionOutlineObjects(),
      );
    }

    // Create debug overlays (from base class)
    this.initDebugOverlays();

    // Create instrumentation
    this.instrumentation = new Instrumentation({
      renderMode: "main-thread",
      diagnostics: config.diagnostics,
    });

    // Handle initial resize
    handleResize(this.rendererState, config.width, config.height);
    this.setInteractionMode(this.interactionMode);
    this.setCameraRotationMode(this.cameraRotationMode);
    this.setOrbitTargetIndicatorEnabled(this.orbitTargetIndicatorEnabled);

    // Start render loop
    this.startRenderLoopInternal();

    log.info("Main thread renderer initialized");
  }

  /**
   * Setup resize observer for automatic resizing.
   * Call this after init() with the container element.
   */
  setupResizeObserver(container: HTMLDivElement): void {
    if (!this.rendererState) return;

    // Append inspector UI to container
    if (this.rendererState.inspector) {
      container.appendChild(this.rendererState.inspector.domElement);
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && this.rendererState) {
          handleResize(this.rendererState, width, height);
        }
      }
    });
    this.resizeObserver.observe(container);
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    if (!this.rendererState) return;
    handleResize(this.rendererState, width, height, devicePixelRatio);
  }

  pause(): void {
    if (!this.rendererState || this.rendererState.isPaused) return;
    stopRenderLoop(this.rendererState);
    this.instrumentation?.pause();
  }

  resume(): void {
    if (!this.rendererState?.isPaused) return;
    this.instrumentation?.resume();
    this.startRenderLoopInternal();
  }

  isPaused(): boolean {
    return this.rendererState?.isPaused ?? true;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.debugOverlays?.dispose();
    this.sceneManager?.dispose();
    this.instrumentation?.clear();
    if (this.rendererState) {
      const state = this.rendererState;
      this.rendererState = undefined;
      void disposeRenderer(state).catch((error) => {
        log.error(
          "Failed to drain visualizer GPU timestamps during disposal",
          error,
        );
      });
    }
  }

  /**
   * Get the Three.js scene for inspection.
   * Only available in main thread mode.
   */
  getScene(): Scene | undefined {
    return this.rendererState?.scene;
  }

  /**
   * Check if using worker-based rendering.
   */
  isUsingWorker(): boolean {
    return false;
  }

  /**
   * Get the debug overlays registry for direct manipulation.
   */
  getDebugOverlays(): DebugOverlayRegistry | undefined {
    return this.debugOverlays;
  }

  /**
   * Zoom the camera to frame the specified fixtures.
   * If no UIDs provided, zooms to all fixtures in the scene.
   */
  zoomToFit(uids?: string[]): void {
    if (!this.rendererState || !this.sceneManager) return;

    const groups = this.sceneManager.getFixtureGroups(uids);
    if (groups.length === 0) return;

    zoomCameraToGroups(
      this.rendererState.camera,
      this.rendererState.controls,
      groups,
    );
  }

  // ============================================================================
  // Viewport Control Implementation
  // ============================================================================

  async getCameraState(): Promise<CameraState> {
    if (!this.rendererState) {
      return {
        position: { ...DEFAULT_CAMERA_POSITION },
        target: { ...DEFAULT_CAMERA_TARGET },
      };
    }
    const { camera, controls } = this.rendererState;
    return {
      position: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      target: {
        x: controls.target.x,
        y: controls.target.y,
        z: controls.target.z,
      },
    };
  }

  setCameraPosition(position: Vec3): void {
    if (!this.rendererState) return;
    const { camera, controls } = this.rendererState;
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(controls.target);
  }

  setCameraTarget(target: Vec3): void {
    if (!this.rendererState) return;
    const { camera, controls } = this.rendererState;
    controls.target.set(target.x, target.y, target.z);
    camera.lookAt(controls.target);
  }

  setCameraState(state: CameraState): void {
    if (!this.rendererState) return;
    const { camera, controls } = this.rendererState;
    camera.position.set(state.position.x, state.position.y, state.position.z);
    controls.target.set(state.target.x, state.target.y, state.target.z);
    camera.lookAt(controls.target);
  }

  resetCamera(): void {
    if (!this.rendererState) return;
    const { camera, controls } = this.rendererState;
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
    camera.lookAt(controls.target);
  }

  setStatsCallback(
    callback: ((stats: VisualizerStats | null) => void) | null,
  ): void {
    this.instrumentation?.setStatsCallback(callback);
  }

  setInteractionMode(mode: VisualizerInteractionMode): void {
    this.interactionMode = mode;
    this.applyControlInteractionState();
  }

  setCameraDragEnabled(enabled: boolean): void {
    this.cameraDragEnabled = enabled;
    if (!enabled) {
      this.cancelCameraInteraction();
    }
    this.applyControlInteractionState();
  }

  /** Cancel any active OrbitControls pointer drag. */
  cancelCameraInteraction(): void {
    if (!this.rendererState) return;
    cancelControlsInteraction(this.rendererState.controls);
  }

  setCameraRotationMode(mode: VisualizerCameraRotationMode): void {
    this.cameraRotationMode = mode;
    if (!this.rendererState) return;
    setControlsRotationMode(this.rendererState.controls, mode);
  }

  setGridEnabled(enabled: boolean): void {
    if (!this.rendererState) return;
    // Keep both helpers in sync with the toolbar's single grid toggle.
    this.rendererState.environment.grid.visible = enabled;
    this.rendererState.environment.axesHelper.visible = enabled;
  }

  /** Updates ambient lighting and background without rebuilding the renderer. */
  setDarkness(darkness: number): void {
    if (this.rendererState)
      setSceneDarkness(
        this.rendererState.scene,
        this.rendererState.environment,
        darkness,
      );
  }

  setOrbitTargetIndicatorEnabled(enabled: boolean): void {
    this.orbitTargetIndicatorEnabled = enabled;
    if (!this.rendererState) return;
    this.rendererState.environment.orbitTargetIndicator.visible = enabled;
  }

  getInteractionMode(): VisualizerInteractionMode {
    return this.interactionMode;
  }

  async pickFixtureAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    if (!this.sceneManager || !this.rendererState) {
      return null;
    }
    return this.sceneManager.pickFixtureAtScreenPoint(
      this.rendererState.camera,
      point,
    );
  }

  async pickSceneObjectAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    if (!this.sceneManager || !this.rendererState) {
      return null;
    }
    return this.sceneManager.pickSceneObjectAtScreenPoint(
      this.rendererState.camera,
      point,
    );
  }

  async pickFixturesInScreenRect(
    rect: VisualizerScreenRect,
  ): Promise<string[]> {
    if (!this.sceneManager || !this.rendererState) {
      return [];
    }
    return this.sceneManager.pickFixturesInScreenRect(
      this.rendererState.camera,
      rect,
    );
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private startRenderLoopInternal(): void {
    if (!this.rendererState || !this.sceneManager || !this.instrumentation)
      return;

    const callbacks: RenderLoopCallbacks = {
      onUpdate: () => this.updateEmitters(),
      onFrame: (metrics) => {
        this.instrumentation!.recordFrame(metrics.time, {
          completedAt: metrics.completedAt,
          reducedPrismEmitters: this.sceneManager?.reducedPrismEmitters,
          reducedGoboEmitters: this.sceneManager?.reducedGoboEmitters,
          startedAt: metrics.startedAt,
          atmosphereScale:
            this.rendererState?.postProcessing?.volumePass.getResolutionScale(),
          sceneScale:
            this.rendererState?.postProcessing?.scenePass.getResolutionScale(),
          omittedSurfaceLights:
            this.rendererState?.postProcessing?.surfaceLighting
              ?.omittedPointLights,
          updateMs: metrics.updateMs,
          renderMs: metrics.renderMs,
          gpu: metrics.gpu,
        });
      },
    };

    startRenderLoop(this.rendererState, callbacks);
  }

  private applyControlInteractionState(): void {
    if (!this.rendererState) return;
    const allowCameraDrag =
      this.interactionMode !== "select" && this.cameraDragEnabled;
    // The custom wheel dolly path checks controls.enabled, so this also gates zoom.
    this.rendererState.controls.enabled = this.cameraDragEnabled;
    this.rendererState.controls.enableRotate = allowCameraDrag;
    this.rendererState.controls.enablePan = allowCameraDrag;
  }

  /**
   * Update emitter colors from DMX stores.
   * Called once per frame in the render loop.
   */
  private updateEmitters(): void {
    const snapshot = this.dmxSnapshot.read(
      getParametersImmediate(),
      fixturesStore.get(),
    );
    // Strobes and wheel rotation advance even when the engine snapshot is unchanged.
    for (const [uid, dmx] of snapshot) this.setElementDmx(uid, dmx);
  }
}
