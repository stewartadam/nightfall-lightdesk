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
  float,
  floor,
  log2,
  materialColor,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  screenSize,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BoxGeometry,
  DataTexture,
  FloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
} from "three/webgpu";

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
    this.width = 2 ** Math.ceil(Math.log2((count + 2) * 8));
    const pyramid = new Float32Array(this.width * 2 * 4);
    this.pixels = pyramid.subarray(0, this.width * 4);
    this.previousColors = new Float32Array(count * 3);
    this.map = new DataTexture(
      pyramid,
      this.width * 2,
      1,
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
    this.map.minFilter = LinearFilter;
    this.map.magFilter = LinearFilter;
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
    /** Samples one packed pyramid level without filtering across neighboring level boundaries. */
    const sampleLevel = (level: typeof lowerLevel) => {
      const width = pow(2, level.negate()).mul(this.width);
      const offset = width
        .mul(2)
        .negate()
        .add(this.width * 2);
      const coordinate = offset
        .add(clamp(rowUV.mul(width), 0.5, width.sub(0.5)))
        .div(this.width * 2);
      return texture(this.map, vec2(coordinate, 0.5)).level(float(0)).rgb;
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
