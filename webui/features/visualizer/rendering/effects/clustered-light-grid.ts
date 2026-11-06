// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The cluster assignment follows three.js's ClusteredLightsNode addon
 * (examples/jsm/tsl/lighting/ClusteredLightsNode.js), MIT License,
 * Copyright © 2010-2026 three.js authors. It is reimplemented on public
 * three.js APIs because the addon keeps its cluster lookup and light data
 * private, and the optical shading needs both.
 */

import {
  Break,
  clamp,
  dot,
  Fn,
  float,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec2,
  ivec4,
  Loop,
  log,
  max,
  min,
  positionView,
  pow,
  renderGroup,
  screenCoordinate,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  type Camera,
  type ComputeNode,
  DataTexture,
  FloatType,
  Matrix4,
  type Node,
  type PerspectiveCamera,
  type PointLight,
  RGBAFormat,
  type StorageBufferNode,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from "three/webgpu";

/** Light data texture row holding world position and cutoff distance. */
const POSITION_ROW = 0;
/** Light data texture row holding color times intensity and decay. */
const COLOR_ROW = 1;
const ROWS = 2;

const scratchPosition = new Vector3();
const scratchSize = new Vector2();

/**
 * Indexes a vector, array or storage element node with a dynamic index. TSL supports this
 * on every such node, but @types/three declares `element` only on some of them.
 */
function elementOf<T extends "int" | "ivec4">(
  node: object,
  index: Node<"int"> | number,
): Node<T> {
  return (node as { element(index: Node<"int"> | number): Node<T> }).element(
    index,
  );
}

/** Per-light shading inputs read from the depth-sorted light texture. */
export interface ClusterLightData {
  position: Node<"vec3">;
  viewPosition: Node<"vec3">;
  distance: Node<"float">;
  color: Node<"vec3">;
  decay: Node<"float">;
}

/** Light-index storage, its assignment compute and the fragment lookup built for one storage size. */
interface GridResources {
  lightIndexes: StorageBufferNode<"ivec4">;
  compute: ComputeNode;
  screenClusterIndex: Node<"int">;
  elements: number;
  webgl: boolean;
}

/** The camera inputs the grid needs; clusters are sliced between the near and far planes. */
export type ClusterCamera = Camera & Pick<PerspectiveCamera, "near" | "far">;

/**
 * Forward+ cluster assignment for point lights: the view frustum is split into screen
 * tiles times exponential depth slices, and a compute pass lists, per cluster, the
 * 1-based depth-sorted indices of the lights whose spheres reach it.
 *
 * Grid dimensions are uniforms, so a resize that fits the existing storage changes no
 * shader; storage grows geometrically and is rebuilt only outside of rendering.
 */
export class ClusteredLightGrid {
  /** Maps each depth-sorted texture index to the light's index in the last written array. */
  readonly sortOrder: number[] = [];

  private readonly chunksPerCluster: number;
  private readonly lightsTexture: DataTexture;
  private readonly lightsData: Float32Array;
  private readonly zSliceRangesData: Float32Array;
  private readonly zSliceRangesTexture: DataTexture;
  private readonly lightViewZ: Float32Array;
  private readonly cameraNear = uniform(0).setGroup(renderGroup);
  private readonly cameraFar = uniform(0).setGroup(renderGroup);
  private readonly cameraViewMatrix = uniform(new Matrix4()).setGroup(
    renderGroup,
  );
  /** Reciprocal projection focal lengths, mapping NDC to view space per unit depth. */
  private readonly inverseFocal = uniform(new Vector2()).setGroup(renderGroup);
  private readonly gridDimensions = uniform(new Vector2());
  /**
   * NDC extent of one tile. Fragments pick tiles by framebuffer pixel, so the compute maps
   * columns and rows to NDC by the real framebuffer size, not the tile-rounded one.
   */
  private readonly tileNdcSize = uniform(new Vector2());
  private readonly framebufferSize = new Vector2(-1, -1);
  private resources: GridResources | null = null;

  /**
   * Allocates the CPU-side light and depth-range textures; GPU storage waits for the
   * first {@link fitRenderer}.
   *
   * @param uniqueId Distinguishes WebGL transform-feedback programs of different grids.
   */
  constructor(
    readonly maxLights: number,
    readonly tileSize: number,
    readonly zSlices: number,
    readonly maxLightsPerCluster: number,
    private readonly uniqueId: number,
  ) {
    this.chunksPerCluster = Math.ceil(maxLightsPerCluster / 4);
    this.lightsData = new Float32Array(maxLights * 4 * ROWS);
    this.lightsTexture = new DataTexture(
      this.lightsData,
      maxLights,
      ROWS,
      RGBAFormat,
      FloatType,
    );
    this.zSliceRangesData = new Float32Array(zSlices * 4);
    this.zSliceRangesTexture = new DataTexture(
      this.zSliceRangesData,
      zSlices,
      1,
      RGBAFormat,
      FloatType,
    );
    this.lightViewZ = new Float32Array(maxLights);
    this.cameraNear.setName("clusteredCameraNear");
    this.cameraFar.setName("clusteredCameraFar");
    this.cameraViewMatrix.setName("clusteredCameraViewMatrix");
    this.inverseFocal.setName("clusteredInverseFocal");
  }

  /** Whether GPU storage exists, so shaders can reference the cluster lookup. */
  get ready(): boolean {
    return this.resources !== null;
  }

  /**
   * Returns the 1-based light index at a slot of the fragment's cluster; `0` ends the list.
   * Valid only after the grid is {@link ready}.
   */
  tile(slot: Node<"int">): Node<"int"> {
    const { lightIndexes, screenClusterIndex } = this.requireResources();
    const element = int(slot);
    const chunk = screenClusterIndex
      .mul(int(this.chunksPerCluster))
      .add(element.div(4));
    return elementOf<"int">(lightIndexes.element(chunk), element.mod(4));
  }

  /** Reads a light's shading inputs by its 0-based depth-sorted index. */
  lightData(index: Node<"int">): ClusterLightData {
    const position = textureLoad(
      this.lightsTexture,
      ivec2(int(index), POSITION_ROW),
    );
    const color = textureLoad(this.lightsTexture, ivec2(int(index), COLOR_ROW));
    return {
      position: position.xyz,
      viewPosition: this.cameraViewMatrix.mul(vec4(position.xyz, 1)).xyz,
      distance: position.w,
      color: color.rgb,
      decay: color.w,
    };
  }

  /**
   * Fits the grid to the framebuffer the renderer is about to draw into. Call outside
   * rendering, before render objects are prepared.
   *
   * @returns Whether storage was replaced, so materials must rebind it.
   */
  fitRenderer(renderer: WebGPURenderer): boolean {
    const target = renderer.getRenderTarget();
    if (target) scratchSize.set(target.width, target.height);
    else renderer.getDrawingBufferSize(scratchSize);
    const webgl =
      (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend ===
      true;
    return this.resize(scratchSize.x, scratchSize.y, webgl);
  }

  /**
   * Sorts lights by view depth, writes their shading data in that order, and records
   * which sorted range can reach each depth slice so the compute only tests those.
   */
  writeLights(lights: readonly PointLight[], camera: ClusterCamera): void {
    const count = Math.min(lights.length, this.maxLights);
    const data = this.lightsData;
    const line = this.maxLights * 4;
    const viewZ = this.lightViewZ;
    const order = this.sortOrder;
    for (let i = 0; i < count; i++) {
      scratchPosition
        .setFromMatrixPosition(lights[i].matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse);
      viewZ[i] = scratchPosition.z;
      order[i] = i;
    }
    order.length = count;
    order.sort((a, b) => viewZ[a] - viewZ[b]);
    for (let i = 0; i < count; i++) {
      const light = lights[order[i]];
      const offset = i * 4;
      scratchPosition.setFromMatrixPosition(light.matrixWorld);
      data[line * POSITION_ROW + offset] = scratchPosition.x;
      data[line * POSITION_ROW + offset + 1] = scratchPosition.y;
      data[line * POSITION_ROW + offset + 2] = scratchPosition.z;
      data[line * POSITION_ROW + offset + 3] = light.distance;
      data[line * COLOR_ROW + offset] = light.color.r * light.intensity;
      data[line * COLOR_ROW + offset + 1] = light.color.g * light.intensity;
      data[line * COLOR_ROW + offset + 2] = light.color.b * light.intensity;
      data[line * COLOR_ROW + offset + 3] = light.decay;
    }
    this.lightsTexture.needsUpdate = true;

    const { near, far } = camera;
    const ranges = this.zSliceRangesData;
    for (let z = 0; z < this.zSlices; z++) {
      const sliceNear = -(near * (far / near) ** (z / this.zSlices));
      const sliceFar = -(near * (far / near) ** ((z + 1) / this.zSlices));
      let start = count;
      let end = 0;
      for (let i = 0; i < count; i++) {
        const distance = lights[order[i]].distance;
        const radius = distance > 0 ? distance : far;
        const vz = viewZ[order[i]];
        if (vz + radius >= sliceFar && vz - radius <= sliceNear) {
          if (i < start) start = i;
          end = i + 1;
        }
      }
      ranges[z * 4] = start < count ? start : 0;
      ranges[z * 4 + 1] = start < count ? end : 0;
    }
    this.zSliceRangesTexture.needsUpdate = true;
  }

  /**
   * Publishes this render's camera to the shared uniforms and assigns lights to clusters.
   * Cluster bounds assume a centered perspective projection, which every scene camera uses.
   */
  dispatch(renderer: WebGPURenderer, camera: ClusterCamera): void {
    const { compute } = this.requireResources();
    this.cameraNear.value = camera.near;
    this.cameraFar.value = camera.far;
    this.cameraViewMatrix.value = camera.matrixWorldInverse;
    const projection = camera.projectionMatrix.elements;
    this.inverseFocal.value.set(1 / projection[0], 1 / projection[5]);
    renderer.compute(compute);
  }

  /** Frees the GPU storage and the light textures. */
  dispose(): void {
    this.disposeResources();
    this.lightsTexture.dispose();
    this.zSliceRangesTexture.dispose();
  }

  /** Returns the storage-bound resources, which every shading or dispatch call requires. */
  private requireResources(): GridResources {
    if (!this.resources)
      throw new Error("Clustered light grid used before it was sized");
    return this.resources;
  }

  /**
   * Updates the grid uniforms for a framebuffer size and rebuilds storage only when it
   * must grow or the backend changed.
   */
  private resize(width: number, height: number, webgl: boolean): boolean {
    const current = this.resources;
    if (
      current?.webgl === webgl &&
      this.framebufferSize.x === width &&
      this.framebufferSize.y === height
    )
      return false;
    const columns = Math.ceil(width / this.tileSize);
    const rows = Math.ceil(height / this.tileSize);
    const clusterCount = columns * rows * this.zSlices;
    const required = clusterCount * this.chunksPerCluster;
    let rebuilt = false;
    if (!current || current.webgl !== webgl || current.elements < required) {
      // Initial storage gets headroom; later growth doubles to keep rebuilds rare.
      const elements = current
        ? Math.max(required, current.elements * 2)
        : Math.ceil(required * 1.5);
      rebuilt = current !== null;
      this.disposeResources();
      this.resources = this.createResources(elements, webgl);
    }
    this.gridDimensions.value.set(columns, rows);
    this.tileNdcSize.value.set(
      (2 * this.tileSize) / Math.max(width, 1),
      (2 * this.tileSize) / Math.max(height, 1),
    );
    this.resources!.compute.count =
      clusterCount * (webgl ? this.chunksPerCluster : 1);
    this.framebufferSize.set(width, height);
    return rebuilt;
  }

  /** Releases the storage and compute of the current grid, if any. */
  private disposeResources(): void {
    if (!this.resources) return;
    this.resources.compute.dispose();
    this.resources.lightIndexes.value.dispose();
    this.resources = null;
  }

  /**
   * Builds the light-index storage, the compute that fills it, and the fragment-side
   * cluster index. WebGL computes run as transform feedback and write only their own
   * element, so there each invocation fills one chunk; WebGPU fills a cluster per invocation.
   */
  private createResources(elements: number, webgl: boolean): GridResources {
    const { chunksPerCluster, zSlices } = this;
    const grid = this.gridDimensions;
    const columns = int(grid.x);
    const rows = int(grid.y);
    const lightIndexes = instancedArray(new Int32Array(elements * 4), "ivec4")
      .setPBO(true)
      .setName("lightIndexes");
    const chunksPerInvocation = webgl ? 1 : chunksPerCluster;
    const invocationsPerCluster = chunksPerCluster / chunksPerInvocation;

    const compute = Fn(() => {
      const clusterIndex = int(instanceIndex.div(invocationsPerCluster));
      const firstChunk = int(instanceIndex.mod(invocationsPerCluster)).mul(
        chunksPerInvocation,
      );
      const firstSlot = firstChunk.mul(4);
      const lastSlot = firstSlot.add(chunksPerInvocation * 4);

      // View-space AABB of this cluster, from the projection's focal lengths.
      const invFocalX = this.inverseFocal.x;
      const invFocalY = this.inverseFocal.y;
      const cx = clusterIndex.mod(columns);
      const cy = clusterIndex.div(columns).mod(rows);
      const cz = clusterIndex.div(columns.mul(rows));
      const tileNdc = this.tileNdcSize;
      const ndcXmin = float(cx).mul(tileNdc.x).sub(1);
      const ndcXmax = float(cx.add(1)).mul(tileNdc.x).sub(1);
      // Row 0 is the top of the screen, which is NDC y = +1.
      const ndcYmax = float(1).sub(float(cy).mul(tileNdc.y));
      const ndcYmin = float(1).sub(float(cy.add(1)).mul(tileNdc.y));
      const farOverNear = this.cameraFar.div(this.cameraNear);
      const zNear = this.cameraNear
        .mul(pow(farOverNear, float(cz).mul(1 / zSlices)))
        .negate();
      const zFar = this.cameraNear
        .mul(pow(farOverNear, float(cz.add(1)).mul(1 / zSlices)))
        .negate();
      const nearX = zNear.negate().mul(invFocalX);
      const farX = zFar.negate().mul(invFocalX);
      const nearY = zNear.negate().mul(invFocalY);
      const farY = zFar.negate().mul(invFocalY);
      // Tile boundaries can straddle the view axis, so take the extremes of all corners.
      const aabbMin = vec3(
        min(ndcXmin.mul(nearX), ndcXmin.mul(farX)),
        min(ndcYmin.mul(nearY), ndcYmin.mul(farY)),
        zFar,
      );
      const aabbMax = vec3(
        max(ndcXmax.mul(nearX), ndcXmax.mul(farX)),
        max(ndcYmax.mul(nearY), ndcYmax.mul(farY)),
        zNear,
      );

      const chunks = ivec4(0).toArray(chunksPerInvocation).toVar();
      const listed = int(0).toVar();
      const range = textureLoad(this.zSliceRangesTexture, ivec2(cz, 0));
      const rangeStart = int(range.x);
      const rangeEnd = int(range.y);
      Loop(this.maxLights, ({ i }) => {
        const lightIndex = rangeStart.add(i);
        If(
          listed
            .greaterThanEqual(lastSlot)
            .or(lightIndex.greaterThanEqual(rangeEnd)),
          () => {
            Break();
          },
        );
        const { viewPosition, distance } = this.lightData(lightIndex);
        const closest = max(aabbMin, min(viewPosition, aabbMax));
        const offset = viewPosition.sub(closest);
        If(
          distance
            .lessThanEqual(0)
            .or(dot(offset, offset).lessThanEqual(distance.mul(distance))),
          () => {
            // Slots before firstSlot belong to other invocations of this cluster.
            If(listed.greaterThanEqual(firstSlot), () => {
              const slot = listed.sub(firstSlot);
              elementOf<"int">(
                elementOf<"ivec4">(chunks, slot.div(4)),
                slot.mod(4),
              ).assign(lightIndex.add(1));
            });
            listed.addAssign(1);
          },
        );
      });

      const firstElement = clusterIndex.mul(chunksPerCluster).add(firstChunk);
      /** Stores this invocation's chunks into the cluster's slice of the storage. */
      const writeChunks = () => {
        Loop(chunksPerInvocation, ({ i }) => {
          lightIndexes
            .element(firstElement.add(i))
            .assign(elementOf<"ivec4">(chunks, i));
        });
      };
      if (webgl) {
        // WebGL shares transform-feedback programs between identical code and binds their
        // buffers per program; the always-true capacity and id terms keep each grid and
        // storage size in its own program so no compute writes another grid's storage.
        If(
          firstElement
            .lessThan(int(elements))
            .and(int(this.uniqueId).notEqual(int(-1))),
          writeChunks,
        );
      } else {
        writeChunks();
      }
    })()
      .compute(1)
      .setName("Update Clustered Lights");

    const invLogFarOverNear = float(1).div(
      log(this.cameraFar.div(this.cameraNear)),
    );
    const slice = clamp(
      log(positionView.z.negate().div(this.cameraNear))
        .mul(invLogFarOverNear)
        .mul(zSlices)
        .floor(),
      float(0),
      float(zSlices - 1),
    );
    const tile = screenCoordinate.div(this.tileSize).floor();
    const screenClusterIndex = int(tile.x)
      .add(int(tile.y).mul(columns))
      .add(int(slice).mul(columns.mul(rows)))
      .toVar();

    return { lightIndexes, compute, screenClusterIndex, elements, webgl };
  }
}
