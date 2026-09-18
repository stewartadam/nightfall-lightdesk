// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Scene object management for Visualizer.
 * Handles scene object lifecycle (add/remove/update) and synchronization with stores.
 */

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  Box3,
  BoxGeometry,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  type Scene,
  Vector3,
} from "three/webgpu";
import { getBackendUrl } from "../../../lib/api";
import { createLogger } from "../../../lib/logger";
import type {
  AudienceProperties,
  CustomProperties,
  StageElementProperties,
  TrussProperties,
} from "../../../types";
import type {
  RenderableSceneObject,
  SceneObjectInstance,
} from "../model/types";

const log = createLogger("visualizer:scene-object-manager");

// Reusable materials for scene objects
const TRUSS_MATERIAL = new MeshStandardMaterial({
  color: 0x404040,
  metalness: 0.8,
  roughness: 0.3,
});

const AUDIENCE_MATERIAL = new MeshStandardMaterial({
  color: 0x666666,
  metalness: 0.1,
  roughness: 0.9,
});

const STAGE_ELEMENT_MATERIAL = new MeshStandardMaterial({
  color: 0x1a1a1a,
  metalness: 0.2,
  roughness: 0.8,
});

const CUSTOM_MATERIAL = new MeshStandardMaterial({
  color: 0x808080,
  metalness: 0.3,
  roughness: 0.6,
});

// Shared GLTF loader instance
const gltfLoader = new GLTFLoader();
/**
 * SceneObjectManager handles the lifecycle of scene object instances in the Three.js scene.
 * Scene objects are non-fixture 3D elements like trusses, audience areas, and stage elements.
 */
export class SceneObjectManager {
  private scene: Scene;
  private sceneObjectInstances: Map<string, SceneObjectInstance> = new Map();
  // Track pending model loads to avoid duplicate requests
  private pendingModelLoads: Map<string, boolean> = new Map();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Synchronize scene objects with the provided data.
   * Adds new objects, removes deleted ones, and updates existing ones.
   */
  syncSceneObjects(sceneObjects: readonly RenderableSceneObject[]): void {
    log.trace(
      `syncSceneObjects called with ${sceneObjects.length} objects, replacing existing ${this.sceneObjectInstances.size} objects`,
    );
    const currentUids = new Set(sceneObjects.map((obj) => obj.uid));

    // Remove scene objects that no longer exist
    for (const [uid] of this.sceneObjectInstances) {
      if (!currentUids.has(uid)) {
        this.removeSceneObject(uid);
      }
    }

    // Add or update scene objects
    for (const sceneObject of sceneObjects) {
      const existing = this.sceneObjectInstances.get(sceneObject.uid);

      if (!existing) {
        this.addSceneObject(sceneObject);
      } else {
        // Check if properties changed (requires rebuild)
        const newHash = this.computePropertiesHash(sceneObject);
        if (existing.propertiesHash !== newHash) {
          // Properties changed, rebuild the object
          log.debug(
            `Rebuilding scene object ${sceneObject.uid} due to property change`,
          );
          this.removeSceneObject(sceneObject.uid);
          this.addSceneObject(sceneObject);
        } else {
          // Just update transform
          this.updateSceneObjectTransform(sceneObject);
        }
      }
    }
  }

  /**
   * Add a new scene object to the scene.
   */
  private addSceneObject(sceneObject: RenderableSceneObject): void {
    let group: Group | null = null;

    switch (sceneObject.objectType) {
      case "truss":
        group = this.buildTruss(sceneObject.properties.data as TrussProperties);
        break;
      case "audience":
        group = this.buildAudience(
          sceneObject.properties.data as AudienceProperties,
        );
        break;
      case "stageElement":
        group = this.buildStageElement(
          sceneObject.properties.data as StageElementProperties,
        );
        break;
      case "custom":
        group = this.buildCustomObject(
          sceneObject.properties.data as CustomProperties,
          sceneObject.uid,
        );
        break;
      default:
        log.warn(`Unknown scene object type: ${sceneObject.objectType}`);
        return;
    }

    if (!group) {
      return;
    }

    // Apply transform
    this.applyTransform(group, sceneObject);

    const instance: SceneObjectInstance = {
      uid: sceneObject.uid,
      objectType: sceneObject.objectType,
      group,
      propertiesHash: this.computePropertiesHash(sceneObject),
    };

    this.scene.add(group);
    this.sceneObjectInstances.set(sceneObject.uid, instance);

    log.debug(
      `Added ${sceneObject.objectType} scene object: ${sceneObject.label}`,
    );
  }

  /**
   * Remove a scene object from the scene.
   */
  private removeSceneObject(uid: string): void {
    const instance = this.sceneObjectInstances.get(uid);
    if (!instance) return;

    this.pendingModelLoads.delete(uid);
    this.scene.remove(instance.group);
    this.disposeGroup(instance.group);
    this.sceneObjectInstances.delete(uid);

    log.debug(`Removed scene object ${uid}`);
  }

  /**
   * Update the transform of an existing scene object.
   */
  private updateSceneObjectTransform(sceneObject: RenderableSceneObject): void {
    const instance = this.sceneObjectInstances.get(sceneObject.uid);
    if (!instance) return;

    this.applyTransform(instance.group, sceneObject);
  }

  /**
   * Apply position and rotation to a group.
   */
  private applyTransform(
    group: Group,
    sceneObject: RenderableSceneObject,
  ): void {
    const { position, rotation } = sceneObject;
    this.applyPosition(group, position);
    this.applyRotation(group, rotation);
  }

  private applyPosition(
    group: Group,
    position: { x: number; y: number; z: number },
  ): void {
    group.position.set(position.x, position.y, position.z);
  }

  private applyRotation(
    group: Group,
    rotation: { x: number; y: number; z: number },
  ): void {
    group.rotation.set(
      MathUtils.degToRad(rotation.x),
      MathUtils.degToRad(rotation.y),
      MathUtils.degToRad(rotation.z),
      "XYZ",
    );
  }

  /**
   * Build a truss scene object.
   */
  private buildTruss(props: TrussProperties): Group {
    const group = new Group();
    const { length, trussType, diameter } = props;

    // Truss is built along the X axis
    const halfLength = length / 2;
    const tubeRadius = diameter * 0.05; // Tube thickness relative to truss diameter

    switch (trussType) {
      case "box": {
        // Box truss: 4 corner tubes + diagonals
        const cornerOffset = diameter / 2 - tubeRadius;
        const cornerPositions = [
          [-cornerOffset, -cornerOffset],
          [cornerOffset, -cornerOffset],
          [cornerOffset, cornerOffset],
          [-cornerOffset, cornerOffset],
        ];

        // Main corner tubes
        for (const [y, z] of cornerPositions) {
          const tube = new Mesh(
            new CylinderGeometry(tubeRadius, tubeRadius, length, 8),
            TRUSS_MATERIAL,
          );
          tube.rotation.z = Math.PI / 2; // Rotate to lie along X axis
          tube.position.set(0, y, z);
          group.add(tube);
        }

        // Cross braces (simplified)
        const braceSpacing = length / 4;
        for (let i = -1; i <= 1; i++) {
          const x = i * braceSpacing;
          // Horizontal braces
          for (const y of [-cornerOffset, cornerOffset]) {
            const brace = new Mesh(
              new BoxGeometry(
                tubeRadius * 2,
                diameter - tubeRadius * 4,
                tubeRadius * 2,
              ),
              TRUSS_MATERIAL,
            );
            brace.position.set(x, y, 0);
            group.add(brace);
          }
          // Vertical braces
          for (const z of [-cornerOffset, cornerOffset]) {
            const brace = new Mesh(
              new BoxGeometry(
                tubeRadius * 2,
                tubeRadius * 2,
                diameter - tubeRadius * 4,
              ),
              TRUSS_MATERIAL,
            );
            brace.position.set(x, 0, z);
            group.add(brace);
          }
        }
        break;
      }

      case "triangle": {
        // Triangle truss: 3 corner tubes
        const triRadius = diameter / 2 - tubeRadius;
        const cornerPositions = [
          [0, triRadius], // Top
          [
            -triRadius * Math.cos(Math.PI / 6),
            -triRadius * Math.sin(Math.PI / 6),
          ], // Bottom left
          [
            triRadius * Math.cos(Math.PI / 6),
            -triRadius * Math.sin(Math.PI / 6),
          ], // Bottom right
        ];

        for (const [y, z] of cornerPositions) {
          const tube = new Mesh(
            new CylinderGeometry(tubeRadius, tubeRadius, length, 8),
            TRUSS_MATERIAL,
          );
          tube.rotation.z = Math.PI / 2;
          tube.position.set(0, y, z);
          group.add(tube);
        }
        break;
      }

      default: {
        // Ladder truss (default): 2 main tubes with rungs
        const railOffset = diameter / 2 - tubeRadius;

        // Main rails
        for (const z of [-railOffset, railOffset]) {
          const rail = new Mesh(
            new CylinderGeometry(tubeRadius, tubeRadius, length, 8),
            TRUSS_MATERIAL,
          );
          rail.rotation.z = Math.PI / 2;
          rail.position.set(0, 0, z);
          group.add(rail);
        }

        // Rungs
        const rungCount = Math.max(2, Math.floor(length / 0.5));
        const rungSpacing = length / (rungCount + 1);
        for (let i = 1; i <= rungCount; i++) {
          const x = -halfLength + i * rungSpacing;
          const rung = new Mesh(
            new CylinderGeometry(
              tubeRadius * 0.8,
              tubeRadius * 0.8,
              diameter - tubeRadius * 4,
              8,
            ),
            TRUSS_MATERIAL,
          );
          rung.rotation.x = Math.PI / 2;
          rung.position.set(x, 0, 0);
          group.add(rung);
        }
        break;
      }
    }

    return group;
  }

  /**
   * Build an audience scene object.
   */
  private buildAudience(props: AudienceProperties): Group {
    const group = new Group();
    const { width, depth, density, heightVariation } = props;

    // Create a simple representation of audience as a grid of cylinders
    const personRadius = 0.2;
    const personHeight = 1.7;
    const spacing = 1 / Math.sqrt(density);

    const numX = Math.floor(width / spacing);
    const numZ = Math.floor(depth / spacing);

    // Limit to reasonable number of instances
    const maxPeople = 500;
    const totalPeople = numX * numZ;
    const skipFactor =
      totalPeople > maxPeople ? Math.ceil(totalPeople / maxPeople) : 1;

    for (let i = 0; i < numX; i += skipFactor) {
      for (let j = 0; j < numZ; j += skipFactor) {
        const x =
          (i - numX / 2) * spacing + (Math.random() - 0.5) * spacing * 0.3;
        const z =
          (j - numZ / 2) * spacing + (Math.random() - 0.5) * spacing * 0.3;
        const heightVar =
          (Math.random() - 0.5) * heightVariation * personHeight;

        const person = new Mesh(
          new CylinderGeometry(
            personRadius * 0.3, // Head
            personRadius, // Body
            personHeight + heightVar,
            6,
          ),
          AUDIENCE_MATERIAL,
        );
        person.position.set(x, (personHeight + heightVar) / 2, z);
        group.add(person);
      }
    }

    return group;
  }

  /**
   * Build a stage element scene object.
   * Currently just creates a placeholder box until model loading is implemented.
   */
  private buildStageElement(props: StageElementProperties): Group {
    const group = new Group();
    const { scale } = props;

    // Placeholder: 1m cube scaled
    const box = new Mesh(
      new BoxGeometry(1 * scale, 1 * scale, 1 * scale),
      STAGE_ELEMENT_MATERIAL,
    );
    box.position.y = 0.5 * scale;
    group.add(box);

    return group;
  }

  /**
   * Build a custom scene object.
   * If modelPath is available, loads the GLB model asynchronously.
   * Shows a placeholder while loading or if no model is specified.
   */
  private buildCustomObject(props: CustomProperties, uid?: string): Group {
    const group = new Group();
    const { scale, colorOverride, modelPath } = props;

    // Create material with color override if specified
    let material = CUSTOM_MATERIAL;
    if (colorOverride) {
      const color = Number.parseInt(colorOverride.replace("#", ""), 16);
      if (!Number.isNaN(color)) {
        material = new MeshStandardMaterial({
          color,
          metalness: 0.3,
          roughness: 0.6,
        });
      }
    }

    // Create placeholder box (will be replaced when model loads)
    const placeholder = new Mesh(
      new BoxGeometry(0.5 * scale, 0.5 * scale, 0.5 * scale),
      material,
    );
    placeholder.position.y = 0.25 * scale;
    placeholder.name = "placeholder";
    group.add(placeholder);

    // If modelPath is available, load the GLB file
    if (modelPath && uid) {
      this.loadCustomModel(uid, modelPath, scale, group);
    }

    return group;
  }

  /**
   * Load a GLB model for a custom scene object.
   */
  private loadCustomModel(
    uid: string,
    modelPath: string,
    scale: number,
    group: Group,
  ): void {
    // Skip if already loading
    if (this.pendingModelLoads.get(uid)) {
      return;
    }

    this.pendingModelLoads.set(uid, true);

    // Construct the model URL from the backend
    const modelUrl = `${getBackendUrl()}/api/object-model/${modelPath}`;
    log.debug(`Loading custom object model from: ${modelUrl}`);

    gltfLoader.load(
      modelUrl,
      (gltf) => {
        this.pendingModelLoads.delete(uid);

        // Check if the instance still exists (may have been removed during load)
        const instance = this.sceneObjectInstances.get(uid);
        if (!instance || instance.group !== group) {
          log.debug(
            `Scene object ${uid} no longer exists, discarding loaded model`,
          );
          return;
        }

        // Remove placeholder
        const placeholder = group.getObjectByName("placeholder");
        if (placeholder) {
          group.remove(placeholder);
          if (placeholder instanceof Mesh) {
            placeholder.geometry?.dispose();
          }
        }

        // Add loaded model
        const model = gltf.scene;
        model.scale.set(scale, scale, scale);

        // Center the model
        const box = new Box3().setFromObject(model);
        const center = box.getCenter(new Vector3());
        model.position.sub(center);
        model.position.y += (box.max.y - box.min.y) / 2;

        group.add(model);
        log.debug(`Loaded custom object model for ${uid}`);
      },
      undefined,
      (error) => {
        this.pendingModelLoads.delete(uid);
        log.warn(`Failed to load custom object model for ${uid}:`, error);
        // Keep placeholder visible on error
      },
    );
  }
  /**
   * Compute a hash of scene object properties for change detection.
   */
  private computePropertiesHash(sceneObject: RenderableSceneObject): string {
    return JSON.stringify(sceneObject.properties);
  }

  /**
   * Dispose of a group and all its children's geometry and materials.
   */
  private disposeGroup(group: Group): void {
    group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry?.dispose();
        // Don't dispose shared materials
        if (
          object.material !== TRUSS_MATERIAL &&
          object.material !== AUDIENCE_MATERIAL &&
          object.material !== STAGE_ELEMENT_MATERIAL &&
          object.material !== CUSTOM_MATERIAL
        ) {
          if (Array.isArray(object.material)) {
            for (const m of object.material) {
              m.dispose();
            }
          } else {
            object.material?.dispose();
          }
        }
      }
    });
  }

  /**
   * Get a scene object instance by UID.
   */
  getSceneObjectInstance(uid: string): SceneObjectInstance | undefined {
    return this.sceneObjectInstances.get(uid);
  }

  /**
   * Get all scene object instances.
   */
  getAllSceneObjectInstances(): Map<string, SceneObjectInstance> {
    return this.sceneObjectInstances;
  }

  /**
   * Update scene-object position directly on its group transform.
   * Used for interactive drag previews before backend placement sync.
   */
  setSceneObjectPosition(
    uid: string,
    position: { x: number; y: number; z: number },
  ): boolean {
    const instance = this.sceneObjectInstances.get(uid);
    if (!instance) return false;
    this.applyPosition(instance.group, position);
    return true;
  }

  /**
   * Update scene-object rotation directly on its group transform.
   * Rotation values are in degrees.
   */
  setSceneObjectRotation(
    uid: string,
    rotation: { x: number; y: number; z: number },
  ): boolean {
    const instance = this.sceneObjectInstances.get(uid);
    if (!instance) return false;
    this.applyRotation(instance.group, rotation);
    return true;
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    for (const [uid] of this.sceneObjectInstances) {
      this.removeSceneObject(uid);
    }
  }
}
