// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import { FadeCurve, TrackingFlags } from "../types";
import { duplicateSequencePayload } from "./sequence-duplication";

/** Creates a deterministic UID generator for duplication assertions. */
function uidGenerator(): () => string {
  let next = 0;
  return () => `uid-${++next}`;
}

/** Builds an empty fixed transition mode for test cue timing. */
function fixedZeroMode(): types.TransitionMode {
  return { type: "Fixed", data: { secs: 0, nanos: 0 } };
}

/** Builds a minimal cue with optional nested cue parts. */
function cue(uid: string, id: number, label: string): types.Cue {
  return {
    identifiers: { uid, id, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [
      {
        identifiers: { uid: `${uid}-part`, id: 1, label: "Part 1" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        tracking_flags: TrackingFlags.HTP,
      },
    ],
    tracking_flags: TrackingFlags.HTP,
  };
}

/** Builds a sequence containing the provided cue step UIDs. */
function sequence(
  uid: string,
  id: number,
  label: string,
  steps: string[],
): types.Sequence {
  return {
    identifiers: { uid, id, label },
    steps,
    wrap: false,
    release_on_start: false,
    setup_cue: cue(`${uid}-setup`, 0, "Setup"),
    release_cue: cue(`${uid}-release`, 0, "Release"),
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

test("duplicateSequencePayload creates an independent sequence and cue copies", () => {
  const sourceCue = cue("cue-a", 5, "Cue A");
  const sourceSequence = sequence("seq-a", 7, "Main", ["cue-a"]);
  const duplicated = duplicateSequencePayload({
    sourceSequence,
    existingSequences: [sequence("seq-existing", 1, "Existing", [])],
    cuesByUid: { "cue-a": sourceCue },
    createUid: uidGenerator(),
  });

  assert.equal(duplicated.sequence.identifiers.id, 2);
  assert.equal(duplicated.sequence.identifiers.uid, "uid-3");
  assert.equal(duplicated.sequence.identifiers.label, "Main Copy");
  assert.deepEqual(duplicated.sequence.steps, ["uid-1"]);
  assert.equal(duplicated.cues.length, 1);
  assert.equal(duplicated.cues[0]?.identifiers.id, sourceCue.identifiers.id);
  assert.equal(duplicated.cues[0]?.identifiers.uid, "uid-1");
  assert.equal(duplicated.cues[0]?.parts?.[0]?.identifiers.uid, "uid-2");
  assert.equal(duplicated.sequence.setup_cue.identifiers.uid, "uid-4");
  assert.equal(duplicated.sequence.release_cue.identifiers.uid, "uid-6");
  assert.notStrictEqual(duplicated.cues[0], sourceCue);
  assert.notStrictEqual(duplicated.sequence, sourceSequence);
});

test("duplicateSequencePayload maps repeated step references to one cue copy", () => {
  const sourceSequence = sequence("seq-a", 1, "", [
    "cue-a",
    "cue-a",
    "missing-cue",
  ]);
  const duplicated = duplicateSequencePayload({
    sourceSequence,
    existingSequences: [sourceSequence],
    cuesByUid: { "cue-a": cue("cue-a", 5, "Cue A") },
    createUid: uidGenerator(),
  });

  assert.equal(duplicated.sequence.identifiers.id, 2);
  assert.equal(duplicated.sequence.identifiers.label, "sequence 2");
  assert.deepEqual(duplicated.sequence.steps, [
    "uid-1",
    "uid-1",
    "missing-cue",
  ]);
  assert.equal(duplicated.cues.length, 1);
});
