// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FixtureElement, FixtureGeometry } from "../../../types";
import { attributeOutputKey } from "../rendering/channel-evaluation";
import { opticalReadoutKeys } from "../rendering/optical-readouts";

/** One element parameter whose evaluated channel drives an aperture's optics. */
export interface OpticalParameterBinding {
  /** Element owning the parameter; its label keys the element's DMX record. */
  readonly element: FixtureElement;
  /** Index of the parameter in `element.parameters`. */
  readonly parameterIndex: number;
}

/**
 * Appends an element's optical parameters to `bindings`, skipping attributes a
 * nearer element already controls.
 */
function bindElement(
  element: FixtureElement,
  bound: Set<string>,
  bindings: OpticalParameterBinding[],
): void {
  const readouts = opticalReadoutKeys(element);
  for (let index = 0; index < element.parameters.length; index++) {
    if (!readouts[index]) continue;
    const key = attributeOutputKey(element.parameters[index].attribute);
    if (bound.has(key)) continue;
    bound.add(key);
    bindings.push({ element, parameterIndex: index });
  }
}

/**
 * Resolves the optical parameters each beam of a geometry tree inherits,
 * once per fixture build. GDTF names an element after the geometry its
 * channels sit on, and optics set on an ancestor (a head's gobo wheel) reach
 * every beam below it. The nearest geometry wins per attribute, so a local
 * control overrides its ancestor's only for its own descendants.
 */
export function bindEmitterOpticalParameters(
  geometry: FixtureGeometry,
  elements: readonly FixtureElement[],
): Map<string, OpticalParameterBinding[]> {
  const elementsByGeometry = new Map(
    elements.map((element) => [element.label, element]),
  );
  const result = new Map<string, OpticalParameterBinding[]>();
  for (let index = 0; index < geometry.nodes.length; index++) {
    const emitter = geometry.nodes[index];
    if (emitter.geometryType !== "beam") continue;
    const bindings: OpticalParameterBinding[] = [];
    const bound = new Set<string>();
    const visited = new Set<number>();
    let ancestor = index;
    while (
      ancestor >= 0 &&
      ancestor < geometry.nodes.length &&
      !visited.has(ancestor)
    ) {
      visited.add(ancestor);
      const node = geometry.nodes[ancestor];
      const element = elementsByGeometry.get(node.name);
      if (element) bindElement(element, bound, bindings);
      ancestor = node.parentIndex;
    }
    result.set(emitter.name, bindings);
  }
  return result;
}

/**
 * Binds the optical parameters of fixtures without a geometry tree, whose
 * single aperture is driven by every element; earlier elements win per
 * attribute.
 */
export function bindElementOpticalParameters(
  elements: readonly FixtureElement[],
): OpticalParameterBinding[] {
  const bindings: OpticalParameterBinding[] = [];
  const bound = new Set<string>();
  for (const element of elements) bindElement(element, bound, bindings);
  return bindings;
}
