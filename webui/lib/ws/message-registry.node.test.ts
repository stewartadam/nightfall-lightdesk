// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createWsMessageHandlerRegistry } from "./message-registry";

type TestMessage =
  | { type: "Alpha"; data: number }
  | { type: "Beta"; data: string };

/** Verifies registered handlers receive the correctly discriminated payload. */
test("dispatch calls the registered handler for a message type", () => {
  const registry = createWsMessageHandlerRegistry<TestMessage>();
  const seen: number[] = [];

  registry.register("Alpha", (message) => {
    seen.push(message.data);
  });

  assert.equal(registry.dispatch({ type: "Alpha", data: 42 }), true);
  assert.deepEqual(seen, [42]);
});

/** Verifies unregistered message types remain available for legacy dispatch. */
test("dispatch returns false for an unregistered message type", () => {
  const registry = createWsMessageHandlerRegistry<TestMessage>();

  assert.equal(registry.dispatch({ type: "Beta", data: "legacy" }), false);
});

/** Verifies duplicate handlers fail fast during registry construction. */
test("register rejects duplicate handlers for the same message type", () => {
  const registry = createWsMessageHandlerRegistry<TestMessage>();

  registry.register("Alpha", () => {});

  assert.throws(
    () => registry.register("Alpha", () => {}),
    /already registered for Alpha/u,
  );
});
