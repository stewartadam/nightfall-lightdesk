// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parameterDmxBreak } from "../../../lib/dmx";
import type * as types from "../../../types";

/** One attribute of a patched fixture with the output offset its DMX parameters apply. */
export interface OutputOffsetRow {
  /** Stable key and display name of the attribute. */
  label: string;
  /** Attribute the offset command targets. */
  attribute: types.Attribute;
  /** Offset as a percentage of the parameter's range, rounded to two decimals. */
  percent: number;
}

/** Returns the display name of an attribute, using a custom attribute's own label. */
function attributeLabel(attribute: types.Attribute): string {
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/**
 * Converts a stored offset to a percentage of the parameter's range. Raw offsets are in the
 * parameter's DMX units, so they scale by its range like the engine does when it applies them.
 */
export function offsetPercent(parameter: types.ParameterMetadata): number {
  const offset = parameter.offset;
  let fraction: number;
  switch (offset.type) {
    case "AbsolutePercent":
      fraction = offset.data.value;
      break;
    case "RelativePercent":
      fraction = offset.data.offset;
      break;
    case "Absolute": {
      const range = parameter.max - parameter.min;
      fraction = range === 0 ? 0 : offset.data.value / range;
      break;
    }
    case "Relative": {
      const range = parameter.max - parameter.min;
      fraction = range === 0 ? 0 : offset.data.offset / range;
      break;
    }
  }
  return Math.round(fraction * 10_000) / 100;
}

/**
 * Lists the offsettable attributes of a fixture in profile order, once each. The engine sets an
 * attribute's offset on every element at once, so the first element that has it supplies the
 * shown value. Virtual parameters have no DMX output to calibrate and are left out.
 */
export function fixtureOutputOffsetRows(
  fixture: types.Fixture,
): OutputOffsetRow[] {
  const rows = new Map<string, OutputOffsetRow>();
  for (const element of fixture.elements) {
    for (const parameter of element.parameters) {
      if (parameterDmxBreak(parameter) === null) continue;
      const label = attributeLabel(parameter.attribute);
      if (rows.has(label)) continue;
      rows.set(label, {
        label,
        attribute: parameter.attribute,
        percent: offsetPercent(parameter),
      });
    }
  }
  return [...rows.values()];
}

/** Builds the command that sets one attribute's output offset on a fixture, in percent. */
export function outputOffsetCommand(
  fixtureId: number,
  attribute: types.Attribute,
  percent: number,
): types.FixtureCommand {
  return {
    type: "UpdateFixtureParameterOffset",
    data: {
      id: fixtureId,
      attribute,
      offset:
        percent === 0
          ? { type: "Absolute", data: { value: 0 } }
          : { type: "AbsolutePercent", data: { value: percent / 100 } },
    },
  };
}
