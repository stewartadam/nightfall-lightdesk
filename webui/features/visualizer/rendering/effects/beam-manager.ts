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
  SpotLight,
  Texture,
  Vector3,
} from "three/webgpu";
import type { VisualizerBeamQuality } from "../../../../lib/feature-flags";
import { getLogger } from "../../../../lib/logger";
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
  isLowQualityBeamMaterial,
  updateBeamMaterial,
} from "./beam-material";
import { renderableConeAngleDegrees } from "./beam-zoom";

const log = getLogger(import.meta.url);

/** Fetches a gobo image and wraps it in a texture usable from the main thread or a worker. */
async function loadGoboTexture(url: string): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const texture = new Texture(bitmap);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Returns a white image for a spot light that projected a gobo and is now open.
 *
 * It matches the size of the image it replaces, since resizing a map in
 * place does not reliably reallocate its GPU texture.
 */
function openProjectionImage(width: number, height: number): ImageData {
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(255);
  return new ImageData(pixels, width, height);
}

/**
 * Projects a gobo image from a beam's spot light, or white when `gobo` is null.
 *
 * Lit materials key their pipelines on each spot light's map texture, so
 * assigning a different texture per gobo would recompile every lit material
 * in the scene on each change. Each light instead keeps one map, created
 * with its first gobo, and only that map's image changes; the map is only
 * replaced when a gobo of a different image size is selected. Lights that
 * never show a gobo get no map and cost no texture sampler.
 */
function setProjectedGobo(beam: BeamInstance, gobo: Texture | null): void {
  if (beam.projectedGobo === gobo) return;
  beam.projectedGobo = gobo;
  // Scene inspection (debug tools, e2e) reads whether a gobo is projected.
  beam.spotLight.userData.projectsGobo = gobo !== null;
  let map = beam.spotLight.map;
  const current = map?.image as { width: number; height: number } | undefined;
  const next = gobo?.image as { width: number; height: number } | undefined;
  if (
    map &&
    current &&
    next &&
    (current.width !== next.width || current.height !== next.height)
  ) {
    // A differently sized image needs a new GPU texture (see openProjectionImage).
    map.dispose();
    map = null;
  }
  if (!map) {
    if (!gobo) return;
    map = new Texture();
    map.flipY = false;
    beam.spotLight.map = map;
  }
  if (gobo) {
    map.image = gobo.image;
  } else {
    const { width, height } = map.image as { width: number; height: number };
    map.image = openProjectionImage(width, height);
  }
  map.needsUpdate = true;
}

/** Beam specification for a fixture */
export interface BeamSpec {
  beamAngle: number;
  fieldAngle: number;
  lumens: number;
}

/** Data for a single beam instance */
export interface BeamInstance {
  mesh: Mesh;
  material: BeamMaterial;
  spotLight: SpotLight;
  spotlightTarget: Object3D;
  /** The parent object this beam is attached to */
  parent: Object3D;
  /** Current beam length in meters */
  beamLength: number;
  /** Gobo image the spot light projects, or null for an open beam. */
  projectedGobo: Texture | null;
}

/** Map of fixture UID to beam instances */
type BeamInstanceMap = Map<string, BeamInstance>;

/**
 * BeamManager creates and updates volumetric light beams for fixtures.
 */
export class BeamManager {
  private beams: BeamInstanceMap = new Map();
  /** Gobo textures by URL; null while loading or after a failed load. */
  private goboTextures = new Map<string, Texture | null>();
  private beamQuality: VisualizerBeamQuality;
  /** Default beam specification when fixture doesn't provide one */
  private defaultBeamSpec: BeamSpec = {
    beamAngle: 15,
    fieldAngle: 30,
    lumens: 10000,
  };

  constructor(beamQuality: VisualizerBeamQuality = "high") {
    this.beamQuality = beamQuality;
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
      mesh,
      material,
      spotLight,
      spotlightTarget,
      parent,
      beamLength: defaultBeamParameters.beamLength,
      projectedGobo: null,
    };
    this.beams.set(fixtureUid, beam);
    return beam;
  }

  /**
   * Shapes a beam with a gobo image, or opens it when `goboUrl` is undefined.
   *
   * Images load once per URL (in the main thread or a worker) and are shared
   * between beams; until an image is ready the beam renders open. The image
   * is also projected by the beam's spot light onto the floor and scenery
   * (see {@link goboProjectionNode}); this works without shadow maps, which
   * the visualizer leaves disabled.
   */
  private applyGobo(beam: BeamInstance, goboUrl: string | undefined): void {
    const loaded = goboUrl ? this.goboTextures.get(goboUrl) : undefined;
    if (goboUrl && loaded === undefined) {
      this.goboTextures.set(goboUrl, null);
      loadGoboTexture(goboUrl).then(
        (texture) => this.goboTextures.set(goboUrl, texture),
        () => log.warn(`Failed to load gobo image ${goboUrl}`),
      );
    }
    if (isLowQualityBeamMaterial(beam.material)) return;
    setProjectedGobo(beam, loaded ?? null);
    const material = beam.material;
    if (loaded) {
      for (const node of material.goboTextureNodes) node.value = loaded;
      material.goboActiveUniform.value = 1;
    } else {
      material.goboActiveUniform.value = 0;
    }
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
      /** Beam angle in degrees stated by the profile, replacing `zoom`. */
      zoomDegrees?: number;
      /** Iris aperture as a fraction of the open beam. */
      iris?: number;
      frost?: number;
      /** URL of the gobo image shaping the beam; undefined for an open beam. */
      goboUrl?: string;
    },
  ): void {
    const beam = this.beams.get(fixtureUid);
    if (!beam) return;
    this.applyGobo(beam, options?.goboUrl);

    const beamSpec = options?.beamSpec ?? this.defaultBeamSpec;
    const zoom = options?.zoom ?? 0.5;
    const frost = options?.frost ?? 0;

    const coneAngleDeg =
      renderableConeAngleDegrees(
        beamSpec.beamAngle,
        beamSpec.fieldAngle,
        zoom,
        options?.zoomDegrees,
      ) * (options?.iris ?? 1);
    const halfAngleRad = (coneAngleDeg * Math.PI) / 360;

    // Calculate beam origin world position and direction
    // The beam mesh is parented to the emitter node, so it inherits transforms automatically.
    // We still need world-space values for the shader's lighting calculations.
    const beamOrigin = new Vector3();
    const beamDirection = new Vector3(0, 0, -1); // Local -Z direction (GDTF beam output)
    const worldQuaternion = new Quaternion();

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
    beam.spotLight.map?.dispose();
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
    // Remove beams for fixtures that no longer exist
    for (const beamId of this.beams.keys()) {
      // Extract fixture UID from composite beam ID (format: "fixtureUid:emitterName")
      const fixtureUid = beamId.split(":")[0];
      if (!fixtures.has(fixtureUid)) {
        this.removeBeam(beamId);
      }
    }
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    for (const fixtureUid of [...this.beams.keys()]) {
      this.removeBeam(fixtureUid);
    }
    for (const texture of this.goboTextures.values()) {
      texture?.dispose();
    }
    this.goboTextures.clear();
  }
}
