// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { FxDirection, type StepFx } from "../../../types";
import {
  createStepFxColorLane,
  stepFxColorComponentTrack,
} from "./step-fx-color-model";
import {
  canRestartStepFxPreview,
  deleteStepFxSteps,
  distributeStepFxWidthsEvenly,
  duplicateStepFxSteps,
  formatStepFxBeatCount,
  formatStepFxTarget,
  formatStepFxWidthBeats,
  parseStepFxTarget,
  reorderStepFxSteps,
  roundStepFxWidthBeats,
  stepFxAuthoredPassBeats,
  stepFxAutomaticCycleBeats,
  stepFxCycleBeats,
  stepFxEquals,
  stepFxPasteInsertionIndex,
  stepFxPhaseOffset,
  stepFxPhaseSlots,
  stepFxSpeedValue,
  stepFxStepsFromClipboard,
  stepFxTimingFromSpeed,
  validateStepFxDraft,
} from "./step-fx-editor-model";
import {
  buildStepFxWaveformModel,
  sampleStepFxWaveform,
} from "./step-fx-waveform-model";

/** Builds a valid default draft with deterministic top-level identity. */
function draft(): StepFx {
  return {
    identifiers: {
      id: 12,
      uid: "11111111111111111111111111111111",
      label: "Chase",
    },
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
    },
    timing: { beat_duration: { secs: 0, nanos: 500_000_000 } },
    phase: { waypoints: [0, 1] },
    direction: FxDirection.Forward,
    cycle_scale: { type: "Auto" },
    lanes: [
      {
        attribute: { type: "Intensity" },
        absolute: {
          steps: [1, 0].map((value, index) => ({
            uid: `${index + 1}`.repeat(32),
            target: { type: "AbsolutePercent", data: { value } },
            width_beats: 1,
            transition: { start: 0, end: 1 },
            curve: { type: "Snap", data: {} },
          })),
        },
      },
    ],
  };
}

/** Whole colors validate on their own and cannot compete with physical color lanes. */
test("color lane validation preserves independent attribute ownership", () => {
  const fx = draft();
  fx.lanes = [];
  fx.color_lane = createStepFxColorLane();
  assert.deepEqual(validateStepFxDraft(fx), []);
  fx.lanes = draft().lanes;
  assert.deepEqual(validateStepFxDraft(fx), []);
  fx.lanes[0].attribute = { type: "Red" };
  assert.ok(
    validateStepFxDraft(fx).some((issue) => issue.path === "color_lane"),
  );
  fx.lanes = [];
  fx.color_lane.steps[0].transition.start = 0.9;
  fx.color_lane.steps[0].transition.end = 0.1;
  assert.ok(
    validateStepFxDraft(fx).some(
      (issue) => issue.path === "color_lane.steps.0.transition",
    ),
  );
});

/** A two-color fade previews the composite output and respects snap shaping. */
test("color preview shares the existing scalar interpolation semantics", () => {
  const lane = createStepFxColorLane();
  const red = buildStepFxWaveformModel(stepFxColorComponentTrack(lane, "red"))!;
  const blue = buildStepFxWaveformModel(
    stepFxColorComponentTrack(lane, "blue"),
  )!;
  assert.equal(sampleStepFxWaveform(red, 0.5)?.value, 0.5);
  assert.equal(sampleStepFxWaveform(blue, 0.5)?.value, 0.5);
  lane.steps[0].curve = { type: "Snap", data: {} };
  assert.equal(
    sampleStepFxWaveform(
      buildStepFxWaveformModel(stepFxColorComponentTrack(lane))!,
      0.5,
    )?.value,
    1,
  );
});

test("speed units round-trip through canonical beat duration", () => {
  for (const [unit, value] of [
    ["BPM", 120],
    ["Hz", 2],
    ["Seconds", 0.5],
    ["Milliseconds", 500],
  ] as const) {
    const timing = stepFxTimingFromSpeed(value, unit);
    assert.ok(timing);
    assert.ok(Math.abs(stepFxSpeedValue(timing, unit) - value) < 0.0001);
  }
});

/** Verifies operator-facing speed text hides integer-duration conversion noise. */
test("speed display values omit duration quantization artifacts", () => {
  const timing = stepFxTimingFromSpeed(9.5, "BPM");
  assert.ok(timing);
  assert.equal(stepFxSpeedValue(timing, "BPM"), 9.5);
});

/** Verifies cycle readouts hide backend float serialization noise. */
test("cycle beat display values omit float serialization artifacts", () => {
  assert.equal(formatStepFxBeatCount(1.0000000298023224), "1");
  assert.equal(formatStepFxBeatCount(1.23456749), "1.234567");
});

/** Verifies authored widths share one three-decimal edit and display precision. */
test("step width values are limited to three decimal places", () => {
  assert.equal(roundStepFxWidthBeats(0.166667), 0.167);
  assert.equal(formatStepFxWidthBeats(1.5000001), "1.5");
});

/** Verifies draft equality normalizes compact UUIDs and null optional lane fields. */
test("draft equality accepts compact backend UUIDs and null optional fields", () => {
  const browser = draft();
  browser.identifiers.uid = "11111111-1111-1111-1111-111111111111";
  const backend = structuredClone(browser);
  backend.identifiers.uid = "1".repeat(32);
  backend.lanes[0].timing_override = null as unknown as undefined;
  backend.selection.union = [];
  assert.equal(stepFxEquals(browser, backend), true);
});

test("fixed cycle scaling preserves authored step widths", () => {
  const source = draft();
  source.lanes[0].relative = structuredClone(source.lanes[0].absolute);
  source.cycle_scale = { type: "Fixed", data: 8 };
  assert.equal(stepFxCycleBeats(source, source.lanes[0].absolute), 8);
  assert.equal(stepFxAuthoredPassBeats(source.lanes[0].absolute), 2);
  assert.deepEqual(
    source.lanes[0].relative?.steps.map((step) => step.width_beats),
    [1, 1],
  );
});

/** Verifies automatic readouts use the explicitly selected track despite timing overrides. */
test("automatic cycle scaling reads the selected overridden lane", () => {
  const source = draft();
  source.lanes[0].timing_override = {
    beat_duration: { secs: 1, nanos: 0 },
  };

  assert.equal(stepFxAuthoredPassBeats(source.lanes[0].absolute), 2);
  assert.equal(stepFxAutomaticCycleBeats(source.lanes[0].absolute), 2);
});

/** Verifies automatic bounce gives the forward and return passes their full authored widths. */
test("bounce automatic cycle is twice the authored pass", () => {
  const source = draft();
  source.direction = FxDirection.Bounce;
  source.lanes[0].absolute!.steps.push({
    ...structuredClone(source.lanes[0].absolute!.steps[1]),
    uid: "3".repeat(32),
    width_beats: 2,
  });
  assert.equal(stepFxAuthoredPassBeats(source.lanes[0].absolute), 4);
  assert.equal(stepFxAutomaticCycleBeats(source.lanes[0].absolute), 4);
  assert.equal(
    stepFxAutomaticCycleBeats(source.lanes[0].absolute, FxDirection.Bounce),
    8,
  );
  assert.equal(stepFxCycleBeats(source, source.lanes[0].absolute), 8);
});

/** Verifies tracks with different automatic cycle lengths remain valid. */
test("draft validation permits independent automatic track lengths", () => {
  const source = draft();
  source.lanes.push({
    attribute: { type: "Red" },
    absolute: {
      steps: [
        {
          ...structuredClone(source.lanes[0].absolute!.steps[0]),
          uid: "3".repeat(32),
          width_beats: 4,
        },
      ],
    },
  });

  assert.deepEqual(validateStepFxDraft(source), []);
  source.lanes[0].absolute!.steps.push({
    ...structuredClone(source.lanes[0].absolute!.steps[1]),
    uid: "4".repeat(32),
  });
  assert.deepEqual(validateStepFxDraft(source), []);
});

test("phase slots use half-open scalar and waypoint distributions", () => {
  assert.deepEqual(stepFxPhaseSlots(draft().phase, 4), [0, 0.25, 0.5, 0.75]);
  const offset = {
    waypoints: [0.25, 1.25],
  };
  assert.equal(stepFxPhaseOffset(offset, 3, 12), 0.5);
  assert.deepEqual(
    stepFxPhaseSlots({ waypoints: [0.5] }, 4),
    [0.5, 0.5, 0.5, 0.5],
  );
  assert.deepEqual(
    stepFxPhaseSlots({ waypoints: [0, 1, 0] }, 8),
    [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25],
  );
  assert.deepEqual(
    stepFxPhaseSlots(
      {
        waypoints: [0, 1],
        groups: { type: "Explicit", data: 2 },
      },
      4,
    ),
    [0, 0, 0.5, 0.5],
  );
});

/** Verifies pasted blocks follow the complete selection instead of its first row. */
test("paste insertion follows the last selected step", () => {
  const track = draft().lanes[0].absolute!;
  track.steps.push({
    ...structuredClone(track.steps[1]),
    uid: "3".repeat(32),
  });

  assert.equal(
    stepFxPasteInsertionIndex(
      track,
      new Set([track.steps[0].uid, track.steps[1].uid]),
    ),
    2,
  );
});

/** Verifies reordering retains step identity while duplication creates a new identity. */
test("step structural edits manage stable identities", () => {
  const track = draft().lanes[0].absolute!;
  const selected = new Set([track.steps[0].uid]);
  const reordered = reorderStepFxSteps(track, selected, 1);
  assert.equal(reordered.steps[1].uid, track.steps[0].uid);
  const duplicated = duplicateStepFxSteps(track, selected);
  assert.notEqual(duplicated.track.steps[1].uid, track.steps[0].uid);
  const deleted = deleteStepFxSteps(duplicated.track, duplicated.selectedUids);
  assert.equal(deleted.track.steps.length, 2);
  assert.equal(deleted.selectedUids.size, 1);
});

/** Verifies even distribution uses a multi-selection and falls back to every step otherwise. */
test("step widths distribute evenly across the effective selection", () => {
  const track = draft().lanes[0].absolute!;
  track.steps.push({
    ...structuredClone(track.steps[1]),
    uid: "3".repeat(32),
    width_beats: 4,
  });

  const selected = distributeStepFxWidthsEvenly(
    track,
    new Set([track.steps[0].uid, track.steps[1].uid]),
  );
  assert.deepEqual(
    selected.steps.map((step) => step.width_beats),
    [1, 1, 4],
  );

  const all = distributeStepFxWidthsEvenly(
    track,
    new Set([track.steps[0].uid]),
  );
  assert.deepEqual(
    all.steps.map((step) => step.width_beats),
    [2, 2, 2],
  );
});

test("draft validation localizes malformed timing and tracks", () => {
  const source = draft();
  source.identifiers.label = "";
  source.cycle_scale = { type: "Fixed", data: 0 };
  source.lanes[0].absolute!.steps[0].width_beats = 0;
  source.lanes[0].absolute!.steps[1].target = {
    type: "RelativePercent",
    data: { offset: 0 },
  };
  const paths = validateStepFxDraft(source).map((issue) => issue.path);
  assert.ok(paths.includes("identifiers.label"));
  assert.ok(paths.includes("cycle_scale.data"));
  assert.ok(paths.includes("lanes.0.absolute.steps.0.width_beats"));
  assert.ok(paths.includes("lanes.0.absolute.steps.1.target"));
});

/** Verifies reconnect cannot revive a preview the operator stopped or whose draft was deleted. */
test("preview restart requires current operator intent and a live valid draft", () => {
  assert.equal(
    canRestartStepFxPreview({
      previewActive: true,
      deletedExternally: false,
      hasValidDraft: true,
    }),
    true,
  );
  for (const blocked of [
    {
      previewActive: false,
      deletedExternally: false,
      hasValidDraft: true,
    },
    {
      previewActive: true,
      deletedExternally: true,
      hasValidDraft: true,
    },
    {
      previewActive: true,
      deletedExternally: false,
      hasValidDraft: false,
    },
  ])
    assert.equal(canRestartStepFxPreview(blocked), false);
});

/** Verifies draft validation rejects reversed transition-window endpoints. */
test("draft validation localizes reversed transition windows", () => {
  const source = draft();
  source.lanes[0].absolute!.steps[0].transition = { start: 0.75, end: 0.25 };

  assert.ok(
    validateStepFxDraft(source).some(
      (issue) => issue.path === "lanes.0.absolute.steps.0.transition",
    ),
  );
});

/** Verifies Step FX target fields consistently use operator-facing percentages. */
test("target values round-trip through percentage display units", () => {
  const template = draft().lanes[0].absolute!.steps[0].target;

  assert.equal(formatStepFxTarget(template), "100");
  assert.deepEqual(parseStepFxTarget("100", "absolute"), {
    type: "AbsolutePercent",
    data: { value: 1 },
  });
  assert.deepEqual(parseStepFxTarget("-25%", "relative"), {
    type: "RelativePercent",
    data: { offset: -0.25 },
  });
});

/** Verifies plain clipboard scalars use the same percentage units as the sheet. */
test("clipboard scalar JSON falls back to a percentage target value", () => {
  const template = draft().lanes[0].absolute!.steps[0];
  const pasted = stepFxStepsFromClipboard("50", "absolute", template);

  assert.equal(pasted.length, 1);
  assert.deepEqual(pasted[0].target, {
    type: "AbsolutePercent",
    data: { value: 0.5 },
  });
});

test("clipboard structured steps reject malformed tagged unions", () => {
  const template = draft().lanes[0].absolute!.steps[0];
  const malformed = JSON.stringify([
    { ...template, target: {}, curve: {} },
    {
      ...template,
      target: { type: "AbsolutePercent", data: {} },
      curve: { type: "Bezier", data: { cp1: {}, cp2: {} } },
    },
  ]);

  assert.deepEqual(
    stepFxStepsFromClipboard(malformed, "absolute", template),
    [],
  );
});
