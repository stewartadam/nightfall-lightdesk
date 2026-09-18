// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CommandAutocompleteResponse } from "./wasm-bridge";

/** Maps native parser byte offsets to browser UTF-16 positions without splitting Unicode characters. */
export function commandOffsetMap(input: string) {
  const encoder = new TextEncoder();
  const toBytes = [0];
  const toCodeUnits = [0];
  let bytes = 0;
  let units = 0;
  for (const character of input) {
    const byteLength = encoder.encode(character).length;
    for (let index = 0; index < byteLength; index++)
      toCodeUnits[bytes + index] = units;
    for (let index = 0; index < character.length; index++)
      toBytes[units + index] = bytes;
    bytes += byteLength;
    units += character.length;
    toCodeUnits[bytes] = units;
    toBytes[units] = bytes;
  }
  return {
    /** Converts a browser cursor to the preceding complete UTF-8 character boundary. */
    toBytes: (offset: number) =>
      toBytes[Math.max(0, Math.min(units, Math.trunc(offset)))],
    /** Converts a parser location to the preceding complete browser character boundary. */
    toCodeUnits: (offset: number) =>
      toCodeUnits[Math.max(0, Math.min(bytes, Math.trunc(offset)))],
  };
}

/** Converts every UI-facing range in a parser response to the browser's string index convention. */
export function browserCommandOffsets(
  input: string,
  response: CommandAutocompleteResponse,
): CommandAutocompleteResponse {
  const offsets = commandOffsetMap(input);
  const segmentStart = offsets.toCodeUnits(response.segment_start);
  /** Converts a complete-input byte range to a browser text range. */
  const globalRange = (range: { start: number; end: number }) => ({
    start: offsets.toCodeUnits(range.start),
    end: offsets.toCodeUnits(range.end),
  });
  /** Keeps grammar spans relative to the active segment while changing their index units. */
  const localRange = (range: { start: number; end: number }) => ({
    start:
      offsets.toCodeUnits(response.segment_start + range.start) - segmentStart,
    end: offsets.toCodeUnits(response.segment_start + range.end) - segmentStart,
  });
  /** Preserves diagnostic evidence while translating its explicitly named source spans. */
  const diagnosticSpans = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(diagnosticSpans);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (
          key === "span" &&
          child &&
          typeof child === "object" &&
          "start" in child &&
          "end" in child &&
          typeof child.start === "number" &&
          typeof child.end === "number"
        )
          return [key, localRange({ start: child.start, end: child.end })];
        return [key, diagnosticSpans(child)];
      }),
    );
  };
  return {
    ...response,
    input_len: input.length,
    cursor: offsets.toCodeUnits(response.cursor),
    segment_start: segmentStart,
    segment_end: offsets.toCodeUnits(response.segment_end),
    replace: globalRange(response.replace),
    candidates: response.candidates.map((candidate) => ({
      ...candidate,
      replace: globalRange(candidate.replace),
    })),
    object_reference_requests: response.object_reference_requests.map(
      (request) => ({
        ...request,
        replace: globalRange(request.replace),
      }),
    ),
    parse: {
      ...response.parse,
      furthest_pos: offsets.toCodeUnits(response.parse.furthest_pos),
      frontier: {
        ...response.parse.frontier,
        alternatives: response.parse.frontier.alternatives.map(
          (alternative) => ({
            ...alternative,
            replace: localRange(alternative.replace),
          }),
        ),
      },
    },
    slot_plan: {
      ...response.slot_plan,
      filled: response.slot_plan.filled.map(diagnosticSpans),
      suppression: response.slot_plan.suppression.map(diagnosticSpans),
    },
  };
}
