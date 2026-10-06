// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { UncaughtErrorDetails } from "./uncaught-error";
import {
  createUncaughtErrorReporter,
  REPEAT_SUPPRESSION_MS,
  type UncaughtErrorReport,
} from "./uncaught-error-reporter";

const failure: UncaughtErrorDetails = {
  kind: "error",
  name: "TypeError",
  message: "crypto.randomUUID is not a function",
  stack: "TypeError: crypto.randomUUID is not a function\n    at send",
};

/** Creates a reporter with a controllable clock that records presented reports. */
function createReporter() {
  let time = 1000;
  const presented: UncaughtErrorReport[] = [];
  const report = createUncaughtErrorReporter({
    present: (entry) => presented.push(entry),
    now: () => time,
  });
  return {
    presented,
    report,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** A failure loop shows one notification until the suppression window passes. */
test("presents repeated failures once per suppression window", () => {
  const { presented, report, advance } = createReporter();
  report("app", failure);
  report("app", failure);
  advance(REPEAT_SUPPRESSION_MS - 1);
  report("app", failure);
  assert.equal(presented.length, 1);
  assert.deepEqual(presented[0], { ...failure, source: "app" });

  advance(1);
  report("app", failure);
  assert.equal(presented.length, 2);
});

/** The same failure from a different thread, or a different failure, is shown separately. */
test("distinguishes failures by source and message", () => {
  const { presented, report } = createReporter();
  report("app", failure);
  report("visualizer", failure);
  report("app", { ...failure, message: "other" });
  assert.deepEqual(
    presented.map((entry) => `${entry.source}: ${entry.message}`),
    [
      "app: crypto.randomUUID is not a function",
      "visualizer: crypto.randomUUID is not a function",
      "app: other",
    ],
  );
});

/** Benign browser notices and opaque cross-origin errors do not alarm the user. */
test("ignores browser noise", () => {
  const { presented, report } = createReporter();
  report("app", {
    ...failure,
    message: "ResizeObserver loop completed with undelivered notifications.",
  });
  report("app", { kind: "error", name: "Error", message: "Script error." });
  assert.equal(presented.length, 0);
});
