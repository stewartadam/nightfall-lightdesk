// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OutboundParameterState, ParameterValue } from "../types";
import type { AnyWsMessage } from "./ws/types";

/** Numeric parameter snapshots cross the worker boundary without cloning thousands of nested objects. */
export interface PackedParameterState {
  fixtureUids: string[];
  attributes: string[];
  values: Float64Array;
}

type ParameterValueType = ParameterValue["type"];

/**
 * Numeric field each assertion variant carries. Keyed by every variant so a new
 * backend variant fails type checking here instead of decoding incorrectly.
 */
const PARAMETER_VALUE_FIELDS: Record<ParameterValueType, "value" | "offset"> = {
  Absolute: "value",
  AbsolutePercent: "value",
  Relative: "offset",
  RelativePercent: "offset",
};
/** Wire code of each variant is its index in this list. */
const PARAMETER_VALUE_TYPES = Object.keys(
  PARAMETER_VALUE_FIELDS,
) as ParameterValueType[];

/** Preserves normal object shapes while treating imported prototype-like names as data. */
function setAttribute<T>(
  target: Record<string, T>,
  name: string,
  value: T,
): void {
  if (name === "__proto__") {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[name] = value;
  }
}

/** Counts a plain map's own enumerable keys without allocating an entries array. */
function keyCount(map: object): number {
  let count = 0;
  for (const _ in map) count++;
  return count;
}

/** Returns how many numbers a snapshot encodes to, so packing fills one exact-size buffer. */
function packedLength(states: OutboundParameterState[]): number {
  let length = 0;
  for (const fixture of states) {
    length += 1;
    for (const element of fixture.parameters) {
      length +=
        3 +
        2 * keyCount(element.output) +
        3 * keyCount(element.absolute) +
        3 * keyCount(element.relative);
    }
  }
  return length;
}

/** Encodes a complete snapshot, preserving double precision and all asserted parameter variants. */
export function packParameterState(
  states: OutboundParameterState[],
): PackedParameterState {
  const attributes: string[] = [];
  const indices = new Map<string, number>();
  const values = new Float64Array(packedLength(states));
  let cursor = 0;
  /** Interns repeated attribute names across every fixture and element in this snapshot. */
  function attributeIndex(name: string): number {
    let index = indices.get(name);
    if (index === undefined) {
      index = attributes.length;
      attributes.push(name);
      indices.set(name, index);
    }
    return index;
  }
  /** Appends a counted set of asserted values in their original property order. */
  function appendAssertions(assertions: Record<string, ParameterValue>): void {
    values[cursor++] = keyCount(assertions);
    for (const name in assertions) {
      const assertion = assertions[name];
      const field = PARAMETER_VALUE_FIELDS[assertion.type];
      values[cursor++] = attributeIndex(name);
      values[cursor++] = PARAMETER_VALUE_TYPES.indexOf(assertion.type);
      values[cursor++] = (assertion.data as Record<typeof field, number>)[
        field
      ];
    }
  }
  for (const fixture of states) {
    values[cursor++] = fixture.parameters.length;
    for (const element of fixture.parameters) {
      values[cursor++] = keyCount(element.output);
      for (const name in element.output) {
        values[cursor++] = attributeIndex(name);
        values[cursor++] = element.output[name];
      }
      appendAssertions(element.absolute);
      appendAssertions(element.relative);
    }
  }
  return {
    fixtureUids: states.map((fixture) => fixture.fixture_uid),
    attributes,
    values,
  };
}

/** Restores the existing public parameter shape after the numeric buffer transfers ownership. */
export function unpackParameterState(
  packed: PackedParameterState,
): OutboundParameterState[] {
  const { values, attributes } = packed;
  let cursor = 0;
  /** Reads a counted assertion map, restoring each variant's value or offset field. */
  function readAssertions(): Record<string, ParameterValue> {
    const result: Record<string, ParameterValue> = {};
    const count = values[cursor++];
    for (let i = 0; i < count; i++) {
      const name = attributes[values[cursor++]];
      const type = PARAMETER_VALUE_TYPES[values[cursor++]];
      const value = values[cursor++];
      setAttribute(result, name, {
        type,
        data: { [PARAMETER_VALUE_FIELDS[type]]: value },
      } as ParameterValue);
    }
    return result;
  }
  return packed.fixtureUids.map((fixture_uid) => {
    const count = values[cursor++];
    const parameters: OutboundParameterState["parameters"] = [];
    for (let i = 0; i < count; i++) {
      const output: Record<string, number> = {};
      const outputCount = values[cursor++];
      for (let j = 0; j < outputCount; j++) {
        const name = attributes[values[cursor++]];
        setAttribute(output, name, values[cursor++]);
      }
      parameters.push({
        output,
        absolute: readAssertions(),
        relative: readAssertions(),
      });
    }
    return { fixture_uid, parameters };
  });
}

/** One websocket payload the runtime worker queued for the main thread. */
export interface WorkerQueuedMessage {
  data?: AnyWsMessage;
  packedParameters?: PackedParameterState;
  postedAtMs?: unknown;
  deliveryMessageId?: unknown;
}

/** Returns whether a queued worker message carries a parameter snapshot, packed or not. */
export function carriesParameterState(message: unknown): boolean {
  const queued = message as WorkerQueuedMessage | undefined;
  return (
    queued?.data?.type === "ParameterState" ||
    queued?.packedParameters !== undefined
  );
}

/** Returns the websocket message a queued worker message delivers, unpacking transferred snapshots. */
export function queuedWorkerMessageData(
  message: WorkerQueuedMessage,
): AnyWsMessage | undefined {
  if (!message.packedParameters) return message.data;
  return {
    type: "ParameterState",
    data: unpackParameterState(message.packedParameters),
  } as AnyWsMessage;
}
