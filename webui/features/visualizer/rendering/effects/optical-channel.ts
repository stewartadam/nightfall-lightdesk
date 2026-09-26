// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  OpticalChannel,
  OpticalChannelSet,
  OpticalDmxProfile,
  OpticalFunction,
} from "../../../../types";

/** Reusable evaluation result, including explicit unsupported source semantics. */
export interface OpticalChannelState {
  function: OpticalFunction | undefined;
  set: OpticalChannelSet | undefined;
  physical: number | undefined;
  wheel: string | undefined;
  wheelSlot: number | undefined;
  status: "inactive" | "resolved" | "requires-profile" | "requires-mode-master";
}

/** Evaluates a sorted GDTF percentage curve in function-relative DMX space without allocations. */
function profilePhysical(
  curve: OpticalDmxProfile,
  fraction: number,
): number | undefined {
  if (
    !curve.points.length ||
    !Number.isFinite(curve.min) ||
    !Number.isFinite(curve.max)
  )
    return undefined;
  let low = 0;
  let high = curve.points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (curve.points[middle].dmxPercentage <= fraction * 100) low = middle + 1;
    else high = middle;
  }
  let percentage = 0;
  if (low > 0) {
    const point = curve.points[low - 1];
    const x = fraction * 100 - point.dmxPercentage;
    const [c0, c1, c2, c3] = point.coefficients;
    percentage = ((c3 * x + c2) * x + c1) * x + c0;
  }
  if (!Number.isFinite(percentage)) return undefined;
  return (
    curve.min +
    Math.min(1, Math.max(0, percentage / 100)) * (curve.max - curve.min)
  );
}

/** Allocates state once when the fixture's optical channels are compiled. */
export function createOpticalChannelState(): OpticalChannelState {
  return {
    function: undefined,
    set: undefined,
    physical: undefined,
    wheel: undefined,
    wheelSlot: undefined,
    status: "inactive",
  };
}

/** Finds the interval containing a DMX integer in a sorted source table. */
function intervalAt<T extends { dmxFrom: number; dmxTo: number }>(
  intervals: readonly T[],
  value: number,
): T | undefined {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const interval = intervals[middle];
    if (value < interval.dmxFrom) high = middle - 1;
    else if (value > interval.dmxTo) low = middle + 1;
    else return interval;
  }
  return undefined;
}

/** Evaluates source DMX intervals without allocating or confusing physical values with slot indices. */
export function evaluateOpticalChannel(
  channel: OpticalChannel,
  normalizedDmx: number | undefined,
  state: OpticalChannelState,
  masterValues?: ReadonlyMap<string, object>,
): void {
  state.function = undefined;
  state.set = undefined;
  state.physical = undefined;
  state.wheel = undefined;
  state.wheelSlot = undefined;
  state.status = "inactive";
  if (
    normalizedDmx === undefined ||
    !Number.isFinite(normalizedDmx) ||
    channel.dmxMax <= 0
  )
    return;
  const value = Math.round(
    Math.min(1, Math.max(0, normalizedDmx)) * channel.dmxMax,
  );
  let fn: OpticalFunction | undefined;
  for (const candidate of channel.functions) {
    if (candidate.dmxFrom > value) break;
    if (candidate.dmxTo < value) continue;
    if (candidate.modeMaster.type === "Unresolved") {
      state.function = candidate;
      state.status = "requires-mode-master";
      continue;
    }
    if (candidate.modeMaster.type === "Resolved") {
      const conditions = candidate.modeMaster.data;
      let missing = false;
      let inactive = false;
      for (const condition of conditions) {
        const values = masterValues?.get(condition.geometry) as
          | Record<string, unknown>
          | undefined;
        const normalized = values?.[condition.parameterKey];
        if (
          typeof normalized !== "number" ||
          !Number.isFinite(normalized) ||
          condition.dmxMax <= 0
        ) {
          missing = true;
          continue;
        }
        const masterDmx = Math.round(
          Math.min(1, Math.max(0, normalized)) * condition.dmxMax,
        );
        if (masterDmx < condition.dmxFrom || masterDmx > condition.dmxTo) {
          inactive = true;
          break;
        }
      }
      if (inactive) continue;
      if (missing) {
        state.function = candidate;
        state.status = "requires-mode-master";
        continue;
      }
    }
    fn = candidate;
    break;
  }
  if (!fn) return;
  state.function = fn;
  state.status = "inactive";
  if (fn.profile.type === "Unresolved") {
    state.status = "requires-profile";
    return;
  }
  const set = intervalAt(fn.sets, value);
  const interval = set ?? fn;
  const range = interval.dmxTo - interval.dmxFrom;
  const fraction = range > 0 ? (value - interval.dmxFrom) / range : 0;
  const physical =
    fn.profile.type === "Curve"
      ? profilePhysical(
          fn.profile.data,
          fn.dmxTo > fn.dmxFrom
            ? (value - fn.dmxFrom) / (fn.dmxTo - fn.dmxFrom)
            : 0,
        )
      : interval.physicalFrom +
        fraction * (interval.physicalTo - interval.physicalFrom);
  if (physical === undefined) {
    state.status = "requires-profile";
    return;
  }
  if (!Number.isFinite(physical)) return;
  state.set = set;
  state.physical = physical;
  state.wheel = fn.wheel;
  state.wheelSlot = set?.wheelSlot;
  state.status = "resolved";
}
