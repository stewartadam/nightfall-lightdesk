// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as types from "../types/index";
import {
  buildFixturePatchMapFromBindings,
  type FixturePatchChannel,
  fixtureElementIdsInDmxOrder,
} from "./binding-utils";

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

/** Builds the coarse Red/Green/Blue patch channels of an RGB element starting at `start`. */
function rgbChannels(start: number): FixturePatchChannel[] {
  return [0, 1, 2].map((parameterIndex) => ({
    parameterIndex,
    address: start + parameterIndex,
    width: 1,
  }));
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
    { universe: 2, address: 121, transport: null, channels: rgbChannels(121) },
  ]);
  assert.deepEqual(patchMap.b["1"], [
    { universe: 2, address: 124, transport: null, channels: rgbChannels(124) },
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
    { universe: 2, address: 121, transport: null, channels: rgbChannels(121) },
    {
      universe: 10,
      address: 121,
      transport: { type: "Sacn", data: { mode: { type: "Multicast" } } },
      channels: rgbChannels(121),
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
    { universe: 3, address: 1, transport: null, channels: rgbChannels(1) },
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
    { universe: 1, address: 1, transport: null, channels: rgbChannels(1) },
    { universe: 7, address: 1, transport: sacn, channels: rgbChannels(1) },
  ]);
  assert.deepEqual(patchMap.b["2"], [
    { universe: 1, address: 4, transport: null, channels: rgbChannels(4) },
    { universe: 7, address: 4, transport: sacn, channels: rgbChannels(4) },
  ]);
});

/**
 * Verifies a parameter-filtered console binding patches only the selected parameter: an
 * RGB element bound for Red at console 1.1 claims address 1 alone, so the next fixture
 * starts at 2 and addresses 2/3 are not labelled Green/Blue of the first fixture. The
 * passthrough window carries exactly those channels onto the wire.
 */
test("buildFixturePatchMapFromBindings patches only the filtered parameter", () => {
  const fixtures = {
    a: makeRgbFixture("a", 1),
    b: makeRgbFixture("b", 2),
  };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      {
        ...consoleBinding(["a", "b"], 1, 1),
        source: { type: "Fixture", data: { uids: ["a", "b"], param: "green" } },
      },
      {
        source: { type: "Console", data: { universe: { start: 1, end: 1 } } },
        target: {
          type: "Transport",
          data: { target: "sacn", universe: { start: 4, end: 4 }, address: 11 },
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
  const green = (address: number) => [{ parameterIndex: 1, address, width: 1 }];

  assert.deepEqual(patchMap.a["1"], [
    { universe: 1, address: 1, transport: null, channels: green(1) },
    { universe: 4, address: 11, transport: sacn, channels: green(11) },
  ]);
  assert.deepEqual(patchMap.b["1"], [
    { universe: 1, address: 2, transport: null, channels: green(2) },
    { universe: 4, address: 12, transport: sacn, channels: green(12) },
  ]);
});

/**
 * Verifies a higher-priority parameter-filtered console binding moves only that parameter,
 * leaving the element's other parameters at the lower-priority binding's addresses, as the
 * engine's per-parameter console layout does.
 */
test("buildFixturePatchMapFromBindings replaces console addresses per parameter", () => {
  const fixtures = { a: makeRgbFixture("a", 1) };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      consoleBinding(["a"], 1, 1),
      {
        ...consoleBinding(["a"], 2, 50),
        source: { type: "Fixture", data: { uids: ["a"], param: "Red" } },
        priority: 5,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);

  assert.deepEqual(patchMap.a["1"], [
    {
      universe: 1,
      address: 2,
      transport: null,
      channels: rgbChannels(1).slice(1),
    },
    {
      universe: 2,
      address: 50,
      transport: null,
      channels: [{ parameterIndex: 0, address: 50, width: 1 }],
    },
  ]);
});

/** Loads the wiring-order golden file shared with the engine's `FixtureLayout` tests. */
function goldenDmxElementOrder(): Record<string, number[]> {
  const root = process.env.NIGHTFALL_REPO_ROOT;
  assert.ok(root, "NIGHTFALL_REPO_ROOT is required");
  return JSON.parse(
    readFileSync(
      join(
        root,
        "crates/fixtures/tests/data/fixture_layout_dmx_element_order.json",
      ),
      "utf8",
    ),
  );
}

/** Builds a fixture with `count` single-intensity elements and an optional layout. */
function makeSegmentedFixture(
  uid: string,
  count: number,
  layout?: types.FixtureLayout,
): types.Fixture {
  return {
    identifiers: { id: 1, uid, label: "Segmented" },
    make: "Test",
    model: "Segmented",
    mode: `${count}ch`,
    layout,
    elements: Array.from({ length: count }, (_, index) => ({
      label: `Segment ${index + 1}`,
      parameters: [makeParam({ type: "Intensity" })],
    })),
  };
}

/**
 * Pins the web UI's element wiring order to the golden file the engine's
 * `FixtureLayout::dmx_element_order` test also checks, and verifies layouts absent from it
 * keep declaration order.
 */
test("fixtureElementIdsInDmxOrder matches the engine's wiring-order golden file", () => {
  const golden = goldenDmxElementOrder();
  for (const layout of Object.values(types.FixtureLayout)) {
    const expected = golden[layout];
    const count = expected ? Math.max(...expected) : 4;
    const order = fixtureElementIdsInDmxOrder(
      makeSegmentedFixture("f", count, layout),
    );
    assert.deepEqual(
      order,
      expected ?? [1, 2, 3, 4],
      `wiring order for ${layout}`,
    );
  }
  assert.deepEqual(
    fixtureElementIdsInDmxOrder(makeSegmentedFixture("f", 3)),
    [1, 2, 3],
  );
});

/**
 * Verifies whole-fixture console and transport patches place RGB strobe bar and rotating
 * wash beam elements at the addresses of their hardware wiring order rather than their
 * logical element order.
 */
test("buildFixturePatchMapFromBindings lays wired layouts out in DMX order", () => {
  const golden = goldenDmxElementOrder();
  for (const layout of [
    types.FixtureLayout.RgbStrobeBar,
    types.FixtureLayout.RotatingWashBeam,
  ]) {
    const order = golden[layout];
    const fixtures = {
      a: makeSegmentedFixture("a", Math.max(...order), layout),
    };
    const snapshot: types.BindingsSnapshot = {
      input: [],
      disabled: [],
      output: [
        consoleBinding(["a"], 1, 1),
        {
          source: { type: "Fixture", data: { uids: ["a"] } },
          target: {
            type: "Transport",
            data: {
              target: "sacn",
              universe: { start: 3, end: 3 },
              address: 101,
            },
          },
          priority: 0,
          clone: false,
        },
      ],
    };

    const patchMap = buildFixturePatchMapFromBindings(snapshot, fixtures);

    for (const [position, elementId] of order.entries()) {
      const entries = patchMap.a[String(elementId)];
      assert.deepEqual(
        entries.map((entry) => [entry.universe, entry.address]),
        [
          [3, 101 + position],
          [1, 1 + position],
        ],
        `${layout} element ${elementId}`,
      );
    }
  }
});
