// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Comlink-based API for the Visualizer renderer.
 *
 * Defines the interface that both worker and main-thread renderers implement,
 * enabling a unified API regardless of rendering mode.
 */

import type { Scene } from "three/webgpu";
import type { SelectionTarget } from "../../../../lib/selection-targets";
import type { VisualizerStats } from "../../../../state/appStores";
import type {
  CameraState,
  Vec3,
  VisualizerScreenPoint,
  VisualizerScreenRect,
} from "../../interactions/visualizer-interaction-types";
import type {
  RenderableFixture,
  RenderableSceneObject,
} from "../../model/types";
import type { VisualizerQualityPreset } from "../../state/settings";

export type {
  CameraState,
  Vec3,
  VisualizerScreenPoint,
  VisualizerScreenRect,
} from "../../interactions/visualizer-interaction-types";

/**
 * Active user interaction mode for VIS2.
 */
export type VisualizerInteractionMode =
  | "camera"
  | "measure"
  | "move"
  | "rotate"
  | "select";

/**
 * Camera rotation pivot behavior for camera tool drag.
 */
export type VisualizerCameraRotationMode = "camera-locked" | "center-locked";

/**
 * Dynamic DMX parameter state for a single fixture element.
 * Keys are normalized DMX parameter names and values are normalized to 0-1.
 */
export type ElementDmxData = Record<string, number>;

/**
 * Map of element keys to their DMX parameter state.
 * Keys are either element indices (as strings) for non-GDTF fixtures,
 * or element labels for GDTF fixtures.
 */
export type FixtureElementDmxMap = Map<string, ElementDmxData>;

/**
 * Complete fixture DMX snapshot carried across the visualizer worker boundary,
 * keyed by fixture UID. Fixtures absent from the snapshot keep their last state.
 */
export type FixtureDmxBatch = ReadonlyMap<string, FixtureElementDmxMap>;

/**
 * Configuration for initializing a visualizer renderer.
 */
export interface VisualizerInitConfig {
  /** Canvas to render to (HTMLCanvasElement for main thread, OffscreenCanvas for worker) */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Initial width in CSS pixels */
  width: number;
  /** Initial height in CSS pixels */
  height: number;
  /** Device pixel ratio for HiDPI support */
  devicePixelRatio: number;
  /** Proxy ID for event forwarding (worker mode only) */
  proxyId?: number;
  /**
   * Publishes developer diagnostics with renderer stats. Resolved on the main
   * thread from the `visualizer:inspector` URL flag, because the worker cannot
   * see the page URL.
   */
  diagnostics?: boolean;
  /** Initial camera pose; renderers fall back to the persisted camera state when absent. */
  initialCameraState?: CameraState;
  /** Beam render quality selected by visualizer runtime settings. */
  beamQuality: VisualizerQualityPreset;
}

/**
 * Core renderer interface implemented by both worker and main-thread renderers.
 *
 * This interface abstracts the message-passing complexity and provides a clean,
 * typed API for controlling the visualizer.
 */
export interface IVisualizerRenderer {
  /**
   * Initialize the renderer with the given configuration.
   * Must be called before any other methods.
   */
  init(config: VisualizerInitConfig): Promise<void>;

  /**
   * Resize the renderer viewport.
   */
  resize(width: number, height: number, devicePixelRatio: number): void;

  /**
   * Synchronize fixtures to render.
   * Adds new fixtures, removes deleted ones, and updates changed fixtures.
   */
  setFixtures(fixtures: readonly RenderableFixture[]): void;

  /**
   * Synchronize scene objects to render.
   * Scene objects are non-fixture 3D elements like trusses, audience areas, etc.
   */
  setSceneObjects(sceneObjects: readonly RenderableSceneObject[]): void;

  /**
   * Update DMX parameter state for a single fixture's elements.
   * Called frequently (once per frame) to sync DMX values.
   */
  setElementDmx(fixtureUid: string, elementDmx: FixtureElementDmxMap): void;

  /**
   * Update DMX parameter state for multiple fixtures in one renderer call.
   * Worker mode sends a snapshot only when the engine output changes and the
   * worker re-applies the retained snapshot every frame, so strobes and wheel
   * rotation keep advancing between engine updates.
   */
  setElementDmxBatch(batch: FixtureDmxBatch): void;

  /**
   * Set the currently selected fixture UIDs for highlighting.
   */
  setSelection(selectedUids: string[]): void;

  /**
   * Set panel edit-target UIDs for the secondary highlight.
   */
  setEditSelection(selectedUids: string[]): void;

  /**
   * Set fixture UIDs that currently have values in the programmer.
   */
  setProgrammerValues(fixtureUids: string[]): void;

  /**
   * Set detailed active-span selection targets for fixture-element highlighting.
   */
  setActiveSelectionTargets(targets: SelectionTarget[]): void;

  /**
   * Set a fixture world position directly for interactive drag previews.
   */
  setFixturePosition(fixtureUid: string, position: Vec3): void;

  /**
   * Set a fixture world rotation directly for interactive drag previews.
   * Rotation values are in degrees.
   */
  setFixtureRotation(fixtureUid: string, rotation: Vec3): void;

  /**
   * Set a scene-object world position directly for interactive drag previews.
   */
  setSceneObjectPosition(sceneObjectUid: string, position: Vec3): void;

  /**
   * Set a scene-object world rotation directly for interactive drag previews.
   * Rotation values are in degrees.
   */
  setSceneObjectRotation(sceneObjectUid: string, rotation: Vec3): void;

  /**
   * Enable or disable selection highlighting effect.
   */
  setHighlightSelection(enabled: boolean): void;

  /**
   * Pause rendering (stops the render loop).
   */
  pause(): void;

  /**
   * Resume rendering (restarts the render loop).
   */
  resume(): void;

  /**
   * Check if rendering is currently paused.
   */
  isPaused(): boolean;

  /**
   * Toggle the emitter debug overlay (shows emitter positions).
   */
  toggleEmitterDebug(): void;

  /**
   * Enable or disable the emitter debug overlay.
   */
  setEmitterDebugEnabled(enabled: boolean): void;

  /**
   * Toggle volumetric beam rendering.
   */
  toggleBeams(): void;

  /**
   * Enable or disable ground-reference helpers (grid + axes).
   */
  setGridEnabled(enabled: boolean): void;
  /** Changes ambient rig visibility without changing fixture output. */
  setDarkness(darkness: number): void;

  /**
   * Enable or disable visualization of the current orbit target.
   */
  setOrbitTargetIndicatorEnabled(enabled: boolean): void;

  /**
   * Enable or disable snap points overlay.
   */
  setSnapPointsEnabled(enabled: boolean): void;

  /**
   * Set fixture labels for overlays that display text.
   */
  setFixtureLabels(labels: Record<string, string>): void;

  /**
   * Set the active interaction mode.
   */
  setInteractionMode(mode: VisualizerInteractionMode): void;

  /**
   * Set camera drag rotation behavior.
   */
  setCameraRotationMode(mode: VisualizerCameraRotationMode): void;

  /**
   * Enable or disable camera drag controls (orbit + pan).
   * Wheel zoom remains available regardless of this setting.
   */
  setCameraDragEnabled(enabled: boolean): void;

  /**
   * Cancel any in-progress camera drag without changing the camera state.
   */
  cancelCameraInteraction(): void;

  /**
   * Get the currently active interaction mode.
   */
  getInteractionMode(): VisualizerInteractionMode;

  /**
   * Pick the top-most selectable fixture at a screen point.
   * Returns null when no selectable fixture is under the cursor.
   */
  pickFixtureAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null>;

  /**
   * Pick the top-most selectable scene object at a screen point.
   * Returns null when no scene object is under the cursor.
   */
  pickSceneObjectAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null>;

  /**
   * Pick selectable fixtures whose projected center falls within a screen rectangle.
   */
  pickFixturesInScreenRect(rect: VisualizerScreenRect): Promise<string[]>;

  /**
   * Dispose of the renderer and release all resources.
   */
  dispose(): void;

  /**
   * Get the Three.js scene (only available in main thread mode).
   */
  getScene(): Scene | undefined;

  /**
   * Check if using worker-based rendering.
   */
  isUsingWorker(): boolean;

  /**
   * Setup resize observer (main-thread specific).
   */
  setupResizeObserver?(container: HTMLDivElement): void;

  // ============================================================================
  // Viewport Control (for programmatic camera manipulation / testing)
  // ============================================================================

  /**
   * Get the current camera state (position and target).
   */
  getCameraState(): Promise<CameraState>;

  /**
   * Set the camera position.
   * @param position New camera position in world coordinates
   */
  setCameraPosition(position: Vec3): void;

  /**
   * Set the orbit target (the point the camera looks at).
   * @param target New target position in world coordinates
   */
  setCameraTarget(target: Vec3): void;

  /**
   * Set both camera position and target at once.
   * @param state Camera state with position and target
   */
  setCameraState(state: CameraState): void;

  /**
   * Reset the camera to default position and target.
   */
  resetCamera(): void;

  /**
   * Zoom the camera to frame the specified fixtures.
   * If no UIDs provided, zooms to all fixtures in the scene.
   * @param uids - Fixture UIDs to zoom to, or empty/undefined for all fixtures
   */
  zoomToFit(uids?: string[]): void;

  /**
   * Set a callback to receive periodic performance stats.
   * @param callback Function called with stats, or null to clear callback
   */
  setStatsCallback(
    callback: ((stats: VisualizerStats | null) => void) | null,
  ): void;
}
