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

/** Builds parameter metadata placed at explicit 1-based footprint offsets. */
function makeExplicitParam(
  attribute: types.Attribute,
  offsets: number[],
): types.ParameterMetadata {
  return {
    ...makeParam(attribute),
    resolution:
      offsets.length === 2
        ? types.DmxValueResolution.Fine
        : types.DmxValueResolution.Coarse,
    dmx_slots: { type: "Explicit", data: { dmx_break: 1, offsets } },
  };
}

/** Verifies explicit profile slots yield per-parameter byte addresses and advance by the full footprint. */
test("buildFixturePatchMapFromBindings places explicit profile slots", () => {
  const uid = "explicituid";
  const nextUid = "nextuid";
  const fixture: types.Fixture = {
    identifiers: { id: 1, uid, label: "Heads" },
    make: "Test",
    model: "Test",
    mode: "Test",
    elements: [
      {
        label: "Head 1",
        parameters: [
          makeExplicitParam({ type: "Tilt" }, [1, 6]),
          makeExplicitParam({ type: "Intensity" }, [3]),
        ],
      },
      {
        label: "Head 2",
        parameters: [
          makeExplicitParam({ type: "Tilt" }, [2, 7]),
          {
            ...makeParam({ type: "Intensity" }),
            dmx_slots: { type: "Virtual" },
          },
        ],
      },
    ],
  };
  const next: types.Fixture = {
    ...fixture,
    identifiers: { id: 2, uid: nextUid, label: "Next" },
    elements: [{ label: "Main", parameters: [makeParam({ type: "Red" })] }],
  };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      {
        source: { type: "Fixture", data: { uids: [uid, nextUid] } },
        target: {
          type: "Transport",
          data: {
            target: "sacn",
            universe: { start: 1, end: 1 },
            address: 101,
          },
        },
        priority: 0,
        clone: false,
      },
    ],
  };

  const patchMap = buildFixturePatchMapFromBindings(snapshot, {
    [uid]: fixture,
    [nextUid]: next,
  });

  assert.deepEqual(patchMap[uid]["1"][0].parameterAddresses, [
    [101, 106],
    [103],
  ]);
  assert.equal(patchMap[uid]["1"][0].address, 101);
  assert.deepEqual(patchMap[uid]["2"][0].parameterAddresses, [[102, 107], []]);
  assert.equal(patchMap[uid]["2"][0].address, 102);
  assert.equal(patchMap[nextUid]["1"][0].address, 108);
});
