// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { initializeOwnedVisualizerRenderer } from "./renderer-lifecycle-ownership";

/** Creates a promise whose completion the test can control explicitly. */
function createDeferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Disposes a renderer that finishes initialization after its owner unmounts. */
test("late renderer initialization disposes instead of activating", async () => {
  const deferredRenderer = createDeferred<{ dispose: () => void }>();
  let disposed = false;
  let disposeCount = 0;
  let activationCount = 0;
  const initialization = initializeOwnedVisualizerRenderer(
    () => deferredRenderer.promise,
    () => disposed,
    () => {
      activationCount += 1;
    },
  );

  disposed = true;
  deferredRenderer.resolve({
    dispose: () => {
      disposeCount += 1;
    },
  });
  await initialization;

  assert.equal(disposeCount, 1);
  assert.equal(activationCount, 0);
});

/** Activates a renderer that completes while its owner is still mounted. */
test("owned renderer initialization activates without disposal", async () => {
  let disposeCount = 0;
  let activationCount = 0;

  await initializeOwnedVisualizerRenderer(
    async () => ({
      dispose: () => {
        disposeCount += 1;
      },
    }),
    () => false,
    () => {
      activationCount += 1;
    },
  );

  assert.equal(disposeCount, 0);
  assert.equal(activationCount, 1);
});
