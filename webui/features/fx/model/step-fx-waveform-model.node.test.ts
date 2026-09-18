// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FxStep, FxTrack } from "../../../types";
import {
  buildStepFxWaveformModel,
  sampleStepFxWaveform,
  snapStepFxWaveformValue,
  stepFxWaveformPath,
} from "./step-fx-waveform-model";

/** Builds one deterministic percentage step for waveform model tests. */
function step(
  uid: string,
  value: number,
  widthBeats: number,
  transition: number | readonly [start: number, end: number],
  curve: FxStep["curve"] = { type: "Linear", data: {} },
): FxStep {
  return {
    uid,
    target: { type: "AbsolutePercent", data: { value } },
    width_beats: widthBeats,
    transition: Array.isArray(transition)
      ? { start: transition[0], end: transition[1] }
      : { start: 0, end: transition },
    curve,
  };
}

/** Verifies forward geometry preserves authored widths and wrap interpolation. */
test("forward waveform resolves transition and hold intervals", () => {
  const track: FxTrack = {
    steps: [step("one", 1, 1, 0.5), step("two", 0, 3, 0.25)],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  assert.equal(model.totalBeats, 4);
  assert.deepEqual(
    model.segments.map((segment) => [
      segment.stepIndex,
      segment.startBeat,
      segment.transitionStartBeat,
      segment.transitionEndBeat,
      segment.endBeat,
      segment.fromValue,
      segment.targetValue,
    ]),
    [
      [0, 0, 0, 0.5, 1, 0, 1],
      [1, 1, 1, 1.75, 4, 1, 0],
    ],
  );
});

/** Verifies authored geometry remains in step order independent of transport direction. */
test("waveform shape follows authored step order", () => {
  const track: FxTrack = {
    steps: [
      step("one", 0, 1, 0),
      step("two", 0.5, 2, 0),
      step("three", 1, 3, 0),
    ],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  assert.deepEqual(
    model.segments.map((segment) => [
      segment.stepIndex,
      segment.startBeat,
      segment.endBeat,
    ]),
    [
      [0, 0, 1],
      [1, 1, 3],
      [2, 3, 6],
    ],
  );
});

/** Verifies exact SVG commands distinguish Snap, Linear, Bézier, and hold geometry. */
test("waveform path emits semantic SVG segments", () => {
  const track: FxTrack = {
    steps: [
      step("snap", 0, 1, 1, { type: "Snap", data: {} }),
      step("linear", 0.5, 1, 0.5),
      step("ease", 1, 2, 0.5, {
        type: "Bezier",
        data: { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } },
      }),
    ],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  const path = stepFxWaveformPath(model, 400, 100);
  assert.match(path, /^M /);
  assert.match(path, /L 0 /);
  assert.match(path, /L 150 /);
  assert.match(path, /C 242 /);
  assert.match(path, /H 400$/);
});

/** Verifies Snap holds its target through the step instead of drawing a diagonal. */
test("snap waveform jumps at the step boundary and then holds", () => {
  const track: FxTrack = {
    steps: [
      step("high", 1, 1, 1, { type: "Snap", data: {} }),
      step("low", 0, 1, 1, { type: "Snap", data: {} }),
    ],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  const path = stepFxWaveformPath(model, 200, 100);
  assert.match(path, /L 0 [\d.]+ H 100 L 100 [\d.]+ H 200$/);
  assert.equal(model.segments[0].transitionStartBeat, 0);
  assert.equal(model.segments[0].transitionEndBeat, 1);
  assert.equal(model.scaleMinimumValue, 0);
  assert.equal(model.scaleMaximumValue, 1);
});

/** Verifies percentage drags ignore plot padding and resolve to half points. */
test("waveform value dragging clamps and snaps on the semantic percent scale", () => {
  const model = buildStepFxWaveformModel({
    steps: [step("high", 1, 1, 1), step("low", 0, 1, 1)],
  });

  assert.ok(model);
  assert.equal(snapStepFxWaveformValue(model, 1.1), 1);
  assert.equal(snapStepFxWaveformValue(model, -0.1), 0);
  assert.equal(snapStepFxWaveformValue(model, 0.163), 0.165);
  assert.equal(snapStepFxWaveformValue(model, 0.162), 0.16);
});

/** Verifies incomplete numeric draft edits suppress unsafe SVG output. */
test("waveform model rejects invalid draft geometry", () => {
  const track: FxTrack = { steps: [step("invalid", 1, 0, 1)] };
  assert.equal(buildStepFxWaveformModel(track), null);
});

/** Verifies live samples wrap and follow transition-versus-hold timing. */
test("waveform samples live cycle position", () => {
  const track: FxTrack = {
    steps: [step("one", 1, 1, 0.5), step("two", 0, 1, 0.5)],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  assert.equal(sampleStepFxWaveform(model, 0)?.value, 0);
  assert.equal(sampleStepFxWaveform(model, 0.25)?.value, 0.5);
  assert.equal(sampleStepFxWaveform(model, 0.75)?.value, 1);
  assert.equal(sampleStepFxWaveform(model, 2.25)?.value, 0.5);
});

/** Verifies delayed ramps hold both their incoming and target values. */
test("waveform honors ramp start and end handles", () => {
  const track: FxTrack = {
    steps: [step("one", 1, 1, [0.25, 0.75]), step("two", 0, 1, 0)],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  assert.equal(sampleStepFxWaveform(model, 0.125)?.value, 0);
  assert.equal(sampleStepFxWaveform(model, 0.5)?.value, 0.5);
  assert.equal(sampleStepFxWaveform(model, 0.875)?.value, 1);
});

/** Verifies live samples use CSS-style horizontal Bézier controls. */
test("waveform samples exact bezier timing", () => {
  const track: FxTrack = {
    steps: [
      step("ease-in", 1, 1, 1, {
        type: "Bezier",
        data: { cp1: { x: 0.42, y: 0 }, cp2: { x: 1, y: 1 } },
      }),
      step("snap", 0, 1, 0, { type: "Snap", data: {} }),
    ],
  };
  const model = buildStepFxWaveformModel(track);

  assert.ok(model);
  const midpoint = sampleStepFxWaveform(model, 0.5);
  assert.ok(midpoint);
  assert.ok(midpoint.value < 0.5);
  assert.ok(midpoint.value > 0.3);
});
