// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

/**
 * Attribute names per fixture element. Elements are immutable values that the
 * fixture snapshot replaces when a definition changes, so keying on the element
 * stays correct across edits.
 */
const elementAttributeCache = new WeakMap<types.FixtureElement, Set<string>>();

/** A fixture's attribute names, with the elements they were collected from. */
interface FixtureAttributeEntry {
  elements: readonly types.FixtureElement[];
  names: Set<string>;
}

const fixtureAttributeCache = new WeakMap<
  types.Fixture,
  FixtureAttributeEntry
>();

/**
 * Returns the set of attribute names exposed by any element in a fixture.
 *
 * The union is cached per fixture and reused while the fixture still holds the
 * same element objects.
 */
export function getFixtureAttributeNames(fixture: types.Fixture): Set<string> {
  const elements = fixture.elements ?? [];
  const cached = fixtureAttributeCache.get(fixture);
  if (
    cached &&
    cached.elements.length === elements.length &&
    cached.elements.every((element, index) => element === elements[index])
  ) {
    return cached.names;
  }
  const names = new Set<string>();
  for (const element of elements) {
    for (const attr of elementAttributeNames(element)) names.add(attr);
  }
  fixtureAttributeCache.set(fixture, { elements: [...elements], names });
  return names;
}

/**
 * Returns the set of attribute names exposed by a one-based fixture element.
 */
export function getFixtureElementAttributeNames(
  fixture: types.Fixture,
  elementIndex: number,
): Set<string> {
  const element = fixture.elements?.[elementIndex - 1];
  return element ? elementAttributeNames(element) : new Set();
}

/**
 * Collects the attribute names an element's parameters expose, naming custom
 * attributes by label and counting virtual intensity as Intensity.
 */
function elementAttributeNames(element: types.FixtureElement): Set<string> {
  const cached = elementAttributeCache.get(element);
  if (cached) return cached;

  const attributes = new Set<string>();
  for (const param of element.parameters ?? []) {
    const attr = param.attribute as types.Attribute;
    if (attr.type === "Custom" && attr.data) {
      attributes.add(attr.data.label);
    } else {
      attributes.add(attr.type);
    }

    if (attr.type === "VirtualIntensity") {
      attributes.add("Intensity");
    }
  }

  elementAttributeCache.set(element, attributes);
  return attributes;
}
