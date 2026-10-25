// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Matches a plain signed decimal number, optionally in exponent notation. */
const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;

/**
 * Significant digits kept from interpolated fan values, so binary rounding
 * noise such as `0.30000000000000004` never reaches cells or the backend.
 */
const FAN_PRECISION = 12;

/**
 * Splits command-line style fan input such as `0>3` or `0>5>0` into trimmed
 * waypoint strings. Returns null unless the input has at least two non-empty
 * waypoints separated by `>`.
 */
export function splitFanInput(input: string): string[] | null {
  if (!input.includes(">")) return null;
  const values = input.split(">").map((value) => value.trim());
  if (values.length < 2 || values.some((value) => value === "")) {
    return null;
  }
  return values;
}

/**
 * Parses numeric fan input such as `0>3` or `-1.5>0>1.5` into ordered
 * waypoints. Returns null when the input is not a fan or any waypoint is not a
 * finite number.
 */
export function parseNumericFanInput(input: string): number[] | null {
  const values = splitFanInput(input);
  if (!values) return null;

  if (!values.every((value) => DECIMAL_NUMBER.test(value))) return null;
  return values.map(Number);
}

/**
 * Resolves the value at `offset` of `total` evenly spaced targets along fan
 * waypoints. The first target receives the first waypoint, the last target the
 * last waypoint, and targets in between are linearly interpolated through each
 * waypoint segment.
 */
export function resolveFanNumber(
  waypoints: readonly number[],
  offset: number,
  total: number,
): number {
  const first = waypoints[0] ?? 0;
  if (waypoints.length <= 1 || total <= 1) return first;

  const t = offset / Math.max(1, total - 1);
  const maxSegment = waypoints.length - 1;
  const segmentPosition = t * maxSegment;
  const segmentIndex = Math.min(Math.floor(segmentPosition), maxSegment - 1);
  const segmentT = segmentPosition - segmentIndex;
  const start = waypoints[segmentIndex] ?? first;
  const end = waypoints[segmentIndex + 1] ?? first;
  return Number((start + segmentT * (end - start)).toPrecision(FAN_PRECISION));
}

/**
 * Returns the numeric value each of `count` ordered edit targets receives.
 * Fan input (`0>3`) is spread across the targets; any other input gives every
 * target the same `fallback` value.
 */
export function fannedNumbersForTargets(
  count: number,
  fallback: number,
  input: string | undefined,
): number[] {
  const waypoints = input === undefined ? null : parseNumericFanInput(input);
  return Array.from({ length: count }, (_, offset) =>
    waypoints ? resolveFanNumber(waypoints, offset, count) : fallback,
  );
}
