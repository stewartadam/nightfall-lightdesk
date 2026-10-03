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
 * Resolves the optical parameters the backend assigned to each beam of a
 * geometry tree into element parameter indices, once per fixture build.
 * References to elements or attributes the fixture no longer has are skipped.
 */
export function bindEmitterOpticalParameters(
  geometry: FixtureGeometry,
  elements: readonly FixtureElement[],
): Map<string, OpticalParameterBinding[]> {
  const result = new Map<string, OpticalParameterBinding[]>();
  for (const node of geometry.nodes) {
    if (node.geometryType !== "beam") continue;
    const bindings: OpticalParameterBinding[] = [];
    for (const reference of node.opticalParameters ?? []) {
      const element = elements[reference.element];
      if (!element) continue;
      const key = attributeOutputKey(reference.attribute);
      const parameterIndex = element.parameters.findIndex(
        (parameter) => attributeOutputKey(parameter.attribute) === key,
      );
      if (parameterIndex >= 0) bindings.push({ element, parameterIndex });
    }
    result.set(node.name, bindings);
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
