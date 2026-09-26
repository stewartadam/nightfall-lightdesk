// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Base class for Visualizer renderers.
 *
 * Provides common functionality shared between MainThreadRenderer and WorkerRenderer,
 * including scene management, fixture handling, and selection.
 */

import { createLogger } from "../../../../lib/logger";
import type { SelectionTarget } from "../../../../lib/selection-targets";
import {
  DebugOverlayRegistry,
  EmitterDebugOverlay,
  type FixtureLabels,
  SnapPointsOverlay,
} from "../../components/debug-overlays";
import type {
  RenderableFixture,
  RenderableSceneObject,
} from "../../model/types";
import type { SceneManager } from "../scene-manager";
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

const log = createLogger("visualizer:base-renderer");

/**
 * Abstract base class for visualizer renderers.
 * Implements common functionality while leaving renderer-specific details to subclasses.
 */
export abstract class BaseVisualizerRenderer implements IVisualizerRenderer {
  protected sceneManager: SceneManager | undefined;
  protected debugOverlays: DebugOverlayRegistry | undefined;

  /**
   * Initialize debug overlays. Call from subclass init() after creating the scene.
   */
  protected initDebugOverlays(): void {
    this.debugOverlays = new DebugOverlayRegistry();
    this.debugOverlays.register(new EmitterDebugOverlay());
    this.debugOverlays.register(new SnapPointsOverlay());
  }

  abstract init(config: VisualizerInitConfig): Promise<void>;
  abstract resize(
    width: number,
    height: number,
    devicePixelRatio: number,
  ): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract isPaused(): boolean;
  abstract dispose(): void;
  abstract setStatsCallback(
    callback:
      | ((
          stats: import("../../../../state/appStores").VisualizerStats | null,
        ) => void)
      | null,
  ): void;
  abstract zoomToFit(uids?: string[]): void;

  setFixtures(fixtures: readonly RenderableFixture[]): void {
    if (!this.sceneManager || !this.debugOverlays) {
      throw new Error("setFixtures called before init() completed");
    }

    const startMs = performance.now();

    const sceneSyncStartMs = performance.now();
    this.sceneManager.syncFixtures(fixtures);
    const sceneSyncMs = performance.now() - sceneSyncStartMs;

    const overlaySyncStartMs = performance.now();
    this.debugOverlays.updateFixtures(
      this.sceneManager.getAllFixtureInstances(),
    );
    const overlaySyncMs = performance.now() - overlaySyncStartMs;

    const totalMs = performance.now() - startMs;
    log.trace(
      `setFixtures fixtures=${fixtures.length} sceneSyncMs=${sceneSyncMs.toFixed(2)} overlaySyncMs=${overlaySyncMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
    );
  }

  setSceneObjects(sceneObjects: readonly RenderableSceneObject[]): void {
    if (!this.sceneManager || !this.debugOverlays) {
      throw new Error("setSceneObjects called before init() completed");
    }

    const startMs = performance.now();

    const sceneSyncStartMs = performance.now();
    this.sceneManager.syncSceneObjects(sceneObjects);
    const sceneSyncMs = performance.now() - sceneSyncStartMs;

    const overlaySyncStartMs = performance.now();
    this.debugOverlays.updateSceneObjects(
      this.sceneManager.getAllSceneObjectInstances(),
    );
    const overlaySyncMs = performance.now() - overlaySyncStartMs;

    const totalMs = performance.now() - startMs;
    log.trace(
      `setSceneObjects sceneObjects=${sceneObjects.length} sceneSyncMs=${sceneSyncMs.toFixed(2)} overlaySyncMs=${overlaySyncMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
    );
  }

  setElementDmx(fixtureUid: string, elementDmx: FixtureElementDmxMap): void {
    this.sceneManager?.updateSingleFixtureDmx(fixtureUid, elementDmx);
  }

  /**
   * Applies a batch of fixture element DMX updates to the scene manager.
   */
  setElementDmxBatch(batch: FixtureDmxBatch): void {
    for (const [fixtureUid, elements] of batch) {
      this.setElementDmx(fixtureUid, elements);
    }
  }

  setSelection(selectedUids: string[]): void {
    if (!this.sceneManager) {
      throw new Error("setSelection called before init() completed");
    }
    log.trace(`Setting selection: ${selectedUids.length} fixtures`);
    this.sceneManager.setSelection(selectedUids);
  }

  /**
   * Set panel edit-target UIDs for yellow visualizer highlighting.
   */
  setEditSelection(selectedUids: string[]): void {
    if (!this.sceneManager) {
      throw new Error("setEditSelection called before init() completed");
    }
    log.trace(`Setting edit selection: ${selectedUids.length} targets`);
    this.sceneManager.setEditSelection(selectedUids);
  }

  /**
   * Set fixture UIDs that currently have values in the programmer.
   */
  setProgrammerValues(fixtureUids: string[]): void {
    if (!this.sceneManager) {
      throw new Error("setProgrammerValues called before init() completed");
    }
    log.trace(`Setting programmer values: ${fixtureUids.length} fixtures`);
    this.sceneManager.setProgrammerValues(fixtureUids);
  }

  /**
   * Set detailed active-span selection targets for fixture-element highlighting.
   */
  setActiveSelectionTargets(targets: SelectionTarget[]): void {
    if (!this.sceneManager) {
      throw new Error(
        "setActiveSelectionTargets called before init() completed",
      );
    }
    log.trace(`Setting active selection targets: ${targets.length} targets`);
    this.sceneManager.setActiveSelectionTargets(targets);
  }

  setFixturePosition(fixtureUid: string, position: Vec3): void {
    const updated =
      this.sceneManager?.setFixturePosition(fixtureUid, position) ?? false;
    if (updated) {
      this.debugOverlays?.notifyFixturesChanged();
    }
    log.trace(
      `setFixturePosition uid=${fixtureUid} updated=${updated} x=${position.x.toFixed(3)} y=${position.y.toFixed(3)} z=${position.z.toFixed(3)}`,
    );
  }

  setFixtureRotation(fixtureUid: string, rotation: Vec3): void {
    const updated =
      this.sceneManager?.setFixtureRotation(fixtureUid, rotation) ?? false;
    log.trace(
      `setFixtureRotation uid=${fixtureUid} updated=${updated} x=${rotation.x.toFixed(3)} y=${rotation.y.toFixed(3)} z=${rotation.z.toFixed(3)}`,
    );
  }

  setSceneObjectPosition(sceneObjectUid: string, position: Vec3): void {
    this.sceneManager?.setSceneObjectPosition(sceneObjectUid, position);
  }

  setSceneObjectRotation(sceneObjectUid: string, rotation: Vec3): void {
    this.sceneManager?.setSceneObjectRotation(sceneObjectUid, rotation);
  }

  setHighlightSelection(enabled: boolean): void {
    this.sceneManager?.setHighlightSelection(enabled);
  }

  toggleEmitterDebug(): void {
    this.debugOverlays?.toggle("emitter-debug");
  }

  setEmitterDebugEnabled(enabled: boolean): void {
    this.debugOverlays?.setEnabled("emitter-debug", enabled);
  }

  toggleBeams(): void {
    if (this.sceneManager) {
      this.sceneManager.setBeamsEnabled(!this.sceneManager.getBeamsEnabled());
    }
  }

  abstract setGridEnabled(enabled: boolean): void;
  /** Changes ambient rig visibility without changing fixture output. */
  abstract setDarkness(darkness: number): void;
  abstract setOrbitTargetIndicatorEnabled(enabled: boolean): void;

  setSnapPointsEnabled(enabled: boolean): void {
    this.debugOverlays?.setEnabled("snap-points", enabled);
  }

  setFixtureLabels(labels: FixtureLabels): void {
    this.debugOverlays?.setLabels(labels);
  }

  abstract setInteractionMode(mode: VisualizerInteractionMode): void;
  abstract setCameraRotationMode(mode: VisualizerCameraRotationMode): void;
  abstract setCameraDragEnabled(enabled: boolean): void;
  /** Cancel any in-progress camera drag without changing camera state. */
  abstract cancelCameraInteraction(): void;
  abstract getInteractionMode(): VisualizerInteractionMode;
  abstract pickFixtureAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null>;
  abstract pickSceneObjectAtScreenPoint(
    point: VisualizerScreenPoint,
  ): Promise<string | null>;
  abstract pickFixturesInScreenRect(
    rect: VisualizerScreenRect,
  ): Promise<string[]>;

  // ============================================================================
  // Viewport Control - Abstract methods for camera manipulation
  // ============================================================================

  abstract getCameraState(): Promise<CameraState>;
  abstract setCameraPosition(position: Vec3): void;
  abstract setCameraTarget(target: Vec3): void;
  abstract setCameraState(state: CameraState): void;
  abstract resetCamera(): void;
  abstract getScene(): import("three").Scene | undefined;
  abstract isUsingWorker(): boolean;
}
