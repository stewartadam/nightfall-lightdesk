// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import ClusteredLightsNode from "three/addons/tsl/lighting/ClusteredLightsNode.js";
import {
  abs,
  Break,
  clamp,
  directPointLight,
  dot,
  exp,
  Fn,
  float,
  If,
  int,
  ivec2,
  Loop,
  log,
  max,
  mix,
  positionView,
  positionWorld,
  pow,
  screenCoordinate,
  smoothstep,
  textureLoad,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import {
  type Camera,
  Color,
  DataTexture,
  FloatType,
  type Light,
  Lighting,
  LightsNode,
  type Node,
  PointLight,
  RGBAFormat,
  type Scene,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from "three/webgpu";
import type { ResolvedEmitterOptics } from "./emitter-optics";
import { GoboAtlas } from "./gobo-atlas";
import { sampleGoboProjection } from "./gobo-projection";
import { OpticalShadowPool } from "./optical-shadow-pool";
import { SurfaceLightBudget } from "./surface-light-budget";

/** Profile marker for ordinary point lights, which skip optical aperture attenuation. */
const PLAIN_LIGHT = -1;
/**
 * Sources an overflowing cluster evaluates beyond its own full list. Together with the
 * list capacity this bounds per-fragment light iterations regardless of scene light count.
 */
export const FULL_CLUSTER_PRIORITY_LIGHTS = 64;

/** A clusterable source whose intensity is area-normalized flux in scene units, shared with the atmosphere. */
export class OpticalSurfaceLight extends PointLight {
  readonly apertureRight = new Vector3(1, 0, 0);
  readonly apertureUp = new Vector3(0, 1, 0);
  readonly apertureForward = new Vector3(0, 0, -1);
  beamLength = 30;
  readonly secondaryColor = new Color();
  splitColor = false;
  frost = 0;
  goboSlot = 0;
  goboRotation = 0;
  focusDistance = 0;
  /** Assigned by the shadow pool on registration; 0 means no shadow map can apply. */
  shadowKey = 0;

  /** Creates a reusable light; owners update its world pose and intensity alongside the fog instance. */
  constructor(readonly optics: ResolvedEmitterOptics) {
    super(0xffffff, 1, 40, 2);
  }
}

interface ClusterLightData {
  position: Node<"vec3">;
  viewPosition: Node<"vec3">;
  distance: Node<"float">;
  cutoffDistance?: Node<"float">;
  color: Node<"vec3">;
  decay: Node<"float">;
}

/** Runtime extension points in the installed Three addon that its declaration file omits. */
interface ClusterRuntime {
  _screenClusterIndex: Node<"int">;
  _gridDimensions: Node<"vec2">;
  _cameraNear: Node<"float">;
  _cameraFar: Node<"float">;
  zSlices: number;
  _lightSortOrder: number[];
  getTile(index: Node<"int">): Node<"int">;
  updateProgram(renderer: unknown): void;
  updateLightsTexture(camera: Camera): void;
  getLightData(index: Node<"int">): ClusterLightData;
}
const clusterPrototype =
  ClusteredLightsNode.prototype as unknown as ClusterRuntime;

/** The installed runtime accepts a light vector; its declaration still names a view position. */
const directOpticalPointLight = directPointLight as unknown as (parameters: {
  color: Node<"vec3">;
  lightVector: Node<"vec3">;
  cutoffDistance: Node<"float">;
  decayExponent: Node<"float">;
}) => ReturnType<typeof directPointLight>;

/** Adds aperture attenuation to Three's existing cluster lookup and material BRDF integration. */
export class OpticalClusteredLightsNode extends ClusteredLightsNode {
  private readonly targetSize = new Vector2();
  private readonly pixelScale = uniform(new Vector2(1, 1));
  /** Maps scaled fragment pixels into the stable full-canvas cluster grid. */
  private readonly scaledClusterIndex = Fn(() => {
    const runtime = this as unknown as ClusterRuntime;
    const tile = screenCoordinate
      .mul(this.pixelScale)
      .div(this.tileSize)
      .floor();
    const dimensions = runtime._gridDimensions;
    const slice = clamp(
      log(positionView.z.negate().div(runtime._cameraNear))
        .div(log(runtime._cameraFar.div(runtime._cameraNear)))
        .mul(runtime.zSlices)
        .floor(),
      float(0),
      float(runtime.zSlices - 1),
    );
    return int(tile.x)
      .add(int(tile.y).mul(int(dimensions.x)))
      .add(int(slice).mul(int(dimensions.x.mul(dimensions.y))));
  })().toVar();

  /** Matches cluster pixels to the active render target when the scene resolution is reduced. */
  updateProgram(renderer: WebGPURenderer): void {
    const target = renderer.getRenderTarget();
    renderer.getDrawingBufferSize(this.targetSize);
    this.pixelScale.value.set(
      target ? this.targetSize.x / target.width : 1,
      target ? this.targetSize.y / target.height : 1,
    );
    clusterPrototype.updateProgram.call(this, renderer);
    (this as unknown as ClusterRuntime)._screenClusterIndex =
      this.scaledClusterIndex;
  }
  /** The addon's setLights routes only non-shadowing point lights into this array. */
  declare clusteredLights: PointLight[];
  private readonly apertureData: Float32Array;
  private readonly apertureTexture: DataTexture;
  private readonly atlasColumns = uniform(4);
  private readonly pointCandidates: PointLight[] = [];
  private readonly lightBudget: SurfaceLightBudget;
  /** Extra sources an overflowing cluster may evaluate, bounding its per-fragment loop. */
  private readonly priorityCapacity: number;
  private readonly priorityBudget: SurfaceLightBudget;
  private readonly priorityLights: PointLight[] = [];
  private readonly priorityData: Float32Array;
  private readonly priorityTexture: DataTexture;
  private readonly sortedIndex = new Map<PointLight, number>();
  private texturesChanged = false;
  omittedPointLights = 0;
  renderedOmittedPointLights = 0;

  /** Keeps cluster uploads inside allocated storage without turning overflow into unbounded material lights. */
  override setLights(lights: Light[]): this {
    super.setLights(lights);
    this.omittedPointLights = Math.max(
      0,
      this.clusteredLights.length - this.maxLights,
    );
    if (this.omittedPointLights > 0) {
      this.pointCandidates.length = this.clusteredLights.length;
      for (let i = 0; i < this.clusteredLights.length; i++)
        this.pointCandidates[i] = this.clusteredLights[i];
      this.clusteredLights.length = this.maxLights;
    } else {
      this.pointCandidates.length = 0;
    }
    return this;
  }

  /** Bounds surface work with a fixed cluster capacity and a shared optical parameter texture. */
  constructor(
    maxLights = 1024,
    maxPerCluster = 64,
    private readonly goboAtlas?: GoboAtlas,
    private readonly shadows?: OpticalShadowPool,
  ) {
    super(maxLights, 32, 24, maxPerCluster);
    this.lightBudget = new SurfaceLightBudget(maxLights);
    this.apertureData = new Float32Array(maxLights * 4 * 6);
    this.apertureTexture = new DataTexture(
      this.apertureData,
      maxLights,
      6,
      RGBAFormat,
      FloatType,
    );
    this.apertureTexture.generateMipmaps = false;
    this.priorityCapacity = Math.min(FULL_CLUSTER_PRIORITY_LIGHTS, maxLights);
    // Full cluster lists hold the earliest depth-sorted sources, so equally important
    // later sources are the ones the list is most likely to have dropped.
    this.priorityBudget = new SurfaceLightBudget(
      this.priorityCapacity,
      (left, right) =>
        (this.sortedIndex.get(left) ?? 0) < (this.sortedIndex.get(right) ?? 0),
    );
    this.priorityData = new Float32Array(this.priorityCapacity * 4);
    this.priorityTexture = new DataTexture(
      this.priorityData,
      this.priorityCapacity,
      1,
      RGBAFormat,
      FloatType,
    );
    this.priorityTexture.generateMipmaps = false;
    // Allocate real GPU storage before any material binds these textures. Three binds a
    // never-uploaded texture to a placeholder and re-resolves a binding only when that render
    // object refreshes in a frame where the version changed; render objects that skip that
    // frame keep sampling the placeholder, an all-zero aperture that floods surfaces with light.
    // With change-only uploads the version may never change again, so later uploads must only
    // replace the contents of storage every binding already references.
    this.apertureTexture.needsUpdate = true;
    this.priorityTexture.needsUpdate = true;
  }

  /**
   * Mirrors the addon's depth-sorted light order so each cluster index finds the correct aperture,
   * and ranks the full-cluster priority list. Textures upload only when their contents change.
   */
  updateLightsTexture(camera: Camera): void {
    this.renderedOmittedPointLights = this.omittedPointLights;
    if (this.omittedPointLights > 0)
      this.lightBudget.select(
        this.pointCandidates,
        camera,
        this.clusteredLights,
      );
    if (this.goboAtlas) this.atlasColumns.value = this.goboAtlas.tilesPerRow;
    clusterPrototype.updateLightsTexture.call(this, camera);
    const order = (this as unknown as ClusterRuntime)._lightSortOrder;
    const stride = this.maxLights * 4;
    const count = Math.min(this.clusteredLights.length, this.maxLights);
    this.texturesChanged = false;
    // Rows beyond the current light count are never indexed, so they need no clearing.
    for (let index = 0; index < count; index++) {
      const light = this.clusteredLights[order[index]];
      const offset = index * 4;
      if (!(light instanceof OpticalSurfaceLight)) {
        this.write(this.apertureData, stride * 3 + offset + 3, PLAIN_LIGHT);
        continue;
      }
      this.writeVector(this.apertureData, offset, light.apertureRight);
      this.write(this.apertureData, offset + 3, light.optics.radius);
      this.writeVector(this.apertureData, stride + offset, light.apertureUp);
      this.write(this.apertureData, stride + offset + 3, light.optics.slopeX);
      this.writeVector(
        this.apertureData,
        stride * 2 + offset,
        light.apertureForward,
      );
      this.write(
        this.apertureData,
        stride * 2 + offset + 3,
        light.optics.slopeY,
      );
      this.write4(
        this.apertureData,
        stride * 3 + offset,
        light.optics.distributionPower,
        light.optics.shape === "rectangle" ? 1 : 0,
        light.beamLength,
        light.shadowKey,
      );
      this.write4(
        this.apertureData,
        stride * 4 + offset,
        light.secondaryColor.r * light.intensity,
        light.secondaryColor.g * light.intensity,
        light.secondaryColor.b * light.intensity,
        light.splitColor ? 1 : 0,
      );
      this.write4(
        this.apertureData,
        stride * 5 + offset,
        light.goboSlot,
        light.goboRotation,
        light.focusDistance,
        light.frost,
      );
    }
    if (this.texturesChanged) this.apertureTexture.needsUpdate = true;
    this.updatePriorityLights(camera, order, count);
  }

  /**
   * Lists the most important sources, as 1-based depth-sorted indices, for fragments whose
   * cluster list overflowed. Only overflowing clusters read it, and those need more lights
   * than a full list holds, so smaller scenes keep it empty.
   */
  private updatePriorityLights(
    camera: Camera,
    order: readonly number[],
    count: number,
  ): void {
    this.texturesChanged = false;
    let selected = 0;
    if (count > this.maxLightsPerCluster) {
      this.sortedIndex.clear();
      for (let index = 0; index < count; index++)
        this.sortedIndex.set(this.clusteredLights[order[index]], index);
      this.priorityBudget.select(
        this.clusteredLights,
        camera,
        this.priorityLights,
      );
      for (const light of this.priorityLights)
        this.write(
          this.priorityData,
          selected++ * 4,
          this.sortedIndex.get(light)! + 1,
        );
    }
    for (let index = selected; index < this.priorityCapacity; index++)
      this.write(this.priorityData, index * 4, 0);
    if (this.texturesChanged) this.priorityTexture.needsUpdate = true;
  }

  /** Stores one float and records whether the GPU copy became stale. */
  private write(data: Float32Array, index: number, value: number): void {
    const rounded = Math.fround(value);
    if (data[index] === rounded) return;
    data[index] = rounded;
    this.texturesChanged = true;
  }

  /** Stores a vector's components in the first three channels of a texel. */
  private writeVector(data: Float32Array, index: number, vector: Vector3) {
    this.write(data, index, vector.x);
    this.write(data, index + 1, vector.y);
    this.write(data, index + 2, vector.z);
  }

  /** Stores all four channels of one texel. */
  private write4(
    data: Float32Array,
    index: number,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    this.write(data, index, x);
    this.write(data, index + 1, y);
    this.write(data, index + 2, z);
    this.write(data, index + 3, w);
  }

  /** Attenuates each clustered source before Three evaluates the receiving surface's BRDF. */
  getLightData(index: Node<"int">): ClusterLightData {
    const light = clusterPrototype.getLightData.call(this, index);
    const right = textureLoad(this.apertureTexture, ivec2(int(index), 0));
    const up = textureLoad(this.apertureTexture, ivec2(int(index), 1));
    const forward = textureLoad(this.apertureTexture, ivec2(int(index), 2));
    const profile = textureLoad(this.apertureTexture, ivec2(int(index), 3));
    const secondary = textureLoad(this.apertureTexture, ivec2(int(index), 4));
    const pattern = textureLoad(this.apertureTexture, ivec2(int(index), 5));
    const offset = positionWorld.sub(light.position);
    const z = dot(offset, forward.xyz);
    const width = max(
      vec2(up.w, forward.w).mul(max(z, 0)).add(right.w),
      vec2(0.0001),
    );
    const uv = vec2(dot(offset, right.xyz), dot(offset, up.xyz)).div(width);
    const radius = mix(uv.length(), max(abs(uv.x), abs(uv.y)), profile.y);
    const distribution = exp(
      pow(radius, max(profile.x, 0.1)).mul(-Math.log(10)),
    );
    const inside = z
      .greaterThanEqual(0)
      .and(z.lessThanEqual(profile.z))
      .and(radius.lessThanEqual(2));
    // The cluster light applies inverse-square falloff later; replace it with finite-aperture spreading.
    const spreading = max(dot(offset, offset), 0.01).div(
      max(width.x.mul(width.y), 1e-8),
    );
    const edgeWidth = max(pattern.w.mul(0.5), 0.00001);
    const split = smoothstep(edgeWidth.negate(), edgeWidth, uv.x).mul(
      secondary.w,
    );
    const plain = profile.w.lessThan(0);
    return {
      ...light,
      // Optical attenuation already includes finite-aperture spreading and a
      // bounded throw. Cluster bounds must not introduce an extra radial fade.
      cutoffDistance: plain.select(light.distance, 0),
      color: Fn(() => {
        const contribution = vec3(0).toVar();
        If(plain, () => {
          contribution.assign(light.color);
        }).ElseIf(inside, () => {
          // Cluster spheres are conservative; only covered fragments need optical texture samples.
          contribution.assign(
            mix(light.color, secondary.xyz, split)
              .mul(distribution.mul(spreading))
              .mul(this.shadows?.sample(positionWorld, profile.w) ?? 1)
              .mul(
                this.goboAtlas
                  ? sampleGoboProjection(
                      this.goboAtlas.texture,
                      this.atlasColumns,
                      uv,
                      width,
                      right.w,
                      z,
                      pattern,
                      this.goboAtlas.stacks.texture,
                    )
                  : 1,
              ),
          );
        });
        return contribution;
      })(),
    };
  }

  /**
   * Uses compact cluster lists normally. When a list is full, the fragment also evaluates the
   * ranked priority sources the list could not hold, so per-fragment work stays bounded by
   * the list capacity plus FULL_CLUSTER_PRIORITY_LIGHTS instead of the whole light set.
   */
  override setupLights(
    ...[builder, lightNodes]: Parameters<LightsNode["setupLights"]>
  ): void {
    const runtime = this as unknown as ClusterRuntime;
    runtime.updateProgram(builder.renderer);
    const context = builder as unknown as {
      context: {
        reflectedLight: {
          directDiffuse: Node<"vec3">;
          directSpecular: Node<"vec3">;
        };
      };
      lightsNode: LightsNode;
    };
    context.context.reflectedLight.directDiffuse.toStack();
    context.context.reflectedLight.directSpecular.toStack();
    LightsNode.prototype.setupLights.call(this, builder, lightNodes);
    Fn(() => {
      const listSize = this.maxLightsPerCluster;
      // Cluster lists hold ascending 1-based sorted indices and end at the first 0 unless full,
      // so priority entries are only reached after a full list, with its last entry recorded.
      const lastListed = int(0).toVar();
      Loop(listSize + this.priorityCapacity, ({ i }) => {
        const lightIndex = int(0).toVar();
        If(i.lessThan(listSize), () => {
          lightIndex.assign(runtime.getTile(i));
          If(lightIndex.equal(0), () => {
            Break();
          });
          lastListed.assign(lightIndex);
        }).Else(() => {
          const candidate = int(
            textureLoad(this.priorityTexture, ivec2(i.sub(listSize), 0)).x,
          );
          If(candidate.equal(0), () => {
            Break();
          });
          // Lower indices were either listed or cannot reach this cluster.
          If(candidate.greaterThan(lastListed), () => {
            lightIndex.assign(candidate);
          });
        });
        If(lightIndex.greaterThan(0), () => {
          const { color, decay, viewPosition, distance, cutoffDistance } =
            this.getLightData(lightIndex.sub(1));
          const lightVector = viewPosition.sub(positionView);
          If(
            distance
              .equal(0)
              .or(
                dot(lightVector, lightVector).lessThanEqual(
                  distance.mul(distance),
                ),
              ),
            () => {
              context.lightsNode.setupDirectLight(
                builder,
                this,
                directOpticalPointLight({
                  color,
                  lightVector,
                  cutoffDistance: cutoffDistance ?? distance,
                  decayExponent: decay,
                }),
              );
            },
          );
        });
      });
    }, "void")();
  }

  /** Releases the additional optical textures when the renderer's scene lighting is disposed. */
  disposeApertures(): void {
    this.apertureTexture.dispose();
    this.priorityTexture.dispose();
  }
}

/** Installs clustered optical surface sources while retaining Three's ambient and directional lighting. */
export class OpticalSurfaceLighting extends Lighting {
  /** Lower presets retain projected illumination without compiling or preparing shadow maps. */
  constructor(private readonly shadowsEnabled = true) {
    super();
  }
  readonly goboAtlas = new GoboAtlas();
  readonly shadows = new OpticalShadowPool();
  private readonly nodes = new Set<OpticalClusteredLightsNode>();

  /** Reports the largest active scene light overflow without adding counts from separate render passes. */
  get omittedPointLights(): number {
    let omitted = 0;
    for (const node of this.nodes)
      omitted = Math.max(omitted, node.renderedOmittedPointLights);
    return omitted;
  }

  /** Clears stale diagnostics even when an empty scene skips light-texture updates. */
  override beginRender(scene: Scene): void {
    const node = this.getNode(scene);
    if (node instanceof OpticalClusteredLightsNode)
      node.renderedOmittedPointLights = 0;
    super.beginRender(scene);
  }

  /** Creates one clustered node per renderer-managed scene/camera lighting context. */
  override createNode(lights: Light[] = []): OpticalClusteredLightsNode {
    const node = new OpticalClusteredLightsNode(
      1024,
      64,
      this.shadowsEnabled ? this.goboAtlas : undefined,
      this.shadowsEnabled ? this.shadows : undefined,
    );
    node.setLights(lights);
    this.nodes.add(node);
    return node;
  }

  /** Releases adapter textures alongside the owning renderer. */
  dispose(): void {
    for (const node of this.nodes) node.disposeApertures();
    this.nodes.clear();
    this.goboAtlas.dispose();
    this.shadows.dispose();
  }
}
