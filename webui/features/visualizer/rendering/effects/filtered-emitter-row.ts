// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  abs,
  cameraProjectionMatrix,
  clamp,
  dFdx,
  dFdy,
  floor,
  int,
  ivec2,
  log2,
  materialColor,
  max,
  min,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  round,
  screenSize,
  textureLoad,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BoxGeometry,
  DataTexture,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  type Node,
  RGBAFormat,
} from "three/webgpu";

/**
 * Texels per texture row. Well below WebGPU's default maxTextureDimension2D (8192)
 * and WebGL2's guaranteed minimum (2048), so long rows never exceed device limits.
 */
export const TEXTURE_ROW_TEXELS = 2048;
/** Finest pyramid level resolution; beyond it, several cells share one texel's area average. */
export const MAX_BASE_TEXELS = 65536;

/** Prefilters a regular emitter row's linear radiance and gaps without changing its optical apertures. */
export class FilteredEmitterRow {
  readonly mesh: Mesh<BoxGeometry, MeshBasicNodeMaterial>;
  private readonly map: DataTexture;
  private readonly pixels: Float32Array;
  private readonly width: number;
  private readonly previousColors: Float32Array;
  private readonly levels: {
    data: Float32Array;
    width: number;
    height: number;
  }[];

  /** Builds a mipmapped luminous surface from physical cell spacing, width, and transverse dimensions. */
  constructor(
    private readonly count: number,
    spacing: number,
    cellWidth: number,
    height: number,
    depth: number,
  ) {
    this.width = Math.min(
      MAX_BASE_TEXELS,
      2 ** Math.ceil(Math.log2((count + 2) * 8)),
    );
    // The packed pyramid holds 2 * width texels; wrap it into rows that fit any device.
    const texels = this.width * 2;
    const rowWidth = Math.min(texels, TEXTURE_ROW_TEXELS);
    const pyramid = new Float32Array(texels * 4);
    this.pixels = pyramid.subarray(0, this.width * 4);
    this.previousColors = new Float32Array(count * 3);
    this.map = new DataTexture(
      pyramid,
      rowWidth,
      texels / rowWidth,
      RGBAFormat,
      FloatType,
    );
    this.levels = [{ data: this.pixels, width: this.width, height: 1 }];
    let offset = this.width * 4;
    for (let width = this.width / 2; width >= 1; width /= 2) {
      this.levels.push({
        data: pyramid.subarray(offset, offset + width * 4),
        width,
        height: 1,
      });
      offset += width * 4;
    }
    this.map.generateMipmaps = false;
    // Filtering happens in the shader so wrapped rows never blend unrelated texels.
    this.map.minFilter = NearestFilter;
    this.map.magFilter = NearestFilter;
    this.map.needsUpdate = true;
    const length = (count + 2) * spacing;
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const centerView = modelViewMatrix.mul(vec4(positionGeometry.x, 0, 0, 1));
    const worldDiameter = modelViewMatrix
      .mul(vec4(0, 1, 0, 0))
      .xyz.length()
      .mul(Math.max(height, depth));
    const projectedDiameter = cameraProjectionMatrix
      .mul(vec4(0, 1, 0, 0))
      .y.mul(worldDiameter)
      .mul(screenSize.y)
      .div(max(centerView.z.negate(), 0.001))
      .mul(0.5);
    const expansion = max(
      1,
      max(3, projectedDiameter).div(max(projectedDiameter, 0.001)),
    );
    // A subpixel silhouette needs finite raster coverage as well as texture filtering.
    // Expanding only the transverse dimensions and dividing radiance by that expansion preserves line flux.
    material.positionNode = positionGeometry.mul(vec3(1, expansion, expansion));
    const rowUV = positionGeometry.x.div(length).add(0.5);
    const footprint = max(abs(dFdx(rowUV)), abs(dFdy(rowUV))).mul(this.width);
    const lod = clamp(log2(max(footprint, 1)), 0, Math.log2(this.width));
    const lowerLevel = floor(lod);
    /** Loads one texel of the packed pyramid by its linear index across wrapped rows. */
    const texel = (index: Node<"float">) => {
      const linear = int(index);
      return textureLoad(
        this.map,
        ivec2(linear.mod(int(rowWidth)), linear.div(int(rowWidth))),
      ).rgb;
    };
    /** Linearly filters one packed pyramid level without blending across level or row boundaries. */
    const sampleLevel = (level: typeof lowerLevel) => {
      // Rounding keeps power-of-two level widths exact for integer texel indexing.
      const width = round(pow(2, level.negate()).mul(this.width));
      const offset = width
        .mul(2)
        .negate()
        .add(this.width * 2);
      const position = clamp(rowUV.mul(width), 0.5, width.sub(0.5)).sub(0.5);
      const first = floor(position);
      const second = min(first.add(1), width.sub(1));
      return mix(
        texel(offset.add(first)),
        texel(offset.add(second)),
        position.sub(first),
      );
    };
    // Packing the pyramid into one image avoids an upload command for every mip level on each DMX change.
    const radiance = mix(
      sampleLevel(lowerLevel),
      sampleLevel(clamp(lowerLevel.add(1), 0, Math.log2(this.width))),
      lod.sub(lowerLevel),
    ).toVar();
    material.maskNode = max(
      radiance.r,
      max(radiance.g, radiance.b),
    ).greaterThan(0);
    material.colorNode = radiance
      .mul(materialColor.rgb)
      .div(varying(expansion));
    this.mesh = new Mesh(new BoxGeometry(length, height, depth), material);
    this.mesh.name = "FilteredEmitterRow";
    // Keep the shader prepared across scene-light changes, including while the row is dark or offscreen.
    this.mesh.frustumCulled = false;
    this.spacing = spacing;
    this.cellWidth = cellWidth;
  }

  private readonly spacing: number;
  private readonly cellWidth: number;

  /** Area-averages changed DMX radiance into texture texels; unchanged output avoids uploads and mip generation. */
  update(colors: ArrayLike<number>): void {
    let sourceChanged = false;
    for (let i = 0; i < this.previousColors.length; i++) {
      const value = Math.fround(colors[i]);
      if (value !== this.previousColors[i]) {
        this.previousColors[i] = value;
        sourceChanged = true;
      }
    }
    if (!sourceChanged) return;
    const length = (this.count + 2) * this.spacing;
    const texelWidth = length / this.width;
    let changed = false;
    for (let x = 0; x < this.width; x++) {
      const left = x * texelWidth - this.spacing;
      const right = left + texelWidth;
      const first = Math.max(0, Math.floor(left / this.spacing));
      const last = Math.min(this.count - 1, Math.floor(right / this.spacing));
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (let cell = first; cell <= last; cell++) {
          const center = (cell + 0.5) * this.spacing;
          const overlap = Math.max(
            0,
            Math.min(right, center + this.cellWidth / 2) -
              Math.max(left, center - this.cellWidth / 2),
          );
          value += (colors[cell * 3 + channel] * overlap) / texelWidth;
        }
        const index = x * 4 + channel;
        const rounded = Math.fround(value);
        if (this.pixels[index] !== rounded) {
          this.pixels[index] = rounded;
          changed = true;
        }
      }
    }
    if (changed) {
      // Preallocated 1D averages avoid a GPU render pass per level for every changing fixture.
      for (let level = 1; level < this.levels.length; level++) {
        const previous = this.levels[level - 1].data;
        const next = this.levels[level].data;
        for (let texel = 0; texel < this.levels[level].width; texel++) {
          for (let channel = 0; channel < 3; channel++) {
            next[texel * 4 + channel] =
              (previous[texel * 8 + channel] +
                previous[texel * 8 + 4 + channel]) *
              0.5;
          }
        }
      }
      this.map.needsUpdate = true;
    }
  }

  /** Releases surface geometry, material, and the radiance texture. */
  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.map.dispose();
  }
}
