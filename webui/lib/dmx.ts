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
 * Hardware wiring order of fixture layouts whose DMX element order differs from their
 * logical element order. Mirrors `FixtureLayout::dmx_element_order` in
 * `crates/fixtures/src/fixture.rs`; both are pinned by
 * `crates/fixtures/tests/data/fixture_layout_dmx_element_order.json`.
 */
const FIXTURE_LAYOUT_DMX_ELEMENT_ORDER: Partial<
  Record<`${types.FixtureLayout}`, () => number[]>
> = {
  "rgb-strobe-bar": () => [
    ...inclusiveRange(48, 25),
    ...inclusiveRange(49, 72),
    ...inclusiveRange(24, 1),
  ],
  "rotating-wash-beam": () => [
    1,
    ...inclusiveRange(13, 2),
    ...inclusiveRange(14, 37),
  ],
};

/** Returns the integers from `from` to `to` inclusive, counting down when `to < from`. */
function inclusiveRange(from: number, to: number): number[] {
  const step = to < from ? -1 : 1;
  const values: number[] = [];
  for (let value = from; value !== to + step; value += step) {
    values.push(value);
  }
  return values;
}

/**
 * Returns a fixture's 1-based element IDs in the order its hardware consumes DMX channels.
 *
 * Whole-fixture layouts place elements in this order: declaration order for most fixtures,
 * or the physical wiring sequence of layouts such as the RGB strobe bar and rotating wash
 * beam, matching the engine's `FixtureLayout::dmx_element_order`.
 */
export function fixtureElementIdsInDmxOrder(fixture: types.Fixture): number[] {
  const wiringOrder = fixture.layout
    ? FIXTURE_LAYOUT_DMX_ELEMENT_ORDER[fixture.layout]
    : undefined;
  if (wiringOrder) return wiringOrder();
  return fixture.elements.map((_, index) => index + 1);
}

/** Normalizes a parameter or filter name for case-insensitive attribute matching. */
export function normalizeParameterName(value: string): string {
  return value.trim().toLowerCase();
}

/** Returns the attribute name a patch parameter filter matches against. */
function parameterAttributeName(parameter: types.ParameterMetadata): string {
  const { attribute } = parameter;
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/**
 * Returns the indices of the element parameters a layout selects: every parameter, or the
 * first one whose attribute matches `parameterName`, mirroring the engine resolving one
 * parameter per element for a binding's parameter filter.
 */
function selectedParameterIndices(
  element: types.FixtureElement,
  parameterName: string | undefined,
): number[] {
  if (parameterName === undefined) {
    return element.parameters.map((_, index) => index);
  }
  const index = element.parameters.findIndex(
    (parameter) =>
      normalizeParameterName(parameterAttributeName(parameter)) ===
      parameterName,
  );
  return index < 0 ? [] : [index];
}

/**
 * Lays out a fixture's parameters the same way the engine's `WireLayout` does.
 *
 * Elements follow the fixture's DMX wiring order. Only parameters on `dmxBreak` (default 1)
 * are laid out; each break has its own start address. Sequential parameters pack after the
 * highest slot used so far; explicit parameters use their declared 1-based offsets. When
 * the selection is partial (one element or one parameter per element), slots are rebased
 * so the first selected byte lands on the patch address.
 */
export function fixtureWireLayout(
  fixture: types.Fixture,
  options: {
    /** 1-based element to lay out alone. */
    elementId?: number;
    /** Attribute name selecting one parameter per element (case-insensitive). */
    parameterName?: string;
    /** DMX break whose parameters are laid out. */
    dmxBreak?: number;
  } = {},
): FixtureWireLayout {
  const { elementId, dmxBreak = 1 } = options;
  const parameterName =
    options.parameterName === undefined
      ? undefined
      : normalizeParameterName(options.parameterName);
  const elementIndices = (
    elementId && elementId > 0
      ? [elementId - 1]
      : fixtureElementIdsInDmxOrder(fixture).map((id) => id - 1)
  ).filter((index) => index >= 0 && index < fixture.elements.length);

  const parameters: PlacedParameter[] = [];
  let nextFree = 0;
  for (const elementIndex of elementIndices) {
    const element = fixture.elements[elementIndex];
    for (const parameterIndex of selectedParameterIndices(
      element,
      parameterName,
    )) {
      const parameter = element.parameters[parameterIndex];
      if (parameterDmxBreak(parameter) !== dmxBreak) continue;
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
    }
  }

  const partial =
    Boolean(elementId && elementId > 0) || parameterName !== undefined;
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
