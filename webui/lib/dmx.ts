// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";
import { DmxValueResolution } from "../types/index";

/**
 * Get the number of DMX channels a resolution occupies.
 */
export function getResolutionChannelWidth(
  resolution: types.DmxValueResolution,
): number {
  switch (resolution) {
    case DmxValueResolution.Fine:
      return 2;
    case DmxValueResolution.UltraFine:
      return 3;
    case DmxValueResolution.Uber:
      return 4;
    default:
      return 1;
  }
}

/** Byte placement of one fixture parameter within a laid-out DMX footprint. */
export type PlacedParameter = {
  /** Zero-based element index within the fixture. */
  elementIndex: number;
  /** Zero-based parameter index within the element. */
  parameterIndex: number;
  /** Zero-based footprint slot of every byte, most significant first. */
  slots: number[];
};

/** Result of laying out the parameters a patch selects from a fixture. */
export type FixtureWireLayout = {
  /** Parameters that occupy DMX slots, in fixture DMX order. */
  parameters: PlacedParameter[];
  /** Number of slots from the first slot through the highest used slot. */
  footprint: number;
};

/**
 * Returns the DMX break a parameter writes bytes to, or null for virtual parameters.
 * Sequential parameters always belong to the primary break 1.
 */
export function parameterDmxBreak(
  parameter: types.ParameterMetadata,
): number | null {
  if (parameter.attribute.type === "VirtualIntensity") return null;
  const slots = parameter.dmx_slots;
  if (!slots || slots.type === "Sequential") return 1;
  if (slots.type === "Explicit") return slots.data.dmx_break;
  return null;
}

/**
 * Lays out a fixture's parameters the same way the engine's `WireLayout` does.
 *
 * Only parameters on `dmxBreak` (default 1) are laid out; each break has its
 * own start address. Sequential parameters pack after the highest slot used
 * so far; explicit parameters use their declared 1-based offsets. When the
 * selection is partial (one element or one parameter), slots are rebased so
 * the first selected byte lands on the patch address.
 */
export function fixtureWireLayout(
  fixture: types.Fixture,
  options: {
    elementId?: number;
    includeParameter?: (parameter: types.ParameterMetadata) => boolean;
    dmxBreak?: number;
  } = {},
): FixtureWireLayout {
  const { elementId, includeParameter, dmxBreak = 1 } = options;
  const elementIndices =
    elementId && elementId > 0
      ? [elementId - 1].filter((index) => index < fixture.elements.length)
      : fixture.elements.map((_, index) => index);

  const parameters: PlacedParameter[] = [];
  let nextFree = 0;
  for (const elementIndex of elementIndices) {
    const element = fixture.elements[elementIndex];
    element.parameters.forEach((parameter, parameterIndex) => {
      if (parameterDmxBreak(parameter) !== dmxBreak) return;
      if (includeParameter && !includeParameter(parameter)) return;
      const width = getResolutionChannelWidth(parameter.resolution);
      let slots: number[];
      const placement = parameter.dmx_slots;
      if (placement?.type === "Explicit" && placement.data.offsets.length > 0) {
        slots = placement.data.offsets
          .slice(0, width)
          .map((offset) => Math.max(offset - 1, 0));
        while (slots.length < width) {
          slots.push((slots[slots.length - 1] ?? 0) + 1);
        }
      } else {
        slots = Array.from({ length: width }, (_, byte) => nextFree + byte);
      }
      nextFree = Math.max(nextFree, Math.max(...slots) + 1);
      parameters.push({ elementIndex, parameterIndex, slots });
    });
  }

  const partial =
    Boolean(elementId && elementId > 0) || Boolean(includeParameter);
  const allSlots = parameters.flatMap((parameter) => parameter.slots);
  if (partial && allSlots.length > 0) {
    const min = Math.min(...allSlots);
    for (const parameter of parameters) {
      parameter.slots = parameter.slots.map((slot) => slot - min);
    }
  }
  const footprint =
    allSlots.length === 0
      ? 0
      : Math.max(...parameters.flatMap((parameter) => parameter.slots)) + 1;
  return { parameters, footprint };
}
