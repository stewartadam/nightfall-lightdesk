// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { msToDuration } from "../../../lib/duration";
import * as types from "../../../types";
import {
  firstSequenceCue,
  normalizeFirstCueWrapDelay,
  triggerDurationEdit,
  triggerDurationOrZero,
  wrapDelayTrigger,
} from "./sequence-wrap-delay";

/** Builds a minimal cue with the requested trigger for wrap-delay tests. */
function cue(trigger: types.CueTriggerType): types.Cue {
  return {
    identifiers: {
      id: 1,
      uid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      label: "Cue 1",
    },
    trigger,
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    tracking_flags: types.TrackingFlags.HTP,
  };
}

/** Builds a minimal sequence with one step for wrap-delay tests. */
function sequence(cueUid: string): types.Sequence {
  return {
    identifiers: {
      id: 1,
      uid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      label: "Sequence",
    },
    steps: [cueUid],
    wrap: true,
    release_on_start: false,
    setup_cue: cue({ type: "Manual" }),
    release_cue: cue({ type: "Manual" }),
    default_timing: {
      delay_in: { type: "Fixed", data: msToDuration(0) },
      fade_in: { type: "Fixed", data: msToDuration(0) },
      curve_in: types.FadeCurve.Linear,
      delay_out: { type: "Fixed", data: msToDuration(0) },
      fade_out: { type: "Fixed", data: msToDuration(0) },
      curve_out: types.FadeCurve.Linear,
    },
    tracking_mode: {
      type: "Flags",
      data: { __Composed__: 7 } as unknown as types.TrackingFlags,
    },
  };
}

test("normalizeFirstCueWrapDelay preserves wrapped cue duration as AfterDelay", () => {
  const source = cue({ type: "At", data: msToDuration(2500) });
  const normalized = normalizeFirstCueWrapDelay(source, true);

  assert.deepEqual(normalized?.trigger, {
    type: "AfterDelay",
    data: msToDuration(2500),
  });
});

test("normalizeFirstCueWrapDelay forces disabled wrap delay to zero", () => {
  const source = cue({ type: "AfterDelay", data: msToDuration(2500) });
  const normalized = normalizeFirstCueWrapDelay(source, false);

  assert.deepEqual(normalized?.trigger, {
    type: "AfterDelay",
    data: msToDuration(0),
  });
});

test("normalizeFirstCueWrapDelay skips already normalized first cues", () => {
  assert.equal(
    normalizeFirstCueWrapDelay(
      cue({ type: "AfterDelay", data: msToDuration(0) }),
      false,
    ),
    undefined,
  );
  assert.equal(
    normalizeFirstCueWrapDelay(
      cue({ type: "AfterDelay", data: msToDuration(500) }),
      true,
    ),
    undefined,
  );
});

test("triggerDurationOrZero returns zero for non-duration triggers", () => {
  assert.deepEqual(triggerDurationOrZero({ type: "Manual" }), msToDuration(0));
});

test("triggerDurationEdit forces wrap-delay edits to AfterDelay", () => {
  assert.deepEqual(
    triggerDurationEdit(
      { type: "At", data: msToDuration(5000) },
      msToDuration(3000),
      true,
    ),
    wrapDelayTrigger(msToDuration(3000)),
  );
});

test("triggerDurationEdit preserves non-wrap duration trigger type", () => {
  assert.deepEqual(
    triggerDurationEdit(
      { type: "At", data: msToDuration(5000) },
      msToDuration(3000),
      false,
    ),
    { type: "At", data: msToDuration(3000) },
  );
});

test("firstSequenceCue resolves the first loaded sequence step", () => {
  const first = cue({ type: "Manual" });
  assert.equal(
    firstSequenceCue(sequence(first.identifiers.uid), {
      [first.identifiers.uid]: first,
    }),
    first,
  );
});
