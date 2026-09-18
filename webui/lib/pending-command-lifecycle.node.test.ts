// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { settlePendingCommand } from "./pending-command-lifecycle";

/** Verifies a terminal result consumes its waiter and associated metadata together. */
test("terminal command result settles waiter and metadata", () => {
  const state = {
    waiters: new Map([["command-1", "waiter"]]),
    resultMetadata: new Map([
      ["command-1", { name: "sample.nightfall-show", bumpRevision: true }],
    ]),
  };

  const result = settlePendingCommand(state, "command-1");
  assert.equal(result.waiter, "waiter");
  assert.deepEqual(result.resultMetadata, {
    name: "sample.nightfall-show",
    bumpRevision: true,
  });
  assert.equal(state.waiters.has("command-1"), false);
  assert.equal(state.resultMetadata.has("command-1"), false);
});
