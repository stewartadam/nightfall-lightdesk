// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Scene management for Visualizer.
 * Coordinates fixture management, emitter updates, and beam rendering.
 */

import { Raycaster, Vector2, Vector3 } from "three";
import { Mesh, type PerspectiveCamera, type Scene } from "three/webgpu";
import type { VisualizerBeamQuality } from "../../../lib/feature-flags";
import { createLogger } from "../../../lib/logger";
import type { SelectionTarget } from "../../../lib/selection-targets";
import type { FixtureElement } from "../../../types";
import {
  getSelectionMeshes,
  SelectionHighlighter,
} from "../model/selection-utils";
import type { RenderableFixture, RenderableSceneObject } from "../model/types";
import { BeamManager, BeamUpdater } from "./effects";
import { FixtureColorState } from "./fixture-color-state";
import { FixtureManager } from "./fixture-manager";
import {
  type ExtendedFixtureInstance,
  updateFixtureColors,
} from "./fixture-renderers";
import {
  type EmitterColor,
  updateEmitterColors,
  updateGdtfPanTilt,
} from "./geometry-builder";
import type {
  FixtureElementDmxMap,
  VisualizerScreenPoint,
  VisualizerScreenRect,
} from "./renderers/renderer-api";
import { SceneObjectManager } from "./scene-object-manager";
import {
  applyStrobeShutterIntensity,
  fixtureIntensityValueFromOutputs,
} from "./visualizer-dmx";

const log = createLogger("visualizer:scene-manager");

function getPanTiltFromElements(
  elementDmx: Map<
    string,
    {
      pan?: number;
      tilt?: number;
    }
  >,
): { pan: number; tilt: number } {
  for (const dmx of elementDmx.values()) {
    if (dmx.pan !== undefined || dmx.tilt !== undefined) {
      return {
        pan: dmx.pan ?? 0,
        tilt: dmx.tilt ?? 0,
      };
    }
  }

  return { pan: 0, tilt: 0 };
}

/** Returns the strongest fixture-level strobe shutter value in an element map. */
function getFixtureStrobeShutter(
  elementDmx: Map<string, { strobeShutter?: number }>,
): number | undefined {
  let strobeShutter: number | undefined;
  for (const dmx of elementDmx.values()) {
    if (dmx.strobeShutter === undefined || dmx.strobeShutter <= 0) continue;
    strobeShutter =
      strobeShutter === undefined
        ? dmx.strobeShutter
        : Math.max(strobeShutter, dmx.strobeShutter);
  }
  return strobeShutter;
}

/** Applies element-local or fixture-level strobe shutter timing to intensity. */
function strobeAdjustedIntensity(
  intensity: number,
  elementStrobeShutter: number | undefined,
  fixtureStrobeShutter: number | undefined,
  timeSeconds: number,
): number {
  return applyStrobeShutterIntensity(
    intensity,
    elementStrobeShutter ?? fixtureStrobeShutter,
    timeSeconds,
  );
}

/**
 * SceneManager coordinates the various scene subsystems.
 * Delegates fixture lifecycle to FixtureManager and handles emitter color updates.
 */
export class SceneManager {
  private fixtureManager: FixtureManager;
  private sceneObjectManager: SceneObjectManager;
  private beamManager: BeamManager;
  private beamUpdater: BeamUpdater;
  private selectionHighlighter: SelectionHighlighter;
  private raycaster = new Raycaster();
  private mouseNdc = new Vector2();
  private readonly fixtureColors = new WeakMap<
    ExtendedFixtureInstance,
    FixtureColorState
  >();

  constructor(scene: Scene, beamQuality: VisualizerBeamQuality = "high") {
    this.fixtureManager = new FixtureManager(scene, beamQuality);
    this.sceneObjectManager = new SceneObjectManager(scene);
    this.beamManager = new BeamManager(scene, beamQuality);
    this.beamUpdater = new BeamUpdater(this.beamManager);
    this.selectionHighlighter = new SelectionHighlighter(
      this.fixtureManager.getAllFixtureInstances(),
    );
  }

  /**
   * Enable or disable beam rendering.
   */
  setBeamsEnabled(enabled: boolean): void {
    this.beamUpdater.setEnabled(enabled);
  }

  /**
   * Check if beams are enabled.
   */
  getBeamsEnabled(): boolean {
    return this.beamUpdater.isEnabled();
  }

  /** Reports active prism approximation for renderer-independent instrumentation. */
  get reducedPrismEmitters(): number {
    return this.beamUpdater.reducedPrismEmitters;
  }

  /** Reports active mask approximation for renderer-independent instrumentation. */
  get reducedGoboEmitters(): number {
    return this.beamManager.reducedGoboEmitters;
  }

  /**
   * Synchronize fixtures in the scene with the provided fixture data.
   */
  syncFixtures(fixtures: readonly RenderableFixture[]): void {
    const startMs = performance.now();
    const beforeCount = this.fixtureManager.getAllFixtureInstances().size;

    const fixtureSyncStartMs = performance.now();
    this.fixtureManager.syncFixtures(fixtures);
    const fixtureSyncMs = performance.now() - fixtureSyncStartMs;

    // Sync beams with current fixtures
    const instances = this.fixtureManager.getAllFixtureInstances();
    const beamSyncStartMs = performance.now();
    this.beamUpdater.syncWithFixtures(instances);
    const beamSyncMs = performance.now() - beamSyncStartMs;

    // Update selection highlighter's fixture reference
    const selectionSyncStartMs = performance.now();
    this.selectionHighlighter.setFixtureInstances(instances);
    const selectionSyncMs = performance.now() - selectionSyncStartMs;

    const totalMs = performance.now() - startMs;
    log.trace(
      `syncFixtures fixtures=${fixtures.length} instancesBefore=${beforeCount} instancesAfter=${instances.size} fixtureSyncMs=${fixtureSyncMs.toFixed(2)} beamSyncMs=${beamSyncMs.toFixed(2)} selectionSyncMs=${selectionSyncMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
    );
  }

  /**
   * Synchronize scene objects in the scene with the provided data.
   * Scene objects are non-fixture 3D elements like trusses, audience areas, etc.
   */
  syncSceneObjects(sceneObjects: readonly RenderableSceneObject[]): void {
    this.sceneObjectManager.syncSceneObjects(sceneObjects);
    this.selectionHighlighter.setSceneObjectInstances(
      this.sceneObjectManager.getAllSceneObjectInstances(),
    );
  }

  /**
   * Set the selected fixture UIDs for highlighting.
   */
  setSelection(selectedUids: string[]): void {
    this.selectionHighlighter.setSelection(new Set(selectedUids));
  }

  /**
   * Set the panel edit-target UIDs for highlighting.
   */
  setEditSelection(selectedUids: string[]): void {
    this.selectionHighlighter.setEditSelection(new Set(selectedUids));
  }

  /**
   * Set fixture UIDs with values currently present in the programmer.
   */
  setProgrammerValues(fixtureUids: string[]): void {
    this.selectionHighlighter.setProgrammerValues(new Set(fixtureUids));
  }

  /**
   * Set detailed active-span selection targets for highlighting.
   */
  setActiveSelectionTargets(targets: SelectionTarget[]): void {
    this.selectionHighlighter.setActiveSelectionTargets(targets);
  }

  /**
   * Enable or disable selection highlighting.
   */
  setHighlightSelection(enabled: boolean): void {
    this.selectionHighlighter.setHighlightEnabled(enabled);
  }

  /**
   * Get selected fixture objects for outline post-processing.
   */
  getSelectionOutlineObjects(): import("three/webgpu").Object3D[] {
    return this.selectionHighlighter.getSelectedObjects();
  }

  /**
   * Get panel edit-target objects for outline post-processing.
   */
  getEditSelectionOutlineObjects(): import("three/webgpu").Object3D[] {
    return this.selectionHighlighter.getEditSelectionObjects();
  }

  /**
   * Get fixture objects with programmer values for outline post-processing.
   */
  getProgrammerValueOutlineObjects(): import("three/webgpu").Object3D[] {
    return this.selectionHighlighter.getProgrammerValueObjects();
  }

  /**
   * Get active-span fixture objects for stronger outline post-processing.
   */
  getActiveSelectionOutlineObjects(): import("three/webgpu").Object3D[] {
    return this.selectionHighlighter.getActiveTargetObjects();
  }

  /**
   * Check if selection highlighting is enabled.
   */
  getHighlightSelection(): boolean {
    return this.selectionHighlighter.getHighlightEnabled();
  }

  /**
   * Get a fixture instance by UID.
   */
  getFixtureInstance(uid: string): ExtendedFixtureInstance | undefined {
    return this.fixtureManager.getFixtureInstance(uid);
  }

  /**
   * Set the fixture position directly for interactive previews.
   */
  setFixturePosition(
    uid: string,
    position: { x: number; y: number; z: number },
  ): boolean {
    const updated = this.fixtureManager.setFixturePosition(uid, position);
    log.trace(
      `setFixturePosition uid=${uid} updated=${updated} x=${position.x.toFixed(3)} y=${position.y.toFixed(3)} z=${position.z.toFixed(3)}`,
    );
    return updated;
  }

  /**
   * Set the fixture rotation directly for interactive previews.
   * Rotation is expressed in degrees.
   */
  setFixtureRotation(
    uid: string,
    rotation: { x: number; y: number; z: number },
  ): boolean {
    const updated = this.fixtureManager.setFixtureRotation(uid, rotation);
    log.trace(
      `setFixtureRotation uid=${uid} updated=${updated} x=${rotation.x.toFixed(3)} y=${rotation.y.toFixed(3)} z=${rotation.z.toFixed(3)}`,
    );
    return updated;
  }

  /**
   * Set the scene-object position directly for interactive previews.
   */
  setSceneObjectPosition(
    uid: string,
    position: { x: number; y: number; z: number },
  ): boolean {
    return this.sceneObjectManager.setSceneObjectPosition(uid, position);
  }

  /**
   * Set the scene-object rotation directly for interactive previews.
   * Rotation is expressed in degrees.
   */
  setSceneObjectRotation(
    uid: string,
    rotation: { x: number; y: number; z: number },
  ): boolean {
    return this.sceneObjectManager.setSceneObjectRotation(uid, rotation);
  }

  /**
   * Get all fixture instances.
   */
  getAllFixtureInstances(): Map<string, ExtendedFixtureInstance> {
    return this.fixtureManager.getAllFixtureInstances();
  }

  /**
   * Get all scene object instances.
   */
  getAllSceneObjectInstances() {
    return this.sceneObjectManager.getAllSceneObjectInstances();
  }

  /**
   * Get fixture groups for the specified UIDs.
   * If uids is empty or undefined, returns all fixture groups.
   */
  getFixtureGroups(uids?: string[]): import("three/webgpu").Group[] {
    const instances = this.fixtureManager.getAllFixtureInstances();
    const groups: import("three/webgpu").Group[] = [];

    if (!uids || uids.length === 0) {
      // Return all fixture groups
      for (const instance of instances.values()) {
        groups.push(instance.group);
      }
    } else {
      // Return only specified fixture groups
      for (const uid of uids) {
        const instance = instances.get(uid);
        if (instance) {
          groups.push(instance.group);
        }
      }
    }

    return groups;
  }

  pickFixtureAtScreenPoint(
    camera: PerspectiveCamera,
    point: VisualizerScreenPoint,
  ): string | null {
    const meshToUid = new Map<import("three/webgpu").Mesh, string>();
    const selectableMeshes: import("three/webgpu").Mesh[] = [];
    for (const [
      uid,
      instance,
    ] of this.fixtureManager.getAllFixtureInstances()) {
      if (!instance.group.visible) continue;
      for (const mesh of getSelectionMeshes(instance)) {
        if (!(mesh instanceof Mesh)) continue;
        if (!mesh.visible) continue;
        meshToUid.set(mesh, uid);
        selectableMeshes.push(mesh);
      }
    }
    if (selectableMeshes.length === 0) {
      return null;
    }

    this.mouseNdc.set(
      (point.x / point.viewportWidth) * 2 - 1,
      -(point.y / point.viewportHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.mouseNdc, camera);
    const intersections = this.raycaster.intersectObjects(selectableMeshes);
    for (const intersection of intersections) {
      const uid = meshToUid.get(
        intersection.object as import("three/webgpu").Mesh,
      );
      if (uid) return uid;
    }
    return null;
  }

  pickSceneObjectAtScreenPoint(
    camera: PerspectiveCamera,
    point: VisualizerScreenPoint,
  ): string | null {
    const meshToUid = new Map<import("three/webgpu").Mesh, string>();
    const selectableMeshes: import("three/webgpu").Mesh[] = [];
    for (const [
      uid,
      instance,
    ] of this.sceneObjectManager.getAllSceneObjectInstances()) {
      if (!instance.group.visible) continue;
      instance.group.traverse((object) => {
        if (!(object as import("three/webgpu").Mesh).isMesh) return;
        if (!object.visible) return;
        const mesh = object as import("three/webgpu").Mesh;
        meshToUid.set(mesh, uid);
        selectableMeshes.push(mesh);
      });
    }
    if (selectableMeshes.length === 0) {
      return null;
    }

    this.mouseNdc.set(
      (point.x / point.viewportWidth) * 2 - 1,
      -(point.y / point.viewportHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.mouseNdc, camera);
    const intersections = this.raycaster.intersectObjects(selectableMeshes);
    for (const intersection of intersections) {
      const uid = meshToUid.get(
        intersection.object as import("three/webgpu").Mesh,
      );
      if (uid) return uid;
    }
    return null;
  }

  pickFixturesInScreenRect(
    camera: PerspectiveCamera,
    rect: VisualizerScreenRect,
  ): string[] {
    const minX = Math.min(rect.startX, rect.endX);
    const maxX = Math.max(rect.startX, rect.endX);
    const minY = Math.min(rect.startY, rect.endY);
    const maxY = Math.max(rect.startY, rect.endY);
    const selectedUids: string[] = [];
    const projectedPosition = new Vector3();

    for (const [
      uid,
      instance,
    ] of this.fixtureManager.getAllFixtureInstances()) {
      if (!instance.group.visible) continue;
      projectedPosition.copy(instance.group.position).project(camera);
      if (
        !Number.isFinite(projectedPosition.x) ||
        !Number.isFinite(projectedPosition.y)
      ) {
        continue;
      }
      if (projectedPosition.z < -1 || projectedPosition.z > 1) {
        continue;
      }

      const screenX = (projectedPosition.x + 1) * 0.5 * rect.viewportWidth;
      const screenY = (1 - projectedPosition.y) * 0.5 * rect.viewportHeight;
      if (
        screenX >= minX &&
        screenX <= maxX &&
        screenY >= minY &&
        screenY <= maxY
      ) {
        selectedUids.push(uid);
      }
    }

    return selectedUids;
  }

  /**
   * Update DMX parameter state for a single fixture's elements.
   * Used by the renderer API to push DMX values per-fixture.
   */
  updateSingleFixtureDmx(
    fixtureUid: string,
    elementDmx: FixtureElementDmxMap,
  ): void {
    const instance = this.fixtureManager.getFixtureInstance(fixtureUid);
    if (!instance) return;

    let colorState = this.fixtureColors.get(instance);
    if (!colorState) {
      colorState = new FixtureColorState();
      this.fixtureColors.set(instance, colorState);
    }
    const colorMap = colorState.update(
      elementDmx,
      getFixtureStrobeShutter(elementDmx),
      performance.now() / 1000,
    );

    // Use appropriate update function based on renderer type
    if (instance.rendererType !== "gdtf") {
      // Non-GDTF renderers (LED bar, strobe, moving head) use label-based keys
      updateFixtureColors(instance, colorMap);
      this.beamUpdater.updateFixtureBeam(fixtureUid, instance, colorMap);
    } else {
      // GDTF renderer uses label-based emitter mapping
      updateEmitterColors(instance, colorMap);

      // Apply pan/tilt rotations to GDTF geometry axis nodes
      if (instance.geometry) {
        const { pan, tilt } = getPanTiltFromElements(colorMap);
        updateGdtfPanTilt(instance, instance.geometry, pan, tilt);
      }

      // Update beam for this fixture
      this.beamUpdater.updateFixtureBeam(fixtureUid, instance, colorMap);
    }
  }

  /**
   * Update emitter colors from DMX parameter output.
   * Handles both specialized renderers (LED bar, strobe, moving head) and default GDTF rendering.
   * @param parametersImmediate Map of fixture UID to per-element output arrays
   * @param extractDmx Function to extract RGB+intensity+pan/tilt/zoom/frost from element output
   */
  updateEmitters(
    parametersImmediate: Map<string, Record<string, number>[]>,
    extractDmx: (
      output: Record<string, number>,
      element: FixtureElement,
      fixtureIntensity?: number,
    ) => {
      red: number;
      green: number;
      blue: number;
      intensity: number;
      pan?: number;
      tilt?: number;
      tiltSpeed: number;
      zoom: number;
      zoomDegrees?: number;
      focus?: number;
      frost: number;
      white?: number;
      strobeShutter?: number;
    },
    fixtureElements: Map<string, FixtureElement[]>,
  ): void {
    for (const [
      uid,
      instance,
    ] of this.fixtureManager.getAllFixtureInstances()) {
      const elementOutputs = parametersImmediate.get(uid);
      if (!elementOutputs) continue;

      const labelMap = this.fixtureManager.getElementLabelMap(uid);
      if (!labelMap) continue;

      const elements = fixtureElements.get(uid);
      if (!elements) continue;
      const fixtureIntensity = fixtureIntensityValueFromOutputs(
        elementOutputs,
        elements,
      );

      // Use specialized renderer for LED bars, strobe panels, moving heads
      if (instance.rendererType !== "gdtf") {
        // For non-GDTF renderers, use index-based keys to handle empty/duplicate labels
        const elementColors = new Map<
          string,
          Record<string, number | undefined> &
            EmitterColor & {
              pan?: number;
              tilt?: number;
              tiltSpeed?: number;
              zoom?: number;
              frost?: number;
              strobeShutter?: number;
            }
        >();
        const rawElementDmx = new Map<string, ReturnType<typeof extractDmx>>();
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i];
          const output = elementOutputs[i];
          if (!output) continue;

          const dmx = extractDmx(output, element, fixtureIntensity);
          rawElementDmx.set(String(i), dmx);
        }

        const nowSeconds = performance.now() / 1000;
        const fixtureStrobeShutter = getFixtureStrobeShutter(rawElementDmx);
        for (const [key, dmx] of rawElementDmx) {
          // Use index as key for non-GDTF renderers
          // pan/tilt from extractDmx are normalized for renderer rotation ranges
          elementColors.set(key, {
            ...dmx,
            red: dmx.red,
            green: dmx.green,
            blue: dmx.blue,
            intensity: strobeAdjustedIntensity(
              dmx.intensity,
              dmx.strobeShutter,
              fixtureStrobeShutter,
              nowSeconds,
            ),
            pan: dmx.pan,
            tilt: dmx.tilt,
            tiltSpeed: dmx.tiltSpeed,
            zoom: dmx.zoom,
            frost: dmx.frost,
            white: dmx.white,
            strobeShutter: dmx.strobeShutter,
          });
        }
        updateFixtureColors(instance, elementColors);
        this.beamUpdater.updateFixtureBeam(uid, instance, elementColors);
      } else {
        // Default GDTF renderer - use label-based mapping
        const elementColors = new Map<string, EmitterColor>();
        const rawElementDmx: Array<{
          element: FixtureElement;
          dmx: ReturnType<typeof extractDmx>;
        }> = [];
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i];
          const output = elementOutputs[i];
          if (!output) continue;

          const dmx = extractDmx(output, element, fixtureIntensity);
          rawElementDmx.push({ element, dmx });
        }

        const nowSeconds = performance.now() / 1000;
        const fixtureStrobeShutter = getFixtureStrobeShutter(
          new Map(
            rawElementDmx.map(({ element, dmx }) => [element.label, dmx]),
          ),
        );
        for (const { element, dmx } of rawElementDmx) {
          elementColors.set(element.label, {
            ...dmx,
            red: dmx.red,
            green: dmx.green,
            blue: dmx.blue,
            intensity: strobeAdjustedIntensity(
              dmx.intensity,
              dmx.strobeShutter,
              fixtureStrobeShutter,
              nowSeconds,
            ),
            pan: dmx.pan,
            tilt: dmx.tilt,
            zoom: dmx.zoom,
            zoomDegrees: dmx.zoomDegrees,
            focus: dmx.focus,
            frost: dmx.frost,
          });
        }

        // Only update emitters that exist
        const emitterColors = new Map<string, EmitterColor>();
        for (const [_nodeName, emitter] of instance.emitters) {
          const color = elementColors.get(emitter.controlledElement);
          if (color) {
            emitterColors.set(emitter.controlledElement, color);
          }
        }
        updateEmitterColors(instance, emitterColors);

        // Apply pan/tilt rotations to GDTF geometry axis nodes
        // Use the first element that provides pan/tilt values.
        if (instance.geometry) {
          const { pan, tilt } = getPanTiltFromElements(elementColors);
          updateGdtfPanTilt(instance, instance.geometry, pan, tilt);
        }

        // Update beam for this fixture using shared BeamUpdater
        this.beamUpdater.updateFixtureBeam(uid, instance, elementColors);
      }
    }
  }

  /**
   * Dispose the all resources.
   */
  dispose(): void {
    this.selectionHighlighter.dispose();
    this.beamUpdater.dispose();
    this.fixtureManager.dispose();
    this.sceneObjectManager.dispose();
  }
}
