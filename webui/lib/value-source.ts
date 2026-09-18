// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import type { ProcessedParameterValue } from "./datagrid";
import { parseParameterValue, resolveParameterValue } from "./utils";

export type ValueSourceEditParseResult =
  | { type: "Valid"; source: types.ValueSource }
  | { type: "Empty" }
  | { type: "Invalid" };
export type ValueSourceAssertionStyle = "absolute" | "relative";

/** Converts one parameter value between absolute and relative assertion styles. */
export function convertParameterValueAssertionStyle(
  value: types.ParameterValue,
  style: ValueSourceAssertionStyle,
): types.ParameterValue {
  switch (value.type) {
    case "Absolute":
    case "Relative": {
      const rawValue =
        value.type === "Absolute" ? value.data.value : value.data.offset;
      return style === "absolute"
        ? { type: "Absolute", data: { value: rawValue } }
        : { type: "Relative", data: { offset: rawValue } };
    }
    case "AbsolutePercent":
    case "RelativePercent": {
      const percentValue =
        value.type === "AbsolutePercent" ? value.data.value : value.data.offset;
      return style === "absolute"
        ? { type: "AbsolutePercent", data: { value: percentValue } }
        : { type: "RelativePercent", data: { offset: percentValue } };
    }
  }
}

/** Converts inline and fanned value sources between absolute and relative assertions. */
export function convertValueSourceAssertionStyle(
  source: types.ValueSource | undefined,
  style: ValueSourceAssertionStyle,
): types.ValueSource | undefined {
  if (source?.type === "Inline") {
    return {
      type: "Inline",
      data: convertParameterValueAssertionStyle(source.data, style),
    };
  }
  if (source?.type === "Fanned") {
    return {
      type: "Fanned",
      data: {
        values: source.data.values.map((value) =>
          convertParameterValueAssertionStyle(value, style),
        ),
      },
    };
  }
  return undefined;
}

/** Returns the assertion style requested by a marker-only edit. */
export function assertionStyleForMarkerEdit(
  input: string,
): ValueSourceAssertionStyle | undefined {
  const trimmed = input.trim();
  if (trimmed === "@") return "absolute";
  if (trimmed === "~") return "relative";
  return undefined;
}

/** Converts a parameter value into the processed grid value representation. */
export function parameterValueToProcessedParameterValue(
  value: types.ParameterValue,
): ProcessedParameterValue | undefined {
  const result = resolveParameterValue(value);
  if (result.value === null) return undefined;
  return {
    value: result.value,
    isPercentage: result.isPercentage,
    isRelative: result.isRelative,
  };
}

/** Converts a value source into the processed grid value representation. */
export function valueSourceToProcessedParameterValue(
  source: types.ValueSource,
): ProcessedParameterValue | undefined {
  if (source.type === "Inline") {
    return parameterValueToProcessedParameterValue(source.data);
  }
  if (source.type === "Release") {
    return { marker: "release", isPercentage: false, isRelative: false };
  }
  if (source.type === "HoldPosition") {
    return { marker: "hold", isPercentage: false, isRelative: false };
  }
  return undefined;
}

/** Parses an edited value-source cell while preserving empty input intent. */
export function parseValueSourceEditResult(
  input: string,
): ValueSourceEditParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { type: "Empty" };
  const marker = trimmed.toLowerCase();
  if (marker === "r") return { type: "Valid", source: { type: "Release" } };
  if (marker === "release") {
    return { type: "Valid", source: { type: "Release" } };
  }
  if (marker === "h") {
    return { type: "Valid", source: { type: "HoldPosition" } };
  }
  if (marker === "hold") {
    return { type: "Valid", source: { type: "HoldPosition" } };
  }
  if (marker.startsWith("b")) {
    const blockValue = trimmed.slice(1).trim();
    if (blockValue.length > 0) {
      const parsedBlockValue = parseParameterValue(blockValue);
      if (parsedBlockValue !== null) {
        return {
          type: "Valid",
          source: { type: "Inline", data: parsedBlockValue },
        };
      }
    }
  }

  const parsedValue = parseParameterValue(trimmed);
  if (parsedValue === null) return { type: "Invalid" };
  return { type: "Valid", source: { type: "Inline", data: parsedValue } };
}

/** Parses an edited value-source cell into the stored cue value source. */
export function parseValueSourceEdit(input: string): types.ValueSource | null {
  const result = parseValueSourceEditResult(input);
  return result.type === "Valid" ? result.source : null;
}

/** Interpolates two parameter values for fanned value-source resolution. */
function interpolateParameterValues(
  from: types.ParameterValue,
  to: types.ParameterValue,
  factor: number,
): types.ParameterValue {
  if (from.type !== to.type) return to;

  switch (from.type) {
    case "AbsolutePercent": {
      const toValue = to as Extract<
        types.ParameterValue,
        { type: "AbsolutePercent" }
      >;
      return {
        type: "AbsolutePercent",
        data: {
          value: Math.min(
            1,
            Math.max(
              0,
              from.data.value + (toValue.data.value - from.data.value) * factor,
            ),
          ),
        },
      };
    }
    case "Absolute": {
      const toValue = to as Extract<types.ParameterValue, { type: "Absolute" }>;
      return {
        type: "Absolute",
        data: {
          value: Math.round(
            from.data.value + (toValue.data.value - from.data.value) * factor,
          ),
        },
      };
    }
    case "RelativePercent": {
      const toValue = to as Extract<
        types.ParameterValue,
        { type: "RelativePercent" }
      >;
      return {
        type: "RelativePercent",
        data: {
          offset:
            from.data.offset +
            (toValue.data.offset - from.data.offset) * factor,
        },
      };
    }
    case "Relative": {
      const toValue = to as Extract<types.ParameterValue, { type: "Relative" }>;
      return {
        type: "Relative",
        data: {
          offset:
            from.data.offset +
            (toValue.data.offset - from.data.offset) * factor,
        },
      };
    }
  }
}

/** Resolves the concrete parameter value contributed by one value source. */
export function parameterValueForValueSource(
  source: types.ValueSource,
  selectionIndex: number,
  selectionSize: number,
): types.ParameterValue | undefined {
  if (source.type === "Inline") return source.data;
  if (source.type !== "Fanned") return undefined;

  const values = source.data.values;
  if (values.length === 0) return undefined;
  if (values.length === 1 || selectionSize <= 1) return values[0];

  if (values.length === selectionSize) return values[selectionIndex];

  const position = selectionIndex / (selectionSize - 1);
  const segmentCount = values.length - 1;
  const scaledPosition = position * segmentCount;
  const lower = Math.floor(scaledPosition);
  const upper = Math.min(lower + 1, values.length - 1);
  return interpolateParameterValues(
    values[lower],
    values[upper],
    scaledPosition - lower,
  );
}
