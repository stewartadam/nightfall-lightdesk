// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";
import { createWindowMouseDrag } from "./window-drag";

/** Records the drag callbacks a target's events reach. */
function recordDrag(target: EventTarget) {
  const calls: string[] = [];
  let dispose = () => {};
  const drag = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createWindowMouseDrag(
      {
        move: () => calls.push("move"),
        end: () => calls.push("end"),
      },
      target,
    );
  });
  return { calls, drag, dispose: () => dispose() };
}

/** Verifies a drag follows moves until the release, then stops listening. */
test("createWindowMouseDrag follows moves until the release", () => {
  const target = new EventTarget();
  const { calls, drag } = recordDrag(target);

  target.dispatchEvent(new Event("mousemove"));
  drag.start();
  target.dispatchEvent(new Event("mousemove"));
  target.dispatchEvent(new Event("mouseup"));
  target.dispatchEvent(new Event("mousemove"));
  target.dispatchEvent(new Event("mouseup"));

  assert.deepEqual(calls, ["move", "end"]);
});

/** Verifies disposing the owner mid-drag removes the listeners, so a later release does nothing. */
test("createWindowMouseDrag drops an active drag when its owner is disposed", () => {
  const target = new EventTarget();
  const { calls, drag, dispose } = recordDrag(target);

  drag.start();
  dispose();
  target.dispatchEvent(new Event("mousemove"));
  target.dispatchEvent(new Event("mouseup"));

  assert.deepEqual(calls, []);
});

/** Verifies restarting a drag doesn't stack listeners, and cancel abandons it without `end`. */
test("createWindowMouseDrag restarts and cancels without stacking listeners", () => {
  const target = new EventTarget();
  const { calls, drag } = recordDrag(target);

  drag.start();
  drag.start();
  target.dispatchEvent(new Event("mousemove"));
  drag.cancel();
  target.dispatchEvent(new Event("mouseup"));

  assert.deepEqual(calls, ["move"]);
});
