// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  beginShowfileTransition,
  endShowfileTransition,
  showfileTransition,
  showfileTransitionDataReady,
} from "./showfile-transition";

const started = { resyncGeneration: 4, showfileRevision: 2 };

/** Verifies the dock stays hidden until the new world's resync, show, and layout all arrive. */
test("showfileTransitionDataReady waits for resync, confirmation, and layout", () => {
  const ready = {
    resyncComplete: true,
    resyncGeneration: 5,
    showfileRevision: 3,
    layoutShowfileRevision: 3,
  };
  assert.equal(showfileTransitionDataReady(started, ready), true);
  assert.equal(
    showfileTransitionDataReady(started, { ...ready, resyncComplete: false }),
    false,
  );
  assert.equal(
    showfileTransitionDataReady(started, { ...ready, resyncGeneration: 4 }),
    false,
    "the previous world's resync does not count",
  );
  assert.equal(
    showfileTransitionDataReady(started, {
      ...ready,
      showfileRevision: 2,
      layoutShowfileRevision: 2,
    }),
    false,
    "the replacement show must be confirmed",
  );
  assert.equal(
    showfileTransitionDataReady(started, {
      ...ready,
      layoutShowfileRevision: 2,
    }),
    false,
    "Dockview must restore the new show's layout",
  );
});

/** Verifies overlapping replacements keep the first transition's baseline until it ends. */
test("beginShowfileTransition keeps the pending baseline", () => {
  beginShowfileTransition(started);
  beginShowfileTransition({ resyncGeneration: 9, showfileRevision: 9 });
  assert.deepEqual(showfileTransition.get(), started);
  endShowfileTransition();
  assert.equal(showfileTransition.get(), null);
});
