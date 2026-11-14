// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import {
  commandFailure,
  commandOutputValue,
  commandSucceeded,
  failedCommandKeys,
  requireCommandSuccess,
} from "./command-result";

/** Creates a successful command result with optional domain output. */
function succeeded(value?: unknown): types.CommandResult {
  return {
    command_id: "1234",
    outcome: {
      type: "Succeeded",
      data: value === undefined ? {} : { output: { value } },
    },
  };
}

/** Creates a failed command result for helper tests. */
function failed(): types.CommandResult {
  return {
    command_id: "1234",
    outcome: {
      type: "Failed",
      data: { code: "test.failure", message: "failed", details: null },
    },
  };
}

test("command result helpers distinguish terminal outcomes", () => {
  assert.equal(commandSucceeded(succeeded()), true);
  assert.equal(commandSucceeded(failed()), false);
  assert.equal(commandFailure(failed())?.code, "test.failure");
  assert.equal(commandFailure(succeeded()), null);
});

test("commandOutputValue returns only successful domain output", () => {
  assert.deepEqual(commandOutputValue(succeeded({ instance_id: "abcd" })), {
    instance_id: "abcd",
  });
  assert.equal(commandOutputValue(failed()), undefined);
});

test("requireCommandSuccess throws structured failure messages", () => {
  assert.doesNotThrow(() => requireCommandSuccess(succeeded()));
  assert.throws(() => requireCommandSuccess(failed()), /failed/);
});

/** Verifies rejected and unsent commands are both reported by key, in order, and successes are not. */
test("failedCommandKeys lists rejected and unsent commands", async () => {
  const keys = await failedCommandKeys([
    { key: 1, result: Promise.resolve(succeeded()) },
    { key: 2, result: Promise.resolve(failed()) },
    { key: 3, result: Promise.reject(new Error("not sent")) },
    { key: 4, result: Promise.resolve(succeeded()) },
  ]);
  assert.deepEqual(keys, [2, 3]);
});
