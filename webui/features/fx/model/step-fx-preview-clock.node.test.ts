// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types/index";
import {
  findStepFxPreviewStatus,
  stepFxAuthoredBeat,
  stepFxEffectiveCycleBeats,
  stepFxPhaseMarkerBeat,
  stepFxPlayheadCycleOffset,
  stepFxPreviewBeat,
  stepFxPreviewBeats,
  stepFxPreviewOrStartBeats,
} from "./step-fx-preview-clock";

const SESSION_ID = "12345678123456781234567812345678";

/** Builds a backend preview anchor with optional continuity corrections. */
function previewStatus(
  options: Partial<types.StepFxPreviewPlaybackStatus> = {},
): types.StepFxPreviewPlaybackStatus {
  return {
    session_id: SESSION_ID,
    sampled_at_epoch_ms: 10_000,
    elapsed: { secs: 1, nanos: 0 },
    elapsed_rate: 1,
    track_phase_offsets: [],
    ...options,
  };
}

/** Builds the minimal active playback record needed for preview-session matching. */
function playback(
  preview: types.StepFxPreviewPlaybackStatus | undefined,
): types.InstanceInfo {
  return {
    instance_id: "preview-playback",
    kind: types.InstanceKind.Fx,
    display_kind: types.InstanceDisplayKind.StepFx,
    tags: [],
    is_preview: true,
    is_releasing: false,
    is_paused: false,
    owner_uids: [],
    intensity_scale: 1,
    rate: 1,
    rate_master_scale: 1,
    effective_rate: 1,
    step_fx_preview: preview,
    status: {
      position: { type: "None" },
    },
  };
}

/** Verifies preview lookup accepts the UUID formatting difference introduced by serialization. */
test("findStepFxPreviewStatus matches the editor session only", () => {
  const expected = previewStatus();
  const found = findStepFxPreviewStatus(
    { preview: playback(expected) },
    "12345678-1234-5678-1234-567812345678",
  );

  assert.equal(found, expected);
  assert.equal(
    findStepFxPreviewStatus(
      { preview: playback(expected) },
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ),
    undefined,
  );
});

/** Verifies the UI advances from a backend epoch instead of owning a free-running phase. */
test("stepFxPreviewBeat interpolates from the authoritative backend anchor", () => {
  const beat = stepFxPreviewBeat(
    previewStatus(),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_500,
  );

  assert.equal(beat, 3);
});

/** Verifies live-edit continuity offsets are applied independently to each contribution track. */
test("stepFxPreviewBeat applies the selected track continuity offset", () => {
  const status = previewStatus({
    elapsed: { secs: 0, nanos: 0 },
    elapsed_rate: 0,
    track_phase_offsets: [
      {
        attribute: { type: "Custom", data: { label: "Blade 1" } },
        absolute: 0.25,
        relative: 0.75,
      },
    ],
  });

  assert.equal(
    stepFxPreviewBeat(
      status,
      { type: "Custom", data: { label: "Blade 1" } },
      "absolute",
      4,
      0.5,
      10_000,
    ),
    1,
  );
  assert.equal(
    stepFxPreviewBeat(
      status,
      { type: "Custom", data: { label: "Blade 1" } },
      "relative",
      4,
      0.5,
      10_000,
    ),
    3,
  );
});

/** Verifies the reference playhead samples the first resolved selection phase. */
test("stepFxPreviewBeat applies the first selection phase offset", () => {
  const beat = stepFxPreviewBeat(
    previewStatus({
      elapsed: { secs: 0, nanos: 0 },
      elapsed_rate: 0,
    }),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    0.25,
  );

  assert.equal(beat, 1);
});

/** Verifies every visible playhead derives from the same authoritative clock sample. */
test("stepFxPreviewBeats resolves every selection phase offset", () => {
  const beats = stepFxPreviewBeats(
    previewStatus({
      elapsed: { secs: 0, nanos: 0 },
      elapsed_rate: 0,
    }),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    [0, 0.25, 0.5, 0.75],
  );

  assert.deepEqual(beats, [0, 1, 2, 3]);
});

/** Verifies stopped previews retain the complete fixture start distribution. */
test("stepFxPreviewOrStartBeats falls back to authored fixture starts", () => {
  assert.deepEqual(
    stepFxPreviewOrStartBeats(
      undefined,
      { type: "Pan" },
      "absolute",
      4,
      0.5,
      10_000,
      [0, 0.25, 0.5, 0.75],
    ),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    stepFxPreviewOrStartBeats(
      undefined,
      { type: "Pan" },
      "absolute",
      4,
      0.5,
      10_000,
      [0, 0.25, 0.5, 0.75],
      types.FxDirection.Reverse,
    ),
    [4, 3, 2, 1],
  );
});

/** Verifies an available preview clock remains authoritative over static starts. */
test("stepFxPreviewOrStartBeats prefers the live preview clock", () => {
  const beats = stepFxPreviewOrStartBeats(
    previewStatus({
      elapsed: { secs: 0, nanos: 0 },
      elapsed_rate: 0,
    }),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    [0.25, 0.5],
  );

  assert.deepEqual(beats, [1, 2]);
});

/** Verifies centered waveforms keep wrapped spread playheads on one continuous pass. */
test("stepFxPlayheadCycleOffset unwraps forward and reverse spreads", () => {
  assert.equal(
    stepFxPlayheadCycleOffset(
      0.4,
      3.36,
      1.1,
      0.84,
      4,
      types.FxDirection.Forward,
    ),
    1,
  );
  assert.equal(
    stepFxPlayheadCycleOffset(
      3.6,
      0.64,
      1.1,
      0.84,
      4,
      types.FxDirection.Reverse,
    ),
    -1,
  );
  assert.equal(
    stepFxPlayheadCycleOffset(
      0.4,
      3.36,
      1.1,
      0.84,
      4,
      types.FxDirection.Bounce,
    ),
    0,
  );
});

/** Verifies cycle-wide spreads re-enter the opposite side of centered waveform mode. */
test("stepFxPlayheadCycleOffset viewport-wraps full-cycle spreads", () => {
  assert.equal(
    stepFxPlayheadCycleOffset(
      3.6,
      1,
      0.9,
      0.25,
      4,
      types.FxDirection.Forward,
      true,
    ),
    -1,
  );
  assert.equal(
    stepFxPlayheadCycleOffset(
      0.4,
      1,
      1.1,
      0.25,
      4,
      types.FxDirection.Forward,
      true,
    ),
    0,
  );
  assert.equal(
    stepFxPlayheadCycleOffset(
      0.4,
      3,
      0.9,
      0.25,
      4,
      types.FxDirection.Reverse,
      true,
    ),
    1,
  );
  assert.equal(
    stepFxPlayheadCycleOffset(
      3.6,
      3,
      1.1,
      0.25,
      4,
      types.FxDirection.Reverse,
      true,
    ),
    0,
  );
});

/** Verifies fixed scaling controls one bounce pass before an equal return pass. */
test("stepFxPreviewBeat gives both fixed bounce passes their configured beats", () => {
  const beat = stepFxPreviewBeat(
    previewStatus({
      elapsed: { secs: 1, nanos: 0 },
      elapsed_rate: 0,
    }),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    0,
    types.FxDirection.Bounce,
    { type: "Fixed", data: 4 },
  );

  assert.equal(
    stepFxEffectiveCycleBeats(
      4,
      { type: "Fixed", data: 4 },
      types.FxDirection.Bounce,
    ),
    8,
  );
  assert.equal(beat, 2);
});

/** Verifies direction changes transport position without changing authored geometry. */
test("stepFxAuthoredBeat maps forward reverse and bounce transport", () => {
  assert.equal(stepFxAuthoredBeat(0.25, 4, types.FxDirection.Forward), 1);
  assert.equal(stepFxAuthoredBeat(0.25, 4, types.FxDirection.Reverse), 3);
  assert.equal(stepFxAuthoredBeat(0.25, 4, types.FxDirection.Bounce), 2);
  assert.equal(stepFxAuthoredBeat(0.75, 4, types.FxDirection.Bounce), 2);
});

/** Verifies the stable phase marker follows direction without depending on live time. */
test("stepFxPhaseMarkerBeat maps an assigned offset onto the authored graph", () => {
  assert.equal(stepFxPhaseMarkerBeat(0.25, 4, types.FxDirection.Forward), 1);
  assert.equal(stepFxPhaseMarkerBeat(0.25, 4, types.FxDirection.Reverse), 3);
  assert.equal(stepFxPhaseMarkerBeat(0.25, 4, types.FxDirection.Bounce), 1);
  assert.equal(stepFxPhaseMarkerBeat(1.25, 4, types.FxDirection.Forward), 1);
});

/** Verifies Bounce converts authored start positions into its two-pass transport. */
test("stepFxPreviewBeat starts Bounce at the same authored position as Forward", () => {
  const status = previewStatus({
    elapsed: { secs: 0, nanos: 0 },
    elapsed_rate: 0,
  });
  const startPosition = 0.25;
  const forward = stepFxPreviewBeat(
    status,
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    startPosition,
    types.FxDirection.Forward,
  );
  const bounce = stepFxPreviewBeat(
    status,
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    startPosition,
    types.FxDirection.Bounce,
  );

  assert.equal(forward, 1);
  assert.equal(bounce, forward);
});

/** Verifies automatic bounce traverses at authored speed over two complete passes. */
test("stepFxPreviewBeat maps bounce over twice the authored pass width", () => {
  const beat = stepFxPreviewBeat(
    previewStatus({
      elapsed: { secs: 1, nanos: 500_000_000 },
      elapsed_rate: 0,
    }),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    10_000,
    0,
    types.FxDirection.Bounce,
  );

  assert.equal(beat, 3);
});

/** Verifies timestamps slightly ahead of the browser clock do not interpolate backwards. */
test("stepFxPreviewBeat clamps negative transport latency", () => {
  const beat = stepFxPreviewBeat(
    previewStatus(),
    { type: "Pan" },
    "absolute",
    4,
    0.5,
    9_500,
  );

  assert.equal(beat, 2);
});
