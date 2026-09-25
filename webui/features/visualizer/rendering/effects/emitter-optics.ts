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

/** Sanitizes optional imported values without allowing NaN into GPU buffers. */
function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Resolves one emitting aperture; a Glow aperture contributes only its visible lens. */
export function resolveEmitterOptics(
  optics: BeamOptics,
  zoomAngleDegrees?: number,
): ResolvedEmitterOptics | undefined {
  const physical = optics.physical;
  if (physical.beamType === BeamType.Glow) return undefined;
  const beamAngle = Math.max(0, Math.min(170, finite(physical.beamAngle, 15)));
  const fieldAngle = Math.max(
    beamAngle,
    Math.min(170, finite(physical.fieldAngle, beamAngle)),
  );
  const beamSlope = Math.tan((beamAngle * Math.PI) / 360);
  const fieldSlope = Math.tan((fieldAngle * Math.PI) / 360);
  const zoomSlope = Math.tan(
    (Math.max(0, Math.min(170, finite(zoomAngleDegrees, beamAngle))) *
      Math.PI) /
      360,
  );
  const zoomScale = beamSlope > 1e-6 ? zoomSlope / beamSlope : 1;
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

/** Evaluates the relative irradiance of the resolved distribution at an emitter-local point. */
export function sampleEmitterDistribution(
  optics: ResolvedEmitterOptics,
  x: number,
  y: number,
  distance: number,
): number {
  if (distance < 0) return 0;
  const u = x / (optics.radius + distance * optics.slopeX);
  const v = y / (optics.radius + distance * optics.slopeY);
  const radius =
    optics.shape === "rectangle"
      ? Math.max(Math.abs(u), Math.abs(v))
      : Math.hypot(u, v);
  if (radius > 2) return 0;
  return Math.exp(-Math.log(10) * radius ** optics.distributionPower);
}

/** Evaluates flux per square metre on a plane perpendicular to the beam axis, before filters or haze losses. */
export function sampleEmitterIlluminance(
  optics: ResolvedEmitterOptics,
  x: number,
  y: number,
  distance: number,
): number {
  if (distance < 0) return 0;
  const width = optics.radius + distance * optics.slopeX;
  const height = optics.radius + distance * optics.slopeY;
  return (
    (optics.lumens * sampleEmitterDistribution(optics, x, y, distance)) /
    (emitterDistributionArea(optics.shape, optics.distributionPower) *
      width *
      height)
  );
}
