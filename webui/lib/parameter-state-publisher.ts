// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type ElementParameterRow,
  type ParameterOutputMap,
  type ParameterRow,
  parameters,
  parameterUpdateTimestamp,
  setParametersImmediate,
} from "../state/appStores";
import type * as types from "../types";
import { setStoreAction } from "./nanostore-action";
import { outputValuesConflict } from "./parameter-conflicts";
import {
  measureNextAnimationFrame,
  measurePerformanceScope,
} from "./performance-marks";
import type { ElementParameterState, FixtureParameterState } from "./ws/types";

const REACTIVE_PARAMETER_STATE_INTERVAL_MS = 50;

/** Visualizer outputs of one fixture, with the decoded state they were built from. */
interface ImmediateFixtureOutput {
  source: FixtureParameterState;
  elements: Record<string, number>[];
}

/** Outputs published by the last {@link updateImmediateParams}, keyed by fixture UID. */
let previousImmediateOutputs = new Map<string, ImmediateFixtureOutput>();
let pendingReactiveParameterState: FixtureParameterState[] | null = null;
let reactiveParameterStateTimer: ReturnType<typeof setTimeout> | null = null;
let lastReactiveParameterStateFlushMs = 0;
let previousParameterRows = new Map<string, ParameterRow>();
/** Decoded state each of {@link previousParameterRows} was built from, keyed by fixture UID. */
let previousParameterSources = new Map<string, FixtureParameterState>();

/**
 * Extract and update the immediate parameter output map synchronously.
 * Called when ParameterState arrives so visualizer has fresh DMX data.
 */
export function updateImmediateParams(rawData: FixtureParameterState[]) {
  const outputMap: ParameterOutputMap = new Map();
  const outputs = new Map<string, ImmediateFixtureOutput>();
  for (const item of rawData) {
    const previous = previousImmediateOutputs.get(item.fixture_uid);
    // The decoder returns unchanged fixtures as the same object, so their outputs keep their
    // identity and the visualizer can skip them.
    const output =
      previous?.source === item
        ? previous
        : {
            source: item,
            elements: item.parameters.map((ps) =>
              visualizerOutputForElement(ps),
            ),
          };
    outputMap.set(item.fixture_uid, output.elements);
    outputs.set(item.fixture_uid, output);
  }
  previousImmediateOutputs = outputs;
  setParametersImmediate(outputMap);
}

/**
 * Builds the visualizer-facing output for one element.
 *
 * Pan and tilt output defaults are always present in backend ParameterState even
 * when no object asserts movement. The visualizer needs absence to mean neutral
 * load pose, so only forward pan/tilt when absolute or relative state asserts it.
 */
function visualizerOutputForElement(
  state: ElementParameterState,
): Record<string, number> {
  if (!("Pan" in state.output) && !("Tilt" in state.output)) {
    return state.output;
  }

  const output = { ...state.output };
  if (!("Pan" in state.absolute) && !("Pan" in state.relative)) {
    delete output.Pan;
  }
  if (!("Tilt" in state.absolute) && !("Tilt" in state.relative)) {
    delete output.Tilt;
  }
  return output;
}

/** Clears pending reactive parameter state without publishing it to UI stores. */
export function resetReactiveParameterStateQueue(): void {
  if (reactiveParameterStateTimer !== null) {
    clearTimeout(reactiveParameterStateTimer);
    reactiveParameterStateTimer = null;
  }
  pendingReactiveParameterState = null;
  lastReactiveParameterStateFlushMs = 0;
  previousParameterRows = new Map<string, ParameterRow>();
  previousParameterSources = new Map<string, FixtureParameterState>();
}

/** Publishes the latest queued parameter state to reactive UI stores. */
function flushReactiveParameterState(): void {
  if (reactiveParameterStateTimer !== null) {
    clearTimeout(reactiveParameterStateTimer);
    reactiveParameterStateTimer = null;
  }

  const rawData = pendingReactiveParameterState;
  pendingReactiveParameterState = null;
  if (!rawData) return;

  lastReactiveParameterStateFlushMs = performance.now();
  setStoreAction(
    parameterUpdateTimestamp,
    "Receive ParameterState Timestamp",
    Date.now(),
  );
  const paramMap = measurePerformanceScope(
    "websocket-main.parameter-state.process",
    () => processParameterState(rawData),
    { fixtureCount: rawData.length },
  );
  measurePerformanceScope(
    "websocket-main.parameter-state.store-set",
    () => setStoreAction(parameters, "Receive ParameterState", paramMap),
    { fixtureCount: rawData.length },
  );
  measureNextAnimationFrame("websocket-main.parameter-state.next-frame", {
    fixtureCount: rawData.length,
  });
}

/** Schedules the next reactive parameter state flush after the throttle window. */
function scheduleReactiveParameterStateFlush(delayMs: number): void {
  if (reactiveParameterStateTimer !== null) return;
  reactiveParameterStateTimer = setTimeout(
    flushReactiveParameterState,
    Math.max(0, delayMs),
  );
}

/** Queues the newest parameter state and throttles reactive store notification. */
export function queueReactiveParameterState(
  rawData: FixtureParameterState[],
): void {
  pendingReactiveParameterState = rawData;
  const nowMs = performance.now();
  const elapsedMs = nowMs - lastReactiveParameterStateFlushMs;
  if (elapsedMs >= REACTIVE_PARAMETER_STATE_INTERVAL_MS) {
    flushReactiveParameterState();
    return;
  }
  scheduleReactiveParameterStateFlush(
    REACTIVE_PARAMETER_STATE_INTERVAL_MS - elapsedMs,
  );
}

/** Returns whether two optional record objects expose the same key/value pairs. */
function recordsEqual<T>(
  left: Record<string, T> | undefined,
  right: Record<string, T> | undefined,
  valueEqual: (leftValue: T, rightValue: T) => boolean,
): boolean {
  if (left === right) return true;
  const leftRecord = left ?? {};
  const rightRecord = right ?? {};
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;

  for (const key of leftKeys) {
    if (!(key in rightRecord)) return false;
    if (!valueEqual(leftRecord[key]!, rightRecord[key]!)) return false;
  }
  return true;
}

/** Returns whether two parameter values resolve to the same serialized payload. */
function parameterValuesEqual(
  left: types.ParameterValue,
  right: types.ParameterValue,
): boolean {
  if (left === right) return true;
  if (left.type !== right.type) return false;

  switch (left.type) {
    case "Absolute":
      return right.type === "Absolute" && left.data.value === right.data.value;
    case "AbsolutePercent":
      return (
        right.type === "AbsolutePercent" && left.data.value === right.data.value
      );
    case "Relative":
      return (
        right.type === "Relative" && left.data.offset === right.data.offset
      );
    case "RelativePercent":
      return (
        right.type === "RelativePercent" &&
        left.data.offset === right.data.offset
      );
  }
}

/** Returns whether two optional conflict sets contain the same attributes. */
function conflictSetsEqual(
  left: Set<string> | undefined,
  right: Set<string> | undefined,
): boolean {
  if (left === right) return true;
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  for (const value of left ?? []) {
    if (!right?.has(value)) return false;
  }
  return true;
}

/** Returns whether two processed element rows have identical display data. */
function elementParameterRowsEqual(
  left: ElementParameterRow,
  right: ElementParameterRow,
): boolean {
  return (
    left.elementIndex === right.elementIndex &&
    left.color === right.color &&
    recordsEqual(left.raw, right.raw, Object.is) &&
    recordsEqual(left.absolute, right.absolute, parameterValuesEqual) &&
    recordsEqual(left.relative, right.relative, parameterValuesEqual)
  );
}

/** Returns whether two processed fixture parameter rows have identical display data. */
function parameterRowsEqual(left: ParameterRow, right: ParameterRow): boolean {
  if (
    left.uid !== right.uid ||
    left.color !== right.color ||
    !recordsEqual(left.raw, right.raw, Object.is) ||
    !recordsEqual(left.absolute, right.absolute, parameterValuesEqual) ||
    !recordsEqual(left.relative, right.relative, parameterValuesEqual) ||
    !conflictSetsEqual(left.conflicts, right.conflicts)
  ) {
    return false;
  }

  const leftElements = left.elements ?? [];
  const rightElements = right.elements ?? [];
  return (
    leftElements.length === rightElements.length &&
    leftElements.every((element, index) =>
      elementParameterRowsEqual(element, rightElements[index]!),
    )
  );
}

/**
 * Process raw parameter state into a Map for reactive UI panels.
 * Aggregates per-element data and detects conflicts.
 */
function processParameterState(
  rawData: FixtureParameterState[],
): Map<string, ParameterRow> {
  const paramMap = new Map<string, ParameterRow>();
  const sources = new Map<string, FixtureParameterState>();
  for (const item of rawData) {
    const uid = item.fixture_uid;
    const elementStates = item.parameters;
    sources.set(uid, item);
    // The decoder returns unchanged fixtures as the same object, whose row cannot have changed.
    const unchangedRow =
      previousParameterSources.get(uid) === item
        ? previousParameterRows.get(uid)
        : undefined;
    if (unchangedRow) {
      paramMap.set(uid, unchangedRow);
      continue;
    }

    // Track conflicts: attribute -> element output values
    const conflictTracker: Record<string, number[]> = {};
    const mergedOutput: Record<string, number> = {};
    const mergedAbsolute: Record<string, types.ParameterValue> = {};
    const mergedRelative: Record<string, types.ParameterValue> = {};

    // Build per-element data
    const elements: ElementParameterRow[] = elementStates.map(
      (elementState, idx) => {
        // Track conflicts for output values
        for (const [attr, value] of Object.entries(elementState.output)) {
          conflictTracker[attr] ??= [];
          conflictTracker[attr].push(value);
        }

        // Calculate element color
        const red = Math.round(elementState.output.Red ?? 0);
        const green = Math.round(elementState.output.Green ?? 0);
        const blue = Math.round(elementState.output.Blue ?? 0);

        return {
          elementIndex: idx + 1, // 1-based
          color: `rgb(${red}, ${green}, ${blue})`,
          raw: elementState.output,
          absolute: elementState.absolute,
          relative: elementState.relative,
        };
      },
    );

    // Aggregate: use last element's value for conflicts (Object.assign behavior)
    for (const elementState of elementStates) {
      Object.assign(mergedOutput, elementState.output);
      Object.assign(mergedAbsolute, elementState.absolute);
      Object.assign(mergedRelative, elementState.relative);
    }

    // Identify conflicts whose element outputs differ beyond display tolerance.
    const conflicts = new Set<string>();
    for (const [attr, values] of Object.entries(conflictTracker)) {
      if (outputValuesConflict(values)) {
        conflicts.add(attr);
      }
    }

    // Calculate aggregated color
    const red = Math.round(mergedOutput.Red ?? 0);
    const green = Math.round(mergedOutput.Green ?? 0);
    const blue = Math.round(mergedOutput.Blue ?? 0);

    const nextRow: ParameterRow = {
      uid,
      color: `rgb(${red}, ${green}, ${blue})`,
      raw: mergedOutput,
      absolute: mergedAbsolute,
      relative: mergedRelative,
      elements: elements.length > 1 ? elements : undefined,
      conflicts: conflicts.size > 0 ? conflicts : undefined,
    };
    const previousRow = previousParameterRows.get(uid);
    paramMap.set(
      uid,
      previousRow && parameterRowsEqual(previousRow, nextRow)
        ? previousRow
        : nextRow,
    );
  }
  previousParameterRows = paramMap;
  previousParameterSources = sources;
  return paramMap;
}
