// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  abs,
  attribute,
  cameraPosition,
  Discard,
  dot,
  Fn,
  float,
  If,
  normalize,
  normalWorld,
  positionView,
  positionWorld,
  pow,
  screenUV,
  smoothstep,
  uv,
} from "three/tsl";
import {
  AdditiveBlending,
  BoxGeometry,
  ConeGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  MaxEquation,
  MeshBasicNodeMaterial,
  type Node,
  type Object3D,
  OneFactor,
  Quaternion,
  type Scene,
  Vector3,
} from "three/webgpu";
import type { EmitterColor } from "../geometry-builder";
import {
  type BeamStyle,
  type QualityProfile,
  resolveQualityProfile,
} from "../quality-profile";
import { parseApertureId } from "./aperture-id";
import type { GoboStage } from "./emitter-optical-state";
import {
  emitterDistributionArea,
  LUMENS_PER_SCENE_UNIT,
  type ResolvedEmitterOptics,
} from "./emitter-optics";
import { createEmitterVolumeMaterial } from "./emitter-volume-material";
import { GoboAtlas } from "./gobo-atlas";
import { getOpticalRenderContext } from "./optical-render-context";
import type { OpticalShadowPool } from "./optical-shadow-pool";
import { OpticalSurfaceLight } from "./optical-surface-lighting";
import type { PrismProjection } from "./prism-optics";

const ATTRIBUTE_SIZES = {
  volumeOrigin: 3,
  volumeRight: 3,
  volumeUp: 3,
  volumeForward: 3,
  volumeOptics: 4,
  volumeRadiance: 3,
  volumeDrive: 3,
  volumeSecondary: 4,
  volumeShape: 3,
  volumePattern: 4,
} as const;
type AttributeName = keyof typeof ATTRIBUTE_SIZES;
const RECORD_SIZE = Object.values(ATTRIBUTE_SIZES).reduce(
  (sum, size) => sum + size,
  0,
);

/** Axial extent, in meters, of each drawn beam and its surface light. */
export const DEFAULT_BEAM_LENGTH = 30;
/** Fractional widening of a beam's spread at full frost. */
const FROST_SPREAD = 0.5;
/** Distribution exponent full frost softens a beam toward: a plain Gaussian falloff. */
const FROSTED_DISTRIBUTION_POWER = 2;

/** One frame of an aperture's published optical state; its pose comes from the parent object. */
export interface ApertureUpdate {
  optics: ResolvedEmitterOptics;
  color: EmitterColor;
  /** Multiplier on the aperture's slopes from the current zoom angle; defaults to 1. */
  zoomScale?: number;
  /** Axial extent in meters; defaults to DEFAULT_BEAM_LENGTH. */
  length?: number;
  /** Masks applied to every facet; omitted when the profile does not project gobos. */
  gobos?: readonly GoboStage[];
  /** Prism facets; omitted or empty for an unsplit beam. */
  facets?: readonly PrismProjection[];
  prismRotation?: number;
  focusDistance?: number;
}

/** Scales the schematic cone's DMX drive color into a legible, unexposed display color. */
const SCHEMATIC_CONE_DRIVE_GAIN = 0.18;
/** Scales area-normalized radiance on shaded cones to roughly match volumetric haze brightness. */
const SHADED_CONE_RADIANCE_GAIN = 0.12;
/** Distance, in meters, over which shaded cones lose three quarters of their brightness. */
const SHADED_CONE_FALLOFF_DISTANCE = 5;
/** Exponent easing shaded cones in from the aperture so the source end stays bright. */
const SHADED_CONE_AXIAL_EXPONENT = 1.5;
/** Surface-to-view alignment beyond which shaded cones reach full opacity, hiding silhouettes. */
const SHADED_CONE_FACING_FADE = 0.9;
/** Peak opacity of shaded cone surfaces. */
const SHADED_CONE_OPACITY = 0.6;

/** Builds the cheap cone material used by presets that do not ray-march haze. */
function createConeMaterial(
  style: Exclude<BeamStyle, { kind: "volumetric" }>,
  viewDepth: Node<"float"> | undefined,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  if (style.kind === "schematic-cone") {
    // A schematic union: overlapping apertures must not accumulate into haze.
    material.blending = CustomBlending;
    material.blendEquation = MaxEquation;
    material.blendSrc = OneFactor;
    material.blendDst = OneFactor;
    material.colorNode = attribute<"vec3">("volumeDrive", "vec3").mul(
      SCHEMATIC_CONE_DRIVE_GAIN,
    );
    material.opacityNode = float(1);
  } else {
    material.blending = AdditiveBlending;
    material.colorNode = attribute<"vec3">("volumeRadiance", "vec3").mul(
      SHADED_CONE_RADIANCE_GAIN,
    );
    const axial = float(1).sub(uv().y);
    const distance = axial.mul(attribute<"vec3">("volumeShape", "vec3").y);
    const facing = abs(
      dot(normalize(cameraPosition.sub(positionWorld)), normalWorld),
    );
    const attenuation = pow(
      float(SHADED_CONE_FALLOFF_DISTANCE).div(
        distance.add(SHADED_CONE_FALLOFF_DISTANCE),
      ),
      2,
    );
    material.opacityNode = pow(uv().y, SHADED_CONE_AXIAL_EXPONENT)
      .mul(smoothstep(0, SHADED_CONE_FACING_FADE, facing))
      .mul(attenuation)
      .mul(SHADED_CONE_OPACITY);
    material.side = DoubleSide;
    // Additive front/back faces can share one draw without transparency sorting.
    material.forceSinglePass = true;
  }
  if (viewDepth) {
    const opacity = material.opacityNode;
    /** Clips cheap beams against the multisampled rig without multisampling beam overdraw. */
    material.opacityNode = Fn(() => {
      const opaqueDepth = float(viewDepth).context({
        getUV: () => screenUV,
      });
      If(positionView.z.lessThan(opaqueDepth), () => {
        Discard();
      });
      return opacity;
    })();
  }
  return material;
}

/** Packs arbitrary apertures into one draw with shared geometry and material. */
export class EmitterVolumeBatch {
  private readonly target: Scene;
  private readonly surfaceScene?: Scene;
  private readonly shadows?: OpticalShadowPool;
  private readonly surfaceLights = new Map<string, OpticalSurfaceLight>();
  private readonly material;
  private readonly volume;
  private readonly beamStyle: BeamStyle;
  /** Mask atlas, present only when the quality profile projects gobos. */
  readonly goboAtlas?: GoboAtlas;
  private readonly ownsGoboAtlas: boolean;
  private mesh!: InstancedMesh;
  private attributes!: Record<AttributeName, InterleavedBufferAttribute>;
  private records!: InstancedInterleavedBuffer;
  private capacity = 0;
  private readonly slots = new Map<string, number>();
  /** Instance key drawn by each slot, kept dense so the instanced draw covers only live slots. */
  private readonly slotKeys: string[] = [];
  /** Instance keys reserved per aperture: the aperture ID for its first facet, then one per extra facet. */
  private readonly groups = new Map<string, string[]>();
  private reservedCount = 0;
  private dirty = false;
  private readonly origin = new Vector3();
  private readonly worldOrigin = new Vector3();
  private readonly worldScale = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly scale = new Vector3();
  private readonly center = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly matrix = new Matrix4();
  private readonly basisRight = new Vector3();
  private readonly basisUp = new Vector3();

  /** Capabilities of the pipeline drawing this batch; High when no pipeline owns the scene. */
  readonly profile: QualityProfile;

  /**
   * Allocates one scene-local batch drawn in the scene's atmospheric pass when a pipeline
   * owns one; capacity grows only when fixture topology changes.
   */
  constructor(scene: Scene) {
    const context = getOpticalRenderContext(scene);
    const profile = context?.profile ?? resolveQualityProfile("high");
    this.profile = profile;
    this.beamStyle = profile.beamStyle;
    this.goboAtlas = profile.gobos
      ? (context?.goboAtlas ?? new GoboAtlas())
      : undefined;
    this.ownsGoboAtlas = !!this.goboAtlas && !context?.goboAtlas;
    this.surfaceScene = context?.surfaceScene;
    this.shadows = profile.shadows ? context?.shadows : undefined;
    this.target = context?.scene ?? scene;
    if (this.beamStyle.kind === "volumetric") {
      this.volume = createEmitterVolumeMaterial({
        viewDepth: context?.viewDepth,
        goboTexture: this.goboAtlas?.texture,
        goboStacks: this.goboAtlas?.stacks.texture,
        shadows: this.shadows,
      });
      this.material = this.volume.material;
    } else {
      this.material = createConeMaterial(this.beamStyle, context?.viewDepth);
    }
    this.resize(256);
  }

  /** Reserves the largest declared split during fixture setup, before DMX can enable it. */
  reserve(id: string, facets: number): void {
    this.goboAtlas?.stacks.reserve(id);
    let keys = this.groups.get(id);
    if (!keys) {
      keys = [];
      this.groups.set(id, keys);
    }
    const count = Number.isFinite(facets) ? Math.max(1, Math.floor(facets)) : 1;
    if (count <= keys.length) return;
    this.reservedCount += count - keys.length;
    for (let i = keys.length; i < count; i++)
      keys.push(i === 0 ? id : `${id}\0${i}`);
    if (this.reservedCount > this.capacity) {
      let capacity = this.capacity;
      while (capacity < this.reservedCount) capacity *= 2;
      this.resize(capacity);
    }
  }

  /**
   * Updates one aperture, posed by `parent`, without allocating a mesh, material, or light
   * source. A prism publishes one instance per facet; every facet shares the gobo stack.
   */
  update(id: string, parent: Object3D, aperture: ApertureUpdate): void {
    const count = aperture.facets?.length || 1;
    this.reserve(id, count);
    const patternAddress =
      aperture.gobos && this.goboAtlas
        ? this.goboAtlas.stacks.update(id, aperture.gobos)
        : 0;
    const keys = this.groups.get(id)!;
    parent.updateWorldMatrix(true, false);
    parent.matrixWorld.decompose(
      this.worldOrigin,
      this.orientation,
      this.worldScale,
    );
    this.basisRight.set(1, 0, 0).applyQuaternion(this.orientation);
    this.basisUp.set(0, 1, 0).applyQuaternion(this.orientation);
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation);
    for (let i = 0; i < count; i++)
      this.updateInstance(
        keys[i],
        aperture,
        aperture.facets?.[i],
        count,
        patternAddress,
      );
    for (let i = count; i < keys.length; i++) this.removeInstance(keys[i]);
  }

  /**
   * Publishes a facet using affine ray coordinates, retaining the source aperture's mask.
   * `patternAddress` is the aperture's gobo stack address, or 0 for an open aperture.
   */
  private updateInstance(
    key: string,
    aperture: ApertureUpdate,
    facet: PrismProjection | undefined,
    facetCount: number,
    patternAddress: number,
  ): void {
    const { optics, color } = aperture;
    const length = aperture.length ?? DEFAULT_BEAM_LENGTH;
    const zoomScale = aperture.zoomScale ?? 1;
    const prismRotation = aperture.prismRotation ?? 0;
    const focusDistance = aperture.focusDistance ?? 0;
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = this.slotKeys.length;
      if (slot === this.capacity) this.resize(this.capacity * 2);
      this.slots.set(key, slot);
      this.slotKeys.push(key);
      this.mesh.count = this.slotKeys.length;
    }
    const frost = Number.isFinite(color.frost)
      ? Math.max(0, Math.min(1, color.frost!))
      : 0;
    // Stacked masks carry their own rotations, so the pattern's rotation channel stays 0.
    this.attributes.volumePattern.setXYZW(
      slot,
      patternAddress,
      0,
      focusDistance,
      frost,
    );
    this.origin.copy(this.worldOrigin);
    this.right.copy(this.basisRight);
    this.up.copy(this.basisUp);
    const spread = 1 + frost * FROST_SPREAD;
    const sx = optics.slopeX * zoomScale * spread;
    const sy = optics.slopeY * zoomScale * spread;
    let a = 1,
      b = 0,
      c = 0,
      d = 1,
      tx = 0,
      ty = 0;
    if (facet) {
      const cosine = Math.cos(prismRotation),
        sine = Math.sin(prismRotation);
      a = cosine * facet.a - sine * facet.c;
      b = cosine * facet.b - sine * facet.d;
      c = sine * facet.a + cosine * facet.c;
      d = sine * facet.b + cosine * facet.d;
      tx = (cosine * facet.x - sine * facet.y) * optics.halfPowerRatio;
      ty = (sine * facet.x + cosine * facet.y) * optics.halfPowerRatio;
    }
    this.center
      .copy(this.origin)
      .addScaledVector(this.forward, length / 2)
      .addScaledVector(
        this.basisRight,
        tx * (optics.radius + (sx * length) / 2),
      )
      .addScaledVector(this.basisUp, ty * (optics.radius + (sy * length) / 2));
    this.scale.set(
      4 *
        (Math.abs(a) * (optics.radius + length * sx) +
          Math.abs(b) * (optics.radius + length * sy)) +
        Math.abs(tx * sx * length),
      4 *
        (Math.abs(c) * (optics.radius + length * sx) +
          Math.abs(d) * (optics.radius + length * sy)) +
        Math.abs(ty * sy * length),
      length,
    );
    this.matrix.compose(this.center, this.orientation, this.scale);
    this.mesh.setMatrixAt(slot, this.matrix);
    if (facet) {
      const inverse = 1 / facet.determinant;
      this.origin
        .addScaledVector(this.basisRight, tx * optics.radius)
        .addScaledVector(this.basisUp, ty * optics.radius);
      this.right
        .copy(this.basisRight)
        .multiplyScalar(d * inverse)
        .addScaledVector(this.basisUp, -b * inverse)
        .addScaledVector(this.forward, -(d * tx * sx - b * ty * sy) * inverse);
      this.up
        .copy(this.basisRight)
        .multiplyScalar(-c * inverse)
        .addScaledVector(this.basisUp, a * inverse)
        .addScaledVector(this.forward, -(-c * tx * sx + a * ty * sy) * inverse);
    }
    this.attributes.volumeOrigin.setXYZ(
      slot,
      this.origin.x,
      this.origin.y,
      this.origin.z,
    );
    this.attributes.volumeRight.setXYZ(
      slot,
      this.right.x,
      this.right.y,
      this.right.z,
    );
    this.attributes.volumeUp.setXYZ(slot, this.up.x, this.up.y, this.up.z);
    this.attributes.volumeForward.setXYZ(
      slot,
      this.forward.x,
      this.forward.y,
      this.forward.z,
    );
    this.attributes.volumeOptics.setXYZW(
      slot,
      sx,
      sy,
      optics.radius,
      optics.distributionPower +
        (Math.min(FROSTED_DISTRIBUTION_POWER, optics.distributionPower) -
          optics.distributionPower) *
          frost,
    );
    const intensity =
      (color.intensity * optics.lumens) /
      (LUMENS_PER_SCENE_UNIT *
        facetCount *
        (facet ? Math.abs(facet.determinant) : 1) *
        emitterDistributionArea(
          optics.shape,
          this.attributes.volumeOptics.getW(slot),
        ));
    this.attributes.volumeRadiance.setXYZ(
      slot,
      color.red * intensity * (facet?.red ?? 1),
      color.green * intensity * (facet?.green ?? 1),
      color.blue * intensity * (facet?.blue ?? 1),
    );
    this.attributes.volumeDrive.setXYZ(
      slot,
      color.red * color.intensity,
      color.green * color.intensity,
      color.blue * color.intensity,
    );
    this.attributes.volumeSecondary.setXYZW(
      slot,
      (color.secondaryRed ?? color.red) * intensity * (facet?.red ?? 1),
      (color.secondaryGreen ?? color.green) * intensity * (facet?.green ?? 1),
      (color.secondaryBlue ?? color.blue) * intensity * (facet?.blue ?? 1),
      color.secondaryRed === undefined ? 0 : 1,
    );
    this.attributes.volumeShape.setXYZ(
      slot,
      optics.shape === "rectangle" ? 1 : 0,
      length,
      0,
    );
    if (this.surfaceScene) {
      let light = this.surfaceLights.get(key);
      if (!light) {
        light = new OpticalSurfaceLight({ ...optics });
        light.name = `OpticalSurface:${key}`;
        this.surfaceLights.set(key, light);
        this.surfaceScene.add(light);
        this.shadows?.register(light);
      }
      this.attributes.volumeShape.setZ(slot, light.shadowKey);
      light.visible = true;
      light.position.copy(this.origin);
      light.apertureRight.copy(this.right);
      light.apertureUp.copy(this.up);
      light.apertureForward.copy(this.forward);
      light.optics.radius = optics.radius;
      light.optics.shape = optics.shape;
      light.optics.slopeX = sx;
      light.optics.slopeY = sy;
      light.optics.distributionPower = this.attributes.volumeOptics.getW(slot);
      light.beamLength = length;
      // Enclose the entire affine field, relative to the translated aperture.
      // The box includes both field tails and the facet's axial drift.
      light.distance = Math.hypot(
        length,
        this.scale.x / 2 + Math.abs((tx * sx * length) / 2),
        this.scale.y / 2 + Math.abs((ty * sy * length) / 2),
      );
      light.color.setRGB(
        color.red * (facet?.red ?? 1),
        color.green * (facet?.green ?? 1),
        color.blue * (facet?.blue ?? 1),
      );
      light.intensity = intensity;
      light.secondaryColor.setRGB(
        (color.secondaryRed ?? color.red) * (facet?.red ?? 1),
        (color.secondaryGreen ?? color.green) * (facet?.green ?? 1),
        (color.secondaryBlue ?? color.blue) * (facet?.blue ?? 1),
      );
      light.splitColor = color.secondaryRed !== undefined;
      light.frost = frost;
      light.goboSlot = patternAddress;
      light.goboRotation = 0;
      light.focusDistance = focusDistance;
    }
    this.dirty = true;
  }

  /** Removes an inactive aperture and compacts its slot without moving other scene objects. */
  remove(id: string): void {
    this.goboAtlas?.stacks.deactivate(id);
    const keys = this.groups.get(id);
    if (keys) for (const key of keys) this.removeInstance(key);
    else this.removeInstance(id);
  }

  /** Compacts one facet's GPU record while retaining reusable group identifiers. */
  private removeInstance(key: string): void {
    const light = this.surfaceLights.get(key);
    if (light) light.visible = false;
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    const last = this.slotKeys.length - 1;
    if (slot !== last) {
      const moved = this.slotKeys[last];
      this.slotKeys[slot] = moved;
      this.slots.set(moved, slot);
      this.records.array.copyWithin(
        slot * RECORD_SIZE,
        last * RECORD_SIZE,
        (last + 1) * RECORD_SIZE,
      );
      this.mesh.getMatrixAt(last, this.matrix);
      this.mesh.setMatrixAt(slot, this.matrix);
    }
    this.slotKeys.pop();
    this.slots.delete(key);
    this.mesh.count = this.slotKeys.length;
    this.dirty = true;
  }

  /**
   * Drops obsolete apertures when fixture modes or geometry are rebuilt, releasing each
   * group's facets and surface lights through its own key list.
   */
  sync(
    fixtures: ReadonlyMap<
      string,
      { emitters: ReadonlyMap<string, { optics?: unknown }> }
    >,
  ): void {
    for (const [id, keys] of this.groups) {
      const { fixtureUid, emitterName } = parseApertureId(id);
      if (fixtures.get(fixtureUid)?.emitters.get(emitterName)?.optics) continue;
      this.remove(id);
      this.reservedCount -= keys.length;
      this.groups.delete(id);
      this.goboAtlas?.stacks.release(id);
      for (const key of keys) {
        const light = this.surfaceLights.get(key);
        if (!light) continue;
        light.removeFromParent();
        this.shadows?.unregister(light);
        this.surfaceLights.delete(key);
      }
    }
  }

  /** Hides every aperture while retaining reusable GPU buffers. */
  clear(): void {
    for (const light of this.surfaceLights.values()) {
      light.removeFromParent();
      this.shadows?.unregister(light);
    }
    this.surfaceLights.clear();
    this.slots.clear();
    for (const id of this.groups.keys()) this.goboAtlas?.stacks.release(id);
    this.groups.clear();
    this.reservedCount = 0;
    this.slotKeys.length = 0;
    this.mesh.count = 0;
  }

  /** Releases the single shared draw and its GPU resources. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
    if (this.ownsGoboAtlas) this.goboAtlas?.dispose();
    this.clear();
  }

  /** Reallocates instance buffers geometrically rather than once per additional fixture. */
  private resize(capacity: number): void {
    const previous = this.mesh;
    const geometry =
      this.beamStyle.kind === "volumetric"
        ? new BoxGeometry(1, 1, 1)
        : new ConeGeometry(0.25, 1, this.beamStyle.segments, 1, true).rotateX(
            Math.PI / 2,
          );
    const attributes = {} as Record<AttributeName, InterleavedBufferAttribute>;
    const records = new InstancedInterleavedBuffer(
      new Float32Array(capacity * RECORD_SIZE),
      RECORD_SIZE,
    ).setUsage(DynamicDrawUsage);
    if (previous) records.array.set(this.records.array);
    let offset = 0;
    for (const [name, size] of Object.entries(ATTRIBUTE_SIZES)) {
      const attribute = new InterleavedBufferAttribute(records, size, offset);
      offset += size;
      attributes[name as AttributeName] = attribute;
      geometry.setAttribute(name, attribute);
    }
    const mesh = new InstancedMesh(geometry, this.material, capacity);
    mesh.name = this.volume ? "EmitterVolumes" : "EmitterBeams";
    mesh.count = this.slotKeys.length;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    if (previous) {
      mesh.instanceMatrix.array.set(previous.instanceMatrix.array);
      previous.removeFromParent();
      previous.geometry.dispose();
      previous.dispose();
    }
    this.mesh = mesh;
    this.attributes = attributes;
    this.records = records;
    this.capacity = capacity;
    this.dirty = true;
    /** Uploads all changed emitter records once for the submitted frame. */
    mesh.onBeforeRender = () => {
      if (this.volume && this.goboAtlas)
        this.volume.atlasColumns.value = this.goboAtlas.tilesPerRow;
      if (!this.dirty) return;
      this.records.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    };
    this.target.add(mesh);
  }
}
