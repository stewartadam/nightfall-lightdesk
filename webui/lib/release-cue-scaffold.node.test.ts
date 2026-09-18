// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types";
import { projectReleaseCueFromSequence } from "./release-cue-scaffold";

const sourceCueUid = "11111111111111111111111111111111";
const releaseCueUid = "22222222222222222222222222222222";
const sequenceUid = "33333333333333333333333333333333";
const storedFixtureUid = "44444444444444444444444444444444";
const projectedFixtureUid = "55555555555555555555555555555555";

/** Builds a fixed transition mode for release cue projection tests. */
function fixed(secs: number): types.TransitionMode {
  return {
    type: "Fixed",
    data: { secs, nanos: 0 },
  };
}

/** Builds a minimal cue instruction for one resolved fixture and Red value. */
function redInstruction(fixtureUid: string): types.BoundCueInstruction {
  return redInstructionForFixtures([fixtureUid]);
}

/** Builds a minimal cue instruction for resolved fixtures and a Red value. */
function redInstructionForFixtures(
  fixtureUids: string[],
): types.BoundCueInstruction {
  return {
    selection: {
      source: {
        type: "Resolved",
        data: fixtureUids.map((fixtureUid) => ({ fixture_uid: fixtureUid })),
      },
      clauses: [],
    },
    cue_instruction: {
      values: {
        Red: {
          type: "Inline",
          data: { type: "AbsolutePercent", data: { value: 1 } },
        },
      },
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Builds a minimal cue for release cue projection tests. */
function cue(
  uid: string,
  instructions: types.BoundCueInstruction[],
): types.Cue {
  return {
    identifiers: { id: 1, uid, label: "Cue" },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions,
    parts: [],
    tracking_flags: types.TrackingFlags.HTP,
  };
}

/** Builds a minimal sequence containing one source cue and release cue. */
function sequence(releaseCue: types.Cue): types.Sequence {
  return {
    identifiers: { id: 1, uid: sequenceUid, label: "Sequence" },
    steps: [sourceCueUid],
    wrap: false,
    release_on_start: false,
    setup_cue: cue(`${sequenceUid}-setup`, []),
    release_cue: releaseCue,
    default_timing: {
      delay_in: fixed(0),
      fade_in: fixed(0),
      curve_in: types.FadeCurve.Linear,
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: types.FadeCurve.Linear,
    },
    tracking_mode: {
      type: "Flags",
      data: { __Composed__: 7 } as unknown as types.TrackingFlags,
    },
  };
}

test("release cue projection preserves fixture timing when source row identity changes", () => {
  const releaseInstruction = redInstruction(storedFixtureUid);
  releaseInstruction.cue_instruction.transitions_by_fixture_attribute = [
    {
      fixture: { fixture_uid: projectedFixtureUid },
      transitions_by_attribute: {
        Red: {
          fade_out: fixed(4),
        },
      },
    },
  ];
  const releaseCue = cue(releaseCueUid, [releaseInstruction]);
  const sourceCue = cue(sourceCueUid, [redInstruction(projectedFixtureUid)]);

  const projectedCue = projectReleaseCueFromSequence(sequence(releaseCue), {
    [sourceCueUid]: sourceCue,
  });

  const projectedTiming =
    projectedCue.instructions[0]?.cue_instruction
      .transitions_by_fixture_attribute?.[0]?.transitions_by_attribute.Red
      ?.fade_out;
  assert.equal(
    projectedTiming?.type === "Fixed" ? projectedTiming.data.secs : undefined,
    4,
  );
});

/** Verifies newly merged release fixtures inherit release cue-wide timing. */
test("release cue projection leaves merged fixtures on cue-wide timing", () => {
  const addedFixtureUid = "66666666666666666666666666666666";
  const releaseInstruction = redInstruction(storedFixtureUid);
  releaseInstruction.cue_instruction.transitions_by_fixture_attribute = [
    {
      fixture: { fixture_uid: storedFixtureUid },
      transitions_by_attribute: {
        Red: {
          fade_out: fixed(6),
        },
      },
    },
  ];
  const releaseCue = cue(releaseCueUid, [releaseInstruction]);
  releaseCue.transitions_by_attribute = {
    Red: {
      delay_out: fixed(2),
      fade_out: fixed(4),
    },
  };
  const sourceCue = cue(sourceCueUid, [
    redInstructionForFixtures([storedFixtureUid, addedFixtureUid]),
  ]);

  const projectedCue = projectReleaseCueFromSequence(sequence(releaseCue), {
    [sourceCueUid]: sourceCue,
  });

  const existingTiming =
    projectedCue.instructions[0]?.cue_instruction.transitions_by_fixture_attribute?.find(
      (entry) => entry.fixture.fixture_uid === storedFixtureUid,
    )?.transitions_by_attribute.Red;
  const addedTiming =
    projectedCue.instructions[0]?.cue_instruction.transitions_by_fixture_attribute?.find(
      (entry) => entry.fixture.fixture_uid === addedFixtureUid,
    )?.transitions_by_attribute.Red;
  assert.equal(
    projectedCue.transitions_by_attribute.Red?.delay_out?.type === "Fixed"
      ? projectedCue.transitions_by_attribute.Red.delay_out.data.secs
      : undefined,
    2,
  );
  assert.equal(
    projectedCue.transitions_by_attribute.Red?.fade_out?.type === "Fixed"
      ? projectedCue.transitions_by_attribute.Red.fade_out.data.secs
      : undefined,
    4,
  );
  assert.equal(
    existingTiming?.fade_out?.type === "Fixed"
      ? existingTiming.fade_out.data.secs
      : undefined,
    6,
  );
  assert.equal(addedTiming, undefined);
});
