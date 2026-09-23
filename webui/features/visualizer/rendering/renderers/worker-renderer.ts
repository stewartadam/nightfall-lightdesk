// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Visualizer Web Worker for offscreen canvas rendering.
 * Handles Three.js WebGPU rendering in a separate thread.
 *
 * Uses Comlink for the control API while keeping ProxyManager for
 * high-frequency event handling (to avoid Comlink overhead).
 */

import * as Comlink from "comlink";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PerspectiveCamera, Scene, WebGPURenderer } from "three/webgpu";
import {
  applySerializedConfig,
  createLogger,
  getConfig,
  type SerializedLogConfig,
  subscribeToConfigChanges,
} from "../../../../lib/logger";
import type { SelectionTarget } from "../../../../lib/selection-targets";
import {
  fixtures as fixturesStore,
  getParametersImmediate,
  type VisualizerStats,
} from "../../../../state/appStores";
import type {
  RenderableFixture,
  RenderableSceneObject,
} from "../../model/types";
import { FramePacing } from "../../services/frame-pacing";
import {
  createPostProcessing,
  disposePostProcessing,
  type PostProcessingState,
  renderWithPostProcessing,
  setActiveSpanOutlineSelectedObjects,
  setEditSelectionOutlineSelectedObjects,
  setOutlineSelectedObjects,
  setProgrammerValueOutlineSelectedObjects,
} from "../effects/post-processing";
import { consumeDueFrame } from "../frame-rate-limiter";
import { GpuFrameTimer, type TimestampRenderer } from "../gpu-frame-timer";
import { LatestFrameMailbox } from "../latest-frame-mailbox";
import {
  cancelControlsInteraction,
  createCamera,
  createControls,
  createRenderer,
  createScene,
  DEFAULT_CAMERA_ROTATION_MODE,
  DEFAULT_CAMERA_TARGET,
  loadCameraState,
  saveCameraState,
  setControlsRotationMode,
  zoomCameraToGroups,
} from "../renderer";
import {
  createSceneEnvironment,
  type SceneEnvironment,
  updateFloorTransparency,
  updateOrbitTargetIndicator,
} from "../scene-environment";
import { SceneManager } from "../scene-manager";
import {
  extractElementDmxData,
  fixtureIntensityValueFromOutputs,
  resetDmxPool,
} from "../visualizer-dmx";
import { BaseVisualizerRenderer } from "./base-renderer";
import type {
  CameraState,
  ElementDmxData,
  FixtureDmxBatch,
  FixtureElementDmxMap,
  IVisualizerRenderer,
  Vec3,
  VisualizerCameraRotationMode,
  VisualizerInitConfig,
  VisualizerInteractionMode,
  VisualizerScreenPoint,
  VisualizerScreenRect,
} from "./renderer-api";
import { ElementProxy, ProxyManager } from "./worker-utils/element-proxy";
import type { Vis2EventData } from "./worker-utils/worker-types";

const log = createLogger("visualizer:worker-renderer");

/**
 * Wrapper for worker renderer that handles Comlink communication.
 *
 * Runs on the main thread and forwards to the worker.
 */
export class WorkerRendererProxy implements IVisualizerRenderer {
  private readonly dmxMailbox: LatestFrameMailbox<FixtureDmxBatch>;
  private worker: Worker;
  private workerApi: Comlink.Remote<VisualizerWorkerApi>;
  private proxy: ElementProxy | undefined;
  private _isPaused = false;
  private colorUpdateRafId: number | null = null;
  private unsubscribeLogConfig: (() => void) | null = null;
  private interactionMode: VisualizerInteractionMode = "camera";
  private cameraRotationMode: VisualizerCameraRotationMode =
    DEFAULT_CAMERA_ROTATION_MODE;
  private cameraDragEnabled = true;
  private orbitTargetIndicatorEnabled = false;

  constructor(worker: Worker, workerApi: Comlink.Remote<VisualizerWorkerApi>) {
    this.worker = worker;
    this.workerApi = workerApi;
    this.dmxMailbox = new LatestFrameMailbox(
      (batch) => this.workerApi.setElementDmxBatch(batch),
      (error) => log.warn("Visualizer lighting update failed", { error }),
    );

    // Push initial log config to worker
    this.workerApi.setLogConfig(getConfig());

    // Subscribe to log config changes and sync to worker
    this.unsubscribeLogConfig = subscribeToConfigChanges((config) => {
      this.workerApi.setLogConfig(config);
    });
  }

  async init(config: VisualizerInitConfig): Promise<void> {
    const canvas = config.canvas as HTMLCanvasElement;

    // Transfer canvas to offscreen
    const offscreen = canvas.transferControlToOffscreen();

    // Create element proxy for event forwarding
    this.proxy = new ElementProxy(canvas, this.worker);

    // Load saved camera state from localStorage (main thread has access)
    const initialCameraState = loadCameraState() ?? undefined;

    // Initialize renderer with transferred canvas
    const initConfig = {
      canvas: offscreen,
      width: config.width,
      height: config.height,
      devicePixelRatio: config.devicePixelRatio,
      proxyId: this.proxy.id,
      initialCameraState,
      beamQuality: config.beamQuality,
    };
    await this.workerApi.init(
      // Use Comlink.transfer to ensure the OffscreenCanvas is transferred, not cloned
      Comlink.transfer(initConfig, [offscreen]) as VisualizerInitConfig,
    );
    this.workerApi.setInteractionMode(this.interactionMode);
    this.workerApi.setCameraRotationMode(this.cameraRotationMode);
    this.workerApi.setCameraDragEnabled(this.cameraDragEnabled);
    this.workerApi.setOrbitTargetIndicatorEnabled(
      this.orbitTargetIndicatorEnabled,
    );

    // Set up camera change callback to persist to localStorage
    this.workerApi.setCameraChangeCallback(
      Comlink.proxy((state: CameraState) => {
        saveCameraState(state);
      }),
    );

    // Start the color update loop
    this.startColorUpdateLoop();

    log.debug("Web Worker renderer initialized");
  }

  /**
   * Setup resize observer for automatic resizing.
   */
  setupResizeObserver(container: HTMLDivElement): void {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.resize(width, height, window.devicePixelRatio);
        }
      }
    });
    resizeObserver.observe(container);
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    this.workerApi.resize(width, height, devicePixelRatio);
  }

  setFixtures(fixtures: readonly RenderableFixture[]): void {
    log.trace(`setFixtures called with ${fixtures.length} fixtures`);
    // Use JSON serialization to ensure data is clonable
    const serialized = JSON.parse(JSON.stringify(fixtures));
    this.workerApi.setFixtures(serialized);
  }

  setSceneObjects(sceneObjects: readonly RenderableSceneObject[]): void {
    log.trace(
      `setSceneObjects called with ${sceneObjects.length} scene objects`,
    );
    // Use JSON serialization to ensure data is clonable
    const serialized = JSON.parse(JSON.stringify(sceneObjects));
    this.workerApi.setSceneObjects(serialized);
  }

  setElementDmx(fixtureUid: string, elementDmx: FixtureElementDmxMap): void {
    // Convert Map to serializable array to avoid clone errors
    const dmxArray = Array.from(elementDmx.entries());
    this.workerApi.setElementDmx(fixtureUid, new Map(dmxArray));
  }

  /**
   * Sends all fixture element DMX updates for one frame across the worker boundary.
   */
  setElementDmxBatch(batch: FixtureDmxBatch): void {
    this.dmxMailbox.publish(batch);
  }

  setSelection(selectedUids: string[]): void {
    this.workerApi.setSelection([...selectedUids]);
  }

  /**
   * Set panel edit-target UIDs for yellow visualizer highlighting.
   */
  setEditSelection(selectedUids: string[]): void {
    this.workerApi.setEditSelection([...selectedUids]);
  }

  /**
   * Set fixture UIDs that currently have values in the programmer.
   */
  setProgrammerValues(fixtureUids: string[]): void {
    this.workerApi.setProgrammerValues([...fixtureUids]);
  }

  /**
   * Set detailed active-span selection targets for fixture-element highlighting.
   */
  setActiveSelectionTargets(targets: SelectionTarget[]): void {
    const serialized = targets.map((target) => ({ ...target }));
    this.workerApi.setActiveSelectionTargets(serialized);
  }

  setFixturePosition(fixtureUid: string, position: Vec3): void {
    log.trace(
      `setFixturePosition uid=${fixtureUid} x=${position.x.toFixed(3)} y=${position.y.toFixed(3)} z=${position.z.toFixed(3)}`,
    );
    this.workerApi.setFixturePosition(fixtureUid, position);
  }

  setFixtureRotation(fixtureUid: string, rotation: Vec3): void {
    log.trace(
      `setFixtureRotation uid=${fixtureUid} x=${rotation.x.toFixed(3)} y=${rotation.y.toFixed(3)} z=${rotation.z.toFixed(3)}`,
    );
    this.workerApi.setFixtureRotation(fixtureUid, rotation);
  }

  setSceneObjectPosition(sceneObjectUid: string, position: Vec3): void {
    this.workerApi.setSceneObjectPosition(sceneObjectUid, position);
  }

  setSceneObjectRotation(sceneObjectUid: string, rotation: Vec3): void {
    this.workerApi.setSceneObjectRotation(sceneObjectUid, rotation);
  }

  setHighlightSelection(enabled: boolean): void {
    this.workerApi.setHighlightSelection(enabled);
  }

  pause(): void {
    if (this._isPaused) return;
    this.dmxMailbox.clear();
    this._isPaused = true;
    if (this.colorUpdateRafId !== null) {
      cancelAnimationFrame(this.colorUpdateRafId);
      this.colorUpdateRafId = null;
    }
    this.workerApi.pause();
  }

  resume(): void {
    if (!this._isPaused) return;
    this._isPaused = false;
    this.workerApi.resume();
    if (this.colorUpdateRafId === null) {
      this.startColorUpdateLoop();
    }
  }

  isPaused(): boolean {
    return this._isPaused;
  }

  toggleEmitterDebug(): void {
    this.workerApi.toggleEmitterDebug();
  }

  setEmitterDebugEnabled(enabled: boolean): void {
    this.workerApi.setEmitterDebugEnabled(enabled);
  }

  toggleBeams(): void {
    this.workerApi.toggleBeams();
  }

  setGridEnabled(enabled: boolean): void {
    this.workerApi.setGridEnabled(enabled);
  }

  setOrbitTargetIndicatorEnabled(enabled: boolean): void {
    this.orbitTargetIndicatorEnabled = enabled;
    this.workerApi.setOrbitTargetIndicatorEnabled(enabled);
  }

  setSnapPointsEnabled(enabled: boolean): void {
    this.workerApi.setSnapPointsEnabled(enabled);
  }

  setFixtureLabels(labels: Record<string, string>): void {
    this.workerApi.setFixtureLabels(labels);
  }

  setInteractionMode(mode: VisualizerInteractionMode): void {
    this.interactionMode = mode;
    this.workerApi.setInteractionMode(mode);
  }

  setCameraRotationMode(mode: VisualizerCameraRotationMode): void {
    this.cameraRotationMode = mode;
    this.workerApi.setCameraRotationMode(mode);
  }

  setCameraDragEnabled(enabled: boolean): void {
    this.cameraDragEnabled = enabled;
    this.workerApi.setCameraDragEnabled(enabled);
  }

  /** Cancel any active camera-control pointer drag in the worker. */
  cancelCameraInteraction(): void {
    this.workerApi.cancelCameraInteraction();
  }

  getInteractionMode(): VisualizerInteractionMode {
    return this.interactionMode;
  }

  pickFixtureAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    return this.workerApi.pickFixtureAtScreenPoint(point);
  }

  pickSceneObjectAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    return this.workerApi.pickSceneObjectAtScreenPoint(point);
  }

  pickFixturesInScreenRect(rect: VisualizerScreenRect): Promise<string[]> {
    return this.workerApi.pickFixturesInScreenRect(rect);
  }

  dispose(): void {
    this.dmxMailbox.dispose();
    if (this.colorUpdateRafId !== null) {
      cancelAnimationFrame(this.colorUpdateRafId);
    }
    this.unsubscribeLogConfig?.();
    this.proxy?.dispose();
    // Allow pending GPU mappings to finish before terminating the worker.
    const timeout = setTimeout(() => this.worker.terminate(), 2000);
    void this.workerApi
      .dispose()
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        this.worker.terminate();
      });
  }

  setStatsCallback(
    callback: ((stats: VisualizerStats | null) => void) | null,
  ): void {
    if (callback) {
      this.workerApi.setStatsCallback(Comlink.proxy(callback));
    } else {
      this.workerApi.setStatsCallback(null);
    }
  }

  getScene(): Scene | undefined {
    // Scene not accessible in worker mode
    return undefined;
  }

  isUsingWorker(): boolean {
    return true;
  }

  /**
   * Zoom the camera to frame the specified fixtures.
   * If no UIDs provided, zooms to all fixtures in the scene.
   */
  zoomToFit(uids?: string[]): void {
    this.workerApi.zoomToFit(uids);
  }

  /**
   * Returns the camera state from the renderer running inside the worker.
   */
  getCameraState(): Promise<CameraState> {
    return this.workerApi.getCameraState();
  }

  setCameraPosition(position: Vec3): void {
    this.workerApi.setCameraPosition(position);
  }

  setCameraTarget(target: Vec3): void {
    this.workerApi.setCameraTarget(target);
  }

  setCameraState(state: CameraState): void {
    this.workerApi.setCameraState(state);
  }

  resetCamera(): void {
    this.workerApi.resetCamera();
  }

  /**
   * Start the color update loop.
   * Polls DMX parameters and sends colors to the worker at frame rate.
   */
  private startColorUpdateLoop(): void {
    const updateColors = () => {
      if (this._isPaused) {
        this.colorUpdateRafId = null;
        return;
      }

      // Sample current DMX on the next frame after acknowledgement instead of building discarded snapshots.
      if (this.dmxMailbox.busy) {
        this.colorUpdateRafId = requestAnimationFrame(updateColors);
        return;
      }

      // Reset DMX pool at start of frame
      resetDmxPool();

      const parametersImmediate = getParametersImmediate();
      const fixtureMap = fixturesStore.get();

      const dmxBatch: FixtureDmxBatch = [];
      for (const [uid, fixture] of Object.entries(fixtureMap)) {
        const elementOutputs = parametersImmediate.get(uid);
        if (!elementOutputs) continue;

        // Build element DMX map using element labels as keys
        const elementDmx: Array<[string, ElementDmxData]> = [];
        const fixtureIntensity = fixtureIntensityValueFromOutputs(
          elementOutputs,
          fixture.elements,
        );

        for (let i = 0; i < fixture.elements.length; i++) {
          const element = fixture.elements[i];
          const output = elementOutputs[i];
          if (!output) continue;

          elementDmx.push([
            element.label,
            extractElementDmxData(output, element, fixtureIntensity),
          ]);
        }

        if (elementDmx.length > 0) dmxBatch.push([uid, elementDmx]);
      }

      if (dmxBatch.length > 0) this.setElementDmxBatch(dmxBatch);

      this.colorUpdateRafId = requestAnimationFrame(updateColors);
    };

    this.colorUpdateRafId = requestAnimationFrame(updateColors);
  }
}

/**
 * Worker-side visualizer renderer extending BaseVisualizerRenderer.
 *
 * Exposed via Comlink for the main thread to call.
 */
class WorkerRenderer extends BaseVisualizerRenderer {
  private renderer: WebGPURenderer | undefined;
  private scene: Scene | undefined;
  private camera: PerspectiveCamera | undefined;
  private controls: OrbitControls | undefined;
  private postProcessing: PostProcessingState | null = null;
  private environment: SceneEnvironment | undefined;
  private _isPaused = false;
  private statsCallback: ((stats: VisualizerStats | null) => void) | null =
    null;
  private cameraChangeCallback: ((state: CameraState) => void) | null = null;
  private interactionMode: VisualizerInteractionMode = "camera";
  private cameraRotationMode: VisualizerCameraRotationMode =
    DEFAULT_CAMERA_ROTATION_MODE;
  private cameraDragEnabled = true;
  private orbitTargetIndicatorEnabled = false;

  // Stats tracking
  private readonly STATS_WINDOW_SIZE = 60;
  private readonly STATS_PUBLISH_INTERVAL = 10;
  private frameTimesMs: number[] = [];
  private readonly pacing = new FramePacing();
  private renderTimesMs: number[] = [];
  private updateTimesMs: number[] = [];
  private pendingDmxMs = 0;
  private gpuTimer = new GpuFrameTimer();
  private statsFrameCount = 0;
  private statsLastFrameTime = 0;

  // Render loop timing
  private lastTime = 0;
  private accumulator = 0;

  /** Includes incoming DMX application in the next frame's optional rendering budget. */
  override setElementDmx(
    fixtureUid: string,
    elementDmx: FixtureElementDmxMap,
  ): void {
    const started = performance.now();
    try {
      super.setElementDmx(fixtureUid, elementDmx);
    } finally {
      this.pendingDmxMs += performance.now() - started;
    }
  }

  /**
   * Initializes the worker-side renderer implementation behind the shared renderer API.
   */
  async init(config: VisualizerInitConfig): Promise<void> {
    const {
      canvas,
      width,
      height,
      devicePixelRatio,
      proxyId,
      initialCameraState,
    } = config;

    // Create renderer
    this.renderer = createRenderer({
      canvas: canvas as OffscreenCanvas,
      devicePixelRatio,
    });
    this.renderer.setSize(width, height, false);

    // Wait for WebGPU to initialize
    await this.renderer.init();

    // Create scene
    this.scene = createScene("VisualizerWorkerScene");

    // Setup scene environment
    this.environment = createSceneEnvironment(this.scene);

    // Create scene manager (handles fixtures, beams, selection)
    this.sceneManager = new SceneManager(this.scene, config.beamQuality);

    // Create debug overlays (from base class)
    this.initDebugOverlays();

    // Create camera with initial state if provided
    this.camera = createCamera(width / height);
    if (initialCameraState) {
      this.camera.position.set(
        initialCameraState.position.x,
        initialCameraState.position.y,
        initialCameraState.position.z,
      );
    }

    // Get the element proxy for OrbitControls
    log.debug(`init received proxyId=${proxyId}`);
    if (proxyId === undefined) {
      throw new Error("proxyId must be provided in config");
    }
    const proxy = proxyManager.getProxy(proxyId);
    if (!proxy) {
      throw new Error(
        `Proxy ${proxyId} not found - makeProxy must be called first`,
      );
    }

    // HACK: OrbitControls needs ownerDocument and self.document
    proxy.ownerDocument = proxy;
    (self as unknown as { document: object }).document = {};

    // Create orbit controls with proxy element
    const target = initialCameraState?.target ?? DEFAULT_CAMERA_TARGET;
    this.controls = createControls(
      this.camera,
      proxy as unknown as HTMLElement,
      target,
    );
    this.camera.lookAt(this.controls.target);
    this.setInteractionMode(this.interactionMode);
    this.setCameraRotationMode(this.cameraRotationMode);
    this.setOrbitTargetIndicatorEnabled(this.orbitTargetIndicatorEnabled);

    this.postProcessing = createPostProcessing(
      this.renderer,
      this.scene,
      this.camera,
    );
    await this.postProcessing.surfaceLighting?.shadows.prepare(this.renderer);
    setOutlineSelectedObjects(
      this.postProcessing,
      this.sceneManager.getSelectionOutlineObjects(),
    );
    setEditSelectionOutlineSelectedObjects(
      this.postProcessing,
      this.sceneManager.getEditSelectionOutlineObjects(),
    );
    setProgrammerValueOutlineSelectedObjects(
      this.postProcessing,
      this.sceneManager.getProgrammerValueOutlineObjects(),
    );
    setActiveSpanOutlineSelectedObjects(
      this.postProcessing,
      this.sceneManager.getActiveSelectionOutlineObjects(),
    );

    // Notify main thread of camera changes for localStorage persistence
    this.controls.addEventListener("change", () => {
      if (this.cameraChangeCallback && this.camera && this.controls) {
        this.cameraChangeCallback({
          position: {
            x: this.camera.position.x,
            y: this.camera.position.y,
            z: this.camera.position.z,
          },
          target: {
            x: this.controls.target.x,
            y: this.controls.target.y,
            z: this.controls.target.z,
          },
        });
      }
    });

    // Start render loop
    this.startRenderLoop();

    log.info("Worker renderer initialized via Comlink");
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    if (!this.renderer || !this.camera) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
  }

  pause(): void {
    if (this._isPaused) return;
    this._isPaused = true;
    this.renderer?.setAnimationLoop(null);

    // Send zeroed stats to indicate paused state
    this.publishStats(true);
  }

  resume(): void {
    if (!this._isPaused) return;
    this._isPaused = false;
    this.resetStats();
    this.startRenderLoop();
  }

  isPaused(): boolean {
    return this._isPaused;
  }

  async dispose(): Promise<void> {
    this.renderer?.setAnimationLoop(null);
    this.statsCallback = null;
    this.cameraChangeCallback = null;
    await this.gpuTimer.dispose();
    this.debugOverlays?.dispose();
    this.sceneManager?.dispose();
    disposePostProcessing(this.postProcessing);
    this.postProcessing = null;
    this.renderer?.dispose();
    this.statsCallback = null;
    this.cameraChangeCallback = null;
  }

  /**
   * Zoom the camera to frame the specified fixtures.
   * If no UIDs provided, zooms to all fixtures in the scene.
   */
  zoomToFit(uids?: string[]): void {
    if (!this.camera || !this.controls || !this.sceneManager) return;

    const groups = this.sceneManager.getFixtureGroups(uids);
    if (groups.length === 0) return;

    zoomCameraToGroups(this.camera, this.controls, groups);
  }

  /**
   * Registers the callback used to publish renderer stats back to the main thread.
   */
  setStatsCallback(
    callback: ((stats: VisualizerStats | null) => void) | null,
  ): void {
    this.statsCallback = callback;
  }

  /**
   * Set a callback to receive camera state changes.
   * Used by main thread to persist camera position to localStorage.
   */
  setCameraChangeCallback(
    callback: ((state: CameraState) => void) | null,
  ): void {
    this.cameraChangeCallback = callback;
  }

  /**
   * Reads the current worker-side camera and OrbitControls state.
   */
  async getCameraState(): Promise<CameraState> {
    if (!this.camera || !this.controls) {
      throw new Error("getCameraState called before init() completed");
    }

    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      target: {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z,
      },
    };
  }

  setCameraPosition(position: Vec3): void {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(this.controls.target);
  }

  setCameraTarget(target: Vec3): void {
    if (!this.camera || !this.controls) return;
    this.controls.target.set(target.x, target.y, target.z);
    this.camera.lookAt(this.controls.target);
  }

  setCameraState(state: CameraState): void {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(
      state.position.x,
      state.position.y,
      state.position.z,
    );
    this.controls.target.set(state.target.x, state.target.y, state.target.z);
    this.camera.lookAt(this.controls.target);
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(
      DEFAULT_CAMERA_TARGET.x + 5,
      DEFAULT_CAMERA_TARGET.y + 6,
      DEFAULT_CAMERA_TARGET.z + 10,
    );
    this.controls.target.set(
      DEFAULT_CAMERA_TARGET.x,
      DEFAULT_CAMERA_TARGET.y,
      DEFAULT_CAMERA_TARGET.z,
    );
    this.camera.lookAt(this.controls.target);
  }

  getScene(): Scene | undefined {
    return this.scene;
  }

  isUsingWorker(): boolean {
    return true;
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
    if (!this.controls) return;
    cancelControlsInteraction(this.controls);
  }

  setCameraRotationMode(mode: VisualizerCameraRotationMode): void {
    this.cameraRotationMode = mode;
    if (!this.controls) return;
    setControlsRotationMode(this.controls, mode);
  }

  getInteractionMode(): VisualizerInteractionMode {
    return this.interactionMode;
  }

  setGridEnabled(enabled: boolean): void {
    if (!this.environment) return;
    // Keep both helpers in sync with the toolbar's single grid toggle.
    this.environment.grid.visible = enabled;
    this.environment.axesHelper.visible = enabled;
  }

  setOrbitTargetIndicatorEnabled(enabled: boolean): void {
    this.orbitTargetIndicatorEnabled = enabled;
    if (!this.environment) return;
    this.environment.orbitTargetIndicator.visible = enabled;
  }

  async pickFixtureAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    if (!this.sceneManager || !this.camera) {
      return null;
    }
    return this.sceneManager.pickFixtureAtScreenPoint(this.camera, point);
  }

  async pickSceneObjectAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    if (!this.sceneManager || !this.camera) {
      return null;
    }
    return this.sceneManager.pickSceneObjectAtScreenPoint(this.camera, point);
  }

  async pickFixturesInScreenRect(
    rect: VisualizerScreenRect,
  ): Promise<string[]> {
    if (!this.sceneManager || !this.camera) {
      return [];
    }
    return this.sceneManager.pickFixturesInScreenRect(this.camera, rect);
  }

  private startRenderLoop(): void {
    if (!this.renderer) return;

    this._isPaused = false;
    this.lastTime = 0;
    this.accumulator = 0;

    // Use setAnimationLoop for proper WebGPU async rendering
    this.renderer.setAnimationLoop((time: number) => {
      const startedAt = performance.now();
      if (this._isPaused || !this.scene || !this.camera || !this.controls) {
        return;
      }

      // Calculate delta time
      const deltaTime = this.lastTime === 0 ? 0 : time - this.lastTime;
      this.lastTime = time;
      this.accumulator += deltaTime;

      // Only render when enough time has accumulated (60 FPS cap)
      const remainingFrameTime = consumeDueFrame(this.accumulator);
      if (remainingFrameTime === null) return;
      this.accumulator = remainingFrameTime;

      // Track frame-to-frame timing for stats
      const frameToFrameMs =
        this.statsLastFrameTime > 0 ? time - this.statsLastFrameTime : 0;
      this.statsLastFrameTime = time;
      if (frameToFrameMs > 0) {
        this.pushToWindow(this.frameTimesMs, frameToFrameMs);
      }

      // Update controls
      const updateStarted = performance.now();
      this.controls.update();

      // Update floor transparency based on camera position
      if (this.environment) {
        updateFloorTransparency(this.environment, this.camera);
        updateOrbitTargetIndicator(
          this.environment,
          this.camera,
          this.controls.target,
        );
      }

      // Render and track timing
      const renderStart = performance.now();
      const updateMs = this.pendingDmxMs + renderStart - updateStarted;
      this.pendingDmxMs = 0;
      this.pushToWindow(this.updateTimesMs, updateMs);
      const timedRenderer = this.renderer! as unknown as TimestampRenderer;
      this.gpuTimer.begin(timedRenderer);
      if (this.postProcessing) {
        renderWithPostProcessing(
          this.postProcessing,
          this.gpuTimer.sample,
          updateMs,
        );
      } else {
        this.renderer!.render(this.scene, this.camera);
      }
      this.gpuTimer.end(timedRenderer);
      const renderEnd = performance.now();
      this.pacing.record(
        renderEnd,
        updateMs,
        renderEnd - renderStart,
        startedAt,
        time,
      );
      this.pushToWindow(this.renderTimesMs, renderEnd - renderStart);

      // Publish stats periodically
      this.statsFrameCount++;
      if (this.statsFrameCount % this.STATS_PUBLISH_INTERVAL === 0) {
        this.publishStats(false);
      }
    });
  }

  private pushToWindow(window: number[], value: number): void {
    window.push(value);
    if (window.length > this.STATS_WINDOW_SIZE) {
      window.shift();
    }
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private publishStats(zeroed: boolean): void {
    if (!this.statsCallback) return;

    if (zeroed) {
      this.statsCallback({
        fps: 0,
        frameToFrameMs: 0,
        updateFixturesMs: 0,
        totalRenderMs: 0,
        postProcessMs: 0,
        gpuMs: undefined,
        scenePassMs: 0,
        volumetricPassMs: 0,
        gaussianBlurMs: 0,
        bloomMs: 0,
        renderMode: "worker",
      });
      return;
    }

    if (this.frameTimesMs.length === 0) return;

    const avgFrameTime = this.average(this.frameTimesMs);
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;

    this.statsCallback({
      fps,
      framePacing: this.pacing.snapshot(),
      atmosphereScale: this.postProcessing?.atmosphereBudget.scale,
      sceneScale: this.postProcessing?.scenePass.getResolutionScale(),
      reducedPrismEmitters: this.sceneManager?.reducedPrismEmitters,
      reducedGoboEmitters: this.sceneManager?.reducedGoboEmitters,
      omittedSurfaceLights:
        this.postProcessing?.surfaceLighting?.omittedPointLights,
      frameToFrameMs: avgFrameTime,
      updateFixturesMs: this.average(this.updateTimesMs),
      totalRenderMs: this.average(this.renderTimesMs),
      postProcessMs: 0,
      gpuMs: this.gpuTimer.sample?.milliseconds,
      gpuPasses: this.gpuTimer.sample?.passes,
      scenePassMs: this.average(this.renderTimesMs),
      volumetricPassMs: 0,
      gaussianBlurMs: 0,
      bloomMs: 0,
      renderMode: "worker",
    });
  }

  private resetStats(): void {
    this.pacing.suspend();
    this.frameTimesMs.length = 0;
    this.renderTimesMs.length = 0;
    this.updateTimesMs.length = 0;
    this.statsFrameCount = 0;
    this.statsLastFrameTime = 0;
  }

  private applyControlInteractionState(): void {
    if (!this.controls) return;
    const allowCameraDrag =
      this.interactionMode !== "select" && this.cameraDragEnabled;
    // The custom wheel dolly path checks controls.enabled, so this also gates zoom.
    this.controls.enabled = this.cameraDragEnabled;
    this.controls.enableRotate = allowCameraDrag;
    this.controls.enablePan = allowCameraDrag;
  }
}

// Proxy event handling stays outside Comlink for high-frequency pointer traffic.
const proxyManager = new ProxyManager();

const renderer = new WorkerRenderer();

/**
 * Worker API exposed via Comlink.
 * Combines the renderer methods with proxy event handling.
 */
const workerApi = {
  // Renderer methods (IVisualizerRendererWithStats)
  init: (config: VisualizerInitConfig) => renderer.init(config),
  resize: (width: number, height: number, devicePixelRatio: number) =>
    renderer.resize(width, height, devicePixelRatio),
  setFixtures: (fixtures: readonly RenderableFixture[]) =>
    renderer.setFixtures(fixtures),
  setSceneObjects: (sceneObjects: readonly RenderableSceneObject[]) =>
    renderer.setSceneObjects(sceneObjects),
  setElementDmx: (fixtureUid: string, elementDmx: FixtureElementDmxMap) =>
    renderer.setElementDmx(fixtureUid, elementDmx),
  setElementDmxBatch: (batch: FixtureDmxBatch) =>
    renderer.setElementDmxBatch(batch),
  setSelection: (selectedUids: string[]) => renderer.setSelection(selectedUids),
  setEditSelection: (selectedUids: string[]) =>
    renderer.setEditSelection(selectedUids),
  setProgrammerValues: (fixtureUids: string[]) =>
    renderer.setProgrammerValues(fixtureUids),
  setActiveSelectionTargets: (targets: SelectionTarget[]) =>
    renderer.setActiveSelectionTargets(targets),
  setFixturePosition: (fixtureUid: string, position: Vec3) =>
    renderer.setFixturePosition(fixtureUid, position),
  setFixtureRotation: (fixtureUid: string, rotation: Vec3) =>
    renderer.setFixtureRotation(fixtureUid, rotation),
  setSceneObjectPosition: (sceneObjectUid: string, position: Vec3) =>
    renderer.setSceneObjectPosition(sceneObjectUid, position),
  setSceneObjectRotation: (sceneObjectUid: string, rotation: Vec3) =>
    renderer.setSceneObjectRotation(sceneObjectUid, rotation),
  setHighlightSelection: (enabled: boolean) =>
    renderer.setHighlightSelection(enabled),
  pause: () => renderer.pause(),
  resume: () => renderer.resume(),
  isPaused: () => renderer.isPaused(),
  toggleEmitterDebug: () => renderer.toggleEmitterDebug(),
  setEmitterDebugEnabled: (enabled: boolean) =>
    renderer.setEmitterDebugEnabled(enabled),
  toggleBeams: () => renderer.toggleBeams(),
  setGridEnabled: (enabled: boolean) => renderer.setGridEnabled(enabled),
  setOrbitTargetIndicatorEnabled: (enabled: boolean) =>
    renderer.setOrbitTargetIndicatorEnabled(enabled),
  setSnapPointsEnabled: (enabled: boolean) =>
    renderer.setSnapPointsEnabled(enabled),
  setFixtureLabels: (labels: Record<string, string>) =>
    renderer.setFixtureLabels(labels),
  setInteractionMode: (mode: VisualizerInteractionMode) =>
    renderer.setInteractionMode(mode),
  setCameraRotationMode: (mode: VisualizerCameraRotationMode) =>
    renderer.setCameraRotationMode(mode),
  setCameraDragEnabled: (enabled: boolean) =>
    renderer.setCameraDragEnabled(enabled),
  cancelCameraInteraction: () => renderer.cancelCameraInteraction(),
  getInteractionMode: () => renderer.getInteractionMode(),
  pickFixtureAtScreenPoint: (point: VisualizerScreenPoint) =>
    renderer.pickFixtureAtScreenPoint(point),
  pickSceneObjectAtScreenPoint: (point: VisualizerScreenPoint) =>
    renderer.pickSceneObjectAtScreenPoint(point),
  pickFixturesInScreenRect: (rect: VisualizerScreenRect) =>
    renderer.pickFixturesInScreenRect(rect),
  zoomToFit: (uids?: string[]) => renderer.zoomToFit(uids),
  dispose: () => renderer.dispose(),
  setStatsCallback: (
    callback: ((stats: VisualizerStats | null) => void) | null,
  ) => renderer.setStatsCallback(callback),
  setCameraChangeCallback: (callback: ((state: CameraState) => void) | null) =>
    renderer.setCameraChangeCallback(callback),

  // Viewport control
  getCameraState: () => renderer.getCameraState(),
  setCameraPosition: (position: Vec3) => renderer.setCameraPosition(position),
  setCameraTarget: (target: Vec3) => renderer.setCameraTarget(target),
  setCameraState: (state: CameraState) => renderer.setCameraState(state),
  resetCamera: () => renderer.resetCamera(),

  // Proxy management for high-frequency event handling
  makeProxy: (id: number) => proxyManager.makeProxy(id),
  handleProxyEvent: (id: number, data: Vis2EventData) =>
    proxyManager.handleEvent(id, data),

  // Log configuration sync from main thread
  setLogConfig: (config: SerializedLogConfig) => applySerializedConfig(config),
};

export type VisualizerWorkerApi = typeof workerApi;

// Expose the API via Comlink
Comlink.expose(workerApi);

// Also handle raw postMessage for high-frequency event forwarding from ElementProxy
// This runs alongside Comlink for performance reasons
self.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  // Handle raw messages from ElementProxy (not Comlink messages)
  // Comlink messages have specific internal structure, these are our simple messages
  if (msg.type === "makeProxy") {
    log.trace(`makeProxy received for id ${msg.id}`);
    proxyManager.makeProxy(msg.id);
  } else if (msg.type === "event") {
    proxyManager.handleEvent(msg.id, msg.data);
  }
  // Other message types are handled by Comlink
});
