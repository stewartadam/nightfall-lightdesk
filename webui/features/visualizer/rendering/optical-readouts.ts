// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Numeric readouts of evaluated optical channels.
 *
 * Renderers receive each element's DMX as a flat numeric record (so it can
 * cross into the render worker), but optical controls such as gobo, prism,
 * zoom and focus need the profile function and channel set the fixture
 * selected, not a normalized level. The evaluator reports those as indices
 * into the parameter's own metadata, which this module writes into the record
 * and the aperture's optical state resolves back against the same metadata.
 */

import type { FixtureElement, ParameterMetadata } from "../../../types";
import type { EvaluatedChannel } from "./channel-evaluation";
import { attributeOutputKey } from "./channel-evaluation";

/** Record keys of one optical parameter's evaluated function, set and physical value. */
export interface OpticalReadoutKeys {
  /** Index of the active function in `parameter.functions`, or -1 when none is active. */
  readonly function: string;
  /** Index of the active set in the active function's `sets`, or -1 when none is active. */
  readonly set: string;
  /** Physical value of the active function (or set) in its `physical_unit`. */
  readonly physical: string;
}

/** Readout keys per element, aligned with `element.parameters`. */
const readoutKeysCache = new WeakMap<
  FixtureElement,
  (OpticalReadoutKeys | undefined)[]
>();

/** Returns whether the backend classified any of a parameter's profile functions as optical. */
export function isOpticalParameter(parameter: ParameterMetadata): boolean {
  return (parameter.functions ?? []).some((fn) => fn.optical !== undefined);
}

/**
 * Returns the record keys under which each optical parameter of an element
 * publishes its evaluated channel, aligned with `element.parameters`;
 * parameters without optical functions have no keys. Computed once per
 * element object so the render loop does not build strings.
 */
export function opticalReadoutKeys(
  element: FixtureElement,
): readonly (OpticalReadoutKeys | undefined)[] {
  let keys = readoutKeysCache.get(element);
  if (!keys) {
    keys = element.parameters.map((parameter) => {
      if (!isOpticalParameter(parameter)) return undefined;
      const key = attributeOutputKey(parameter.attribute);
      return {
        function: `${key}.function`,
        set: `${key}.set`,
        physical: `${key}.physical`,
      };
    });
    readoutKeysCache.set(element, keys);
  }
  return keys;
}

/**
 * Writes the active function, set and physical value of an element's optical
 * channels into its visualizer record. Channels without output publish
 * nothing, so an aperture reads them as absent rather than as an open slot.
 */
export function writeOpticalReadouts(
  element: FixtureElement,
  channels: readonly (EvaluatedChannel | undefined)[],
  record: Record<string, number>,
): void {
  const keys = opticalReadoutKeys(element);
  for (let index = 0; index < keys.length; index++) {
    const readout = keys[index];
    const channel = channels[index];
    if (!readout || !channel) continue;
    record[readout.function] = channel.functionIndex;
    record[readout.set] = channel.setIndex;
    record[readout.physical] = channel.physical;
  }
}
