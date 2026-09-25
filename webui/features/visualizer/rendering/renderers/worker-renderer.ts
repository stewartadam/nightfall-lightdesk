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
import { Instrumentation } from "../../services/instrumentation";
import {
  createPostProcessing,
  disposePostProcessing,
  type PostProcessingState,
  preparePostProcessing,
  renderWithPostProcessing,
  setActiveSpanOutlineSelectedObjects,
  setEditSelectionOutlineSelectedObjects,
  setOutlineSelectedObjects,
  setProgrammerValueOutlineSelectedObjects,
} from "../effects/post-processing";
import { FixtureDmxSnapshot } from "../fixture-dmx-snapshot";
import { consumeDueFrame } from "../frame-rate-limiter";
import { GpuFrameTimer, type TimestampRenderer } from "../gpu-frame-timer";
import { LatestFrameMailbox } from "../latest-frame-mailbox";
import { resolveQualityProfile } from "../quality-profile";
import {
  cancelControlsInteraction,
  createCamera,
  createControls,
  createRenderer,
  createScene,
  DEFAULT_CAMERA_ROTATION_MODE,
  DEFAULT_CAMERA_TARGET,
  GPU_READBACK_DISPOSAL_TIMEOUT_MS,
  loadCameraState,
  saveCameraState,
  setControlsRotationMode,
  zoomCameraToGroups,
} from "../renderer";
import {
  createSceneEnvironment,
  type SceneEnvironment,
  setSceneDarkness,
  updateFloorTransparency,
  updateOrbitTargetIndicator,
} from "../scene-environment";
import { SceneManager } from "../scene-manager";
import { BaseVisualizerRenderer } from "./base-renderer";
import type {
  CameraState,
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
  private readonly dmxSnapshot = new FixtureDmxSnapshot();
  /** Snapshot revision last handed to the mailbox; -1 forces the next post. */
  private postedDmxRevision = -1;
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
  private disposed = false;
  private resizeObserver: ResizeObserver | undefined;

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
      this.liveApi?.setLogConfig(config);
    });
  }

  /**
   * Returns the worker API while the worker is owned, or `undefined` after
   * disposal so late callers become no-ops instead of messaging a terminated worker.
   */
  private get liveApi(): Comlink.Remote<VisualizerWorkerApi> | undefined {
    return this.disposed ? undefined : this.workerApi;
  }

  async init(config: VisualizerInitConfig): Promise<void> {
    const canvas = config.canvas as HTMLCanvasElement;

    // Transfer canvas to offscreen
    const offscreen = canvas.transferControlToOffscreen();

    // Create element proxy for event forwarding
    this.proxy = new ElementProxy(canvas, this.worker);

    // A replaced renderer hands over its live pose; otherwise restore the persisted one.
    const initialCameraState =
      config.initialCameraState ?? loadCameraState() ?? undefined;

    // Initialize renderer with transferred canvas
    const initConfig = {
      canvas: offscreen,
      width: config.width,
      height: config.height,
      devicePixelRatio: config.devicePixelRatio,
      proxyId: this.proxy.id,
      initialCameraState,
      diagnostics: config.diagnostics,
      beamQuality: config.beamQuality,
    };
    await this.workerApi.init(
      // Use Comlink.transfer to ensure the OffscreenCanvas is transferred, not cloned
      Comlink.transfer(initConfig, [offscreen]) as VisualizerInitConfig,
    );
    this.liveApi?.setInteractionMode(this.interactionMode);
    this.liveApi?.setCameraRotationMode(this.cameraRotationMode);
    this.liveApi?.setCameraDragEnabled(this.cameraDragEnabled);
    this.liveApi?.setOrbitTargetIndicatorEnabled(
      this.orbitTargetIndicatorEnabled,
    );

    // Set up camera change callback to persist to localStorage
    this.liveApi?.setCameraChangeCallback(
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.resize(width, height, window.devicePixelRatio);
        }
      }
    });
    this.resizeObserver.observe(container);
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    this.liveApi?.resize(width, height, devicePixelRatio);
  }

  setFixtures(fixtures: readonly RenderableFixture[]): void {
    if (this.disposed) return;
    log.trace(`setFixtures called with ${fixtures.length} fixtures`);
    // Use JSON serialization to ensure data is clonable
    const serialized = JSON.parse(JSON.stringify(fixtures));
    this.liveApi?.setFixtures(serialized);
  }

  setSceneObjects(sceneObjects: readonly RenderableSceneObject[]): void {
    if (this.disposed) return;
    log.trace(
      `setSceneObjects called with ${sceneObjects.length} scene objects`,
    );
    // Use JSON serialization to ensure data is clonable
    const serialized = JSON.parse(JSON.stringify(sceneObjects));
    this.liveApi?.setSceneObjects(serialized);
  }

  setElementDmx(fixtureUid: string, elementDmx: FixtureElementDmxMap): void {
    // Convert Map to serializable array to avoid clone errors
    const dmxArray = Array.from(elementDmx.entries());
    this.liveApi?.setElementDmx(fixtureUid, new Map(dmxArray));
  }

  /**
   * Sends all fixture element DMX updates for one frame across the worker boundary.
   */
  setElementDmxBatch(batch: FixtureDmxBatch): void {
    this.dmxMailbox.publish(batch);
  }

  setSelection(selectedUids: string[]): void {
    this.liveApi?.setSelection([...selectedUids]);
  }

  /**
   * Set panel edit-target UIDs for yellow visualizer highlighting.
   */
  setEditSelection(selectedUids: string[]): void {
    this.liveApi?.setEditSelection([...selectedUids]);
  }

  /**
   * Set fixture UIDs that currently have values in the programmer.
   */
  setProgrammerValues(fixtureUids: string[]): void {
    this.liveApi?.setProgrammerValues([...fixtureUids]);
  }

  /**
   * Set detailed active-span selection targets for fixture-element highlighting.
   */
  setActiveSelectionTargets(targets: SelectionTarget[]): void {
    const serialized = targets.map((target) => ({ ...target }));
    this.liveApi?.setActiveSelectionTargets(serialized);
  }

  setFixturePosition(fixtureUid: string, position: Vec3): void {
    log.trace(
      `setFixturePosition uid=${fixtureUid} x=${position.x.toFixed(3)} y=${position.y.toFixed(3)} z=${position.z.toFixed(3)}`,
    );
    this.liveApi?.setFixturePosition(fixtureUid, position);
  }

  setFixtureRotation(fixtureUid: string, rotation: Vec3): void {
    log.trace(
      `setFixtureRotation uid=${fixtureUid} x=${rotation.x.toFixed(3)} y=${rotation.y.toFixed(3)} z=${rotation.z.toFixed(3)}`,
    );
    this.liveApi?.setFixtureRotation(fixtureUid, rotation);
  }

  setSceneObjectPosition(sceneObjectUid: string, position: Vec3): void {
    this.liveApi?.setSceneObjectPosition(sceneObjectUid, position);
  }

  setSceneObjectRotation(sceneObjectUid: string, rotation: Vec3): void {
    this.liveApi?.setSceneObjectRotation(sceneObjectUid, rotation);
  }

  setHighlightSelection(enabled: boolean): void {
    this.liveApi?.setHighlightSelection(enabled);
  }

  pause(): void {
    if (this.disposed || this._isPaused) return;
    this.dmxMailbox.clear();
    // A cleared, unsent snapshot must be re-posted on resume.
    this.postedDmxRevision = -1;
    this._isPaused = true;
    if (this.colorUpdateRafId !== null) {
      cancelAnimationFrame(this.colorUpdateRafId);
      this.colorUpdateRafId = null;
    }
    this.liveApi?.pause();
  }

  resume(): void {
    if (this.disposed || !this._isPaused) return;
    this._isPaused = false;
    this.liveApi?.resume();
    if (this.colorUpdateRafId === null) {
      this.startColorUpdateLoop();
    }
  }

  isPaused(): boolean {
    return this._isPaused;
  }

  toggleEmitterDebug(): void {
    this.liveApi?.toggleEmitterDebug();
  }

  setEmitterDebugEnabled(enabled: boolean): void {
    this.liveApi?.setEmitterDebugEnabled(enabled);
  }

  toggleBeams(): void {
    this.liveApi?.toggleBeams();
  }

  setGridEnabled(enabled: boolean): void {
    this.liveApi?.setGridEnabled(enabled);
  }

  /** Forwards ambient visibility changes to the rendering worker. */
  setDarkness(darkness: number): void {
    this.liveApi?.setDarkness(darkness);
  }

  setOrbitTargetIndicatorEnabled(enabled: boolean): void {
    this.orbitTargetIndicatorEnabled = enabled;
    this.liveApi?.setOrbitTargetIndicatorEnabled(enabled);
  }

  setSnapPointsEnabled(enabled: boolean): void {
    this.liveApi?.setSnapPointsEnabled(enabled);
  }

  setFixtureLabels(labels: Record<string, string>): void {
    this.liveApi?.setFixtureLabels(labels);
  }

  setInteractionMode(mode: VisualizerInteractionMode): void {
    this.interactionMode = mode;
    this.liveApi?.setInteractionMode(mode);
  }

  setCameraRotationMode(mode: VisualizerCameraRotationMode): void {
    this.cameraRotationMode = mode;
    this.liveApi?.setCameraRotationMode(mode);
  }

  setCameraDragEnabled(enabled: boolean): void {
    this.cameraDragEnabled = enabled;
    this.liveApi?.setCameraDragEnabled(enabled);
  }

  /** Cancel any active camera-control pointer drag in the worker. */
  cancelCameraInteraction(): void {
    this.liveApi?.cancelCameraInteraction();
  }

  getInteractionMode(): VisualizerInteractionMode {
    return this.interactionMode;
  }

  pickFixtureAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    return (
      this.liveApi?.pickFixtureAtScreenPoint(point) ?? Promise.resolve(null)
    );
  }

  pickSceneObjectAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null> {
    return (
      this.liveApi?.pickSceneObjectAtScreenPoint(point) ?? Promise.resolve(null)
    );
  }

  pickFixturesInScreenRect(rect: VisualizerScreenRect): Promise<string[]> {
    return this.liveApi?.pickFixturesInScreenRect(rect) ?? Promise.resolve([]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dmxMailbox.dispose();
    if (this.colorUpdateRafId !== null) {
      cancelAnimationFrame(this.colorUpdateRafId);
      this.colorUpdateRafId = null;
    }
    this.resizeObserver?.disconnect();
    this.unsubscribeLogConfig?.();
    this.proxy?.dispose();
    // Allow pending GPU mappings to finish before terminating the worker.
    const timeout = setTimeout(
      () => this.worker.terminate(),
      GPU_READBACK_DISPOSAL_TIMEOUT_MS,
    );
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
      this.liveApi?.setStatsCallback(Comlink.proxy(callback));
    } else {
      this.liveApi?.setStatsCallback(null);
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
    this.liveApi?.zoomToFit(uids);
  }

  /**
   * Returns the camera state from the renderer running inside the worker.
   */
  getCameraState(): Promise<CameraState> {
    return (
      this.liveApi?.getCameraState() ??
      Promise.reject(new Error("Visualizer worker renderer was disposed"))
    );
  }

  setCameraPosition(position: Vec3): void {
    this.liveApi?.setCameraPosition(position);
  }

  setCameraTarget(target: Vec3): void {
    this.liveApi?.setCameraTarget(target);
  }

  setCameraState(state: CameraState): void {
    this.liveApi?.setCameraState(state);
  }

  resetCamera(): void {
    this.liveApi?.resetCamera();
  }

  /**
   * Start the color update loop.
   * Polls DMX parameters every animation frame, but converts and posts a
   * snapshot to the worker only when the engine output or fixture definitions
   * changed; the worker replays its retained snapshot for time-based effects.
   */
  private startColorUpdateLoop(): void {
    if (this.disposed) return;
    const updateColors = () => {
      if (this.disposed || this._isPaused) {
        this.colorUpdateRafId = null;
        return;
      }

      // Sample current DMX on the next frame after acknowledgement instead of building discarded snapshots.
      if (!this.dmxMailbox.busy) {
        const snapshot = this.dmxSnapshot.read(
          getParametersImmediate(),
          fixturesStore.get(),
        );
        if (this.dmxSnapshot.revision !== this.postedDmxRevision) {
          this.postedDmxRevision = this.dmxSnapshot.revision;
          this.setElementDmxBatch(snapshot);
        }
      }

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

  // Stats tracking; instrumentation exists once init() knows the diagnostics flag.
  private instrumentation: Instrumentation | undefined;
  private gpuTimer = new GpuFrameTimer();
  /** Latest DMX snapshot from the main thread, re-applied every rendered frame. */
  private dmxSnapshot: FixtureDmxBatch = new Map();

  // Render loop timing
  private lastTime = 0;
  private accumulator = 0;

  /**
   * Retains the main thread's latest snapshot instead of applying it on
   * arrival. The render loop replays it every frame, which keeps strobes and
   * wheel rotation advancing when the engine output has not changed and
   * charges DMX application to the frame's update budget.
   */
  override setElementDmxBatch(batch: FixtureDmxBatch): void {
    this.dmxSnapshot = batch;
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

    this.instrumentation = new Instrumentation({
      renderMode: "worker",
      diagnostics: config.diagnostics,
    });
    this.instrumentation.setStatsCallback(this.statsCallback);

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

    const profile = resolveQualityProfile(config.beamQuality);
    this.postProcessing = createPostProcessing(
      this.renderer,
      this.scene,
      this.camera,
      { profile },
    );
    await preparePostProcessing(this.postProcessing);
    this.sceneManager = new SceneManager(this.scene, profile);
    this.initDebugOverlays();
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
    // Publishes zeroed stats to indicate the paused state.
    this.instrumentation?.pause();
  }

  resume(): void {
    if (!this._isPaused) return;
    this._isPaused = false;
    this.instrumentation?.resume();
    this.startRenderLoop();
  }

  isPaused(): boolean {
    return this._isPaused;
  }

  async dispose(): Promise<void> {
    this.renderer?.setAnimationLoop(null);
    this.setStatsCallback(null);
    this.instrumentation?.clear();
    this.cameraChangeCallback = null;
    await this.gpuTimer.dispose();
    this.debugOverlays?.dispose();
    this.sceneManager?.dispose();
    disposePostProcessing(this.postProcessing);
    this.postProcessing = null;
    this.renderer?.dispose();
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
    this.instrumentation?.setStatsCallback(callback);
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

  /** Updates ambient lighting and background without rebuilding the renderer. */
  setDarkness(darkness: number): void {
    if (this.scene && this.environment)
      setSceneDarkness(this.scene, this.environment, darkness);
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

      // Update controls
      const updateStarted = performance.now();
      for (const [uid, dmx] of this.dmxSnapshot) this.setElementDmx(uid, dmx);
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
      const updateMs = renderStart - updateStarted;
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
      this.instrumentation?.recordFrame(time, {
        completedAt: renderEnd,
        startedAt,
        updateMs,
        renderMs: renderEnd - renderStart,
        gpu: this.gpuTimer.sample,
        reducedPrismEmitters: this.sceneManager?.reducedPrismEmitters,
        reducedGoboEmitters: this.sceneManager?.reducedGoboEmitters,
        omittedSurfaceLights:
          this.postProcessing?.surfaceLighting?.omittedPointLights,
        atmosphereScale: this.postProcessing?.atmosphereBudget.scale,
        sceneScale: this.postProcessing?.scenePass.getResolutionScale(),
      });
    });
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
  /** Applies the main thread's persisted environment preference. */
  setDarkness: (darkness: number) => renderer.setDarkness(darkness),
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
