// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

export { durationToMs, msToDuration } from "./duration";

/** Converts milliseconds to seconds. */
function msToSeconds(ms: number): number {
  return ms / 1000;
}

/** Converts seconds to milliseconds. */
function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

/** Converts timeline pixels to truncated milliseconds at the current zoom. */
export function pixelsToMs(pixels: number, zoom: number): number {
  return Math.trunc(secondsToMs(pixels / zoom));
}

/** Converts milliseconds to timeline pixels at the current zoom. */
export function msToPixels(ms: number, zoom: number): number {
  return Math.ceil(msToSeconds(ms) * zoom);
}

// Helper to turn ParameterValue into a single numeric representation that
// we can show in the grid. For relative values we just show the offset.
// Returns both the value and whether it's a percentage.
export const resolveParameterValue = (
  param: types.ParameterValue,
): { value: number | null; isPercentage: boolean; isRelative: boolean } => {
  if (param === null || typeof param !== "object")
    return { value: null, isPercentage: false, isRelative: false };
  if (param.type === "Absolute")
    return {
      value: param.data.value ?? null,
      isPercentage: false,
      isRelative: false,
    };
  if (param.type === "AbsolutePercent")
    return {
      value: param.data.value ?? null,
      isPercentage: true,
      isRelative: false,
    };
  if (param.type === "Relative")
    return {
      value: param.data.offset ?? null,
      isPercentage: false,
      isRelative: true,
    };
  if (param.type === "RelativePercent")
    return {
      value: param.data.offset ?? null,
      isPercentage: true,
      isRelative: true,
    };
  return { value: null, isPercentage: false, isRelative: false };
};

export const parseParameterValue = (
  input: string,
): types.ParameterValue | null => {
  const s = input.trim();
  if (s === "") {
    return null; // Empty input is not a valid parameter value
  }

  const isRelative = s.startsWith("~");
  const withoutOperator = s.replace(/^[@~]/, "");
  const isPercent = withoutOperator.endsWith("%");
  const numStr = withoutOperator.replace(/%$/, "");
  const raw = Number.parseFloat(numStr);

  // Validate that we got a valid number
  if (Number.isNaN(raw) || !/^[+-]?\d+(?:\.\d+)?$/.test(numStr.trim())) {
    return null; // Invalid number format
  }

  const value = isPercent ? raw / 100 : raw;

  if (isRelative) {
    if (isPercent) {
      return { type: "RelativePercent", data: { offset: value } };
    }
    return { type: "Relative", data: { offset: value } };
  }
  if (isPercent) {
    return { type: "AbsolutePercent", data: { value } };
  }
  return { type: "Absolute", data: { value } };
};

/**
 * Normalize attribute names for display purposes.
 * VirtualIntensity is an internal adapter that should appear as "Intensity" in the UI.
 */
export function normalizeAttributeName(attributeName: string): string {
  if (attributeName === "VirtualIntensity") {
    return "Intensity";
  }
  return attributeName;
}

/**
 * Deep copy helper to remove proxies from nanostores/other libs.
 *
 * This is necessary to avoid corruption of references to solid proxy objects
 * in nanostores, due to use of `reconcile()` in the nanostore solidjs
 * integration.
 */
export function unproxify(val: any): any {
  if (Array.isArray(val)) return val.map(unproxify);
  if (val instanceof Object)
    return Object.fromEntries(
      Object.entries(Object.assign({}, val)).map(([k, v]) => [k, unproxify(v)]),
    );
  return val;
}
