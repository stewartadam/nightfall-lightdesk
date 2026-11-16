// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "./logger";
import { loadedWasmBridge, loadWasmBridge } from "./wasm-module";

const log = getLogger(import.meta.url);

// Load the bridge up front so fanned edits resolve synchronously by the time anyone types one.
loadWasmBridge().catch((error: unknown) => {
  log.error("Failed to load the WASM bridge for fan edits", { error });
});

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
 * Spreads fan waypoints across `total` evenly spaced targets with the engine's
 * fan rules, so a fanned cell edit lands on the values a command-line fan
 * would. Returns null while the WASM bridge is still loading.
 */
export function fanNumbers(
  waypoints: readonly number[],
  total: number,
): number[] | null {
  const wasm = loadedWasmBridge();
  if (!wasm) {
    log.warn("Fan edit ignored because the WASM bridge has not loaded yet");
    return null;
  }
  return Array.from(
    wasm.fan_numbers(Float64Array.from(waypoints), Math.max(0, total)),
    (value) => Number(value.toPrecision(FAN_PRECISION)),
  );
}

/**
 * Spreads fan waypoints across target cells, giving each cell its value in the
 * returned array. Cells are fanned per column in the order given, so a range
 * covering several columns fans each column from the first to the last
 * waypoint independently. Returns null while the WASM bridge is still loading.
 */
export function fanNumbersByColumn(
  cells: readonly (readonly [col: number, row: number])[],
  waypoints: readonly number[],
): number[] | null {
  const columnCounts = new Map<number, number>();
  for (const [col] of cells) {
    columnCounts.set(col, (columnCounts.get(col) ?? 0) + 1);
  }

  const valuesByColumn = new Map<number, number[]>();
  for (const [col, count] of columnCounts) {
    const values = fanNumbers(waypoints, count);
    if (!values) return null;
    valuesByColumn.set(col, values);
  }

  const columnOffsets = new Map<number, number>();
  return cells.map(([col]) => {
    const offset = columnOffsets.get(col) ?? 0;
    columnOffsets.set(col, offset + 1);
    return valuesByColumn.get(col)?.[offset] ?? waypoints[0] ?? 0;
  });
}
