// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type BeamOptics, BeamType } from "../../../../types";
import { MIN_CONE_ANGLE_DEGREES } from "./beam-zoom";

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
 * Scales an aperture's native spread to a zoomed full beam angle. Missing or non-finite
 * angles and a degenerate native angle keep the native spread instead of producing NaN or
 * infinite slopes. Profiles may author a zero or negative angle at one end of a zoom range,
 * so a finite stated angle is floored at {@link MIN_CONE_ANGLE_DEGREES} and the beam never
 * collapses to a line.
 */
export function emitterZoomScale(
  physical: BeamOptics["physical"],
  zoomAngleDegrees: number | undefined,
): number {
  const native = beamAngle(physical.beamAngle, 0);
  const nativeSlope = coneSlope(native);
  if (nativeSlope <= 1e-6) return 1;
  const zoom =
    zoomAngleDegrees !== undefined && Number.isFinite(zoomAngleDegrees)
      ? Math.max(MIN_CONE_ANGLE_DEGREES, beamAngle(zoomAngleDegrees, native))
      : native;
  return coneSlope(zoom) / nativeSlope;
}

/**
 * Resolves the zoomed full beam angle every fixture path feeds to {@link emitterZoomScale}
 * and {@link emitterIrisScale}, in degrees:
 *
 * 1. A finite `zoomDegrees` — from a zoom function that states a real angular range — is the
 *    beam angle itself.
 * 2. Otherwise a finite normalized `zoom` (1 = focused, 0 = zoomed out) sweeps the visible
 *    field edge from the native field angle down to the native beam angle, the same cone the
 *    hard-edged renderer drew at each endpoint, and returns the beam angle that scales the
 *    native optics to that edge. Zoom 0 is therefore the native optics.
 * 3. With neither, `undefined` keeps the aperture's native optics.
 */
export function zoomedBeamAngleDegrees(
  physical: BeamOptics["physical"],
  zoomDegrees: number | undefined,
  zoom: number | undefined,
): number | undefined {
  if (zoomDegrees !== undefined && Number.isFinite(zoomDegrees))
    return zoomDegrees;
  if (zoom === undefined || !Number.isFinite(zoom)) return undefined;
  const native = beamAngle(physical.beamAngle, 0);
  const field = Math.max(native, beamAngle(physical.fieldAngle, native));
  const fieldSlope = coneSlope(field);
  if (fieldSlope <= 1e-6) return undefined;
  const focused = Math.max(0, Math.min(1, zoom));
  const edge = field - (field - native) * focused;
  const scale = coneSlope(edge) / fieldSlope;
  return (360 / Math.PI) * Math.atan(coneSlope(native) * scale);
}

/**
 * Narrows an aperture's zoomed spread by an iris: an iris passing a fraction of the
 * open beam scales the full angle θ to θ·iris, so the spread scales by
 * tan(θ·iris/2) / tan(θ/2). A missing, non-finite or fully open iris leaves it unchanged.
 */
export function emitterIrisScale(
  physical: BeamOptics["physical"],
  zoomAngleDegrees: number | undefined,
  iris: number | undefined,
): number {
  if (iris === undefined || !Number.isFinite(iris) || iris >= 1) return 1;
  const native = beamAngle(physical.beamAngle, 0);
  const halfAngle = Math.atan(
    coneSlope(native) * emitterZoomScale(physical, zoomAngleDegrees),
  );
  if (halfAngle <= 1e-9) return 1;
  return Math.tan(halfAngle * Math.max(0, iris)) / Math.tan(halfAngle);
}

/** Resolves one emitting aperture; a Glow aperture contributes only its visible lens. */
export function resolveEmitterOptics(
  optics: BeamOptics,
  zoomAngleDegrees?: number,
): ResolvedEmitterOptics | undefined {
  const physical = optics.physical;
  if (physical.beamType === BeamType.Glow) return undefined;
  const nativeAngle = beamAngle(physical.beamAngle, 0);
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
    lumens: Math.max(0, finite(physical.lumens, 0)),
  };
}
