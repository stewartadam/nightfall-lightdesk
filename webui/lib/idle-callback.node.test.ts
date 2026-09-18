// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelIdleCallbackSafe,
  type IdleCallbackHandle,
  type IdleDeadlineLike,
  type IdleRequestOptionsLike,
  requestIdleCallbackSafe,
} from "./idle-callback";

/**
 * Installs temporary idle-callback globals while a test callback runs.
 */
function withIdleCallbackGlobals(
  globals: {
    requestIdleCallback?: (
      callback: (deadline: IdleDeadlineLike) => void,
      options?: IdleRequestOptionsLike,
    ) => IdleCallbackHandle;
    cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
  },
  run: () => Promise<void> | void,
): Promise<void> | void {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: typeof globals.requestIdleCallback;
    cancelIdleCallback?: typeof globals.cancelIdleCallback;
  };
  const previousRequestIdleCallback = host.requestIdleCallback;
  const previousCancelIdleCallback = host.cancelIdleCallback;

  if (globals.requestIdleCallback) {
    Object.defineProperty(host, "requestIdleCallback", {
      value: globals.requestIdleCallback,
      configurable: true,
      writable: true,
    });
  } else {
    Reflect.deleteProperty(host, "requestIdleCallback");
  }

  if (globals.cancelIdleCallback) {
    Object.defineProperty(host, "cancelIdleCallback", {
      value: globals.cancelIdleCallback,
      configurable: true,
      writable: true,
    });
  } else {
    Reflect.deleteProperty(host, "cancelIdleCallback");
  }

  /** Restore the previous idle-callback globals after the test callback finishes. */
  const restore = () => {
    if (previousRequestIdleCallback === undefined) {
      Reflect.deleteProperty(host, "requestIdleCallback");
    } else {
      Object.defineProperty(host, "requestIdleCallback", {
        value: previousRequestIdleCallback,
        configurable: true,
        writable: true,
      });
    }

    if (previousCancelIdleCallback === undefined) {
      Reflect.deleteProperty(host, "cancelIdleCallback");
    } else {
      Object.defineProperty(host, "cancelIdleCallback", {
        value: previousCancelIdleCallback,
        configurable: true,
        writable: true,
      });
    }
  };

  try {
    const result = run();
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("requestIdleCallbackSafe uses native requestIdleCallback when available", () =>
  withIdleCallbackGlobals(
    {
      requestIdleCallback: (callback, options) => {
        assert.deepEqual(options, { timeout: 100 });
        callback({
          didTimeout: false,
          timeRemaining: () => 12,
        });
        return 42;
      },
    },
    () => {
      let timeRemaining = -1;
      const handle = requestIdleCallbackSafe(
        (deadline) => {
          timeRemaining = deadline.timeRemaining();
        },
        { timeout: 100 },
      );

      assert.equal(handle, 42);
      assert.equal(timeRemaining, 12);
    },
  ));

test("requestIdleCallbackSafe falls back to setTimeout when unavailable", async () =>
  withIdleCallbackGlobals({}, async () => {
    await new Promise<void>((resolve) => {
      requestIdleCallbackSafe((deadline) => {
        assert.equal(deadline.didTimeout, false);
        assert.ok(deadline.timeRemaining() >= 0);
        resolve();
      });
    });
  }));

test("cancelIdleCallbackSafe clears fallback timeout handles", async () =>
  withIdleCallbackGlobals({}, async () => {
    let called = false;
    const handle = requestIdleCallbackSafe(() => {
      called = true;
    });

    cancelIdleCallbackSafe(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(called, false);
  }));

test("cancelIdleCallbackSafe uses native cancelIdleCallback when available", () =>
  withIdleCallbackGlobals(
    {
      cancelIdleCallback: (handle) => {
        assert.equal(handle, 77);
      },
    },
    () => {
      cancelIdleCallbackSafe(77);
    },
  ));
