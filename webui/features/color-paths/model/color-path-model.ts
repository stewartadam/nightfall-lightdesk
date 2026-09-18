// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type ColorPathRoutePoint,
  ciePreviewBackgroundColor,
  ciePreviewPointInsideSpectralLocus,
  cieSpectralLocusPreviewPoints,
  e154RgbTrianglePreviewPoints,
  resolvedInterpolationSpace,
  rgbToHex,
} from "../../../lib/color-path-preview";
import type * as types from "../../../types";
import { ColorInterpolationSpace } from "../../../types";
export const BUILTIN_COLOR_PATH_IDS = new Set([1, 2, 3]);
export const PREVIEW_SAMPLE_COUNT = 60;
export const OUTSIDE_LOCUS_DIM_OPACITY = 0.46;
export const ROUTE_ENDPOINT_INSET = 0.034;
export const EDITABLE_INTERPOLATION_SPACES = [
  ColorInterpolationSpace.Rgb,
  ColorInterpolationSpace.Hsv,
  ColorInterpolationSpace.Cmy,
] as const;

export type RouteAnchor = "start" | "end";

export interface ColorPathPreviewPoint extends ColorPathRoutePoint {
  cieHex: string;
  fixtureHex: string;
}

/** Constrains CIE preview coordinates to the visible route overlay bounds. */
export function clampPreviewCoordinate(value: number): number {
  return Math.min(
    1 - ROUTE_ENDPOINT_INSET,
    Math.max(ROUTE_ENDPOINT_INSET, value),
  );
}

/** Formats normalized SVG coordinates into a polygon/polyline point list. */
export function svgPointList(
  points: readonly { x: number; y: number }[],
): string {
  return points.map((point) => `${point.x * 100},${point.y * 100}`).join(" ");
}

/** Returns the dimmed CIE map display color for a normalized preview point. */
export function ciePreviewDisplayColor(point: {
  x: number;
  y: number;
}): types.ColorPathRgb {
  const color = ciePreviewBackgroundColor(point.x, point.y);
  const colorScale = ciePreviewPointInsideSpectralLocus(point.x, point.y)
    ? 1
    : 1 - OUTSIDE_LOCUS_DIM_OPACITY;
  return {
    red: color.red * colorScale,
    green: color.green * colorScale,
    blue: color.blue * colorScale,
  };
}

/** Returns the CIE map display color as CSS hex for a normalized preview point. */
export function ciePreviewPointHex(point: { x: number; y: number }): string {
  return rgbToHex(ciePreviewDisplayColor(point));
}

/** Adds named CIE-map and fixture-space display colors to a computed preview route point. */
export function previewPointWithDisplayColors(
  point: ColorPathRoutePoint,
): ColorPathPreviewPoint {
  const displayPoint = {
    x: clampPreviewCoordinate(point.x),
    y: clampPreviewCoordinate(point.y),
  };
  return {
    ...point,
    ...displayPoint,
    cieHex: ciePreviewPointHex(displayPoint),
    fixtureHex: rgbToHex(point.color),
  };
}

export const CIE_SPECTRAL_LOCUS_POINTS = cieSpectralLocusPreviewPoints();
export const CIE_SPECTRAL_LOCUS_POLYGON = svgPointList(
  CIE_SPECTRAL_LOCUS_POINTS,
);
export const E154_RGB_TRIANGLE_POINTS = e154RgbTrianglePreviewPoints();
export const E154_RGB_TRIANGLE_POLYGON = svgPointList(E154_RGB_TRIANGLE_POINTS);

/** Returns whether a normalized preview point is inside the fixture RGB gamut triangle. */
export function previewPointInsideFixtureRgbGamut(point: {
  x: number;
  y: number;
}): boolean {
  const [red, green, blue] = E154_RGB_TRIANGLE_POINTS;
  if (!red || !green || !blue) return false;
  const denominator =
    (green.y - blue.y) * (red.x - blue.x) +
    (blue.x - green.x) * (red.y - blue.y);
  if (Math.abs(denominator) <= Number.EPSILON) return false;
  const redWeight =
    ((green.y - blue.y) * (point.x - blue.x) +
      (blue.x - green.x) * (point.y - blue.y)) /
    denominator;
  const greenWeight =
    ((blue.y - red.y) * (point.x - blue.x) +
      (red.x - blue.x) * (point.y - blue.y)) /
    denominator;
  const blueWeight = 1 - redWeight - greenWeight;
  const tolerance = 0.000001;
  return (
    redWeight >= -tolerance &&
    greenWeight >= -tolerance &&
    blueWeight >= -tolerance
  );
}

/** Returns true when a color path is one of the seeded built-in definitions. */
export function isBuiltinColorPath(path: types.ColorPath): boolean {
  return BUILTIN_COLOR_PATH_IDS.has(path.identifiers.id);
}

/** Creates a deep copy suitable for local form editing. */
export function cloneColorPath(path: types.ColorPath): types.ColorPath {
  return JSON.parse(JSON.stringify(path)) as types.ColorPath;
}

/** Computes the next unused numeric color path ID. */
export function nextColorPathId(paths: readonly types.ColorPath[]): number {
  const existingIds = new Set(paths.map((path) => path.identifiers.id));
  let id = 1;
  while (existingIds.has(id)) id++;
  return id;
}

/** Normalizes optional timing fields before sending a path to the backend. */
export function normalizedColorPath(path: types.ColorPath): types.ColorPath {
  return {
    ...path,
    interpolation_space: resolvedInterpolationSpace(path),
    identifiers: {
      ...path.identifiers,
      label:
        path.identifiers.label.trim() || `Color Path ${path.identifiers.id}`,
    },
    timing: {
      in_color: path.timing.in_color,
      out_color: path.timing.out_color,
      brightness_percent: path.timing.brightness_percent,
      attributes: path.timing.attributes ?? {},
    },
  };
}

/** Formats a percentage-style fraction for numeric input fields. */
export function percentInputValue(
  value: number | undefined,
  fallback: number,
): string {
  return String(Math.round((value ?? fallback) * 100));
}

/** Converts a percentage-style input value into a clamped fraction. */
export function percentInputFraction(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(200, Math.max(0, parsed)) / 100;
}

/** Panel for editing reusable color path definitions and previewing their routes. */
