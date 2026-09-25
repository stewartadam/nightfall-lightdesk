// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OutboundParameterState, ParameterValue } from "../types";

/** Numeric parameter snapshots cross the worker boundary without cloning thousands of nested objects. */
export interface PackedParameterState {
  fixtureUids: string[];
  attributes: string[];
  values: Float64Array;
}

const kinds = [
  "Absolute",
  "AbsolutePercent",
  "Relative",
  "RelativePercent",
] as const;

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

/** Encodes a complete snapshot, preserving double precision and all asserted parameter variants. */
export function packParameterState(
  states: OutboundParameterState[],
): PackedParameterState {
  const attributes: string[] = [];
  const indices = new Map<string, number>();
  const values: number[] = [];
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
    const entries = Object.entries(assertions);
    values.push(entries.length);
    for (const [name, value] of entries) {
      values.push(
        attributeIndex(name),
        kinds.indexOf(value.type),
        "value" in value.data ? value.data.value : value.data.offset,
      );
    }
  }
  for (const fixture of states) {
    values.push(fixture.parameters.length);
    for (const element of fixture.parameters) {
      const outputs = Object.entries(element.output);
      values.push(outputs.length);
      for (const [name, value] of outputs)
        values.push(attributeIndex(name), value);
      appendAssertions(element.absolute);
      appendAssertions(element.relative);
    }
  }
  return {
    fixtureUids: states.map((fixture) => fixture.fixture_uid),
    attributes,
    values: new Float64Array(values),
  };
}

/** Restores the existing public parameter shape after the numeric buffer transfers ownership. */
export function unpackParameterState(
  packed: PackedParameterState,
): OutboundParameterState[] {
  const { values, attributes } = packed;
  let cursor = 0;
  /** Reads a counted assertion map, retaining whether its numeric field is a value or offset. */
  function readAssertions(): Record<string, ParameterValue> {
    const result: Record<string, ParameterValue> = {};
    const count = values[cursor++];
    for (let i = 0; i < count; i++) {
      const name = attributes[values[cursor++]];
      const kind = values[cursor++];
      const value = values[cursor++];
      setAttribute(
        result,
        name,
        (kind < 2
          ? { type: kinds[kind], data: { value } }
          : { type: kinds[kind], data: { offset: value } }) as ParameterValue,
      );
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
