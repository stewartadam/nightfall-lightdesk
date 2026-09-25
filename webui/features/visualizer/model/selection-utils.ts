// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Selection highlighting utilities for Visualizer.
 * Provides functions to highlight selected fixtures and fixture elements in the
 * 3D scene.
 */

import type { Object3D } from "three";
import { Mesh } from "three/webgpu";
import { getLogger } from "../../../lib/logger";
import type { SelectionTarget } from "../../../lib/selection-targets";
import type { ExtendedFixtureInstance } from "../rendering/fixture-renderers";
import type { SceneObjectInstance } from "./types";

const log = getLogger(import.meta.url);

/** Resolve a selection target's fixture-element label from explicit label or index. */
function resolveTargetElementLabel(
  instance: ExtendedFixtureInstance,
  target: SelectionTarget,
): string | undefined {
  if (target.elementLabel) return target.elementLabel;
  if (target.elementIndex == null) return undefined;
  return (
    instance.elementLabels?.[target.elementIndex - 1] ??
    String(target.elementIndex)
  );
}

/** Return an emitter object whose controlled element matches a label. */
function findEmitterForElementLabel(
  instance: ExtendedFixtureInstance,
  elementLabel: string,
): Object3D | undefined {
  for (const emitter of instance.emitters.values()) {
    if (emitter.controlledElement === elementLabel) return emitter.mesh;
  }
  return undefined;
}

/** Get meshes to highlight for a fixture based on its renderer type. */
export const getSelectionMeshes = (
  instance: ExtendedFixtureInstance,
): Object3D[] => {
  const meshes: Object3D[] = [];

  switch (instance.rendererType) {
    case "moving-head":
      if (instance.movingHeadData) {
        instance.movingHeadData.yokeGroup.traverse((child) => {
          if (
            child instanceof Mesh &&
            child.name !== "Beam" &&
            child.name !== "Lens"
          ) {
            meshes.push(child);
          }
        });
        instance.movingHeadData.headGroup.traverse((child) => {
          if (
            child instanceof Mesh &&
            child.name !== "Beam" &&
            child.name !== "Lens"
          ) {
            meshes.push(child);
          }
        });
      }
      break;

    case "led-bar":
      if (instance.ledBarData) {
        const housing = instance.group.children[0];
        if (housing instanceof Mesh) {
          meshes.push(housing);
        }
      }
      break;

    case "strobe-panel":
      if (instance.strobePanelData) {
        instance.group.traverse((child) => {
          if (
            child instanceof Mesh &&
            child.name !== "Pixel" &&
            child.userData.visualizerCellBatch !== true &&
            child.name !== "WhiteSegment" &&
            child.name !== "TopRgbSegment" &&
            child.name !== "BottomRgbSegment"
          ) {
            meshes.push(child);
          }
        });
        return meshes;
      }
      break;

    case "rotating-wash-beam":
      instance.group.traverse((child) => {
        if (
          child instanceof Mesh &&
          !child.name.startsWith("Lens_") &&
          !child.name.startsWith("Beam_") &&
          !child.name.includes("StripPixel")
        ) {
          meshes.push(child);
        }
      });
      return meshes;

    default:
      instance.group.traverse((child) => {
        if (child instanceof Mesh && !child.name.endsWith("_emitter")) {
          meshes.push(child);
        }
      });
      return meshes;
  }

  return meshes;
};

/** Get the most specific highlightable objects for a selection target. */
export function getSelectionTargetObjects(
  instance: ExtendedFixtureInstance,
  target: SelectionTarget,
): Object3D[] {
  const elementLabel = resolveTargetElementLabel(instance, target);
  if (!elementLabel) return getSelectionMeshes(instance);

  if (instance.rendererType === "led-bar" && instance.ledBarData) {
    const cellIndex = instance.ledBarData.elementToCellIndex.get(elementLabel);
    const mesh =
      cellIndex !== undefined
        ? instance.ledBarData.cellSelectionMeshes[cellIndex]
        : undefined;
    if (mesh) return [mesh];
  }

  if (instance.rendererType === "strobe-panel" && instance.strobePanelData) {
    const pixelIndex =
      instance.strobePanelData.pixelElementLabels.indexOf(elementLabel);
    if (pixelIndex >= 0) {
      const mesh = instance.strobePanelData.pixelMeshes[pixelIndex];
      if (mesh) return [mesh];
    }
    const segmentIndex =
      instance.strobePanelData.whiteSegmentElementLabels.indexOf(elementLabel);
    if (segmentIndex >= 0) {
      const mesh = instance.strobePanelData.whiteSegmentMeshes[segmentIndex];
      if (mesh) return [mesh];
    }
  }

  const emitter = findEmitterForElementLabel(instance, elementLabel);
  if (emitter) return [emitter];

  return getSelectionMeshes(instance);
}

/** Get meshes to highlight for a scene object instance. */
export function getSceneObjectSelectionMeshes(
  instance: SceneObjectInstance,
): Object3D[] {
  const meshes: Object3D[] = [];
  instance.group.traverse((child) => {
    if (child instanceof Mesh) {
      meshes.push(child);
    }
  });
  return meshes.length > 0 ? meshes : [instance.group];
}

/**
 * SelectionHighlighter manages the outlined selection objects.
 * Tracks which structural or element meshes should be outlined for selected fixtures.
 */
export class SelectionHighlighter {
  private selectedObjects: Object3D[] = [];
  private editSelectionObjects: Object3D[] = [];
  private programmerValueObjects: Object3D[] = [];
  private activeTargetObjects: Object3D[] = [];
  private highlightEnabled = true;
  private fixtureInstances: Map<string, ExtendedFixtureInstance>;
  private sceneObjectInstances: Map<string, SceneObjectInstance> = new Map();
  private currentSelection: Set<string> = new Set();
  private currentEditSelection: Set<string> = new Set();
  private currentProgrammerValues: Set<string> = new Set();
  private currentTargets: SelectionTarget[] = [];

  constructor(fixtureInstances: Map<string, ExtendedFixtureInstance>) {
    this.fixtureInstances = fixtureInstances;
  }

  /** Update fixture instances and re-apply the current highlight state. */
  setFixtureInstances(instances: Map<string, ExtendedFixtureInstance>): void {
    this.fixtureInstances = instances;
    this.updateSelectedObjects();
  }

  /** Update the scene-object instances available for selection highlighting. */
  setSceneObjectInstances(instances: Map<string, SceneObjectInstance>): void {
    this.sceneObjectInstances = instances;
    this.updateSelectedObjects();
  }

  /** Set whether highlighting is enabled. */
  setHighlightEnabled(enabled: boolean): void {
    if (this.highlightEnabled === enabled) return;
    this.highlightEnabled = enabled;
    this.updateSelectedObjects();
  }

  /** Get whether highlighting is enabled. */
  getHighlightEnabled(): boolean {
    return this.highlightEnabled;
  }

  /** Update selected whole fixtures by UID. */
  setSelection(selectedUids: Set<string>): void {
    this.currentSelection = new Set(selectedUids);
    this.updateSelectedObjects();
  }

  /** Update panel edit-target UIDs by fixture or scene-object UID. */
  setEditSelection(selectedUids: Set<string>): void {
    this.currentEditSelection = new Set(selectedUids);
    this.updateSelectedObjects();
  }

  /** Update fixture UIDs that currently have values in the programmer. */
  setProgrammerValues(fixtureUids: Set<string>): void {
    this.currentProgrammerValues = new Set(fixtureUids);
    this.updateSelectedObjects();
  }

  /** Update active detailed selection targets for fixture-element highlighting. */
  setActiveSelectionTargets(targets: readonly SelectionTarget[]): void {
    this.currentTargets = [...targets];
    this.updateSelectedObjects();
  }

  /** Get general selected objects for the standard outline pass. */
  getSelectedObjects(): Object3D[] {
    return this.selectedObjects;
  }

  /** Get panel edit-target objects for the edit-selection outline pass. */
  getEditSelectionObjects(): Object3D[] {
    return this.editSelectionObjects;
  }

  /** Get fixture objects with live programmer values for the red outline pass. */
  getProgrammerValueObjects(): Object3D[] {
    return this.programmerValueObjects;
  }

  /** Get active-span selected objects for the prominent outline pass. */
  getActiveTargetObjects(): Object3D[] {
    return this.activeTargetObjects;
  }

  /** Rebuild selected object lists from current state while preserving array identity. */
  private updateSelectedObjects(): void {
    this.selectedObjects.length = 0;
    this.editSelectionObjects.length = 0;
    this.programmerValueObjects.length = 0;
    this.activeTargetObjects.length = 0;
    if (!this.highlightEnabled) {
      return;
    }

    for (const uid of this.currentSelection) {
      const instance = this.fixtureInstances.get(uid);
      if (instance) {
        this.selectedObjects.push(...getSelectionMeshes(instance));
        continue;
      }

      const sceneObjectInstance = this.sceneObjectInstances.get(uid);
      if (sceneObjectInstance) {
        this.selectedObjects.push(
          ...getSceneObjectSelectionMeshes(sceneObjectInstance),
        );
      }
    }

    for (const uid of this.currentEditSelection) {
      const instance = this.fixtureInstances.get(uid);
      if (instance) {
        this.editSelectionObjects.push(...getSelectionMeshes(instance));
        continue;
      }

      const sceneObjectInstance = this.sceneObjectInstances.get(uid);
      if (sceneObjectInstance) {
        this.editSelectionObjects.push(
          ...getSceneObjectSelectionMeshes(sceneObjectInstance),
        );
      }
    }

    for (const uid of this.currentProgrammerValues) {
      const instance = this.fixtureInstances.get(uid);
      if (instance) {
        this.programmerValueObjects.push(...getSelectionMeshes(instance));
      }
    }

    for (const target of this.currentTargets) {
      const instance = this.fixtureInstances.get(target.fixtureUid);
      if (!instance) continue;
      this.activeTargetObjects.push(
        ...getSelectionTargetObjects(instance, target),
      );
    }

    log.debug(
      `setSelection: ${this.currentSelection.size} items selected, ${this.currentEditSelection.size} edit targets, ${this.currentProgrammerValues.size} programmer fixtures, ${this.currentTargets.length} detailed targets, ${this.selectedObjects.length} general objects outlined, ${this.editSelectionObjects.length} edit objects outlined, ${this.programmerValueObjects.length} programmer objects outlined, ${this.activeTargetObjects.length} active span objects outlined, highlightEnabled=${this.highlightEnabled}`,
    );
  }

  /** Clear all highlights and reset state. */
  dispose(): void {
    this.selectedObjects.length = 0;
    this.editSelectionObjects.length = 0;
    this.programmerValueObjects.length = 0;
    this.activeTargetObjects.length = 0;
    this.currentSelection.clear();
    this.currentEditSelection.clear();
    this.currentProgrammerValues.clear();
    this.currentTargets = [];
  }
}
