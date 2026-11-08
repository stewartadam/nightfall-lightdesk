// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  abs,
  Break,
  directPointLight,
  dot,
  exp,
  Fn,
  If,
  int,
  ivec2,
  Loop,
  max,
  mix,
  positionView,
  positionWorld,
  pow,
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
  type NodeFrame,
  NodeUpdateType,
  NodeUtils,
  PointLight,
  RGBAFormat,
  type Scene,
  Vector3,
  type WebGPURenderer,
} from "three/webgpu";
import type { QualityProfile } from "../quality-profile";
import {
  type ClusterCamera,
  ClusteredLightGrid,
  type ClusterLightData,
} from "./clustered-light-grid";
import type { ResolvedEmitterOptics } from "./emitter-optics";
import { GoboAtlas } from "./gobo-atlas";
import { sampleGoboProjection } from "./gobo-projection";
import { OpticalShadowPool } from "./optical-shadow-pool";
import { SurfaceLightSelector } from "./surface-light-selector";

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

/** Shading inputs of one clustered source after optical attenuation. */
interface OpticalLightData extends ClusterLightData {
  cutoffDistance: Node<"float">;
}

/** The light-vector form `directPointLight` takes at runtime; its declaration still names a view position. */
const directOpticalPointLight = directPointLight as unknown as (parameters: {
  color: Node<"vec3">;
  lightVector: Node<"vec3">;
  cutoffDistance: Node<"float">;
  decayExponent: Node<"float">;
}) => ReturnType<typeof directPointLight>;

/** Clustered surface lighting with aperture attenuation, on top of the material's BRDF integration. */
export class OpticalClusteredLightsNode extends LightsNode {
  /** Lights shaded by the material's regular analytic light nodes. */
  readonly materialLights: Light[] = [];
  /** Non-shadowing point lights assigned to clusters, capped at {@link maxLights}. */
  readonly clusteredLights: PointLight[] = [];
  private readonly grid: ClusteredLightGrid;
  /** Renderer of the last setup or update, which fits the grid before each render. */
  private renderer: WebGPURenderer | null = null;
  private readonly apertureData: Float32Array;
  private readonly apertureTexture: DataTexture;
  private readonly atlasColumns = uniform(4);
  private readonly pointCandidates: PointLight[] = [];
  private readonly lightSelector: SurfaceLightSelector;
  /** Extra sources an overflowing cluster may evaluate, bounding its per-fragment loop. */
  private readonly priorityCapacity: number;
  private readonly prioritySelector: SurfaceLightSelector;
  private readonly priorityLights: PointLight[] = [];
  private readonly priorityData: Float32Array;
  private readonly priorityTexture: DataTexture;
  private readonly sortedIndex = new Map<PointLight, number>();
  private texturesChanged = false;
  omittedPointLights = 0;
  renderedOmittedPointLights = 0;

  /**
   * Clusters non-shadowing point lights and leaves every other light to the material.
   * Cluster uploads stay inside allocated storage; overflow is not turned into unbounded
   * material lights but ranked per frame by {@link updateLightsTexture}.
   */
  override setLights(lights: Light[]): this {
    this.materialLights.length = 0;
    this.pointCandidates.length = 0;
    for (const light of lights) {
      if (light instanceof PointLight && light.castShadow !== true)
        this.pointCandidates.push(light);
      else this.materialLights.push(light);
    }
    this.omittedPointLights = Math.max(
      0,
      this.pointCandidates.length - this.maxLights,
    );
    const kept = Math.min(this.pointCandidates.length, this.maxLights);
    this.clusteredLights.length = kept;
    for (let i = 0; i < kept; i++)
      this.clusteredLights[i] = this.pointCandidates[i];
    if (this.omittedPointLights === 0) this.pointCandidates.length = 0;
    return super.setLights(lights);
  }

  /** Only lights outside the clusters get the material's per-light analytic nodes. */
  override getBuiltinLights(): Light[] {
    return this.materialLights;
  }

  /**
   * Includes this node's identity and version, so materials never share cluster bindings
   * between nodes and rebind when grid storage is replaced.
   */
  override customCacheKey(): number {
    return NodeUtils.hash(this.id, this.version, super.customCacheKey());
  }

  /** Bounds surface work with a fixed cluster capacity and a shared optical parameter texture. */
  constructor(
    readonly maxLights = 1024,
    readonly maxLightsPerCluster = 64,
    private readonly goboAtlas?: GoboAtlas,
    private readonly shadows?: OpticalShadowPool,
  ) {
    super();
    this.updateBeforeType = NodeUpdateType.RENDER;
    this.grid = new ClusteredLightGrid(
      maxLights,
      32,
      24,
      maxLightsPerCluster,
      this.id,
    );
    this.lightSelector = new SurfaceLightSelector(maxLights);
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
    this.prioritySelector = new SurfaceLightSelector(
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
    // Later uploads (see updateBefore) only replace the contents of the storage every binding
    // already references.
    this.apertureTexture.needsUpdate = true;
    this.priorityTexture.needsUpdate = true;
  }

  /** Depth-sorted cluster index to {@link clusteredLights} index, as of the last texture update. */
  get sortOrder(): readonly number[] {
    return this.grid.sortOrder;
  }

  /**
   * Fits the cluster grid to the framebuffer of the render about to start. Called before
   * that render prepares its objects, so replacing storage cannot affect pending work.
   */
  updateSize(): void {
    if (this.renderer && this.grid.fitRenderer(this.renderer))
      this.needsUpdate = true;
  }

  /**
   * Uploads this render's light data, assigns lights to clusters, then uploads every changed
   * texture that surface shading samples. Three uploads a texture only while refreshing a render
   * object that binds it, and it skips that refresh when the object's material, geometry and
   * material-driven lights are unchanged. A clustered light or gobo edit alone never qualifies,
   * so a static surface would keep sampling the first upload: a light turned away, recolored or
   * fitted with a gobo would keep its old footprint. The cluster light data escapes this only
   * because the cluster compute pass binds it every render. An unchanged texture version makes
   * these calls free.
   */
  override updateBefore(frame: NodeFrame): undefined {
    const { renderer, camera } = frame;
    if (!renderer || !camera) return;
    // Lit scene renders all use perspective cameras; see ClusteredLightGrid.dispatch.
    const clusterCamera = camera as ClusterCamera;
    this.initGrid(renderer as WebGPURenderer);
    this.updateLightsTexture(clusterCamera);
    this.grid.dispatch(renderer as WebGPURenderer, clusterCamera);
    renderer.initTexture(this.apertureTexture);
    renderer.initTexture(this.priorityTexture);
    if (this.goboAtlas) {
      renderer.initTexture(this.goboAtlas.texture);
      renderer.initTexture(this.goboAtlas.stacks.texture);
    }
  }

  /**
   * Allocates the grid on first use. Later size changes wait for {@link updateSize}: while
   * rendering, replaced storage could still be referenced by unsubmitted commands.
   */
  private initGrid(renderer: WebGPURenderer): void {
    this.renderer = renderer;
    if (!this.grid.ready) this.grid.fitRenderer(renderer);
  }

  /**
   * Writes the depth-sorted cluster light data, mirrors that order in the aperture texture so
   * each cluster index finds its aperture, and ranks the full-cluster priority list. Optical
   * textures upload only when their contents change.
   */
  updateLightsTexture(camera: ClusterCamera): void {
    this.renderedOmittedPointLights = this.omittedPointLights;
    if (this.omittedPointLights > 0)
      this.lightSelector.select(
        this.pointCandidates,
        camera,
        this.clusteredLights,
      );
    if (this.goboAtlas) this.atlasColumns.value = this.goboAtlas.tilesPerRow;
    this.grid.writeLights(this.clusteredLights, camera);
    const order = this.grid.sortOrder;
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
      this.prioritySelector.select(
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
  private getLightData(index: Node<"int">): OpticalLightData {
    const light = this.grid.lightData(index);
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
    // A zero or placeholder aperture record (no throw, no radius) would otherwise hit the
    // minimum width everywhere and multiply the light by ~1e8, flooding every surface.
    const validAperture = profile.z.greaterThan(0).and(right.w.greaterThan(0));
    const inside = validAperture
      .and(z.greaterThanEqual(0))
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
    this.initGrid(builder.renderer as WebGPURenderer);
    const { reflectedLight } = builder.context as {
      reflectedLight: {
        directDiffuse: Node<"vec3">;
        directSpecular: Node<"vec3">;
      };
    };
    reflectedLight.directDiffuse.toStack();
    reflectedLight.directSpecular.toStack();
    super.setupLights(builder, lightNodes);
    Fn(() => {
      const listSize = this.maxLightsPerCluster;
      // Cluster lists hold ascending 1-based sorted indices and end at the first 0 unless full,
      // so priority entries are only reached after a full list, with its last entry recorded.
      const lastListed = int(0).toVar();
      Loop(listSize + this.priorityCapacity, ({ i }) => {
        const lightIndex = int(0).toVar();
        If(i.lessThan(listSize), () => {
          lightIndex.assign(this.grid.tile(i));
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
              this.setupDirectLight(
                builder,
                this,
                directOpticalPointLight({
                  color,
                  lightVector,
                  cutoffDistance,
                  decayExponent: decay,
                }),
              );
            },
          );
        });
      });
    }, "void")();
  }

  /** Frees the cluster grid and the optical textures. */
  override dispose(): void {
    this.grid.dispose();
    this.apertureTexture.dispose();
    this.priorityTexture.dispose();
    super.dispose();
  }
}

/** Installs clustered optical surface sources while retaining Three's ambient and directional lighting. */
export class OpticalSurfaceLighting extends Lighting {
  /** Shared mask atlas, allocated only when the quality profile projects gobos. */
  readonly goboAtlas?: GoboAtlas;
  /** Shadow maps, allocated only when the quality profile renders optical shadows. */
  readonly shadows?: OpticalShadowPool;
  private readonly nodes = new Set<OpticalClusteredLightsNode>();

  /** Lower presets keep projected illumination without allocating or compiling masks and shadow maps. */
  constructor(profile: Pick<QualityProfile, "gobos" | "shadows">) {
    super();
    if (profile.gobos) this.goboAtlas = new GoboAtlas();
    if (profile.shadows) this.shadows = new OpticalShadowPool();
  }

  /** Reports the largest active scene light overflow without adding counts from separate render passes. */
  get omittedPointLights(): number {
    let omitted = 0;
    for (const node of this.nodes)
      omitted = Math.max(omitted, node.renderedOmittedPointLights);
    return omitted;
  }

  /**
   * Clears stale diagnostics even when an empty scene skips light-texture updates, and fits
   * the cluster grid to this render's framebuffer before any of its objects are prepared.
   */
  override beginRender(scene: Scene): void {
    const node = this.getNode(scene);
    if (node instanceof OpticalClusteredLightsNode)
      node.renderedOmittedPointLights = 0;
    super.beginRender(scene);
    if (node instanceof OpticalClusteredLightsNode) node.updateSize();
  }

  /** Creates one clustered node per renderer-managed scene/camera lighting context. */
  override createNode(lights: Light[] = []): OpticalClusteredLightsNode {
    const node = new OpticalClusteredLightsNode(
      1024,
      64,
      this.goboAtlas,
      this.shadows,
    );
    node.setLights(lights);
    this.nodes.add(node);
    return node;
  }

  /** Releases every lights node's grid and optical textures, plus the shared masks and shadow maps. */
  override dispose(): void {
    super.dispose();
    this.nodes.clear();
    this.goboAtlas?.dispose();
    this.shadows?.dispose();
  }
}
