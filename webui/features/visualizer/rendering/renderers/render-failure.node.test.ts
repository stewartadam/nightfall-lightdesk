// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRenderFailure,
  RenderFailureLatch,
  SimulatedRenderFailure,
  type VisualizerRenderFailure,
} from "./render-failure";

/** Only the first failure reaches the listener, however often the renderer breaks. */
test("RenderFailureLatch reports the first failure once", () => {
  const latch = new RenderFailureLatch();
  const received: VisualizerRenderFailure[] = [];
  latch.setCallback((failure) => received.push(failure));
  latch.report({ kind: "render-error", message: "first" });
  latch.report({ kind: "device-lost", message: "second" });
  assert.equal(latch.failed, true);
  assert.deepEqual(received, [{ kind: "render-error", message: "first" }]);
});

/** A failure before anyone listens is held and delivered to the first listener. */
test("RenderFailureLatch delivers a failure that happened before the listener", () => {
  const latch = new RenderFailureLatch();
  latch.report({ kind: "render-error", message: "early" });
  const received: string[] = [];
  latch.setCallback((failure) => received.push(failure.message));
  latch.setCallback((failure) => received.push(`again ${failure.message}`));
  assert.deepEqual(received, ["early"]);
});

/** Thrown errors keep their name, message and stack across the worker boundary. */
test("describeRenderFailure keeps the error name and stack", () => {
  const error = new TypeError("bad frame");
  const failure = describeRenderFailure("render-error", error);
  assert.equal(failure.message, "TypeError: bad frame");
  assert.equal(failure.stack, error.stack);
  assert.deepEqual(describeRenderFailure("init-error", "plain"), {
    kind: "init-error",
    message: "plain",
  });
});

/** A simulated render error throws after a few frames, like a real broken frame. */
test("SimulatedRenderFailure throws a render error after a few frames", () => {
  const simulated = new SimulatedRenderFailure("render");
  assert.equal(simulated.tick(), null);
  assert.throws(() => {
    for (let frame = 0; frame < 100; frame += 1) simulated.tick();
  }, /Simulated visualizer render failure/);
});

/** A simulated device loss is returned for the renderer to report. */
test("SimulatedRenderFailure reports a device loss after a few frames", () => {
  const simulated = new SimulatedRenderFailure("device-lost");
  let failure: VisualizerRenderFailure | null = null;
  for (let frame = 0; frame < 100 && !failure; frame += 1) {
    failure = simulated.tick();
  }
  assert.equal(failure?.kind, "device-lost");
  assert.equal(new SimulatedRenderFailure(undefined).tick(), null);
});
