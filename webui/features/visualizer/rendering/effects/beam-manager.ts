// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Beam manager for visualizer fixtures.
 * Creates and updates volumetric light beams attached to fixture emitters,
 * and drives the shared spot light pool that lights stage surfaces.
 */

import {
  Mesh,
  type Object3D,
  Quaternion,
  type Scene,
  Texture,
  Vector3,
} from "three/webgpu";
import type { VisualizerBeamQuality } from "../../../../lib/feature-flags";
import { getLogger } from "../../../../lib/logger";
import { excludeFromSelection } from "../../model/selection-exclusion";
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
import { DEFAULT_STAGE_FLOOR_TOP_Y } from "../scene-environment";
import { BeamLightPool } from "./beam-light-pool";
import {
  type BeamLightSample,
  buildBeamLightProxies,
} from "./beam-light-proxies";
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

/** Beam specification for a fixture */
export interface BeamSpec {
  beamAngle: number;
  fieldAngle: number;
  lumens: number;
}

/** Surface lighting a beam contributes, pooled across beams each frame. */
export interface BeamLight {
  /** Spot light intensity; 0 when the beam does not light surfaces. */
  intensity: number;
  /** Half cone angle in radians. */
  halfAngle: number;
  /** Linear color, 0-1 per channel. */
  red: number;
  green: number;
  blue: number;
  /** Gobo image projected onto surfaces, or null for an open beam. */
  gobo: Texture | null;
}

/** Data for a single beam instance */
export interface BeamInstance {
  mesh: Mesh;
  material: BeamMaterial;
  /** The emitter node this beam is attached to; its -Z axis is the beam direction. */
  parent: Object3D;
  /** Current beam length in meters */
  beamLength: number;
  /** Surface lighting this beam contributes to the light pool. */
  light: BeamLight;
}

/** Map of beam ID ("fixtureUid:emitterName") to beam instances */
type BeamInstanceMap = Map<string, BeamInstance>;

/**
 * BeamManager creates and updates volumetric light beams for fixtures.
 */
export class BeamManager {
  private beams: BeamInstanceMap = new Map();
  /** Gobo textures by URL; null while loading or after a failed load. */
  private goboTextures = new Map<string, Texture | null>();
  private beamQuality: VisualizerBeamQuality;
  /** Spot lights lighting stage surfaces; absent without a scene or in low quality. */
  private lightPool: BeamLightPool | null = null;
  /** Scene whose render hook syncs the light pool. */
  private scene: Scene | null = null;
  /** Default beam specification when fixture doesn't provide one */
  private defaultBeamSpec: BeamSpec = {
    beamAngle: 15,
    fieldAngle: 30,
    lumens: 10000,
  };

  /**
   * Creates a beam manager; with a scene (and high quality), a fixed light
   * pool is added to it and synced before every render.
   */
  constructor(beamQuality: VisualizerBeamQuality = "high", scene?: Scene) {
    this.beamQuality = beamQuality;
    if (scene && beamQuality !== "low") {
      this.scene = scene;
      this.lightPool = new BeamLightPool(scene);
      scene.onBeforeRender = () => this.syncLights();
    }
  }

  /**
   * Get or create a beam for a fixture.
   * The beam is attached to the provided parent object.
   */
  getOrCreateBeam(beamId: string, parent: Object3D): BeamInstance {
    let beam = this.beams.get(beamId);
    if (beam) {
      return beam;
    }

    const material = createBeamMaterial(this.beamQuality);
    const geometry = createBeamGeometry(this.beamQuality);
    const mesh = new Mesh(geometry, material);
    mesh.name = `Beam_${beamId}`;
    excludeFromSelection(mesh);
    // Temporary position (updated dynamically in updateBeam)
    mesh.position.set(0, -0.5, 0);
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    // Render beams after opaque geometry but before UI overlays
    // This prevents z-fighting with floor transparency at certain camera angles
    mesh.renderOrder = 100;
    parent.add(mesh);

    beam = {
      mesh,
      material,
      parent,
      beamLength: defaultBeamParameters.beamLength,
      light: {
        intensity: 0,
        halfAngle: Math.PI / 6,
        red: 1,
        green: 1,
        blue: 1,
        gobo: null,
      },
    };
    this.beams.set(beamId, beam);
    return beam;
  }

  /**
   * Shapes a beam with a gobo image, or opens it when `goboUrl` is undefined.
   *
   * Images load once per URL (in the main thread or a worker) and are shared
   * between beams; until an image is ready the beam renders open. The image
   * is also projected onto stage surfaces by the pooled light standing in
   * for the beam, when that light stands for this beam alone.
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
    beam.light.gobo = loaded ?? null;
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
    beamId: string,
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
    const beam = this.beams.get(beamId);
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

    // The beam mesh is parented to the emitter node, so it inherits transforms automatically.
    // We still need world-space values for the shader's lighting calculations.
    const beamOrigin = new Vector3();
    const beamDirection = new Vector3(0, 0, -1); // Local -Z direction (GDTF beam output)
    const worldQuaternion = new Quaternion();

    beam.parent.updateMatrixWorld(true);
    beam.parent.getWorldPosition(beamOrigin);
    beam.parent.getWorldQuaternion(worldQuaternion);
    beamDirection.applyQuaternion(worldQuaternion);

    // Use default beam length and let clipping/depth handle the floor.
    // This keeps the cone cap away from the floor so angled beams do not show
    // a moving circular cutoff where they intersect the stage.
    const beamLength = defaultBeamParameters.beamLength;

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
    beam.mesh.position.set(0, 0, (-beamLength / 2) * parentScale);
    beam.beamLength = beamLength;

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

    const lit = color.intensity > 0.01;
    beam.mesh.visible = lit;
    beam.light.halfAngle = halfAngleRad;
    beam.light.intensity = lit ? color.intensity * beamSpec.lumens * 0.02 : 0;
    beam.light.red = color.red;
    beam.light.green = color.green;
    beam.light.blue = color.blue;
  }

  /** Hides a beam and stops it lighting surfaces, e.g. when its intensity drops out. */
  hideBeam(beamId: string): void {
    const beam = this.beams.get(beamId);
    if (!beam) return;
    beam.mesh.visible = false;
    beam.light.intensity = 0;
  }

  /**
   * Points the light pool at this frame's beams.
   *
   * Runs before every render, after world matrices update, so lights follow
   * moving heads. Lit beams are combined into per-fixture proxies (see
   * beam-light-proxies) and the brightest proxies take the pooled lights.
   */
  syncLights(): void {
    if (!this.lightPool) return;
    const samples: BeamLightSample[] = [];
    const worldQuaternion = new Quaternion();
    for (const [beamId, beam] of this.beams) {
      if (beam.light.intensity <= 0 || !beam.mesh.visible) continue;
      const position = new Vector3();
      beam.parent.getWorldPosition(position);
      beam.parent.getWorldQuaternion(worldQuaternion);
      samples.push({
        fixtureUid: beamId.split(":")[0],
        position,
        direction: new Vector3(0, 0, -1).applyQuaternion(worldQuaternion),
        halfAngle: beam.light.halfAngle,
        intensity: beam.light.intensity,
        red: beam.light.red,
        green: beam.light.green,
        blue: beam.light.blue,
        gobo: beam.light.gobo ?? undefined,
      });
    }
    this.lightPool.assign(buildBeamLightProxies(samples));
  }

  /**
   * Remove a beam for a fixture.
   */
  removeBeam(beamId: string): void {
    const beam = this.beams.get(beamId);
    if (!beam) return;

    beam.parent.remove(beam.mesh);
    beam.mesh.geometry?.dispose();
    disposeBeamMaterial(beam.material);

    this.beams.delete(beamId);
  }

  /**
   * Check if a fixture has a beam.
   */
  hasBeam(beamId: string): boolean {
    return this.beams.has(beamId);
  }

  /**
   * Get beam for a fixture.
   */
  getBeam(beamId: string): BeamInstance | undefined {
    return this.beams.get(beamId);
  }

  /**
   * Update all beams for fixtures.
   * Call this when fixture instances change.
   * Beam IDs use format "fixtureUid:emitterName" for multi-emitter fixtures.
   */
  syncWithFixtures(fixtures: Map<string, ExtendedFixtureInstance>): void {
    for (const beamId of this.beams.keys()) {
      const fixtureUid = beamId.split(":")[0];
      if (!fixtures.has(fixtureUid)) {
        this.removeBeam(beamId);
      }
    }
  }

  /**
   * Remove all beams and gobo images; the light pool stays, dark.
   */
  dispose(): void {
    for (const beamId of [...this.beams.keys()]) {
      this.removeBeam(beamId);
    }
    for (const texture of this.goboTextures.values()) {
      texture?.dispose();
    }
    this.goboTextures.clear();
    this.lightPool?.assign([]);
  }

  /**
   * Dispose beams and remove the light pool and its render hook from the scene.
   */
  destroy(): void {
    this.dispose();
    this.lightPool?.dispose();
    this.lightPool = null;
    if (this.scene) {
      this.scene.onBeforeRender = () => {};
      this.scene = null;
    }
  }
}
