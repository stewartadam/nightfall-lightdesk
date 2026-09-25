// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  abs,
  clamp,
  cos,
  Fn,
  float,
  floor,
  If,
  int,
  ivec2,
  Loop,
  log2,
  max,
  min,
  mod,
  pow,
  select,
  sin,
  texture,
  textureLoad,
  vec2,
  vec4,
} from "three/tsl";
import type { DataTexture, Node } from "three/webgpu";
import { MAX_GOBO_STAGES } from "./gobo-stack-table";

/** Multiplies independent wheel masks using a bounded stack shared by fog and surface shading. */
export function sampleGoboProjection(
  atlas: DataTexture,
  columns: Node<"float">,
  uv: Node<"vec2">,
  width: Node<"vec2">,
  apertureRadius: Node<"float">,
  distance: Node<"float">,
  pattern: Node<"vec4">,
  stacks?: DataTexture,
): Node<"float"> {
  if (!stacks)
    return sampleSingleGoboProjection(
      atlas,
      columns,
      uv,
      width,
      apertureRadius,
      distance,
      pattern,
    );
  return Fn(() => {
    const result = float(1).toVar();
    If(pattern.x.lessThan(0), () => {
      const row = int(pattern.x.negate().sub(1));
      const count = textureLoad(stacks, ivec2(0, row)).x;
      Loop(MAX_GOBO_STAGES, ({ i }) => {
        If(float(i).lessThan(count), () => {
          const mask = textureLoad(stacks, ivec2(i.add(1), row));
          result.mulAssign(
            sampleSingleGoboProjection(
              atlas,
              columns,
              uv,
              width,
              apertureRadius,
              distance,
              vec4(mask.xy, pattern.zw),
            ),
          );
        });
      });
    }).Else(() => {
      result.assign(
        sampleSingleGoboProjection(
          atlas,
          columns,
          uv,
          width,
          apertureRadius,
          distance,
          pattern,
        ),
      );
    });
    return result;
  })();
}

/** Samples a padded atlas tile with the same aperture-relative focus and frost on fog and surfaces. */
function sampleSingleGoboProjection(
  atlas: DataTexture,
  columns: Node<"float">,
  uv: Node<"vec2">,
  width: Node<"vec2">,
  apertureRadius: Node<"float">,
  distance: Node<"float">,
  pattern: Node<"vec4">,
): Node<"float"> {
  return Fn(() => {
    const transmission = float(1).toVar();
    If(pattern.x.greaterThan(0), () => {
      const c = cos(pattern.y);
      const s = sin(pattern.y);
      const rotated = vec2(
        uv.x.mul(c).sub(uv.y.mul(s)),
        uv.x.mul(s).add(uv.y.mul(c)),
      );
      const tile = vec2(mod(pattern.x, columns), floor(pattern.x.div(columns)));
      const inside = max(abs(rotated.x), abs(rotated.y)).lessThanEqual(1);
      const localUv = clamp(rotated, -1, 1)
        .mul(0.5)
        .add(0.5)
        .mul(251)
        .add(2.5)
        .div(256);
      const blur = apertureRadius
        .mul(abs(float(1).sub(distance.div(max(pattern.z, 0.001)))))
        .div(max(min(width.x, width.y), 0.0001));
      const focusLod = select(
        pattern.z.greaterThan(0),
        clamp(log2(max(blur.mul(126), 1)), 0, 6),
        0,
      );
      const lod = max(focusLod, pattern.w.mul(6));
      // Keep every mip footprint inside this tile, including fractional LOD filtering.
      const margin = pow(2, lod.ceil()).mul(0.5).div(256);
      const mask = texture(
        atlas,
        tile.add(clamp(localUv, margin, float(1).sub(margin))).div(columns),
      ).level(lod).r;
      transmission.assign(select(inside, mask, 0));
    });
    return transmission;
  })();
}
