// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type BeamOptics, BeamType } from "../../../../types";

/** Exposure convention shared by atmospheric and surface rendering; source metadata remains in lumens. */
export const LUMENS_PER_SCENE_UNIT = 1000;

const MIN_POWER = 0.1;
const MAX_POWER = 64;
const POWER_STEPS = 256;
const LOG_POWER_RANGE = Math.log(MAX_POWER / MIN_POWER);

/** Integrates the bounded radial profile once at startup, keeping changing frost values cheap during playback. */
function buildDistributionAreas(): Float64Array {
  const areas = new Float64Array(POWER_STEPS + 1);
  const steps = 256;
  const width = 2 / steps;
  for (let index = 0; index <= POWER_STEPS; index++) {
    const power = MIN_POWER * Math.exp((index * LOG_POWER_RANGE) / POWER_STEPS);
    let integral = 0;
    for (let i = 0; i <= steps; i++) {
      const radius = i * width;
      const weight = i === 0 || i === steps ? 1 : i % 2 === 0 ? 2 : 4;
      integral += weight * radius * Math.exp(-Math.log(10) * radius ** power);
    }
    areas[index] = (2 * integral * width) / 3;
  }
  return areas;
}

const DISTRIBUTION_AREAS = buildDistributionAreas();

/** Returns the effective area of a unit-width profile, truncated at twice the field contour like the shaders. */
export function emitterDistributionArea(
  shape: "round" | "rectangle",
  power: number,
): number {
  const bounded = Number.isFinite(power)
    ? Math.max(MIN_POWER, Math.min(MAX_POWER, power))
    : 4;
  const index = (Math.log(bounded / MIN_POWER) / LOG_POWER_RANGE) * POWER_STEPS;
  const lower = Math.min(POWER_STEPS - 1, Math.floor(index));
  const fraction = index - lower;
  const area =
    DISTRIBUTION_AREAS[lower] +
    fraction * (DISTRIBUTION_AREAS[lower + 1] - DISTRIBUTION_AREAS[lower]);
  return area * (shape === "round" ? Math.PI : 4);
}

/** Renderer-independent cross section of one aperture, in meters and radians. */
export interface ResolvedEmitterOptics {
  shape: "round" | "rectangle";
  radius: number;
  /** Half-width and half-height added per meter of propagation. */
  slopeX: number;
  slopeY: number;
  /** Radius of the 50% contour relative to the 10% contour. */
  halfPowerRatio: number;
  /** Super-Gaussian exponent matching the supplied beam and field angles. */
  distributionPower: number;
  lumens: number;
}

/** Widest full beam angle, in degrees, an aperture may project. */
const MAX_BEAM_ANGLE_DEGREES = 170;
/** Beam angle assumed when imported photometry omits or corrupts it. */
const DEFAULT_BEAM_ANGLE_DEGREES = 15;

/** Sanitizes optional imported values without allowing NaN into GPU buffers. */
function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Clamps a full cone angle to the projectable range, replacing non-finite input with a fallback. */
function beamAngle(degrees: number | undefined, fallback: number): number {
  return Math.max(
    0,
    Math.min(MAX_BEAM_ANGLE_DEGREES, finite(degrees, fallback)),
  );
}

/** Half-width added per meter of propagation by a full cone angle. */
function coneSlope(degrees: number): number {
  return Math.tan((degrees * Math.PI) / 360);
}

/**
 * Scales an aperture's native spread to a zoomed full beam angle. Missing, non-finite or
 * degenerate angles keep the native spread instead of producing NaN or infinite slopes.
 */
export function emitterZoomScale(
  physical: BeamOptics["physical"],
  zoomAngleDegrees: number | undefined,
): number {
  const native = beamAngle(physical.beamAngle, DEFAULT_BEAM_ANGLE_DEGREES);
  const nativeSlope = coneSlope(native);
  return nativeSlope > 1e-6
    ? coneSlope(beamAngle(zoomAngleDegrees, native)) / nativeSlope
    : 1;
}

/** Resolves one emitting aperture; a Glow aperture contributes only its visible lens. */
export function resolveEmitterOptics(
  optics: BeamOptics,
  zoomAngleDegrees?: number,
): ResolvedEmitterOptics | undefined {
  const physical = optics.physical;
  if (physical.beamType === BeamType.Glow) return undefined;
  const nativeAngle = beamAngle(physical.beamAngle, DEFAULT_BEAM_ANGLE_DEGREES);
  const fieldAngle = Math.max(
    nativeAngle,
    beamAngle(physical.fieldAngle, nativeAngle),
  );
  const beamSlope = coneSlope(nativeAngle);
  const fieldSlope = coneSlope(fieldAngle);
  const zoomScale = emitterZoomScale(physical, zoomAngleDegrees);
  const halfPowerRatio =
    fieldSlope > 1e-6
      ? Math.max(0.001, Math.min(0.999, beamSlope / fieldSlope))
      : 0.999;
  const rectangle = physical.beamType === BeamType.Rectangle;
  const throwRatio = Math.max(0.01, finite(optics.throwRatio, 1));
  const aspectRatio = Math.max(0.01, finite(optics.rectangleRatio, 1));
  const slopeX = rectangle
    ? zoomScale / (2 * throwRatio)
    : fieldSlope * zoomScale;
  return {
    shape: rectangle ? "rectangle" : "round",
    radius: Math.max(0.0001, Math.min(10, finite(optics.radius, 0.01))),
    slopeX,
    slopeY: rectangle ? slopeX / aspectRatio : slopeX,
    halfPowerRatio,
    distributionPower: Math.min(
      64,
      Math.max(
        0.1,
        Math.log(Math.log(10) / Math.log(2)) / Math.log(1 / halfPowerRatio),
      ),
    ),
    lumens: Math.max(0, finite(physical.lumens, 1000)),
  };
}
