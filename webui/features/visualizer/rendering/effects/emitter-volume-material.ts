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
  cameraViewMatrix,
  Discard,
  dot,
  exp,
  Fn,
  float,
  If,
  Loop,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  screenUV,
  select,
  sign,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BackSide,
  type DataTexture,
  MeshBasicNodeMaterial,
  type Node,
} from "three/webgpu";
import { sampleGoboProjection } from "./gobo-projection";
import type { OpticalShadowPool } from "./optical-shadow-pool";

/** Samples along each view ray through the aperture's frustum; bounds per-fragment cost. */
const RAY_MARCH_STEPS = 12;
/** Single-scattering coefficient of the uniform stage haze, per meter. */
const HAZE_SCATTERING = 0.045;
/** Display exposure that strengthens scattering without changing beam spread or source flux. */
const SCATTERING_DISPLAY_EXPOSURE = 3;

/** Per-aperture values the integrator reads for the fragment's aperture. */
export interface EmitterVolumeInputs {
  origin: Node<"vec3">;
  right: Node<"vec3">;
  up: Node<"vec3">;
  forward: Node<"vec3">;
  /** Slope X, slope Y, aperture radius and distribution power. */
  optics: Node<"vec4">;
  radiance: Node<"vec3">;
  /** Secondary split-color radiance, with w enabling the split. */
  secondary: Node<"vec4">;
  rectangular: Node<"float">;
  beamLength: Node<"float">;
  /** Shadow key selecting the aperture's optical shadow map, 0 for none. */
  sourceId: Node<"float">;
  /** Gobo address, gobo rotation, focus distance and frost. */
  pattern: Node<"vec4">;
}

/** Reads each aperture from the emitter batch's interleaved instance attributes. */
function instancedInputs(): EmitterVolumeInputs {
  const shape = attribute<"vec3">("volumeShape", "vec3");
  return {
    origin: attribute<"vec3">("volumeOrigin", "vec3"),
    right: attribute<"vec3">("volumeRight", "vec3"),
    up: attribute<"vec3">("volumeUp", "vec3"),
    forward: attribute<"vec3">("volumeForward", "vec3"),
    optics: attribute<"vec4">("volumeOptics", "vec4"),
    radiance: attribute<"vec3">("volumeRadiance", "vec3"),
    secondary: attribute<"vec4">("volumeSecondary", "vec4"),
    rectangular: shape.x,
    beamLength: shape.y,
    sourceId: shape.z,
    pattern: attribute<"vec4">("volumePattern", "vec4"),
  };
}

/** Ray-marched single scattering for each aperture drawn by the material's mesh. */
export function createEmitterVolumeMaterial(
  options: {
    /** Aperture values; defaults to the emitter batch's instance attributes. */
    inputs?: EmitterVolumeInputs;
    viewDepth?: Node<"float">;
    goboTexture?: DataTexture;
    goboStacks?: DataTexture;
    shadows?: OpticalShadowPool;
  } = {},
) {
  const atlasColumns = uniform(4);
  const inputs = options.inputs ?? instancedInputs();
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });

  material.fragmentNode = Fn(() => {
    const {
      origin,
      right,
      up,
      forward,
      optics,
      radiance,
      secondary,
      rectangular,
      beamLength,
      pattern,
    } = inputs;
    const ray = normalize(positionWorld.sub(cameraPosition));
    const offset = cameraPosition.sub(origin);
    const localOrigin = vec3(
      dot(offset, right),
      dot(offset, up),
      dot(offset, forward),
    );
    const localRay = vec3(dot(ray, right), dot(ray, up), dot(ray, forward));
    const inverseRay = sign(localRay.add(1e-8)).div(
      max(abs(localRay), vec3(1e-6)),
    );
    const extent = optics.xy.mul(beamLength).add(optics.z).mul(2);
    const a = vec3(extent.negate(), 0).sub(localOrigin).mul(inverseRay);
    const b = vec3(extent, beamLength).sub(localOrigin).mul(inverseRay);
    const lower = min(a, b);
    const upper = max(a, b);
    const enter = max(max(max(lower.x, lower.y), lower.z), 0).toVar();
    const leave = min(min(upper.x, upper.y), upper.z).toVar();
    if (options.viewDepth) {
      const viewRayZ = cameraViewMatrix.mul(vec4(ray, 0)).z;
      leave.assign(
        min(
          leave,
          float(options.viewDepth)
            .context({ getUV: () => screenUV })
            .div(min(viewRayZ, -1e-6)),
        ),
      );
    }
    // Clip the ray to the expanding aperture before sampling, avoiding long empty box intervals.
    for (const axis of ["x", "y"] as const) {
      for (const direction of [-1, 1]) {
        const slope = optics[axis].mul(2);
        const distance = localOrigin[axis]
          .mul(direction)
          .sub(optics.z.mul(2))
          .sub(localOrigin.z.mul(slope));
        const velocity = localRay[axis]
          .mul(direction)
          .sub(localRay.z.mul(slope));
        const safeVelocity = sign(velocity.add(1e-8)).mul(
          max(abs(velocity), 1e-6),
        );
        const crossing = distance.negate().div(safeVelocity);
        enter.assign(select(velocity.lessThan(0), max(enter, crossing), enter));
        leave.assign(
          select(velocity.greaterThanEqual(0), min(leave, crossing), leave),
        );
      }
    }
    // Bounding boxes overlap much more than the actual light volumes, especially for linear arrays.
    If(leave.lessThanEqual(enter), () => {
      Discard();
    });
    const stepLength = leave.sub(enter).div(RAY_MARCH_STEPS);
    const integral = vec3(0).toVar();
    Loop(RAY_MARCH_STEPS, ({ i }) => {
      const t = enter.add(float(i).add(0.5).mul(stepLength));
      const point = localOrigin.add(localRay.mul(t));
      const width = optics.xy.mul(max(point.z, 0)).add(optics.z);
      const uv = point.xy.div(width);
      const roundRadius = uv.length();
      const rectangleRadius = max(abs(uv.x), abs(uv.y));
      const radius = mix(roundRadius, rectangleRadius, rectangular);
      const distribution = select(
        radius.lessThanEqual(2),
        exp(pow(radius, optics.w).mul(-Math.log(10))),
        0,
      );
      const attenuation = float(1).div(max(width.x.mul(width.y), 1e-8));
      const transmission = options.goboTexture
        ? sampleGoboProjection(
            options.goboTexture,
            atlasColumns,
            uv,
            width,
            optics.z,
            point.z,
            pattern,
            options.goboStacks,
          )
        : float(1);
      integral.addAssign(
        mix(
          radiance,
          secondary.xyz,
          smoothstep(
            max(pattern.w.mul(0.5), 0.00001).negate(),
            max(pattern.w.mul(0.5), 0.00001),
            uv.x,
          ).mul(secondary.w),
        )
          .mul(distribution)
          .mul(attenuation)
          .mul(stepLength)
          .mul(
            options.shadows?.sample(
              cameraPosition.add(ray.mul(t)),
              inputs.sourceId,
            ) ?? 1,
          )
          .mul(transmission),
      );
    });
    // Single scattering through a uniform haze; every aperture adds its own colored contribution.
    const phase = float(0.35).add(
      pow(max(dot(ray.negate(), forward), 0), 8).mul(1.65),
    );
    return vec4(
      integral.mul(phase).mul(HAZE_SCATTERING * SCATTERING_DISPLAY_EXPOSURE),
      1,
    );
  })();

  return { material, atlasColumns };
}

export type EmitterVolumeMaterial = ReturnType<
  typeof createEmitterVolumeMaterial
>;
