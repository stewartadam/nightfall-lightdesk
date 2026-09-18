// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Debug overlay system for Visualizer.
 * Provides pluggable debug visualizations that can be toggled on/off.
 */

import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three/webgpu";
import { getLogger } from "../../../lib/logger";
import type { FixtureInstance, SceneObjectInstance } from "../model/types";

const log = getLogger(import.meta.url);

/** Target marker radius in world space (meters) */
const MARKER_RADIUS_METERS = 0.03;

/** Fixture labels map: uid -> label text */
export type FixtureLabels = Record<string, string>;

/**
 * Context provided to overlays during updates.
 */
export interface OverlayUpdateContext {
  fixtures: Map<string, FixtureInstance>;
  sceneObjects: Map<string, SceneObjectInstance>;
  labels: FixtureLabels;
}

/**
 * Base interface for debug overlays.
 * Debug overlays render visual markers to help debug fixture geometry and behavior.
 */
export interface DebugOverlay {
  /** Unique identifier for this overlay */
  readonly id: string;
  /** Human-readable description */
  readonly description: string;
  /** Whether the overlay is currently enabled */
  readonly enabled: boolean;
  /** Toggle the overlay on/off */
  toggle(): void;
  /** Update overlay markers for the given context */
  update(context: OverlayUpdateContext): void;
  /** Dispose all resources */
  dispose(): void;
}

/**
 * Debug overlay that shows magenta spheres at each emitter position.
 * Useful for verifying emitter placement in fixture geometry.
 */
export class EmitterDebugOverlay implements DebugOverlay {
  readonly id = "emitter-debug";
  readonly description = "Toggle emitter debug markers";

  private _enabled = false;
  private geometry: SphereGeometry | undefined;
  private material: MeshBasicMaterial | undefined;
  private markers: Mesh[] = [];

  get enabled(): boolean {
    return this._enabled;
  }

  toggle(): void {
    this._enabled = !this._enabled;
    log.debug(`Emitter debug ${this._enabled ? "enabled" : "disabled"}`);
  }

  update(context: OverlayUpdateContext): void {
    this.clearMarkers();

    if (!this._enabled) return;

    // Lazily create shared geometry and material
    // Use unit sphere (radius 1) - we'll scale each marker based on fixture group scale
    if (!this.geometry) {
      this.geometry = new SphereGeometry(1, 8, 6);
    }
    if (!this.material) {
      this.material = new MeshBasicMaterial({
        color: 0xff00ff,
        depthTest: false,
        transparent: true,
        opacity: 0.7,
      });
    }

    // Create markers for each emitter in each fixture
    for (const [_uid, instance] of context.fixtures) {
      // Get the fixture group's world scale to compute correct marker size
      const worldScale = new Vector3();
      instance.group.getWorldScale(worldScale);
      // Use the average scale factor (handles non-uniform scaling)
      const avgScale = (worldScale.x + worldScale.y + worldScale.z) / 3;
      // Compute marker scale: target radius in world space / current world scale
      const markerScale = MARKER_RADIUS_METERS / avgScale;

      for (const [_nodeName, emitter] of instance.emitters) {
        const marker = new Mesh(this.geometry, this.material);
        marker.renderOrder = 999;
        marker.position.set(0, 0, 0);
        marker.scale.setScalar(markerScale);
        emitter.mesh.add(marker);
        this.markers.push(marker);
      }
    }
  }

  private clearMarkers(): void {
    for (const marker of this.markers) {
      marker.parent?.remove(marker);
      // Don't dispose geometry/material - they're shared
    }
    this.markers.length = 0;
  }

  dispose(): void {
    this.clearMarkers();
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = undefined;
    this.material = undefined;
  }
}

/** Snap point marker radius in world space (meters) */
const SNAP_POINT_RADIUS_METERS = 0.08;

function createTextLabelSprite(text: string, color: string): Sprite {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d");

  if (ctx) {
    const fontSize = 20;
    const padding = 6;
    ctx.font = `bold ${fontSize}px monospace`;
    const textWidth = ctx.measureText(text).width;

    // Size canvas to fit text with padding
    canvas.width = Math.ceil(textWidth + padding * 2);
    canvas.height = fontSize + padding * 2;

    // Re-set font after resize (canvas resize clears context state)
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  const texture = new CanvasTexture(canvas);
  const spriteMat = new SpriteMaterial({
    map: texture,
    depthTest: false,
  });
  const sprite = new Sprite(spriteMat);

  // Scale based on canvas aspect ratio
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(aspect * 0.3, 0.3, 1);

  return sprite;
}

/**
 * Overlay that shows snap points at each fixture's position with labels.
 * Snap points help with fixture placement by showing attachment points.
 */
export class SnapPointsOverlay implements DebugOverlay {
  readonly id = "snap-points";
  readonly description = "Show fixture snap points";

  private _enabled = false;
  private geometry: SphereGeometry | undefined;
  private material: MeshBasicMaterial | undefined;
  private markers: Mesh[] = [];
  private labels: Sprite[] = [];

  get enabled(): boolean {
    return this._enabled;
  }

  toggle(): void {
    this._enabled = !this._enabled;
    log.debug(`Snap points ${this._enabled ? "enabled" : "disabled"}`);
  }

  update(context: OverlayUpdateContext): void {
    this.clearMarkers();

    if (!this._enabled) return;

    // Lazily create shared geometry and material
    if (!this.geometry) {
      this.geometry = new SphereGeometry(SNAP_POINT_RADIUS_METERS, 8, 6);
    }
    if (!this.material) {
      this.material = new MeshBasicMaterial({
        color: 0x00ff00,
        depthTest: false,
      });
    }

    for (const [uid, instance] of context.fixtures) {
      this.addSnapPointMarkerAndLabel(
        uid,
        instance.group.position,
        instance.group.parent,
        context.labels,
      );
    }

    for (const [uid, instance] of context.sceneObjects) {
      this.addSnapPointMarkerAndLabel(
        uid,
        instance.group.position,
        instance.group.parent,
        context.labels,
      );
    }
  }

  private addSnapPointMarkerAndLabel(
    uid: string,
    position: Vector3,
    parent: import("three/webgpu").Object3D | null,
    labels: FixtureLabels,
  ): void {
    if (!parent) return;

    const marker = new Mesh(this.geometry!, this.material!);
    marker.position.copy(position);
    marker.renderOrder = 998;
    marker.userData.fixtureUid = uid;
    parent.add(marker);
    this.markers.push(marker);

    const labelText = labels[uid];
    if (!labelText) return;

    const label = createTextLabelSprite(labelText, "#00ff00");
    label.position.copy(position);
    label.position.y += 0.3;
    label.renderOrder = 1001;
    parent.add(label);
    this.labels.push(label);
  }

  private clearMarkers(): void {
    for (const marker of this.markers) {
      marker.parent?.remove(marker);
    }
    this.markers.length = 0;

    for (const label of this.labels) {
      label.parent?.remove(label);
      (label.material as SpriteMaterial).map?.dispose();
      (label.material as SpriteMaterial).dispose();
    }
    this.labels.length = 0;
  }

  dispose(): void {
    this.clearMarkers();
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = undefined;
    this.material = undefined;
  }
}

/**
 * Registry for managing multiple debug overlays.
 * Provides a centralized way to register, toggle, and update overlays.
 */
export class DebugOverlayRegistry {
  private overlays = new Map<string, DebugOverlay>();
  private context: OverlayUpdateContext = {
    fixtures: new Map(),
    sceneObjects: new Map(),
    labels: {},
  };

  /**
   * Register a debug overlay.
   */
  register(overlay: DebugOverlay): void {
    this.overlays.set(overlay.id, overlay);
  }

  /**
   * Get an overlay by ID.
   */
  get<T extends DebugOverlay>(id: string): T | undefined {
    return this.overlays.get(id) as T | undefined;
  }

  /**
   * Toggle an overlay by ID.
   */
  toggle(id: string): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.toggle();
      overlay.update(this.context);
    }
  }

  /**
   * Set an overlay's enabled state directly (without toggling).
   */
  setEnabled(id: string, enabled: boolean): void {
    const overlay = this.overlays.get(id);
    if (overlay && overlay.enabled !== enabled) {
      overlay.toggle();
      overlay.update(this.context);
    }
  }

  /**
   * Update all overlays with new fixture data.
   */
  updateFixtures(fixtures: Map<string, FixtureInstance>): void {
    this.context.fixtures = fixtures;
    for (const overlay of this.overlays.values()) {
      if (overlay.enabled) {
        overlay.update(this.context);
      }
    }
  }

  /**
   * Update all overlays with new scene-object data.
   */
  updateSceneObjects(sceneObjects: Map<string, SceneObjectInstance>): void {
    this.context.sceneObjects = sceneObjects;
    for (const overlay of this.overlays.values()) {
      if (overlay.enabled) {
        overlay.update(this.context);
      }
    }
  }

  /**
   * Update fixture labels.
   */
  setLabels(labels: FixtureLabels): void {
    this.context.labels = labels;
    for (const overlay of this.overlays.values()) {
      if (overlay.enabled) {
        overlay.update(this.context);
      }
    }
  }

  /**
   * Notify overlays that fixture transforms changed without a full fixture sync.
   */
  notifyFixturesChanged(): void {
    for (const overlay of this.overlays.values()) {
      if (overlay.enabled) {
        overlay.update(this.context);
      }
    }
  }

  /**
   * Dispose the all overlays.
   */
  dispose(): void {
    for (const overlay of this.overlays.values()) {
      overlay.dispose();
    }
    this.overlays.clear();
  }
}
