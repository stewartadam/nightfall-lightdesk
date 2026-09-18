// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

const fixtureAttributeCache = new WeakMap<types.Fixture, Set<string>>();
const fixtureElementAttributeCache = new WeakMap<
  types.Fixture,
  Map<number, Set<string>>
>();

/**
 * Returns the set of attribute names exposed by any element in a fixture.
 */
export function getFixtureAttributeNames(fixture: types.Fixture): Set<string> {
  const cached = fixtureAttributeCache.get(fixture);
  if (cached) {
    return cached;
  }
  const attributes = new Set<string>();

  for (let index = 1; index <= (fixture.elements?.length ?? 0); index++) {
    for (const attr of getFixtureElementAttributeNames(fixture, index)) {
      attributes.add(attr);
    }
  }

  fixtureAttributeCache.set(fixture, attributes);
  return attributes;
}

/**
 * Returns the set of attribute names exposed by a one-based fixture element.
 */
export function getFixtureElementAttributeNames(
  fixture: types.Fixture,
  elementIndex: number,
): Set<string> {
  const cachedByIndex = fixtureElementAttributeCache.get(fixture);
  const cached = cachedByIndex?.get(elementIndex);
  if (cached) {
    return cached;
  }

  const attributes = new Set<string>();
  const element = fixture.elements?.[elementIndex - 1];
  for (const param of element?.parameters ?? []) {
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

  const nextByIndex = cachedByIndex ?? new Map<number, Set<string>>();
  nextByIndex.set(elementIndex, attributes);
  fixtureElementAttributeCache.set(fixture, nextByIndex);
  return attributes;
}
