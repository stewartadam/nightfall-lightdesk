// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type Cue,
  FadeCurve,
  type Sequence,
  TrackingFlags,
  type Transition,
} from "../types";
import {
  buildSequencePreviewCue,
  buildSequencePreviewPayload,
} from "./sequence-preview-cue";

/**
 * Builds a fixed transition mode from seconds for preview cue tests.
 */
const fixed = (secs: number) =>
  ({
    type: "Fixed",
    data: { secs, nanos: 0 },
  }) as const;

/**
 * Builds a minimal cue for preview-cue tests.
 */
const cue = (overrides: Partial<Cue> = {}): Cue => ({
  identifiers: { id: 1, uid: "cue-1", label: "Cue 1" },
  trigger: { type: "Manual" },
  transitions: {},
  transitions_by_attribute: {},
  instructions: [
    {
      selection: {} as Cue["instructions"][number]["selection"],
      cue_instruction: {
        values: {},
        transitions: {},
        transitions_by_attribute: {},
        transitions_by_fixture_attribute: [],
      },
    },
  ],
  tracking_flags: TrackingFlags.HTP,
  ...overrides,
});

/**
 * Builds a sequence containing the supplied cue UIDs.
 */
const sequence = (steps: string[]): Sequence => ({
  identifiers: { id: 1, uid: "sequence-1", label: "Sequence 1" },
  steps,
  default_timing: defaultTiming,
  setup_cue: cue({
    identifiers: { id: 0, uid: "sequence-1-setup", label: "Setup" },
  }),
  release_cue: cue({
    identifiers: { id: 0, uid: "sequence-1-release", label: "Release" },
  }),
  release_on_start: false,
  wrap: false,
  tracking_mode: {
    type: "Flags",
    data: { __Composed__: 7 } as unknown as TrackingFlags,
  },
});

const defaultTiming: Transition = {
  delay_in: fixed(1),
  fade_in: fixed(2),
  curve_in: FadeCurve.EaseIn,
  delay_out: fixed(3),
  fade_out: fixed(4),
  curve_out: FadeCurve.EaseOut,
};

const immediateTransition = {
  delay_in: fixed(0),
  fade_in: fixed(0),
  delay_out: fixed(0),
  fade_out: fixed(0),
};

test("buildSequencePreviewCue inherits missing cue timing from sequence defaults", () => {
  const previewCue = buildSequencePreviewCue(
    cue({ transitions: { fade_in: fixed(9) } }),
    defaultTiming,
    { applyTransitions: true },
  );

  assert.deepEqual(previewCue.transitions, {
    delay_in: defaultTiming.delay_in,
    fade_in: fixed(9),
    curve_in: defaultTiming.curve_in,
    delay_out: defaultTiming.delay_out,
    fade_out: defaultTiming.fade_out,
    curve_out: defaultTiming.curve_out,
  });
});

test("buildSequencePreviewCue removes transitions when preview transitions are disabled", () => {
  const previewCue = buildSequencePreviewCue(
    cue({
      transitions: { fade_in: fixed(9) },
      transitions_by_attribute: {
        Dimmer: { fade_in: fixed(8) },
      },
      instructions: [
        {
          selection: {} as Cue["instructions"][number]["selection"],
          cue_instruction: {
            values: {},
            transitions: { delay_in: fixed(7) },
            transitions_by_attribute: {
              Dimmer: { fade_in: fixed(8) },
            },
            transitions_by_fixture_attribute: [
              {
                fixture: { fixture_uid: "fixture-1" },
                transitions_by_attribute: {
                  Dimmer: { delay_in: fixed(6) },
                },
              },
            ],
          },
        },
      ],
    }),
    defaultTiming,
    { applyTransitions: false },
  );

  assert.deepEqual(previewCue.transitions_by_attribute, {});
  assert.deepEqual(
    previewCue.instructions[0].cue_instruction.transitions_by_attribute,
    {},
  );
  assert.deepEqual(
    previewCue.instructions[0].cue_instruction.transitions_by_fixture_attribute,
    [],
  );
  assert.deepEqual(previewCue.transitions.fade_in, fixed(0));
  assert.deepEqual(previewCue.transitions.delay_in, fixed(0));
  assert.deepEqual(previewCue.transitions.fade_out, fixed(0));
  assert.deepEqual(previewCue.transitions.delay_out, fixed(0));
  assert.deepEqual(
    previewCue.instructions[0].cue_instruction.transitions,
    immediateTransition,
  );
});

test("buildSequencePreviewCue keeps carried preview instructions immediate", () => {
  const carriedCue = buildSequencePreviewCue(
    cue({
      instructions: [
        {
          selection: {} as Cue["instructions"][number]["selection"],
          cue_instruction: {
            values: {},
            transitions: { fade_in: fixed(7) },
            transitions_by_attribute: {
              Dimmer: { fade_in: fixed(8) },
            },
            transitions_by_fixture_attribute: [
              {
                fixture: { fixture_uid: "fixture-1" },
                transitions_by_attribute: {
                  Dimmer: { delay_in: fixed(6) },
                },
              },
            ],
          },
        },
      ],
    }),
    defaultTiming,
    { applyTransitions: false },
  );

  const activeCue = buildSequencePreviewCue(
    cue({
      transitions: { fade_in: fixed(9) },
      instructions: [
        ...carriedCue.instructions,
        {
          selection: {} as Cue["instructions"][number]["selection"],
          cue_instruction: {
            values: {},
            transitions: {},
            transitions_by_attribute: {},
            transitions_by_fixture_attribute: [],
          },
        },
      ],
    }),
    defaultTiming,
    { applyTransitions: true },
  );

  assert.deepEqual(
    activeCue.instructions[0].cue_instruction.transitions,
    immediateTransition,
  );
  assert.deepEqual(activeCue.instructions[1].cue_instruction.transitions, {});
  assert.deepEqual(activeCue.transitions.fade_in, fixed(9));
  assert.deepEqual(activeCue.transitions.delay_in, defaultTiming.delay_in);
});

test("buildSequencePreviewPayload sends tracked previous cues and active transitions", () => {
  const previousCue = cue({
    identifiers: { id: 1, uid: "cue-1", label: "Cue 1" },
    instructions: [
      {
        selection: {} as Cue["instructions"][number]["selection"],
        cue_instruction: {
          values: {},
          transitions: { fade_in: fixed(7) },
          transitions_by_attribute: {
            Dimmer: { fade_in: fixed(8) },
          },
          transitions_by_fixture_attribute: [],
        },
      },
    ],
  });
  const activeCue = cue({
    identifiers: { id: 2, uid: "cue-2", label: "Cue 2" },
    transitions: { fade_in: fixed(9) },
    instructions: [
      {
        selection: {} as Cue["instructions"][number]["selection"],
        cue_instruction: {
          values: {},
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
  });

  const payload = buildSequencePreviewPayload(
    sequence(["cue-1", "cue-2"]),
    { "cue-1": previousCue, "cue-2": activeCue },
    activeCue,
    {
      applyTransitions: true,
      trackValues: true,
    },
  );

  assert.deepEqual(payload.sequence.steps, ["cue-1", "cue-2"]);
  assert.equal(payload.position, 2);
  assert.equal(payload.cues.length, 2);
  assert.deepEqual(
    payload.cues[0].instructions[0].cue_instruction.transitions,
    immediateTransition,
  );
  assert.deepEqual(
    payload.cues[1].instructions[0].cue_instruction.transitions,
    {},
  );
  assert.deepEqual(payload.cues[1].transitions.fade_in, fixed(9));
  assert.deepEqual(
    payload.cues[1].transitions.delay_in,
    defaultTiming.delay_in,
  );
});

test("buildSequencePreviewPayload keeps disabled transitions immediate", () => {
  const previousCue = cue({
    identifiers: { id: 1, uid: "cue-1", label: "Cue 1" },
    instructions: [
      {
        selection: {} as Cue["instructions"][number]["selection"],
        cue_instruction: {
          values: {},
          transitions: { fade_in: fixed(7) },
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
  });
  const activeCue = cue({
    identifiers: { id: 2, uid: "cue-2", label: "Cue 2" },
  });

  const payload = buildSequencePreviewPayload(
    sequence(["cue-1", "cue-2"]),
    { "cue-1": previousCue, "cue-2": activeCue },
    activeCue,
    {
      applyTransitions: false,
      trackValues: true,
    },
  );

  assert.deepEqual(payload.sequence.steps, ["cue-1", "cue-2"]);
  assert.equal(payload.position, 2);
  assert.equal(payload.cues.length, 2);
  assert.deepEqual(
    payload.cues[0].instructions[0].cue_instruction.transitions,
    immediateTransition,
  );
  assert.deepEqual(
    payload.cues[1].instructions[0].cue_instruction.transitions,
    immediateTransition,
  );
});

test("buildSequencePreviewPayload uses supplied active cue over stored cue", () => {
  const storedCue = cue({
    identifiers: { id: 1, uid: "cue-1", label: "Stored Cue" },
    transitions: { fade_in: fixed(1) },
  });
  const editedCue = cue({
    identifiers: { id: 1, uid: "cue-1", label: "Edited Cue" },
    transitions: { fade_in: fixed(9) },
  });

  const payload = buildSequencePreviewPayload(
    sequence(["cue-1"]),
    { "cue-1": storedCue },
    editedCue,
    {
      applyTransitions: true,
      trackValues: true,
    },
  );

  assert.equal(payload.cues[0].identifiers.label, "Edited Cue");
  assert.deepEqual(payload.cues[0].transitions.fade_in, fixed(9));
});

test("buildSequencePreviewCue applies sequence defaults to cue parts", () => {
  const previewCue = buildSequencePreviewCue(
    cue({
      parts: [
        {
          identifiers: { id: 1, uid: "part-1", label: "Part 1" },
          transitions: { fade_in: fixed(7) },
          transitions_by_attribute: {},
          instructions: [],
          tracking_flags: TrackingFlags.HTP,
        },
      ],
    }),
    defaultTiming,
    { applyTransitions: true },
  );

  assert.deepEqual(previewCue.parts?.[0].transitions, {
    delay_in: defaultTiming.delay_in,
    fade_in: fixed(7),
    curve_in: defaultTiming.curve_in,
    delay_out: defaultTiming.delay_out,
    fade_out: defaultTiming.fade_out,
    curve_out: defaultTiming.curve_out,
  });
});

test("buildSequencePreviewCue lets cue parts inherit parent cue timing", () => {
  const previewCue = buildSequencePreviewCue(
    cue({
      transitions: {
        fade_in: fixed(9),
        fade_out: fixed(8),
      },
      parts: [
        {
          identifiers: { id: 1, uid: "part-1", label: "Part 1" },
          transitions: { delay_in: fixed(7) },
          transitions_by_attribute: {},
          instructions: [],
          tracking_flags: TrackingFlags.HTP,
        },
      ],
    }),
    defaultTiming,
    { applyTransitions: true },
  );

  assert.deepEqual(previewCue.parts?.[0].transitions, {
    delay_in: fixed(7),
    fade_in: fixed(9),
    curve_in: defaultTiming.curve_in,
    delay_out: defaultTiming.delay_out,
    fade_out: fixed(8),
    curve_out: defaultTiming.curve_out,
  });
});

test("buildSequencePreviewCue removes cue part transitions when disabled", () => {
  const previewCue = buildSequencePreviewCue(
    cue({
      parts: [
        {
          identifiers: { id: 1, uid: "part-1", label: "Part 1" },
          transitions: { fade_in: fixed(7) },
          transitions_by_attribute: {
            Dimmer: { fade_in: fixed(8) },
          },
          instructions: [
            {
              selection: {} as Cue["instructions"][number]["selection"],
              cue_instruction: {
                values: {},
                transitions: { fade_in: fixed(6) },
                transitions_by_attribute: {
                  Dimmer: { fade_in: fixed(5) },
                },
                transitions_by_fixture_attribute: [
                  {
                    fixture: { fixture_uid: "fixture-1" },
                    transitions_by_attribute: {
                      Dimmer: { delay_in: fixed(4) },
                    },
                  },
                ],
              },
            },
          ],
          tracking_flags: TrackingFlags.HTP,
        },
      ],
    }),
    defaultTiming,
    { applyTransitions: false },
  );

  const part = previewCue.parts?.[0];
  assert.ok(part);
  assert.deepEqual(part.transitions_by_attribute, {});
  assert.deepEqual(part.transitions.fade_in, fixed(0));
  assert.deepEqual(part.transitions.delay_in, fixed(0));
  assert.deepEqual(part.transitions.fade_out, fixed(0));
  assert.deepEqual(part.transitions.delay_out, fixed(0));
  assert.deepEqual(
    part.instructions[0].cue_instruction.transitions,
    immediateTransition,
  );
  assert.deepEqual(
    part.instructions[0].cue_instruction.transitions_by_attribute,
    {},
  );
  assert.deepEqual(
    part.instructions[0].cue_instruction.transitions_by_fixture_attribute,
    [],
  );
});
