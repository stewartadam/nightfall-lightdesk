// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type FaderBeatState,
  INITIAL_FADER_BEAT_STATE,
  nextFaderBeatState,
} from "./startup-fader-animation";

/** Returns a deterministic random source backed by the supplied sequence. */
function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

/** Verifies every fader can receive the large movement role on a beat. */
test("nextFaderBeatState randomly assigns each travel magnitude", () => {
  const leftLarge = nextFaderBeatState(
    INITIAL_FADER_BEAT_STATE,
    sequenceRandom([0, 0, 0.9, 0.9, 0.9]),
  );
  const middleLarge = nextFaderBeatState(
    INITIAL_FADER_BEAT_STATE,
    sequenceRandom([0.4, 0, 0.9, 0.9, 0.9]),
  );
  const rightLarge = nextFaderBeatState(
    INITIAL_FADER_BEAT_STATE,
    sequenceRandom([0.9, 0.9, 0.9, 0.9, 0.9]),
  );

  assert.deepEqual(leftLarge, {
    beat: 1,
    left: 5,
    middle: 3,
    right: 1,
    travelMagnitudes: [5, 3, 1],
  });
  assert.deepEqual(middleLarge, {
    beat: 1,
    left: 3,
    middle: 5,
    right: 1,
    travelMagnitudes: [3, 5, 1],
  });
  assert.deepEqual(rightLarge, {
    beat: 1,
    left: 1,
    middle: 3,
    right: 5,
    travelMagnitudes: [1, 3, 5],
  });
});

/** Verifies both random next assignments change every fader's magnitude. */
test("nextFaderBeatState prevents consecutive magnitude repetitions", () => {
  const current: FaderBeatState = {
    beat: 1,
    left: 0,
    middle: 0,
    right: 0,
    travelMagnitudes: [5, 3, 1],
  };
  const forward = nextFaderBeatState(
    current,
    sequenceRandom([0, 0.9, 0.9, 0.9]),
  );
  const backward = nextFaderBeatState(
    current,
    sequenceRandom([0.9, 0.9, 0.9, 0.9]),
  );

  assert.deepEqual(forward.travelMagnitudes, [1, 5, 3]);
  assert.deepEqual(backward.travelMagnitudes, [3, 1, 5]);
  for (const next of [forward, backward]) {
    assert.deepEqual(
      [...(next.travelMagnitudes ?? [])].sort((left, right) => left - right),
      [1, 3, 5],
    );
    next.travelMagnitudes?.forEach((magnitude, index) => {
      assert.notEqual(magnitude, current.travelMagnitudes?.[index]);
    });
  }
});

/** Verifies the no-repeat rule remains true across an extended beat sequence. */
test("nextFaderBeatState avoids magnitude repetitions across cycles", () => {
  let state = nextFaderBeatState(
    INITIAL_FADER_BEAT_STATE,
    sequenceRandom([0, 0, 0.9, 0.9, 0.9]),
  );

  for (let beat = 0; beat < 20; beat += 1) {
    const previous = state;
    state = nextFaderBeatState(previous, () => 0);
    state.travelMagnitudes?.forEach((magnitude, index) => {
      assert.notEqual(magnitude, previous.travelMagnitudes?.[index]);
    });
    assert.ok(Math.abs(state.left) <= 5);
    assert.ok(Math.abs(state.middle) <= 5);
    assert.ok(Math.abs(state.right) <= 5);
  }
});

/** Verifies large and medium moves choose an in-range direction near boundaries. */
test("nextFaderBeatState keeps every fader within its movement range", () => {
  const current: FaderBeatState = {
    beat: 3,
    left: 5,
    middle: -5,
    right: 4,
    travelMagnitudes: [3, 1, 5],
  };
  const next = nextFaderBeatState(current, sequenceRandom([0, 0.9, 0.9, 0.9]));

  assert.deepEqual(next, {
    beat: 0,
    left: 0,
    middle: -2,
    right: 5,
    travelMagnitudes: [5, 3, 1],
  });
  assert.deepEqual(
    [
      Math.abs(next.left - current.left),
      Math.abs(next.middle - current.middle),
      Math.abs(next.right - current.right),
    ].sort((left, right) => left - right),
    [1, 3, 5],
  );
});
