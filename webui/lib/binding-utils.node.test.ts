// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types/index";
import { buildFixturePatchMapFromBindings } from "./binding-utils";

/**
 * Builds parameter metadata for binding utility tests.
 */
function makeParam(attribute: types.Attribute): types.ParameterMetadata {
  return {
    resolution: types.DmxValueResolution.Coarse,
    attribute,
    min: 0,
    max: 255,
    offset: { type: "Absolute", data: { value: 0 } },
    is_inverted: false,
    is_snap: false,
    merge_type: types.MergeStrategy.HTP,
    use_grandmaster: true,
  };
}

/** Verifies an element patched by several output bindings keeps one entry per binding. */
test("buildFixturePatchMapFromBindings keeps multiple output bindings per element", () => {
  const uid = "fixtureuid";

  const fixture: types.Fixture = {
    identifiers: { id: 1, uid, label: "Fixture 1" },
    make: "Test",
    model: "Test",
    mode: "Test",
    elements: [
      {
        label: "Element 1",
        parameters: [makeParam({ type: "Intensity" })],
      },
    ],
  };

  const source: types.OutputSource = { type: "Fixture", data: { uids: [uid] } };

  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      {
        source,
        target: {
          type: "Transport",
          data: {
            target: "sacn",
            universe: { start: 1, end: 1 },
            address: 1,
          },
        },
        priority: 0,
        clone: false,
      },
      {
        source,
        target: {
          type: "Transport",
          data: {
            target: "artnet",
            universe: { start: 1, end: 1 },
            address: 1,
          },
        },
        priority: 0,
        clone: false,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, {
    [uid]: fixture,
  });

  assert.ok(patchMap[uid]);
  assert.ok(patchMap[uid]["1"]);
  assert.equal(patchMap[uid]["1"].length, 2);
  assert.deepEqual(patchMap[uid]["1"].map((p) => p.transport?.type).sort(), [
    "ArtNet",
    "Sacn",
  ]);
});

/** Verifies bindings to custom network DMX targets resolve to their configured transport. */
test("buildFixturePatchMapFromBindings resolves custom network dmx targets", () => {
  const uid = "fixtureuid";

  const fixture: types.Fixture = {
    identifiers: { id: 1, uid, label: "Fixture 1" },
    make: "Test",
    model: "Test",
    mode: "Test",
    elements: [
      {
        label: "Element 1",
        parameters: [makeParam({ type: "Intensity" })],
      },
    ],
  };

  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      {
        source: { type: "Fixture", data: { uids: [uid] } },
        target: {
          type: "Transport",
          data: {
            target: "artnode4",
            universe: { start: 4, end: 4 },
            address: 50,
          },
        },
        priority: 0,
        clone: false,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(
    snapshot,
    { [uid]: fixture },
    {
      targets: [
        {
          id: "artnode4",
          protocol: types.NetworkDmxProtocol.ArtNet,
          delivery: {
            type: "Unicast",
            data: { ip: "10.0.0.4" },
          },
        },
      ],
    },
  );

  assert.equal(patchMap[uid]["1"][0].transport?.type, "ArtNet");
  assert.deepEqual(patchMap[uid]["1"][0].transport, {
    type: "ArtNet",
    data: {
      mode: { type: "Unicast", data: { ip: "10.0.0.4" } },
    },
  });
});

/** Builds a one-element RGB fixture occupying three coarse channels. */
function makeRgbFixture(uid: string, id: number): types.Fixture {
  return {
    identifiers: { id, uid, label: `Fixture ${id}` },
    make: "Test",
    model: "RGB",
    mode: "3ch",
    elements: [
      {
        label: "Cell",
        parameters: [
          makeParam({ type: "Red" }),
          makeParam({ type: "Green" }),
          makeParam({ type: "Blue" }),
        ],
      },
    ],
  };
}

/** Builds a fixture→console binding for consecutive fixtures at one console address. */
function consoleBinding(
  uids: string[],
  universe: number,
  address: number,
): types.OutputBinding {
  return {
    source: { type: "Fixture", data: { uids } },
    target: {
      type: "Console",
      data: { universe: { start: universe, end: universe }, address },
    },
    priority: 0,
    clone: false,
  };
}

/**
 * Verifies consecutive console-bound fixtures are laid out contiguously in console numbering
 * with a `null` transport.
 */
test("buildFixturePatchMapFromBindings lays console-bound fixtures out in console space", () => {
  const fixtures = {
    a: makeRgbFixture("a", 1),
    b: makeRgbFixture("b", 2),
  };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [consoleBinding(["a", "b"], 2, 121)],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);

  assert.deepEqual(patchMap.a["1"], [
    { universe: 2, address: 121, transport: null },
  ]);
  assert.deepEqual(patchMap.b["1"], [
    { universe: 2, address: 124, transport: null },
  ]);
});

/**
 * Verifies a console→transport passthrough adds a wire-numbered entry for console-bound
 * fixtures while keeping the console-space entry.
 */
test("buildFixturePatchMapFromBindings remaps console passthrough to wire numbering", () => {
  const fixtures = { a: makeRgbFixture("a", 1) };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      consoleBinding(["a"], 2, 121),
      {
        source: {
          type: "Console",
          data: { universe: { start: 2, end: 2 } },
        },
        target: {
          type: "Transport",
          data: { target: "sacn", universe: { start: 10, end: 10 } },
        },
        priority: 0,
        clone: false,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);

  assert.deepEqual(patchMap.a["1"], [
    { universe: 2, address: 121, transport: null },
    {
      universe: 10,
      address: 121,
      transport: { type: "Sacn", data: { mode: { type: "Multicast" } } },
    },
  ]);
});

/** Verifies the highest-priority console binding decides a fixture's console address. */
test("buildFixturePatchMapFromBindings applies the highest-priority console binding", () => {
  const fixtures = { a: makeRgbFixture("a", 1) };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      { ...consoleBinding(["a"], 3, 1), priority: 5 },
      consoleBinding(["a"], 2, 1),
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);

  assert.deepEqual(patchMap.a["1"], [
    { universe: 3, address: 1, transport: null },
  ]);
});

/** Verifies a Fixture→Disabled binding suppresses console-space entries for the fixture. */
test("buildFixturePatchMapFromBindings skips console bindings for disabled fixtures", () => {
  const fixtures = { a: makeRgbFixture("a", 1) };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      consoleBinding(["a"], 2, 1),
      {
        source: { type: "Fixture", data: { uids: ["a"] } },
        target: { type: "Disabled" },
        priority: 0,
        clone: false,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);

  assert.equal(patchMap.a, undefined);
});

/** Builds a two-element fixture whose elements each occupy three coarse RGB channels. */
function makeTwoCellFixture(uid: string, id: number): types.Fixture {
  const cell = makeRgbFixture(uid, id).elements[0];
  return {
    ...makeRgbFixture(uid, id),
    elements: [
      { ...cell, label: "Cell 1" },
      { ...cell, label: "Cell 2" },
    ],
  };
}

/**
 * Verifies element-scoped console bindings lay out only the selected element, so the next
 * fixture follows at the filtered footprint instead of overlapping, and passthrough remaps
 * those element addresses onto the wire.
 */
test("buildFixturePatchMapFromBindings honors element filters on console bindings", () => {
  const fixtures = {
    a: makeTwoCellFixture("a", 1),
    b: makeTwoCellFixture("b", 2),
  };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      {
        ...consoleBinding(["a", "b"], 1, 1),
        source: { type: "Fixture", data: { uids: ["a", "b"], element: 2 } },
      },
      {
        source: {
          type: "Console",
          data: { universe: { start: 1, end: 1 } },
        },
        target: {
          type: "Transport",
          data: { target: "sacn", universe: { start: 7, end: 7 } },
        },
        priority: 0,
        clone: false,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);
  const sacn: types.OutputTransport = {
    type: "Sacn",
    data: { mode: { type: "Multicast" } },
  };

  assert.equal(patchMap.a["1"], undefined);
  assert.deepEqual(patchMap.a["2"], [
    { universe: 1, address: 1, transport: null },
    { universe: 7, address: 1, transport: sacn },
  ]);
  assert.deepEqual(patchMap.b["2"], [
    { universe: 1, address: 4, transport: null },
    { universe: 7, address: 4, transport: sacn },
  ]);
});
