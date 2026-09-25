// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fixture management for Visualizer.
 * Handles fixture lifecycle (add/remove/update) and synchronization with stores.
 */

import {
  Euler,
  MathUtils,
  type MeshBasicMaterial,
  Quaternion,
  type Scene,
} from "three/webgpu";
import { createLogger } from "../../../lib/logger";
import type { RenderableFixture } from "../model/types";
import type { VisualizerQualityPreset } from "../state/settings";
import { getOpticalRenderContext } from "./effects/optical-render-context";
import { EMITTER_RADIANCE } from "./emitter-radiance";
import {
  buildFixtureWithoutGeometry,
  buildFixtureWithRenderer,
  disposeFixtureWithRenderer,
  type ExtendedFixtureInstance,
} from "./fixture-renderers";

const log = createLogger("visualizer:fixture-manager");

/**
 * FixtureManager handles the lifecycle of fixture instances in the Three.js scene.
 * It synchronizes reactive fixture data from stores with Three.js objects.
 */
export class FixtureManager {
  private scene: Scene;
  private beamQuality: VisualizerQualityPreset;
  private fixtureInstances: Map<string, ExtendedFixtureInstance> = new Map();
  /** Maps fixture UID -> element label -> element index (0-based) */
  private elementLabelMaps: Map<string, Map<string, number>> = new Map();
  /** Maps fixture UID -> ordered element labels (for strobe panel updates) */
  private elementLabelLists: Map<string, string[]> = new Map();

  constructor(scene: Scene, beamQuality: VisualizerQualityPreset = "high") {
    this.scene = scene;
    this.beamQuality = beamQuality;
  }

  /**
   * Synchronize fixtures in the scene with the provided fixture data.
   * Adds new fixtures, removes deleted ones, and updates existing ones.
   *
   * If a fixture was previously created without geometry and geometry is now
   * available, the fixture will be re-created with full GDTF geometry.
   */
  syncFixtures(fixtures: readonly RenderableFixture[]): void {
    const startMs = performance.now();
    const existingBefore = this.fixtureInstances.size;
    let removedCount = 0;
    let addedCount = 0;
    let rebuiltWithGeometryCount = 0;
    let transformUpdateCount = 0;

    const currentUids = new Set(fixtures.map((f) => f.uid));

    // Remove fixtures that no longer exist
    for (const [uid, _instance] of this.fixtureInstances) {
      if (!currentUids.has(uid)) {
        this.removeFixture(uid);
        removedCount += 1;
      }
    }

    // Add or update fixtures
    for (const fixture of fixtures) {
      const existing = this.fixtureInstances.get(fixture.uid);

      if (!existing) {
        // Add new fixture (with or without GDTF geometry)
        this.addFixture(fixture);
        addedCount += 1;
      } else {
        const layoutChanged = existing.layout !== fixture.layout;
        const physicalChanged =
          existing.physicalSignature !==
          JSON.stringify(fixture.physical ?? null);
        const geometryArrived =
          !fixture.layout && !existing.geometry && !!fixture.geometry;

        if (layoutChanged || geometryArrived || physicalChanged) {
          log.debug(
            `Re-creating fixture ${fixture.uid} after its rendering definition changed`,
          );
          this.removeFixture(fixture.uid);
          this.addFixture(fixture);
          rebuiltWithGeometryCount += 1;
        } else {
          // Update existing fixture position/rotation
          this.updateFixtureTransform(fixture);
          transformUpdateCount += 1;
        }
      }
    }

    const totalMs = performance.now() - startMs;
    log.trace(
      `syncFixtures fixtures=${fixtures.length} existingBefore=${existingBefore} existingAfter=${this.fixtureInstances.size} removed=${removedCount} added=${addedCount} rebuiltWithGeometry=${rebuiltWithGeometryCount} transformUpdates=${transformUpdateCount} totalMs=${totalMs.toFixed(2)}`,
    );
  }

  /**
   * Add a new fixture to the scene.
   */
  private addFixture(fixture: RenderableFixture): void {
    let instance: ExtendedFixtureInstance | null = null;

    if (fixture.geometry) {
      // Build from GDTF geometry
      instance = buildFixtureWithRenderer(
        fixture.uid,
        fixture.geometry,
        fixture.elements,
        fixture.beamType,
        this.beamQuality,
        fixture.layout,
        fixture.physical,
      );
    } else {
      // Try to build without geometry (simple LED bars, strobe panels, etc.)
      instance = buildFixtureWithoutGeometry(
        fixture.uid,
        fixture.elements,
        fixture.beamType,
        this.beamQuality,
        fixture.layout,
        fixture.physical,
      );
    }

    if (!instance) {
      // No renderer available for this fixture
      return;
    }

    instance.layout = fixture.layout;
    if (this.beamQuality !== "high") {
      const displayGain = 2 / EMITTER_RADIANCE;
      if (instance.ledBarData)
        (
          instance.ledBarData.cellMesh.material as MeshBasicMaterial
        ).color.setScalar(instance.ledBarData.filteredRow ? 0 : displayGain);
      instance.ledBarData?.filteredRow?.mesh.material.color.setScalar(
        displayGain,
      );
      for (const { mesh } of instance.strobePanelData?.emitterBatches ?? [])
        (mesh.material as MeshBasicMaterial).color.setScalar(displayGain);
    }
    const opticalContext = getOpticalRenderContext(this.scene);
    if (instance.movingHeadData) {
      instance.movingHeadData.sharedAtmosphere = !!opticalContext;
      instance.movingHeadData.sharedSurfaceLighting =
        !!opticalContext?.surfaceScene || this.beamQuality === "low";
      if (opticalContext?.surfaceScene)
        instance.movingHeadData.floorSpotMesh.visible = false;
    }
    if (instance.rotatingWashBeamData) {
      instance.rotatingWashBeamData.sharedAtmosphere = !!opticalContext;
      instance.rotatingWashBeamData.sharedSurfaceLighting =
        !!opticalContext?.surfaceScene || this.beamQuality === "low";
      if (opticalContext?.surfaceScene)
        for (const beam of instance.rotatingWashBeamData.beamEmitters)
          beam.floorSpotMesh.visible = false;
    }
    instance.physicalSignature = JSON.stringify(fixture.physical ?? null);

    // Apply fixture placement transform
    this.applyPlacement(instance, fixture);

    // Build element label -> index map for DMX lookups
    const labelMap = new Map<string, number>();
    const labelList: string[] = [];
    fixture.elements.forEach((element, index) => {
      labelMap.set(element.label, index);
      labelList.push(element.label);
    });
    this.elementLabelMaps.set(fixture.uid, labelMap);
    this.elementLabelLists.set(fixture.uid, labelList);

    this.scene.add(instance.group);
    this.fixtureInstances.set(fixture.uid, instance);

    if (instance.rendererType !== "gdtf") {
      log.debug(
        `Using ${instance.rendererType} renderer for ${fixture.make} ${fixture.model}`,
      );
    }
  }

  /**
   * Remove a fixture from the scene.
   */
  private removeFixture(uid: string): void {
    const instance = this.fixtureInstances.get(uid);
    if (!instance) return;

    this.scene.remove(instance.group);
    disposeFixtureWithRenderer(instance);
    this.fixtureInstances.delete(uid);
    this.elementLabelMaps.delete(uid);
    this.elementLabelLists.delete(uid);

    log.debug(`Removed fixture ${uid}`);
  }

  /**
   * Update the transform of an existing fixture.
   */
  private updateFixtureTransform(fixture: RenderableFixture): void {
    const instance = this.fixtureInstances.get(fixture.uid);
    if (!instance) return;

    this.applyPlacement(instance, fixture);
  }

  /**
   * Apply FixturePlacement position and rotation to a fixture instance.
   * Position is in meters, rotation is in degrees (Euler angles).
   *
   * For GDTF fixtures: The geometry tree is built in GDTF coordinate space (Z-up),
   * so we apply a base rotation of -90° X to convert to Three.js space (Y-up).
   *
   * For non-GDTF fixtures (simple LED bars, etc.): Built directly in Three.js Y-up
   * space, so we apply rotation directly without coordinate conversion.
   */
  private applyPlacement(
    instance: ExtendedFixtureInstance,
    fixture: RenderableFixture,
  ): void {
    const { position, rotation } = fixture;

    // Set position (already in meters)
    instance.group.position.set(position.x, position.y, position.z);
    this.applyRotation(instance, rotation);
  }

  private applyRotation(
    instance: ExtendedFixtureInstance,
    rotation: { x: number; y: number; z: number },
  ): void {
    if (instance.rendererType === "gdtf") {
      // GDTF fixtures need Z-up to Y-up conversion
      const baseRotation = new Quaternion().setFromEuler(
        new Euler(-Math.PI / 2, 0, 0, "XYZ"),
      );

      // User rotation in Three.js world space (Y-up)
      const userRotation = new Quaternion().setFromEuler(
        new Euler(
          MathUtils.degToRad(rotation.x),
          MathUtils.degToRad(rotation.y),
          MathUtils.degToRad(rotation.z),
          "XYZ",
        ),
      );

      // Apply user rotation first (in world space), then base conversion
      instance.group.quaternion.copy(userRotation).multiply(baseRotation);
    } else {
      // Non-GDTF fixtures (LED bars, strobe panels) are built in Y-up space
      // Apply rotation directly using ZYX order (same as V1 visualizer)
      instance.group.rotation.set(
        MathUtils.degToRad(rotation.x),
        MathUtils.degToRad(rotation.y),
        MathUtils.degToRad(rotation.z),
        "ZYX",
      );
    }
  }

  /**
   * Get a fixture instance by UID.
   */
  getFixtureInstance(uid: string): ExtendedFixtureInstance | undefined {
    return this.fixtureInstances.get(uid);
  }

  /**
   * Update a fixture position directly on its group transform.
   * Used for interactive drag previews before backend placement sync.
   */
  setFixturePosition(
    uid: string,
    position: { x: number; y: number; z: number },
  ): boolean {
    const instance = this.fixtureInstances.get(uid);
    if (!instance) {
      log.trace(`setFixturePosition uid=${uid} updated=false reason=missing`);
      return false;
    }
    instance.group.position.set(position.x, position.y, position.z);
    log.trace(
      `setFixturePosition uid=${uid} updated=true x=${position.x.toFixed(3)} y=${position.y.toFixed(3)} z=${position.z.toFixed(3)}`,
    );
    return true;
  }

  /**
   * Update fixture rotation directly on its group transform.
   * Rotation values are in degrees.
   */
  setFixtureRotation(
    uid: string,
    rotation: { x: number; y: number; z: number },
  ): boolean {
    const instance = this.fixtureInstances.get(uid);
    if (!instance) {
      log.trace(`setFixtureRotation uid=${uid} updated=false reason=missing`);
      return false;
    }
    this.applyRotation(instance, rotation);
    log.trace(
      `setFixtureRotation uid=${uid} updated=true x=${rotation.x.toFixed(3)} y=${rotation.y.toFixed(3)} z=${rotation.z.toFixed(3)}`,
    );
    return true;
  }

  /**
   * Get all fixture instances.
   */
  getAllFixtureInstances(): Map<string, ExtendedFixtureInstance> {
    return this.fixtureInstances;
  }

  /**
   * Get element label map for a fixture.
   * Used for DMX element-to-emitter mapping.
   */
  getElementLabelMap(uid: string): Map<string, number> | undefined {
    return this.elementLabelMaps.get(uid);
  }

  /**
   * Get ordered element labels for a fixture.
   * Used for strobe panel updates where element order matters.
   */
  getElementLabelList(uid: string): string[] | undefined {
    return this.elementLabelLists.get(uid);
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    for (const [uid] of this.fixtureInstances) {
      this.removeFixture(uid);
    }
  }
}
