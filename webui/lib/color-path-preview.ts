// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { ColorInterpolationSpace, FadeCurve, HueDirection } from "../types";

export interface ColorPathHsv {
  hue: number;
  saturation: number;
  value: number;
}

export interface ColorPathRoutePoint {
  color: types.ColorPathRgb;
  x: number;
  y: number;
  progress: number;
}

export interface CieChromaticity {
  x: number;
  y: number;
}

export interface CieSpectralLocusSample extends CieChromaticity {
  wavelength: number;
}

const CIE_PREVIEW_X_MAX = 0.8;
const CIE_PREVIEW_Y_MAX = 0.9;
const D65_WHITEPOINT: CieChromaticity = { x: 0.3127, y: 0.329 };

/** CIE 1931 2-degree spectral locus, downsampled from https://files.cie.co.at/CIE_xyz_1931_2deg.csv. */
export const CIE_1931_SPECTRAL_LOCUS: readonly CieSpectralLocusSample[] = [
  { wavelength: 380, x: 0.174112, y: 0.004964 },
  { wavelength: 390, x: 0.173801, y: 0.004915 },
  { wavelength: 400, x: 0.173337, y: 0.004797 },
  { wavelength: 410, x: 0.172577, y: 0.004799 },
  { wavelength: 420, x: 0.171407, y: 0.005102 },
  { wavelength: 430, x: 0.168878, y: 0.0069 },
  { wavelength: 440, x: 0.164412, y: 0.010858 },
  { wavelength: 450, x: 0.156641, y: 0.017705 },
  { wavelength: 460, x: 0.14396, y: 0.029703 },
  { wavelength: 470, x: 0.124118, y: 0.057803 },
  { wavelength: 480, x: 0.091294, y: 0.132702 },
  { wavelength: 490, x: 0.045391, y: 0.294976 },
  { wavelength: 500, x: 0.008168, y: 0.538423 },
  { wavelength: 510, x: 0.01387, y: 0.750186 },
  { wavelength: 520, x: 0.074302, y: 0.833803 },
  { wavelength: 530, x: 0.154722, y: 0.805864 },
  { wavelength: 540, x: 0.22962, y: 0.754329 },
  { wavelength: 550, x: 0.301604, y: 0.692308 },
  { wavelength: 560, x: 0.373102, y: 0.624451 },
  { wavelength: 570, x: 0.444062, y: 0.554714 },
  { wavelength: 580, x: 0.512486, y: 0.486591 },
  { wavelength: 590, x: 0.575151, y: 0.424232 },
  { wavelength: 600, x: 0.627037, y: 0.372491 },
  { wavelength: 610, x: 0.665764, y: 0.334011 },
  { wavelength: 620, x: 0.691504, y: 0.308342 },
  { wavelength: 630, x: 0.707918, y: 0.292027 },
  { wavelength: 640, x: 0.719033, y: 0.280935 },
  { wavelength: 650, x: 0.725992, y: 0.274008 },
  { wavelength: 660, x: 0.729969, y: 0.270031 },
  { wavelength: 670, x: 0.731993, y: 0.268007 },
  { wavelength: 680, x: 0.733417, y: 0.266583 },
  { wavelength: 690, x: 0.73439, y: 0.26561 },
  { wavelength: 700, x: 0.73469, y: 0.26531 },
];

/**
 * PLASA ANSI E1.54 RGB primaries from Colour Science's E1.54 dataset:
 * https://github.com/colour-science/colour/blob/develop/colour/models/rgb/datasets/plasa_ansi_e154.py
 *
 * That dataset aliases the RIMM/ROMM RGB primaries defined here:
 * https://github.com/colour-science/colour/blob/develop/colour/models/rgb/datasets/rimm_romm_rgb.py
 */
export const E154_RGB_PRIMARIES: readonly CieChromaticity[] = [
  { x: 0.7347, y: 0.2653 },
  { x: 0.1596, y: 0.8404 },
  { x: 0.0366, y: 0.0001 },
];

const E154_RGB_TO_XYZ_MATRIX = [
  [0.9083264656779226, 0.12761160082874742, 0.015990716876119155],
  [0.32799647658139763, 0.6719598329353342, 0.00004369048326808512],
  [0, 0, 0.42087042532146396],
] as const;

/** Clamps a numeric value to an inclusive range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Interpolates two numeric values by the given normalized ratio. */
function lerp(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

/** Applies the same named fade curves used by backend transition sampling. */
function evaluateCurve(curve: types.FadeCurve, ratio: number): number {
  const t = clamp(ratio, 0, 1);
  switch (curve) {
    case FadeCurve.EaseIn:
      return t * t;
    case FadeCurve.EaseOut:
      return 1 - (1 - t) * (1 - t);
    case FadeCurve.EaseInOut:
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    default:
      return t;
  }
}

/** Converts a normalized RGB color into CSS hex notation. */
export function rgbToHex(color: types.ColorPathRgb): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

/** Converts a linear sRGB channel to the display-encoded sRGB transfer curve. */
function linearToSrgb(value: number): number {
  const channel = clamp(value, 0, 1);
  if (channel <= 0.0031308) return 12.92 * channel;
  return 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Converts a display-encoded sRGB channel into linear-light sRGB. */
function srgbToLinear(value: number): number {
  const channel = clamp(value, 0, 1);
  if (channel <= 0.04045) return channel / 12.92;
  return ((channel + 0.055) / 1.055) ** 2.4;
}

/** Converts linear-light sRGB into CIE XYZ using the D65 reference white. */
function linearRgbToXyz(color: types.ColorPathRgb): {
  x: number;
  y: number;
  z: number;
} {
  const red = srgbToLinear(color.red);
  const green = srgbToLinear(color.green);
  const blue = srgbToLinear(color.blue);
  return {
    x: 0.4124564 * red + 0.3575761 * green + 0.1804375 * blue,
    y: 0.2126729 * red + 0.7151522 * green + 0.072175 * blue,
    z: 0.0193339 * red + 0.119192 * green + 0.9503041 * blue,
  };
}

/** Converts CIE XYZ into display-encoded sRGB, fitting chromaticity hues into gamut. */
function xyzToDisplayRgb(x: number, y: number, z: number): types.ColorPathRgb {
  let red = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  let green = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  let blue = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const minChannel = Math.min(red, green, blue);
  if (minChannel < 0) {
    red -= minChannel;
    green -= minChannel;
    blue -= minChannel;
  }
  const maxChannel = Math.max(red, green, blue);
  if (maxChannel > 1) {
    red /= maxChannel;
    green /= maxChannel;
    blue /= maxChannel;
  }
  return {
    red: linearToSrgb(red),
    green: linearToSrgb(green),
    blue: linearToSrgb(blue),
  };
}

/**
 * Converts a CIE 1931 xy chromaticity to the brightest display sRGB color of
 * that hue. Out-of-gamut chromaticities are desaturated toward white.
 */
export function cieChromaticityToFullBrightnessRgb(
  chromaticity: CieChromaticity,
): types.ColorPathRgb {
  const safeY = Math.max(chromaticity.y, 0.001);
  const x = chromaticity.x / safeY;
  const z = (1 - chromaticity.x - chromaticity.y) / safeY;
  let red = 3.2404542 * x - 1.5371385 - 0.4985314 * z;
  let green = -0.969266 * x + 1.8760108 + 0.041556 * z;
  let blue = 0.0556434 * x - 0.2040259 + 1.0572252 * z;
  const minChannel = Math.min(red, green, blue);
  if (minChannel < 0) {
    red -= minChannel;
    green -= minChannel;
    blue -= minChannel;
  }
  const maxChannel = Math.max(red, green, blue, Number.EPSILON);
  return {
    red: linearToSrgb(red / maxChannel),
    green: linearToSrgb(green / maxChannel),
    blue: linearToSrgb(blue / maxChannel),
  };
}

/** Converts normalized RGB to CIE 1931 xy chromaticity coordinates. */
export function rgbToCieChromaticity(
  color: types.ColorPathRgb,
): CieChromaticity {
  const xyz = linearRgbToXyz(color);
  const sum = xyz.x + xyz.y + xyz.z;
  if (sum <= Number.EPSILON) return D65_WHITEPOINT;
  return {
    x: xyz.x / sum,
    y: xyz.y / sum,
  };
}

/** Converts normalized PLASA ANSI E1.54 RGB values to CIE 1931 xy chromaticity coordinates. */
export function e154RgbToCieChromaticity(
  color: types.ColorPathRgb,
): CieChromaticity {
  const xyz = {
    x:
      E154_RGB_TO_XYZ_MATRIX[0][0] * color.red +
      E154_RGB_TO_XYZ_MATRIX[0][1] * color.green +
      E154_RGB_TO_XYZ_MATRIX[0][2] * color.blue,
    y:
      E154_RGB_TO_XYZ_MATRIX[1][0] * color.red +
      E154_RGB_TO_XYZ_MATRIX[1][1] * color.green +
      E154_RGB_TO_XYZ_MATRIX[1][2] * color.blue,
    z:
      E154_RGB_TO_XYZ_MATRIX[2][0] * color.red +
      E154_RGB_TO_XYZ_MATRIX[2][1] * color.green +
      E154_RGB_TO_XYZ_MATRIX[2][2] * color.blue,
  };
  const sum = xyz.x + xyz.y + xyz.z;
  if (sum <= Number.EPSILON) return D65_WHITEPOINT;
  return {
    x: xyz.x / sum,
    y: xyz.y / sum,
  };
}

/** Converts normalized preview coordinates into fitted PLASA ANSI E1.54 RGB controls. */
export function ciePreviewPointToE154Rgb(
  previewX: number,
  previewY: number,
): types.ColorPathRgb {
  const chromaticity = {
    x: clamp(previewX, 0, 1) * CIE_PREVIEW_X_MAX,
    y: (1 - clamp(previewY, 0, 1)) * CIE_PREVIEW_Y_MAX,
  };
  const yLuminance = 1;
  const safeY = Math.max(chromaticity.y, 0.001);
  const x = (chromaticity.x * yLuminance) / safeY;
  const y = yLuminance;
  const z = ((1 - chromaticity.x - chromaticity.y) * yLuminance) / safeY;
  const blue = z / E154_RGB_TO_XYZ_MATRIX[2][2];
  const adjustedX = x - E154_RGB_TO_XYZ_MATRIX[0][2] * blue;
  const adjustedY = y - E154_RGB_TO_XYZ_MATRIX[1][2] * blue;
  const determinant =
    E154_RGB_TO_XYZ_MATRIX[0][0] * E154_RGB_TO_XYZ_MATRIX[1][1] -
    E154_RGB_TO_XYZ_MATRIX[0][1] * E154_RGB_TO_XYZ_MATRIX[1][0];
  const red =
    (adjustedX * E154_RGB_TO_XYZ_MATRIX[1][1] -
      E154_RGB_TO_XYZ_MATRIX[0][1] * adjustedY) /
    determinant;
  const green =
    (E154_RGB_TO_XYZ_MATRIX[0][0] * adjustedY -
      E154_RGB_TO_XYZ_MATRIX[1][0] * adjustedX) /
    determinant;
  const maxChannel = Math.max(red, green, blue);
  const scale = maxChannel > 1 ? maxChannel : 1;
  return {
    red: clamp(red / scale, 0, 1),
    green: clamp(green / scale, 0, 1),
    blue: clamp(blue / scale, 0, 1),
  };
}

/** Converts a CIE xy chromaticity coordinate into normalized preview SVG coordinates. */
export function cieChromaticityToPreviewPoint(chromaticity: CieChromaticity): {
  x: number;
  y: number;
} {
  return {
    x: clamp(chromaticity.x / CIE_PREVIEW_X_MAX, 0, 1),
    y: clamp(1 - chromaticity.y / CIE_PREVIEW_Y_MAX, 0, 1),
  };
}

/** Converts the CIE 1931 spectral locus samples into normalized preview SVG coordinates. */
export function cieSpectralLocusPreviewPoints(): { x: number; y: number }[] {
  return CIE_1931_SPECTRAL_LOCUS.map(cieChromaticityToPreviewPoint);
}

const CIE_SPECTRAL_LOCUS_PREVIEW_POLYGON = cieSpectralLocusPreviewPoints();
const SPECTRAL_LOCUS_EDGE_TOLERANCE = 0.0002;

/** Returns the squared distance between two normalized preview points. */
function squaredPreviewPointDistance(
  first: CieChromaticity,
  second: CieChromaticity,
): number {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

/** Returns the squared distance from a normalized preview point to a polygon edge. */
function squaredPreviewPointDistanceToSegment(
  point: CieChromaticity,
  segmentStart: CieChromaticity,
  segmentEnd: CieChromaticity,
): number {
  const segmentLengthSquared = squaredPreviewPointDistance(
    segmentStart,
    segmentEnd,
  );
  if (segmentLengthSquared <= Number.EPSILON) {
    return squaredPreviewPointDistance(point, segmentStart);
  }

  const ratio = clamp(
    ((point.x - segmentStart.x) * (segmentEnd.x - segmentStart.x) +
      (point.y - segmentStart.y) * (segmentEnd.y - segmentStart.y)) /
      segmentLengthSquared,
    0,
    1,
  );
  const projectedPoint = {
    x: segmentStart.x + (segmentEnd.x - segmentStart.x) * ratio,
    y: segmentStart.y + (segmentEnd.y - segmentStart.y) * ratio,
  };
  return squaredPreviewPointDistance(point, projectedPoint);
}

/** Returns whether normalized preview coordinates fall within the CIE spectral locus polygon. */
export function ciePreviewPointInsideSpectralLocus(
  previewX: number,
  previewY: number,
): boolean {
  const point = {
    x: clamp(previewX, 0, 1),
    y: clamp(previewY, 0, 1),
  };
  let isInside = false;
  for (
    let index = 0, previous = CIE_SPECTRAL_LOCUS_PREVIEW_POLYGON.length - 1;
    index < CIE_SPECTRAL_LOCUS_PREVIEW_POLYGON.length;
    previous = index++
  ) {
    const currentPoint = CIE_SPECTRAL_LOCUS_PREVIEW_POLYGON[index];
    const previousPoint = CIE_SPECTRAL_LOCUS_PREVIEW_POLYGON[previous];
    if (!currentPoint || !previousPoint) continue;
    if (
      squaredPreviewPointDistanceToSegment(
        point,
        currentPoint,
        previousPoint,
      ) <=
      SPECTRAL_LOCUS_EDGE_TOLERANCE ** 2
    ) {
      return true;
    }
    if (
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x
    ) {
      isInside = !isInside;
    }
  }
  return isInside;
}

/** Converts the PLASA ANSI E1.54 RGB primaries into normalized preview SVG coordinates. */
export function e154RgbTrianglePreviewPoints(): { x: number; y: number }[] {
  return E154_RGB_PRIMARIES.map(cieChromaticityToPreviewPoint);
}

/** Converts a CIE xy chromaticity coordinate into an approximate display color. */
function cieChromaticityToDisplayRgb(
  chromaticity: CieChromaticity,
): types.ColorPathRgb {
  const yLuminance = 1;
  const y = Math.max(chromaticity.y, 0.001);
  const x = (chromaticity.x * yLuminance) / y;
  const z = ((1 - chromaticity.x - chromaticity.y) * yLuminance) / y;
  return xyzToDisplayRgb(x, yLuminance, z);
}

/** Samples the CIE chromaticity preview background at normalized preview coordinates. */
export function ciePreviewBackgroundColor(
  previewX: number,
  previewY: number,
): types.ColorPathRgb {
  const chromaticity = {
    x: clamp(previewX, 0, 1) * CIE_PREVIEW_X_MAX,
    y: (1 - clamp(previewY, 0, 1)) * CIE_PREVIEW_Y_MAX,
  };
  return cieChromaticityToDisplayRgb(chromaticity);
}

/** Converts CSS hex notation into a normalized RGB color. */
export function hexToRgb(hex: string): types.ColorPathRgb {
  const normalized = hex.replace(/^#/u, "");
  if (!/^[0-9a-f]{6}$/iu.test(normalized)) {
    return { red: 0, green: 0, blue: 0 };
  }
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16) / 255,
    green: Number.parseInt(normalized.slice(2, 4), 16) / 255,
    blue: Number.parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

/** Resolves the interpolation space implied by a color path definition. */
export function resolvedInterpolationSpace(
  path: types.ColorPath,
): types.ColorInterpolationSpace {
  return path.interpolation_space;
}

/** Samples a color path at a normalized progress ratio. */
export function sampleColorPath(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  progress: number,
): types.ColorPathRgb {
  const ratio = evaluateCurve(path.curve, progress);
  switch (resolvedInterpolationSpace(path)) {
    case ColorInterpolationSpace.Hsv:
      return sampleHsv(start, end, ratio, path.hue_direction);
    case ColorInterpolationSpace.Cmy:
      return sampleCmy(start, end, ratio);
    default:
      return {
        red: lerp(start.red, end.red, ratio),
        green: lerp(start.green, end.green, ratio),
        blue: lerp(start.blue, end.blue, ratio),
      };
  }
}

/** Samples a color path with path timing and per-attribute timing applied. */
export function sampleColorPathWithTiming(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  progress: number,
): types.ColorPathRgb {
  const red = sampleColorPath(
    path,
    start,
    end,
    colorPathChannelRatio(path, progress, "Red"),
  ).red;
  const green = sampleColorPath(
    path,
    start,
    end,
    colorPathChannelRatio(path, progress, "Green"),
  ).green;
  const blue = sampleColorPath(
    path,
    start,
    end,
    colorPathChannelRatio(path, progress, "Blue"),
  ).blue;
  return applyMidpointBrightness(path, { red, green, blue }, progress);
}

/** Samples a preview color while preserving the authored endpoint anchors. */
function sampleColorPathPreview(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  progress: number,
): types.ColorPathRgb {
  if (progress <= 0) return start;
  if (progress >= 1) return end;
  return sampleColorPathWithTiming(path, start, end, progress);
}

/** Builds evenly spaced preview samples for swatches and route overlays. */
export function colorPathSamples(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  count: number,
): types.ColorPathRgb[] {
  const sampleCount = Math.max(2, Math.floor(count));
  return Array.from({ length: sampleCount }, (_, index) =>
    sampleColorPathPreview(path, start, end, index / (sampleCount - 1)),
  );
}

/** Resolves path progress after applying optional attribute timing overrides. */
function colorPathChannelRatio(
  path: types.ColorPath,
  parentProgress: number,
  attribute: "Red" | "Green" | "Blue",
): number {
  const attributeTiming = path.timing.attributes?.[attribute];
  if (attributeTiming) {
    return timedRatio(parentProgress, attributeTiming);
  }
  return colorPathGlobalRatio(path, parentProgress);
}

/** Resolves global path progress from optional in-color and out-color timings. */
function colorPathGlobalRatio(
  path: types.ColorPath,
  parentProgress: number,
): number {
  const inColor = path.timing.in_color;
  const outColor = path.timing.out_color;
  if (inColor && outColor) {
    return (
      (timedRatioLinear(parentProgress, inColor) +
        timedRatioLinear(parentProgress, outColor)) /
      2
    );
  }
  if (inColor) return timedRatioLinear(parentProgress, inColor);
  if (outColor) return timedRatioLinear(parentProgress, outColor);
  return clamp(parentProgress, 0, 1);
}

/** Maps parent progress through one fractional delay/time timing control without easing. */
function timedRatioLinear(
  parentProgress: number,
  timing: types.ColorPathTimingComponent,
): number {
  const parentRatio = clamp(parentProgress, 0, 1);
  const delay = clamp(timing.delay_percent, 0, 1);
  const time = Math.max(0, timing.time_percent);
  if (parentRatio < delay) return 0;
  if (time <= Number.EPSILON) return 1;
  return clamp((parentRatio - delay) / time, 0, 1);
}

/** Maps parent progress through one fractional delay/time timing control. */
function timedRatio(
  parentProgress: number,
  timing: types.ColorAttributeTiming,
): number {
  const parentRatio = clamp(parentProgress, 0, 1);
  const delay = clamp(timing.delay_percent, 0, 1);
  const time = Math.max(0, timing.time_percent);
  if (parentRatio < delay) return 0;
  if (time <= Number.EPSILON) return 1;
  return evaluateCurve(timing.curve, clamp((parentRatio - delay) / time, 0, 1));
}

/** Applies a brightness envelope whose maximum or minimum occurs at fade midpoint. */
function applyMidpointBrightness(
  path: types.ColorPath,
  color: types.ColorPathRgb,
  progress: number,
): types.ColorPathRgb {
  const midpointBrightness = Math.max(0, path.timing.brightness_percent ?? 1);
  const midpointWeight = 1 - Math.abs(clamp(progress, 0, 1) * 2 - 1);
  const brightness = 1 + (midpointBrightness - 1) * midpointWeight;
  return {
    red: clamp(color.red * brightness, 0, 1),
    green: clamp(color.green * brightness, 0, 1),
    blue: clamp(color.blue * brightness, 0, 1),
  };
}

/** Projects preview samples into PLASA ANSI E1.54 CIE xy chromaticity coordinates. */
export function colorPathRoutePoints(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  count: number,
): ColorPathRoutePoint[] {
  const sampleCount = Math.max(2, Math.floor(count));
  if (resolvedInterpolationSpace(path) === ColorInterpolationSpace.Rgb) {
    const startPoint = cieChromaticityToPreviewPoint(
      e154RgbToCieChromaticity(start),
    );
    const endPoint = cieChromaticityToPreviewPoint(
      e154RgbToCieChromaticity(end),
    );
    return Array.from({ length: sampleCount }, (_, index) => {
      const progress = sampleCount <= 1 ? 0 : index / (sampleCount - 1);
      return {
        color: sampleColorPathPreview(path, start, end, progress),
        x: lerp(startPoint.x, endPoint.x, progress),
        y: lerp(startPoint.y, endPoint.y, progress),
        progress,
      };
    });
  }

  return colorPathSamples(path, start, end, count).map((color, index, list) => {
    const point = cieChromaticityToPreviewPoint(
      e154RgbToCieChromaticity(color),
    );
    return {
      color,
      x: point.x,
      y: point.y,
      progress: list.length <= 1 ? 0 : index / (list.length - 1),
    };
  });
}

/** Converts a normalized RGB color into HSV coordinates. */
export function rgbToHsv(color: types.ColorPathRgb): ColorPathHsv {
  const red = clamp(color.red, 0, 1);
  const green = clamp(color.green, 0, 1);
  const blue = clamp(color.blue, 0, 1);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }
  if (hue < 0) hue += 360;

  return {
    hue,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
}

/** Converts HSV coordinates into a normalized RGB color. */
export function hsvToRgb(hsv: ColorPathHsv): types.ColorPathRgb {
  const hue = ((hsv.hue % 360) + 360) % 360;
  const saturation = clamp(hsv.saturation, 0, 1);
  const value = clamp(hsv.value, 0, 1);
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - chroma;

  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) {
    red = chroma;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = chroma;
  } else if (hue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  return { red: red + m, green: green + m, blue: blue + m };
}

/** Samples HSV interpolation with the requested hue direction. */
function sampleHsv(
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  ratio: number,
  direction: types.HueDirection,
): types.ColorPathRgb {
  const startHsv = rgbToHsv(start);
  const endHsv = rgbToHsv(end);
  const hueDelta = directedHueDelta(startHsv.hue, endHsv.hue, direction);
  return hsvToRgb({
    hue: startHsv.hue + hueDelta * ratio,
    saturation: lerp(startHsv.saturation, endHsv.saturation, ratio),
    value: lerp(startHsv.value, endHsv.value, ratio),
  });
}

/** Samples subtractive CMY interpolation and converts back to RGB. */
function sampleCmy(
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  ratio: number,
): types.ColorPathRgb {
  const startCmy = {
    cyan: 1 - start.red,
    magenta: 1 - start.green,
    yellow: 1 - start.blue,
  };
  const endCmy = {
    cyan: 1 - end.red,
    magenta: 1 - end.green,
    yellow: 1 - end.blue,
  };
  return {
    red: 1 - lerp(startCmy.cyan, endCmy.cyan, ratio),
    green: 1 - lerp(startCmy.magenta, endCmy.magenta, ratio),
    blue: 1 - lerp(startCmy.yellow, endCmy.yellow, ratio),
  };
}

/** Calculates the hue delta matching the requested route direction. */
function directedHueDelta(
  startHue: number,
  endHue: number,
  direction: types.HueDirection,
): number {
  const clockwise = (endHue - startHue + 360) % 360;
  const counterClockwise = clockwise - 360;
  switch (direction) {
    case HueDirection.Clockwise:
      return clockwise;
    case HueDirection.CounterClockwise:
      return counterClockwise;
    default:
      return clockwise <= 180 ? clockwise : counterClockwise;
  }
}
