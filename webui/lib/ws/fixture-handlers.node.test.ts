// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fixtures } from "../../state/appStores";
import type * as types from "../../types";
import { getFixtureAttributeNames } from "../fixture-attributes";
import { registerFixtureHandlers } from "./fixture-handlers";
import { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Builds a minimal fixture whose elements expose the given attribute types. */
function fixture(uid: string, attributes: string[][]): types.Fixture {
  return {
    identifiers: { uid, id: 1 },
    make: "Make",
    model: "Model",
    mode: "Mode",
    elements: attributes.map((types, index) => ({
      id: index + 1,
      parameters: types.map((type) => ({ attribute: { type } })),
    })),
  } as unknown as types.Fixture;
}

/** Dispatches one FixtureDefinitions snapshot through the production handler. */
function receive(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
  data: types.Fixture[],
) {
  registry.dispatch({ type: "FixtureDefinitions", data } as AnyWsMessage);
}

/**
 * Verifies a snapshot keeps the element objects it already held when they are unchanged,
 * replaces only changed ones, and marks every held element so Solid stores do not proxy it.
 */
test("FixtureDefinitions keeps unchanged elements and marks them opaque", () => {
  const registry = new WsMessageHandlerRegistry<AnyWsMessage>();
  registerFixtureHandlers(registry);

  receive(registry, [fixture("a", [["Intensity"], ["Red"]])]);
  const [first, second] = fixtures.get().a.elements;
  assert.notEqual(Object.getPrototypeOf(first), Object.prototype);
  assert.notEqual(Object.getPrototypeOf(second), Object.prototype);

  receive(registry, [fixture("a", [["Intensity"], ["Green"]])]);
  const [nextFirst, nextSecond] = fixtures.get().a.elements;
  assert.equal(nextFirst, first);
  assert.notEqual(nextSecond, second);
  assert.notEqual(Object.getPrototypeOf(nextSecond), Object.prototype);
});

/** Verifies a fixture's cached attribute names follow its elements when they are replaced. */
test("getFixtureAttributeNames refreshes when a fixture's elements change", () => {
  const target = fixture("b", [["Intensity"], ["Red"]]);
  assert.deepEqual([...getFixtureAttributeNames(target)], ["Intensity", "Red"]);
  assert.equal(
    getFixtureAttributeNames(target),
    getFixtureAttributeNames(target),
  );

  target.elements[1] = fixture("b", [["Blue"]]).elements[0];
  assert.deepEqual(
    [...getFixtureAttributeNames(target)],
    ["Intensity", "Blue"],
  );
});
