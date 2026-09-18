// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resetCameraPointerDragForRenderer } from "./camera-drag-reset";

/**
 * Builds a renderer stub that records camera drag enablement changes.
 */
function makeRenderer() {
  const states: boolean[] = [];
  return {
    renderer: {
      setCameraDragEnabled(enabled: boolean) {
        states.push(enabled);
      },
    },
    states,
  };
}

test("resetCameraPointerDragForRenderer clears camera drag until the next frame", () => {
  const { renderer, states } = makeRenderer();
  let scheduledCallback: (() => void) | undefined;

  resetCameraPointerDragForRenderer(
    () => renderer,
    (callback) => {
      scheduledCallback = callback;
    },
  );

  assert.deepEqual(states, [false]);
  scheduledCallback?.();
  assert.deepEqual(states, [false, true]);
});

test("resetCameraPointerDragForRenderer ignores a missing renderer", () => {
  let scheduled = false;

  resetCameraPointerDragForRenderer(
    () => undefined,
    () => {
      scheduled = true;
    },
  );

  assert.equal(scheduled, false);
});
