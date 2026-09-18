// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import { findInputBindingIdForOutputChannel } from "./output-binding-follow";

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

  const id = findInputBindingIdForOutputChannel(snapshot, "console", 1, 10);
  assert.equal(id, "input-0");
});

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

  const id = findInputBindingIdForOutputChannel(snapshot, "sacn", 1, 10);
  assert.equal(id, "input-0");
});

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

  const id = findInputBindingIdForOutputChannel(snapshot, "console", 1, 10);
  assert.equal(id, null);
});

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
    findInputBindingIdForOutputChannel(snapshot, "sacn", 1, 12),
    "input-0",
  );
  assert.equal(
    findInputBindingIdForOutputChannel(snapshot, "sacn", 1, 14),
    null,
  );
});
