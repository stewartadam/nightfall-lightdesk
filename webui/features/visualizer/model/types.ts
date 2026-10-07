// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Type definitions for Visualizer.
 */

import type { Group, Mesh, Object3D } from "three/webgpu";
import type {
  BeamOptics,
  BeamType,
  FixtureElement,
  FixtureGeometry,
  FixtureLayout,
  FixturePhysical,
  SceneObjectProperties,
  SceneObjectType,
} from "../../../types";
import type { GdtfJoint } from "../rendering/gdtf-joints";
import type { EmitterColor } from "../rendering/geometry-builder";
import type { OpticalParameterBinding } from "./optical-bindings";

/**
 * Fixture data prepared for rendering.
 * Contains all static fixture properties needed for visualization.
 */
export interface RenderableFixture {
  /** Unique fixture identifier */
  uid: string;
  /** Fixture numeric ID used by backend fixture commands */
  fixtureId: number;
  /** Manufacturer name */
  make: string;
  /** Model name */
  model: string;
  /** World position in meters */
  position: { x: number; y: number; z: number };
  /** Base rotation in degrees (Euler angles) */
  rotation: { x: number; y: number; z: number };
  /** GDTF geometry tree */
  geometry?: FixtureGeometry;
  /** Element metadata for DMX mapping (element label -> element index) */
  elements: FixtureElement[];
  /** Beam type for determining spotlight rendering */
  beamType?: BeamType;
  /** Source photometry retained for fixtures rendered without an imported geometry tree. */
  physical?: FixturePhysical;
  /** Change-detection key for `physical`, from {@link fixturePhysicalSignature}. */
  physicalSignature: string;
  /** Explicit physical layout independent of fixture display names. */
  layout?: FixtureLayout;
}

/**
 * Emitter data for a single beam/pixel.
 */
export interface EmitterData {
  /** Resolved output from a built-in optical control adapter, shared with the atmosphere pass. */
  beamColor?: EmitterColor;
  /** Imported optical distribution for this aperture, independent of fixture layout. */
  optics?: BeamOptics;
  /**
   * Element parameters driving this aperture's optics (gobo, prism, zoom,
   * focus), inherited through the geometry hierarchy.
   */
  opticalParameters?: readonly OpticalParameterBinding[];
  /** Source archive for resolving wheel media during setup. */
  gdtfPath?: string;
  /** Library revision of `gdtfPath`, versioning wheel media URLs. */
  gdtfRevision?: string;
  /** The mesh used to render this emitter */
  mesh: Mesh;
  /** Element name this emitter belongs to (for DMX mapping) */
  controlledElement: string;
  /** Reference to the node's Group for computing world position (debug) */
  nodeGroup?: Object3D;
}

/**
 * Rendered fixture instance in the scene.
 * Maps a fixture UID to its Three.js objects.
 */
export interface FixtureInstance {
  /** Fixture UID */
  uid: string;
  /** Root Three.js group containing all fixture geometry */
  group: Group;
  /** Map of node names to their Object3D instances */
  nodeObjects: Map<string, Object3D>;
  /** Map of beam node names to their emitter data */
  emitters: Map<string, EmitterData>;
  /** Articulated GDTF joints bound to element pan/tilt, when the geometry has any */
  joints?: GdtfJoint[];
}

/**
 * Scene object data prepared for rendering.
 * Contains all static properties needed for visualization.
 */
export interface RenderableSceneObject {
  /** Unique scene object identifier */
  uid: string;
  /** Scene object numeric ID used by backend scene-object commands */
  sceneObjectId: number;
  /** Object type (truss, audience, stageElement, custom) */
  objectType: SceneObjectType;
  /** Display name */
  label: string;
  /** World position in meters */
  position: { x: number; y: number; z: number };
  /** Base rotation in degrees (Euler angles) */
  rotation: { x: number; y: number; z: number };
  /** Type-specific properties */
  properties: SceneObjectProperties;
}

/**
 * Rendered scene object instance.
 */
export interface SceneObjectInstance {
  /** Scene object UID */
  uid: string;
  /** Object type */
  objectType: SceneObjectType;
  /** Root Three.js group */
  group: Group;
  /** Cached properties hash for detecting changes */
  propertiesHash: string;
}
