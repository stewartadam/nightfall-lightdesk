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
  _lightsCount: Node<"int">;
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
  }

  /** Mirrors the addon's depth-sorted light order so each cluster index finds the correct aperture. */
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
    this.apertureData.fill(0);
    for (
      let index = 0;
      index < Math.min(this.clusteredLights.length, this.maxLights);
      index++
    ) {
      const light = this.clusteredLights[order[index]];
      if (!(light instanceof OpticalSurfaceLight)) continue;
      const offset = index * 4;
      const data = this.apertureData;
      light.apertureRight.toArray(data, offset);
      data[offset + 3] = light.optics.radius;
      light.apertureUp.toArray(data, stride + offset);
      data[stride + offset + 3] = light.optics.slopeX;
      light.apertureForward.toArray(data, stride * 2 + offset);
      data[stride * 2 + offset + 3] = light.optics.slopeY;
      data[stride * 3 + offset] = light.optics.distributionPower;
      data[stride * 3 + offset + 1] =
        light.optics.shape === "rectangle" ? 1 : 0;
      data[stride * 3 + offset + 2] = light.beamLength;
      data[stride * 3 + offset + 3] = light.id;
      data[stride * 4 + offset] = light.secondaryColor.r * light.intensity;
      data[stride * 4 + offset + 1] = light.secondaryColor.g * light.intensity;
      data[stride * 4 + offset + 2] = light.secondaryColor.b * light.intensity;
      data[stride * 4 + offset + 3] = light.splitColor ? 1 : 0;
      data[stride * 5 + offset] = light.goboSlot;
      data[stride * 5 + offset + 1] = light.goboRotation;
      data[stride * 5 + offset + 2] = light.focusDistance;
      data[stride * 5 + offset + 3] = light.frost;
    }
    this.apertureTexture.needsUpdate = true;
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
    return {
      ...light,
      // Optical attenuation already includes finite-aperture spreading and a
      // bounded throw. Cluster bounds must not introduce an extra radial fade.
      cutoffDistance: profile.w.equal(0).select(light.distance, 0),
      color: Fn(() => {
        const contribution = vec3(0).toVar();
        If(profile.w.equal(0), () => {
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

  /** Uses compact cluster lists normally, falling back to the bounded source set when a list is full. */
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
      const full = runtime
        .getTile(int(this.maxLightsPerCluster - 1))
        .notEqual(0);
      Loop(this.maxLights, ({ i }) => {
        const lightIndex = int(0).toVar();
        If(full, () => {
          If(i.greaterThanEqual(runtime._lightsCount), () => {
            Break();
          });
          lightIndex.assign(i.add(1));
        }).Else(() => {
          // This branch never indexes beyond the fixed cluster allocation.
          If(i.greaterThanEqual(this.maxLightsPerCluster), () => {
            Break();
          });
          lightIndex.assign(runtime.getTile(i));
          If(lightIndex.equal(0), () => {
            Break();
          });
        });
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
    }, "void")();
  }

  /** Releases the additional optical texture when the renderer's scene lighting is disposed. */
  disposeApertures(): void {
    this.apertureTexture.dispose();
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
