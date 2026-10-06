// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  describeErrorEvent,
  describeUncaughtError,
  forwardUncaughtErrors,
  isUncaughtErrorMessage,
  type UncaughtErrorMessage,
} from "./uncaught-error";

/** Builds a minimal worker scope that records listeners and posted messages. */
function createScope() {
  const target = new EventTarget();
  const posted: UncaughtErrorMessage[] = [];
  return {
    posted,
    target,
    scope: {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      postMessage: (message: UncaughtErrorMessage) => posted.push(message),
    },
  };
}

/** Errors keep their type, message, and stack so bug reports locate the failure. */
test("describes Error instances with their stack", () => {
  const error = new TypeError("crypto.randomUUID is not a function");
  const details = describeUncaughtError(error, "error");
  assert.equal(details.name, "TypeError");
  assert.equal(details.message, "crypto.randomUUID is not a function");
  assert.equal(details.stack, error.stack);
});

/** Rejections with non-Error reasons still produce a readable description. */
test("describes non-Error rejection reasons", () => {
  assert.deepEqual(describeUncaughtError({ code: 7n }, "rejection"), {
    kind: "rejection",
    name: "Unhandled rejection",
    message: '{"code":"7"}',
  });
  assert.equal(
    describeUncaughtError(undefined, "rejection").message,
    "Unknown error",
  );
});

/** Events without a thrown value fall back to their message and source location. */
test("describes error events without an error object", () => {
  const details = describeErrorEvent({
    error: null,
    message: "Uncaught SyntaxError",
    filename: "/worker.js",
    lineno: 3,
    colno: 9,
  } as ErrorEvent);
  assert.equal(details.message, "Uncaught SyntaxError");
  assert.equal(details.stack, "    at /worker.js:3:9");
  assert.equal(
    describeErrorEvent({} as ErrorEvent, "The worker stopped").message,
    "The worker stopped",
  );
});

/** Worker failures are posted with their stack and cancelled so they are reported once. */
test("forwards and cancels uncaught worker errors and rejections", () => {
  const { posted, scope, target } = createScope();
  const dispose = forwardUncaughtErrors(scope);
  const errorEvent = Object.assign(new Event("error", { cancelable: true }), {
    error: new RangeError("bad frame"),
  });
  target.dispatchEvent(errorEvent);
  const rejection = Object.assign(
    new Event("unhandledrejection", { cancelable: true }),
    { reason: "socket closed" },
  );
  target.dispatchEvent(rejection);
  assert.ok(errorEvent.defaultPrevented);
  assert.ok(rejection.defaultPrevented);
  assert.equal(posted.length, 2);
  assert.ok(posted.every(isUncaughtErrorMessage));
  assert.equal(posted[0].error.name, "RangeError");
  assert.equal(posted[0].error.kind, "error");
  assert.equal(posted[1].error.message, "socket closed");
  assert.equal(posted[1].error.kind, "rejection");

  dispose();
  target.dispatchEvent(errorEvent);
  assert.equal(posted.length, 2);
});

/** Ordinary worker protocol messages are not mistaken for forwarded failures. */
test("recognizes only forwarded failure messages", () => {
  assert.equal(isUncaughtErrorMessage({ type: "error", error: "x" }), false);
  assert.equal(isUncaughtErrorMessage({ type: "uncaughtError" }), false);
  assert.equal(isUncaughtErrorMessage(null), false);
});
