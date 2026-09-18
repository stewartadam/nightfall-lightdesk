// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { durationToMs } from "../../../lib/duration";
import type * as types from "../../../types";
import { FadeCurve, TrackingFlags } from "../../../types";
import type { TapPatternCluster } from "./tap-pattern-analysis";
import {
  canCreateTapPatternSequence,
  createTapPatternSequence,
} from "./tap-pattern-sequence-generation";

/** Builds a detected pattern cluster for generation tests. */
function cluster(id: number, phaseMs: number): TapPatternCluster {
  return {
    id,
    phaseMs,
    tapIds: [id + 1, id + 10],
    averageErrorMs: 0,
  };
}

/** Builds an empty fixed transition mode for existing sequence fixtures. */
function fixedZeroMode(): types.TransitionMode {
  return { type: "Fixed", data: { secs: 0, nanos: 0 } };
}

/** Builds a minimal cue for existing sequence fixtures. */
function cue(uid: string, id: number, label: string): types.Cue {
  return {
    identifiers: { uid, id, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    tracking_flags: TrackingFlags.HTP,
    tracking_mode: { type: "Inherit" },
  };
}

/** Builds a minimal existing sequence fixture. */
function sequence(id: number): types.Sequence {
  return {
    identifiers: { uid: `seq-${id}`, id, label: `Sequence ${id}` },
    steps: [],
    wrap: false,
    release_on_start: false,
    setup_cue: cue(`setup-${id}`, 0, "Setup"),
    release_cue: cue(`release-${id}`, 0, "Release"),
    default_timing: {
      delay_in: fixedZeroMode(),
      fade_in: fixedZeroMode(),
      curve_in: FadeCurve.Linear,
      delay_out: fixedZeroMode(),
      fade_out: fixedZeroMode(),
      curve_out: FadeCurve.Linear,
    },
    tracking_mode: {
      type: "Flags",
      data: { __Composed__: 7 } as unknown as TrackingFlags,
    },
  };
}

/** Returns the AfterDelay duration stored on a generated cue. */
function cueAfterDelayMs(cue: types.Cue): number {
  assert.equal(cue.trigger.type, "AfterDelay");
  return durationToMs(cue.trigger.data);
}

test("canCreateTapPatternSequence requires at least one cluster", () => {
  assert.equal(canCreateTapPatternSequence(null), false);
  assert.equal(canCreateTapPatternSequence({ clusters: [] }), false);
  assert.equal(
    canCreateTapPatternSequence({ clusters: [cluster(0, 0)] }),
    true,
  );
  assert.equal(
    canCreateTapPatternSequence({ clusters: [cluster(0, 0), cluster(1, 100)] }),
    true,
  );
});

test("createTapPatternSequence creates a wrapped one-shot cue", () => {
  const generated = createTapPatternSequence({
    clusters: [cluster(0, 250)],
    loopLengthMs: 1500,
    existingSequences: [],
  });

  assert.equal(generated.sequence.identifiers.id, 1);
  assert.equal(generated.sequence.identifiers.label, "Tap Pattern 1");
  assert.equal(generated.sequence.wrap, true);
  assert.deepEqual(generated.sequence.steps, [
    generated.cues[0].identifiers.uid,
  ]);
  assert.equal(generated.cues.length, 1);
  assert.equal(generated.cues[0].identifiers.id, 1);
  assert.equal(generated.cues[0].identifiers.label, "Step 1");
  assert.equal(cueAfterDelayMs(generated.cues[0]), 1500);
  assert.equal(generated.cues[0].instructions.length, 0);
  assert.equal(generated.cues[0].parts?.length ?? 0, 0);
  assert.deepEqual(generated.cues[0].tracking_mode, { type: "Inherit" });
});

test("createTapPatternSequence maps pattern phases to wrapped AfterDelay cues", () => {
  const generated = createTapPatternSequence({
    clusters: [
      cluster(2, 520),
      cluster(0, 0),
      cluster(3, 900),
      cluster(1, 180),
    ],
    loopLengthMs: 1200,
    existingSequences: [sequence(1), sequence(2)],
  });

  assert.equal(generated.sequence.identifiers.id, 3);
  assert.equal(generated.sequence.identifiers.label, "Tap Pattern 3");
  assert.equal(generated.sequence.wrap, true);
  assert.deepEqual(
    generated.sequence.steps,
    generated.cues.map((cue) => cue.identifiers.uid),
  );
  assert.deepEqual(
    generated.cues.map((cue) => cue.identifiers.id),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    generated.cues.map((cue) => cue.identifiers.label),
    ["Step 1", "Step 2", "Step 3", "Step 4"],
  );
  assert.deepEqual(generated.cues.map(cueAfterDelayMs), [300, 180, 340, 380]);
  assert.deepEqual(
    generated.cues.map((cue) => cue.instructions.length),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    generated.cues.map((cue) => cue.parts?.length ?? 0),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    generated.cues.map((cue) => cue.tracking_mode),
    [
      { type: "Inherit" },
      { type: "Inherit" },
      { type: "Inherit" },
      { type: "Inherit" },
    ],
  );
});

test("createTapPatternSequence rejects incomplete pattern input", () => {
  assert.throws(
    () =>
      createTapPatternSequence({
        clusters: [],
        loopLengthMs: 1000,
        existingSequences: [],
      }),
    /at least one step/,
  );
  assert.throws(
    () =>
      createTapPatternSequence({
        clusters: [cluster(0, 0), cluster(1, 100)],
        loopLengthMs: 0,
        existingSequences: [],
      }),
    /positive loop length/,
  );
});
