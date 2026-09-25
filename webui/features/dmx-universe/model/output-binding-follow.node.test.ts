// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import {
  findInputBindingIdForOutputChannel,
  findOutputBindingIdForChannel,
  type OutputSpaceSelection,
} from "./output-binding-follow";

/** Console-space selection used across follow tests. */
const CONSOLE: OutputSpaceSelection = { kind: "console" };
/** Multicast sACN selection used across follow tests. */
const SACN: OutputSpaceSelection = { kind: "transport", key: "Sacn:Multicast" };

/** Builds coarse parameter metadata for output follow tests. */
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

/** Builds a fixture→console binding at one console address with a priority. */
function consoleBinding(
  universe: number,
  address: number,
  priority: number,
): types.OutputBinding {
  return {
    source: { type: "Fixture", data: { uids: ["a"] } },
    target: {
      type: "Console",
      data: { universe: singleUniverse(universe), address },
    },
    priority,
    clone: false,
  };
}

/**
 * Verifies binding follow skips a lower-priority console binding whose address is
 * replaced by a higher-priority console binding, and follows the winning row instead.
 */
test("follows the highest-priority console binding driving a channel", () => {
  const fixtures = { a: makeRgbFixture("a", 1) };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [consoleBinding(1, 1, 5), consoleBinding(1, 1, 0)],
  };
  assert.equal(
    findOutputBindingIdForChannel(snapshot, fixtures, CONSOLE, 1, 2),
    "output-0",
  );

  const moved: types.BindingsSnapshot = {
    ...snapshot,
    output: [consoleBinding(1, 100, 5), consoleBinding(1, 1, 0)],
  };
  assert.equal(
    findOutputBindingIdForChannel(moved, fixtures, CONSOLE, 1, 2),
    null,
  );
  assert.equal(
    findOutputBindingIdForChannel(moved, fixtures, CONSOLE, 1, 101),
    "output-0",
  );
});

/** Verifies binding follow ignores bindings overridden by a Fixture→Disabled row. */
test("does not follow bindings overridden by a disabled row", () => {
  const fixtures = { a: makeRgbFixture("a", 1) };
  const snapshot: types.BindingsSnapshot = {
    input: [],
    disabled: [],
    output: [
      {
        source: { type: "Fixture", data: { uids: ["a"] } },
        target: {
          type: "Transport",
          data: { target: "sacn", universe: singleUniverse(1), address: 1 },
        },
        priority: 0,
        clone: false,
      },
      {
        source: { type: "Fixture", data: { uids: ["a"] } },
        target: { type: "Disabled" },
        priority: 0,
        clone: false,
      },
    ],
  };

  assert.equal(
    findOutputBindingIdForChannel(snapshot, fixtures, SACN, 1, 1),
    null,
  );
});

/**
 * Builds a one-universe DMX range for output binding follow tests.
 */
function singleUniverse(universe: number): types.DmxRange {
  return { start: universe, end: universe };
}

/**
 * Builds a binding snapshot from input bindings for follow behavior tests.
 */
function makeSnapshot(input: types.InputBinding[]): types.BindingsSnapshot {
  return {
    input,
    output: [],
    disabled: [],
  };
}

/** Verifies a transport→console input binding is followed from a console channel. */
test("finds transport->console binding for console output channel", () => {
  const snapshot = makeSnapshot([
    {
      source: {
        type: "Transport",
        data: {
          transport: types.BindingTransport.Sacn,
          universe: singleUniverse(1),
          address: 1,
        },
      },
      target: {
        type: "Console",
        data: {
          universe: singleUniverse(1),
          address: 1,
        },
      },
      priority: 0,
      clone: false,
    },
  ]);

  const id = findInputBindingIdForOutputChannel(snapshot, CONSOLE, 1, 10);
  assert.equal(id, "input-0");
});

/** Verifies a transport→transport input binding is followed from its wire channel. */
test("finds transport->transport binding for selected transport output channel", () => {
  const snapshot = makeSnapshot([
    {
      source: {
        type: "Transport",
        data: {
          transport: types.BindingTransport.Sacn,
          universe: singleUniverse(1),
          address: 1,
        },
      },
      target: {
        type: "Transport",
        data: {
          target: "sacn",
          universe: singleUniverse(1),
          address: 1,
        },
      },
      priority: 0,
      clone: false,
    },
  ]);

  const id = findInputBindingIdForOutputChannel(snapshot, SACN, 1, 10);
  assert.equal(id, "input-0");
});

/** Verifies transport-targeted input bindings are not followed from console space. */
test("does not match transport target when console is selected", () => {
  const snapshot = makeSnapshot([
    {
      source: {
        type: "Transport",
        data: {
          transport: types.BindingTransport.Sacn,
          universe: singleUniverse(1),
          address: 1,
        },
      },
      target: {
        type: "Transport",
        data: {
          target: "sacn",
          universe: singleUniverse(1),
          address: 1,
        },
      },
      priority: 0,
      clone: false,
    },
  ]);

  const id = findInputBindingIdForOutputChannel(snapshot, CONSOLE, 1, 10);
  assert.equal(id, null);
});

/** Verifies follow only matches channels inside the source→target copy window. */
test("respects source/target address copy window", () => {
  const snapshot = makeSnapshot([
    {
      source: {
        type: "Transport",
        data: {
          transport: types.BindingTransport.Sacn,
          universe: singleUniverse(1),
          address: 500,
        },
      },
      target: {
        type: "Transport",
        data: {
          target: "sacn",
          universe: singleUniverse(1),
          address: 1,
        },
      },
      priority: 0,
      clone: false,
    },
  ]);

  assert.equal(
    findInputBindingIdForOutputChannel(snapshot, SACN, 1, 12),
    "input-0",
  );
  assert.equal(findInputBindingIdForOutputChannel(snapshot, SACN, 1, 14), null);
});
