// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Beam manager for visualizer fixtures.
 * Creates and updates volumetric light beams attached to fixture emitters.
 */

import {
  Mesh,
  Object3D,
  Quaternion,
  type Scene,
  SpotLight,
  Vector3,
} from "three/webgpu";
import { getBackendUrl } from "../../../../lib/api";
import type { VisualizerBeamQuality } from "../../../../lib/feature-flags";
import type { BeamOptics } from "../../../../types";
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
import { DEFAULT_STAGE_FLOOR_TOP_Y } from "../scene-environment";
import {
  type BeamMaterial,
  type BeamParameters,
  createBeamGeometry,
  createBeamMaterial,
  defaultBeamParameters,
  disposeBeamMaterial,
  updateBeamMaterial,
} from "./beam-material";
import { beamConeAngleDegrees } from "./beam-zoom";
import { resolveEmitterOptics } from "./emitter-optics";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import type { PrismProjection } from "./prism-optics";

/** Beam specification for a fixture */
export interface BeamSpec {
  beamAngle: number;
  fieldAngle: number;
  lumens: number;
}

/** Data for a single beam instance */
export interface BeamInstance {
  /** Scratch transforms reused when sampling this aperture's world pose. */
  origin: Vector3;
  direction: Vector3;
  orientation: Quaternion;
  mesh: Mesh;
  material: BeamMaterial;
  spotLight: SpotLight;
  spotlightTarget: Object3D;
  /** The parent object this beam is attached to */
  parent: Object3D;
  /** Current beam length in meters */
  beamLength: number;
}

/** Map of fixture UID to beam instances */
type BeamInstanceMap = Map<string, BeamInstance>;

/**
 * BeamManager creates and updates volumetric light beams for fixtures.
 */
export class BeamManager {
  private readonly volumeBatch: EmitterVolumeBatch;

  /** Reports illuminated emitters whose active masks exceed the shader sampling budget. */
  get reducedGoboEmitters(): number {
    return this.volumeBatch.goboAtlas.stacks.reducedStacks;
  }
  private readonly resolvedOptics = new WeakMap<
    BeamOptics,
    ReturnType<typeof resolveEmitterOptics>
  >();
  private beams: BeamInstanceMap = new Map();
  private beamQuality: VisualizerBeamQuality;
  /** Default beam specification when fixture doesn't provide one */
  private defaultBeamSpec: BeamSpec = {
    beamAngle: 15,
    fieldAngle: 30,
    lumens: 10000,
  };

  constructor(scene: Scene, beamQuality: VisualizerBeamQuality = "high") {
    this.beamQuality = beamQuality;
    this.volumeBatch = new EmitterVolumeBatch(scene);
  }

  /** Resolves a source image once during fixture setup, including non-ASCII archive paths. */
  loadGobo(path: string, media: string) {
    const bytes = new TextEncoder().encode(path);
    const encoded = btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return this.volumeBatch.goboAtlas.load(
      `${getBackendUrl()}/api/wheel-media/${encoded}/${encodeURIComponent(media)}`,
    );
  }

  /** Allocates imported prism capacity while fixture geometry is being synchronized. */
  reserveOpticalBeam(id: string, maxFacetCount: number): void {
    this.volumeBatch.reserve(id, maxFacetCount);
  }

  /** Publishes one imported aperture to the shared atmospheric draw. */
  updateOpticalBeam(
    id: string,
    parent: Object3D,
    optics: BeamOptics,
    color: EmitterColor,
    zoomDegrees?: number,
    goboSlot = 0,
    goboRotation = 0,
    facets?: readonly PrismProjection[],
    prismRotation = 0,
    focusDistance = 0,
    gobos?: readonly import("./emitter-optical-state").GoboStage[],
  ): void {
    if (!this.resolvedOptics.has(optics))
      this.resolvedOptics.set(optics, resolveEmitterOptics(optics));
    const resolved = this.resolvedOptics.get(optics);
    const baseSlope = Math.tan((optics.physical.beamAngle * Math.PI) / 360);
    const zoomScale =
      zoomDegrees !== undefined &&
      Number.isFinite(zoomDegrees) &&
      baseSlope > 1e-6
        ? Math.tan((Math.max(0, Math.min(170, zoomDegrees)) * Math.PI) / 360) /
          baseSlope
        : 1;
    if (resolved)
      this.volumeBatch.update(
        id,
        parent,
        resolved,
        color,
        30,
        zoomScale,
        goboSlot,
        goboRotation,
        facets,
        prismRotation,
        focusDistance,
        gobos,
      );
    else this.volumeBatch.remove(id);
  }

  /** Removes an aperture immediately on blackout rather than retaining stale scattering. */
  removeOpticalBeam(id: string): void {
    this.volumeBatch.remove(id);
  }

  /**
   * Get or create a beam for a fixture.
   * The beam is attached to the provided parent object.
   */
  getOrCreateBeam(fixtureUid: string, parent: Object3D): BeamInstance {
    let beam = this.beams.get(fixtureUid);
    if (beam) {
      return beam;
    }

    // Create new beam
    const material = createBeamMaterial(this.beamQuality);
    const geometry = createBeamGeometry(this.beamQuality);
    const mesh = new Mesh(geometry, material);
    mesh.name = `Beam_${fixtureUid}`;
    // ConeGeometry has tip at +Y, base at -Y. We want beam to extend downward (-Y).
    // No rotation needed - just position so tip is at origin.
    mesh.position.set(0, -0.5, 0); // Temporary position (updated dynamically in updateBeam)
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    // Render beams after opaque geometry but before UI overlays
    // This prevents z-fighting with floor transparency at certain camera angles
    mesh.renderOrder = 100;

    // Create spotlight for ground illumination
    const spotLight = new SpotLight(0xffffff, 0);
    spotLight.name = `SpotLight_${fixtureUid}`;
    spotLight.angle = Math.PI / 6;
    spotLight.penumbra = 0.5;
    spotLight.decay = 2;
    spotLight.distance = 50;
    spotLight.castShadow = false;

    const spotlightTarget = new Object3D();
    spotlightTarget.name = `SpotLightTarget_${fixtureUid}`;
    // Target along -Z (GDTF beam direction), scaled for parent hierarchy (0.001)
    spotlightTarget.position.set(0, 0, -50000);
    spotLight.target = spotlightTarget;

    // Add to parent
    parent.add(mesh);
    parent.add(spotLight);
    parent.add(spotlightTarget);

    beam = {
      origin: new Vector3(),
      direction: new Vector3(),
      orientation: new Quaternion(),
      mesh,
      material,
      spotLight,
      spotlightTarget,
      parent,
      beamLength: defaultBeamParameters.beamLength,
    };
    this.beams.set(fixtureUid, beam);
    return beam;
  }

  /**
   * Update a beam's appearance based on DMX values.
   */
  updateBeam(
    fixtureUid: string,
    color: EmitterColor,
    options?: {
      beamSpec?: BeamSpec;
      zoom?: number;
      frost?: number;
    },
  ): void {
    const beam = this.beams.get(fixtureUid);
    if (!beam) return;

    const beamSpec = options?.beamSpec ?? this.defaultBeamSpec;
    const zoom = options?.zoom ?? 0.5;
    const frost = options?.frost ?? 0;

    const coneAngleDeg = beamConeAngleDegrees(
      beamSpec.beamAngle,
      beamSpec.fieldAngle,
      zoom,
    );
    const halfAngleRad = (coneAngleDeg * Math.PI) / 360;

    // Calculate beam origin world position and direction
    // The beam mesh is parented to the emitter node, so it inherits transforms automatically.
    // We still need world-space values for the shader's lighting calculations.
    const beamOrigin = beam.origin;
    const beamDirection = beam.direction.set(0, 0, -1);
    const worldQuaternion = beam.orientation;

    beam.parent.updateMatrixWorld(true);
    beam.parent.getWorldPosition(beamOrigin);
    beam.parent.getWorldQuaternion(worldQuaternion);

    // Transform beam direction from local to world space for shader
    beamDirection.applyQuaternion(worldQuaternion);

    // Use default beam length and let clipping/depth handle the floor.
    // This keeps the cone cap away from the floor so angled beams do not show
    // a moving circular cutoff where they intersect the stage.
    const beamLength = defaultBeamParameters.beamLength;

    // Calculate base radius from cone angle
    const baseRadius = Math.min(
      beamLength * Math.tan(halfAngleRad),
      beamLength * 2,
    );

    // Scale beam mesh and rotate to point along -Z (GDTF beam direction)
    // ConeGeometry tip at +Y, base at -Y. Rotate +90° around X to point tip toward -Z.
    // The beam is parented inside the GDTF geometry tree which has 0.001 scale (mm to m).
    // We need to compensate by scaling the mesh by 1000x.
    const parentScale = 1000;
    beam.mesh.rotation.x = Math.PI / 2;
    beam.mesh.scale.set(
      baseRadius * parentScale,
      beamLength * parentScale,
      baseRadius * parentScale,
    );
    // After rotation, cone extends along Z. Position so tip is at origin.
    // Position is also affected by parent scale, so we scale it too.
    beam.mesh.position.set(0, 0, (-beamLength / 2) * parentScale);
    beam.beamLength = beamLength;

    // Build beam parameters with world-space direction
    const params: BeamParameters = {
      ...defaultBeamParameters,
      intensity: color.intensity,
      color: [color.red, color.green, color.blue, 0.6],
      coneAngleDegrees: coneAngleDeg,
      frostAmount: frost,
      beamDirection,
      beamOrigin,
      clipY: DEFAULT_STAGE_FLOOR_TOP_Y,
      softIntersectionFade: 0.0,
      beamLength,
    };

    updateBeamMaterial(beam.material, params);

    // Update spotlight
    beam.spotLight.angle = halfAngleRad;
    beam.spotLight.intensity =
      this.beamQuality === "low" ? 0 : color.intensity * beamSpec.lumens * 0.02;
    beam.spotLight.color.setRGB(color.red, color.green, color.blue);
    // Target along -Z (GDTF beam direction), scaled for parent hierarchy
    beam.spotlightTarget.position.set(0, 0, -beamLength * parentScale);

    // Set visibility
    beam.mesh.visible = color.intensity > 0.01;
    beam.spotLight.visible =
      this.beamQuality !== "low" && color.intensity > 0.01;
  }

  /**
   * Remove a beam for a fixture.
   */
  removeBeam(fixtureUid: string): void {
    const beam = this.beams.get(fixtureUid);
    if (!beam) return;

    beam.parent.remove(beam.mesh);
    beam.parent.remove(beam.spotLight);
    beam.parent.remove(beam.spotlightTarget);

    beam.mesh.geometry?.dispose();
    disposeBeamMaterial(beam.material);
    beam.spotLight.dispose();

    this.beams.delete(fixtureUid);
  }

  /**
   * Check if a fixture has a beam.
   */
  hasBeam(fixtureUid: string): boolean {
    return this.beams.has(fixtureUid);
  }

  /**
   * Get beam for a fixture.
   */
  getBeam(fixtureUid: string): BeamInstance | undefined {
    return this.beams.get(fixtureUid);
  }

  /**
   * Update all beams for fixtures.
   * Call this when fixture instances change.
   * Beam IDs use format "fixtureUid:emitterName" for multi-emitter fixtures.
   */
  syncWithFixtures(fixtures: Map<string, ExtendedFixtureInstance>): void {
    this.volumeBatch.sync(fixtures);
    for (const [beamId, beam] of this.beams) {
      const separator = beamId.indexOf(":");
      const fixture = fixtures.get(beamId.slice(0, separator));
      const emitter = fixture?.emitters.get(beamId.slice(separator + 1));
      if (!emitter || emitter.optics || emitter.nodeGroup !== beam.parent) {
        this.removeBeam(beamId);
      }
    }
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    this.volumeBatch.clear();
    for (const fixtureUid of [...this.beams.keys()]) {
      this.removeBeam(fixtureUid);
    }
  }

  /** Releases shared GPU resources when the owning scene is destroyed. */
  destroy(): void {
    this.dispose();
    this.volumeBatch.dispose();
  }
}
