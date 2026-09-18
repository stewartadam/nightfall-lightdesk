// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import {
  calculateCueTransitionDurations,
  createTransitionModeResolver,
  deleteInstructionAttributeTiming,
  deleteInstructionFixtureAttributeTiming,
  resolveCueInstructionTiming,
  resolvedSelectionTimingIndexes,
  selectionTimingPositionForFixtureAttribute,
  setSpatialProjectionProjectorForTesting,
  setTransitionModeResolverForTesting,
  type TimingField,
  upsertInstructionFixtureAttributeTiming,
} from "./cue-timing-values";

const duration = (secs: number): types.Duration => ({ secs, nanos: 0 });
const fixed = (secs: number): types.TransitionMode => ({
  type: "Fixed",
  data: duration(secs),
});
const interpolated = (start: number, end: number): types.TransitionMode => ({
  type: "Interpolated",
  data: { start: duration(start), end: duration(end) },
});
const manual = (values: number[]): types.TransitionMode => ({
  type: "Manual",
  data: values.map(duration),
});
const seconds = (value: types.Duration | undefined): number =>
  value ? value.secs + value.nanos / 1_000_000_000 : 0;
const durationFromSeconds = (value: number): types.Duration => ({
  secs: Math.trunc(value),
  nanos: Math.trunc((value % 1) * 1_000_000_000),
});
const uid = (id: number): string => id.toString().padStart(32, "0");
const parameter = (attribute: string): types.ParameterMetadata =>
  ({
    attribute: { type: attribute },
  }) as types.ParameterMetadata;

setSpatialProjectionProjectorForTesting(async (selection) => {
  const source =
    selection.source.type === "Resolved" ? selection.source.data : [];
  let groups = source.map((fixture) => [fixture]);

  for (const clause of selection.clauses ?? []) {
    if (
      clause.type === "Wings" &&
      clause.data.axis === "X" &&
      clause.data.amount === 2
    ) {
      const midpoint = Math.ceil(groups.length / 2);
      const left = groups.slice(0, midpoint);
      const right = groups.slice(midpoint).reverse();
      groups = Array.from(
        { length: Math.max(left.length, right.length) },
        (_, index) => [...(left[index] ?? []), ...(right[index] ?? [])],
      );
    }
  }

  return {
    resolved: {
      canonical: source,
      indexes: groups.map((members, index) => ({
        index,
        invert: false,
        members: members.map((fixture) => ({
          fixture,
          projected_coord: { x: index, y: 0, z: 0 },
        })),
      })),
    },
    issues: [],
  };
});

setTransitionModeResolverForTesting(async (requests) =>
  requests.map(({ mode, offset, total }) => {
    switch (mode.type) {
      case "Fixed":
        return mode.data;
      case "Interpolated": {
        const start = seconds(mode.data.start);
        const end = seconds(mode.data.end);
        if (total <= 1) return mode.data.start;
        if (offset + 1 >= total) return mode.data.end;
        return durationFromSeconds(
          start + ((offset + 1) / total) * (end - start),
        );
      }
      case "Manual": {
        if (mode.data.length === 0) return duration(0);
        if (mode.data.length === 1 || total <= 1)
          return mode.data[0] ?? duration(0);
        const t = offset / Math.max(total - 1, 1);
        const maxSegment = mode.data.length - 1;
        const segmentPosition = t * maxSegment;
        const segmentIndex = Math.min(
          Math.trunc(segmentPosition),
          maxSegment - 1,
        );
        const segmentT = segmentPosition - segmentIndex;
        const start = seconds(mode.data[segmentIndex]);
        const end = seconds(mode.data[segmentIndex + 1]);
        return durationFromSeconds(start + segmentT * (end - start));
      }
    }
    return duration(0);
  }),
);

test("createTransitionModeResolver batches fanned timing resolution", async () => {
  const resolver = createTransitionModeResolver();
  const values = await Promise.all([
    resolver.resolve(fixed(2), 1, 3),
    resolver.resolve(interpolated(1, 5), 0, 2),
    resolver.resolve(interpolated(1, 5), 1, 2),
    resolver.resolve(interpolated(1, 5), 0, 1),
    resolver.resolve(manual([0, 10]), 0, 3),
    resolver.resolve(manual([0, 10]), 1, 3),
    resolver.resolve(manual([0, 10]), 2, 3),
    resolver.resolve(manual([0, 10, 0]), 1, 3),
  ]);

  assert.deepEqual(values, [2, 3, 5, 1, 0, 5, 10, 10]);
});

test("resolveCueInstructionTiming applies precedence and resolves fanned fields", async () => {
  const resolver = createTransitionModeResolver();
  const cue = {
    transitions: {
      fade_in: fixed(1),
      delay_in: fixed(2),
      fade_out: fixed(3),
      delay_out: fixed(4),
    },
    transitions_by_attribute: {
      Intensity: {
        fade_in: interpolated(1, 5),
      },
    },
  } as unknown as types.Cue;
  const instruction = {
    transitions: {
      fade_in: fixed(9),
      delay_out: manual([0, 2, 0]),
    },
    transitions_by_attribute: {
      Intensity: {
        delay_in: fixed(7),
      },
    },
    transitions_by_fixture_attribute: [
      {
        fixture: { fixture_uid: "fixture-1", index: 1 },
        transitions_by_attribute: {
          Intensity: {
            fade_in: fixed(11),
          },
        },
      },
    ],
  } as unknown as types.CueInstruction;

  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "delay_in",
      0,
      3,
    ),
    { value: 7, inherited: false },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "fade_in",
      1,
      3,
      { fixture_uid: "fixture-1", index: 1 },
    ),
    { value: 11, inherited: false },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "fade_in",
      1,
      3,
    ),
    { value: 9, inherited: true },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "delay_in",
      0,
      3,
      { fixture_uid: "fixture-1", index: 2 },
    ),
    { value: 7, inherited: true },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "delay_in",
      0,
      3,
      { fixture_uid: "fixture-1" },
    ),
    { value: 7, inherited: false },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "delay_out",
      1,
      3,
    ),
    { value: 2, inherited: true },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "fade_out",
      0,
      3,
    ),
    { value: 3, inherited: true },
  );
});

/** Verifies element rows style fixture-wide timing as inherited after exact overrides clear. */
test("resolveCueInstructionTiming marks fixture-wide timing inherited on element rows", async () => {
  const resolver = createTransitionModeResolver();
  const cue = {
    transitions: {},
  } as unknown as types.Cue;
  const instruction = {
    transitions_by_fixture_attribute: [
      {
        fixture: { fixture_uid: "fixture-1" },
        transitions_by_attribute: {
          Intensity: {
            fade_in: fixed(4),
            delay_in: fixed(2),
          },
        },
      },
      {
        fixture: { fixture_uid: "fixture-1", index: 1 },
        transitions_by_attribute: {
          Intensity: {
            fade_in: fixed(7),
          },
        },
      },
    ],
  } as unknown as types.CueInstruction;

  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "fade_in",
      0,
      1,
      { fixture_uid: "fixture-1", index: 1 },
    ),
    { value: 7, inherited: false },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "delay_in",
      0,
      1,
      { fixture_uid: "fixture-1", index: 1 },
    ),
    { value: 2, inherited: true },
  );
  assert.deepEqual(
    await resolveCueInstructionTiming(
      resolver,
      cue,
      instruction,
      "Intensity",
      "delay_in",
      0,
      1,
      { fixture_uid: "fixture-1" },
    ),
    { value: 2, inherited: false },
  );
});

test("fixture attribute timing helpers edit only the selected fixture ref", () => {
  const instruction = {
    transitions_by_fixture_attribute: [],
  } as unknown as types.CueInstruction;
  const first = { fixture_uid: "fixture-1", index: 1 };
  const second = { fixture_uid: "fixture-1", index: 2 };

  upsertInstructionFixtureAttributeTiming(
    instruction,
    first,
    "Intensity",
    "delay_in",
    fixed(3),
  );
  upsertInstructionFixtureAttributeTiming(
    instruction,
    second,
    "Intensity",
    "delay_in",
    fixed(5),
  );

  assert.deepEqual(
    instruction.transitions_by_fixture_attribute?.[0]?.transitions_by_attribute
      .Intensity.delay_in,
    fixed(3),
  );
  assert.deepEqual(
    instruction.transitions_by_fixture_attribute?.[1]?.transitions_by_attribute
      .Intensity.delay_in,
    fixed(5),
  );

  deleteInstructionFixtureAttributeTiming(
    instruction,
    first,
    "Intensity",
    "delay_in",
  );
  assert.equal(instruction.transitions_by_fixture_attribute?.length, 1);
  assert.deepEqual(
    instruction.transitions_by_fixture_attribute?.[0]?.fixture,
    second,
  );
});

test("deleteInstructionAttributeTiming clears only the selected field", () => {
  const instruction = {
    transitions_by_attribute: {
      Intensity: {
        fade_in: fixed(1),
        fade_out: fixed(2),
        delay_in: fixed(3),
        delay_out: fixed(4),
      },
    },
  } as unknown as types.CueInstruction;

  deleteInstructionAttributeTiming(instruction, "Intensity", "fade_in");
  const transition = instruction.transitions_by_attribute.Intensity;
  assert.equal(transition.fade_in, undefined);
  assert.deepEqual(transition.fade_out, fixed(2));
  assert.deepEqual(transition.delay_in, fixed(3));
  assert.deepEqual(transition.delay_out, fixed(4));

  for (const field of ["fade_out", "delay_in", "delay_out"] as TimingField[]) {
    deleteInstructionAttributeTiming(instruction, "Intensity", field);
  }
  assert.deepEqual(instruction.transitions_by_attribute, {});
});

test("calculateCueTransitionDurations includes instruction fanned timings", async () => {
  const cue = {
    transitions: {},
    transitions_by_attribute: {},
    instructions: [
      {
        selection: {
          source: {
            type: "Resolved",
            data: [
              { fixture_uid: uid(1), index: 1 },
              { fixture_uid: uid(2), index: 1 },
            ],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            Intensity: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 1 } },
            },
            Green: {
              type: "Inline",
              data: { type: "Absolute", data: { value: 1 } },
            },
          },
          transitions: {
            delay_in: interpolated(0, 2),
            fade_in: interpolated(0.25, 2.25),
            delay_out: manual([0, 1, 0]),
            fade_out: interpolated(2.5, 0.5),
          },
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [
            {
              fixture: { fixture_uid: uid(1), index: 1 },
              transitions_by_attribute: {
                Green: {
                  fade_out: fixed(9),
                },
              },
            },
          ],
        },
      },
    ],
  } as unknown as types.Cue;

  assert.deepEqual(await calculateCueTransitionDurations(cue), {
    delayIn: 2,
    fadeIn: 2.25,
    delayOut: 0,
    fadeOut: 9,
    inDuration: 4.25,
    outDuration: 9,
    totalDuration: 9,
  });
});

test("calculateCueTransitionDurations includes cue part instruction timings", async () => {
  const cue = {
    transitions: {
      delay_in: fixed(1),
      fade_in: fixed(1),
      delay_out: fixed(1),
      fade_out: fixed(1),
    },
    transitions_by_attribute: {},
    instructions: [],
    parts: [
      {
        transitions: {
          delay_in: fixed(5),
          fade_in: fixed(6),
          delay_out: fixed(1),
          fade_out: fixed(2),
        },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: uid(1), index: 1 }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Intensity: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 1 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [
                {
                  fixture: { fixture_uid: uid(1), index: 1 },
                  transitions_by_attribute: {
                    Intensity: {
                      fade_out: fixed(12),
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  } as unknown as types.Cue;

  assert.deepEqual(await calculateCueTransitionDurations(cue), {
    delayIn: 5,
    fadeIn: 6,
    delayOut: 1,
    fadeOut: 12,
    inDuration: 11,
    outDuration: 13,
    totalDuration: 13,
  });
});

test("calculateCueTransitionDurations inherits parent cue timing into parts", async () => {
  const cue = {
    transitions: {
      delay_in: fixed(1),
      fade_in: fixed(2),
      delay_out: fixed(3),
      fade_out: fixed(4),
    },
    transitions_by_attribute: {},
    instructions: [],
    parts: [
      {
        transitions: {
          fade_in: fixed(5),
        },
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: uid(1), index: 1 }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Intensity: {
                  type: "Inline",
                  data: { type: "Absolute", data: { value: 1 } },
                },
              },
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
      },
    ],
  } as unknown as types.Cue;

  assert.deepEqual(await calculateCueTransitionDurations(cue), {
    delayIn: 1,
    fadeIn: 5,
    delayOut: 3,
    fadeOut: 4,
    inDuration: 6,
    outDuration: 7,
    totalDuration: 7,
  });
});

test("selectionTimingPositionForFixtureAttribute uses resolved element offsets", async () => {
  const fixture = {
    identifiers: { uid: uid(1) },
    elements: [
      { label: "Tilt Axis", parameters: [parameter("Tilt")] },
      { label: "Dimmer", parameters: [parameter("White")] },
      {
        label: "Pixel",
        parameters: [parameter("VirtualIntensity"), parameter("Green")],
      },
    ],
  } as unknown as types.Fixture;
  const fixtures = new Map([[fixture.identifiers.uid, fixture]]);
  const selection = {
    source: {
      type: "Resolved",
      data: [
        { fixture_uid: fixture.identifiers.uid, index: 1 },
        { fixture_uid: fixture.identifiers.uid, index: 2 },
        { fixture_uid: fixture.identifiers.uid, index: 3 },
      ],
    },
    clauses: [],
  } as unknown as types.SpatialSelection;

  assert.deepEqual(
    await selectionTimingPositionForFixtureAttribute(
      selection,
      fixtures,
      fixture.identifiers.uid,
      "Tilt",
    ),
    { offset: 0, total: 3 },
  );
  assert.deepEqual(
    await selectionTimingPositionForFixtureAttribute(
      selection,
      fixtures,
      fixture.identifiers.uid,
      "Green",
    ),
    { offset: 2, total: 3 },
  );
  assert.deepEqual(
    await selectionTimingPositionForFixtureAttribute(
      selection,
      fixtures,
      fixture.identifiers.uid,
      "Intensity",
    ),
    { offset: 2, total: 3 },
  );
});

test("selection timing positions account for spatial grouping clauses", async () => {
  const fixtures = new Map(
    [1, 2, 3, 4].map((id) => [
      uid(id),
      {
        identifiers: { uid: uid(id) },
        elements: [{ label: "Dimmer", parameters: [parameter("Intensity")] }],
      } as unknown as types.Fixture,
    ]),
  );
  const selection = {
    source: {
      type: "Resolved",
      data: [1, 2, 3, 4].map((id) => ({
        fixture_uid: uid(id),
        index: 1,
      })),
    },
    clauses: [
      {
        type: "Wings",
        data: { axis: "X", amount: 2 },
      },
    ],
  } as unknown as types.SpatialSelection;

  assert.deepEqual(
    (await resolvedSelectionTimingIndexes(selection)).map((index) =>
      index.members.map((member) => member.fixture_uid),
    ),
    [
      [uid(1), uid(4)],
      [uid(2), uid(3)],
    ],
  );
  assert.deepEqual(
    await selectionTimingPositionForFixtureAttribute(
      selection,
      fixtures,
      uid(4),
      "Intensity",
    ),
    { offset: 0, total: 2 },
  );
  assert.deepEqual(
    await selectionTimingPositionForFixtureAttribute(
      selection,
      fixtures,
      uid(3),
      "Intensity",
    ),
    { offset: 1, total: 2 },
  );
});
