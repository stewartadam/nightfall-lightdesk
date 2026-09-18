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
import { actionDragPositionFromPointer } from "./action-drag";
import type {
  ActionDurationTrailLoopMarker,
  ActionDurationTrailLoopMarkers,
} from "./action-duration";
import {
  actionDurationTrailLoopMarkers,
  actionDurationTrailWidth,
  resolveActionVisualDuration,
  resolveActionVisualDurationMs,
} from "./action-duration";
import type { ActionTargetIndex } from "./action-targets";

/** Builds the snap configuration used by drag geometry tests. */
function snapConfig(enabled: boolean) {
  return {
    enabled,
    interval: 1000,
    threshold: 10,
    isBeat: false,
    beatsPerBar: 4,
  };
}

/** Builds the target lookup index used by duration resolver tests. */
function targetIndex(
  options: Partial<ActionTargetIndex> = {},
): ActionTargetIndex {
  return {
    cueMapByUid: new Map(),
    cueDurationProfileMapByUid: new Map(),
    sequenceMapByUid: new Map(),
    clipMapByUid: new Map(),
    flowMapByUid: new Map(),
    fxMapByUid: new Map(),
    cueSequenceRefByUid: new Map(),
    ...options,
  };
}

/** Builds a minimal cue definition for duration resolver tests. */
function cue(uid: string, trigger: types.CueTriggerType): types.Cue {
  return {
    identifiers: { id: 1, uid, label: uid },
    trigger,
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    tracking_flags: types.TrackingFlags.HTP,
  };
}

/** Builds a minimal cue duration profile message for resolver tests. */
function cueDurationProfile(
  cueUid: string,
  assertionMs: number,
): types.CueDurationProfileMessage {
  const zero = msToDuration(0);
  return {
    cue_uid: cueUid,
    cue_id: 1,
    profile: {
      max_delay_in: zero,
      max_fade_in: zero,
      max_delay_out: zero,
      max_fade_out: zero,
      assertion_duration: msToDuration(assertionMs),
      release_duration: zero,
      max_transition_duration: msToDuration(assertionMs),
    },
  };
}

/** Builds a timeline action with a deliberately uninformative stored duration. */
function timelineAction(
  id: string,
  positionMs: number,
  action: types.ActionKind,
): types.Action {
  return {
    id,
    label: id,
    position: msToDuration(positionMs),
    duration: msToDuration(1000),
    action,
  };
}

/** Builds a stored FX module definition for duration resolver tests. */
function storedFxModule(
  uid: string,
  moduleName: string,
  config: Record<string, string>,
): types.StoredFxModule {
  return {
    identifiers: { id: 1, uid, label: moduleName },
    module_name: moduleName,
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
      union: [],
    },
    config,
  };
}

/** Builds a minimal Step FX definition for duration resolver tests. */
function stepFx(uid: string, durationMs: number): types.StepFx {
  return {
    identifiers: { id: 1, uid, label: "Step FX" },
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
      union: [],
    },
    timing: { beat_duration: msToDuration(durationMs) },
    phase: { waypoints: [0, 1] },
    direction: types.FxDirection.Forward,
    cycle_scale: { type: "Auto" },
    lanes: [
      {
        attribute: { type: "Intensity" },
        absolute: {
          steps: [
            {
              uid: `${uid}-step-1`,
              target: { type: "AbsolutePercent", data: { value: 1 } },
              width_beats: 0.5,
              transition: { start: 0, end: 1 },
              curve: { type: "Snap", data: {} },
            },
            {
              uid: `${uid}-step-2`,
              target: { type: "AbsolutePercent", data: { value: 0 } },
              width_beats: 0.5,
              transition: { start: 0, end: 1 },
              curve: { type: "Snap", data: {} },
            },
          ],
        },
      },
    ],
  };
}

/** Returns the rendered tick entries from a duration trail loop marker model. */
function loopMarkerTicks(
  model: ActionDurationTrailLoopMarkers,
): Extract<ActionDurationTrailLoopMarker, { kind: "tick" }>[] {
  return model.markers.filter((marker) => marker.kind === "tick");
}

/** Returns the sampling ellipsis entry from a duration trail loop marker model. */
function loopMarkerEllipsis(
  model: ActionDurationTrailLoopMarkers,
): Extract<ActionDurationTrailLoopMarker, { kind: "ellipsis" }> | undefined {
  return model.markers.find((marker) => marker.kind === "ellipsis");
}

/** Verifies drag geometry aligns the action start with the pointer position. */
test("actionDragPositionFromPointer aligns action start to the pointer", () => {
  const position = actionDragPositionFromPointer({
    clientX: 275,
    laneLeft: 100,
    initialPositionPx: 40,
    timelineStartMs: 5000,
    zoom: 50,
    snapConfig: snapConfig(false),
  });

  assert.deepEqual(position, {
    positionPx: 175,
    offsetPx: 135,
    positionMs: 8500,
  });
});

/** Verifies known positive durations scale into timeline trail widths. */
test("actionDurationTrailWidth scales duration by zoom", () => {
  assert.equal(actionDurationTrailWidth(2500, 80), 200);
  assert.equal(actionDurationTrailWidth(1, 50), 1);
});

/** Verifies unknown or non-positive durations do not render trails. */
test("actionDurationTrailWidth omits unknown durations", () => {
  assert.equal(actionDurationTrailWidth(undefined, 100), undefined);
  assert.equal(actionDurationTrailWidth(0, 100), undefined);
  assert.equal(actionDurationTrailWidth(Number.NaN, 100), undefined);
});

/** Verifies loop intervals become internal trail markers but not endpoint duplicates. */
test("actionDurationTrailLoopMarkers scales internal loop markers", () => {
  assert.deepEqual(
    loopMarkerTicks(actionDurationTrailLoopMarkers(9000, 4000, 100)).map(
      (marker) => marker.offsetPx,
    ),
    [400, 800],
  );
  assert.deepEqual(
    loopMarkerTicks(actionDurationTrailLoopMarkers(8000, 4000, 100)).map(
      (marker) => marker.offsetPx,
    ),
    [400],
  );
  assert.deepEqual(actionDurationTrailLoopMarkers(3000, 4000, 100).markers, []);
});

/** Verifies dense loop intervals render sampled real boundaries and an ellipsis. */
test("actionDurationTrailLoopMarkers samples dense loop markers", () => {
  const model = actionDurationTrailLoopMarkers(60_000, 10, 100);
  const ticks = loopMarkerTicks(model);
  const ellipsis = loopMarkerEllipsis(model);

  assert.equal(model.sampled, true);
  assert.equal(model.rawMarkerCount, 5999);
  assert.equal(model.sampleStride, 24);
  assert.equal(model.markers.length <= 256, true);
  assert.equal(ellipsis?.sampleStride, 24);
  assert.equal(ellipsis?.rawMarkerCount, 5999);
  assert.equal(ellipsis?.skippedMarkerCount, 5750);
  assert.equal(ticks[0]?.loopIndex, 24);
  assert.equal(ticks[1]?.loopIndex, 48);
  assert.equal(ticks.at(-1)?.loopIndex, 5976);
  assert.equal(
    ticks.every((marker) => marker.loopIndex % 24 === 0),
    true,
  );
  assert.equal(
    ticks.every((marker) => marker.sampled),
    true,
  );
});

/** Verifies sampled ticks stay separated by the minimum readable spacing. */
test("actionDurationTrailLoopMarkers samples by rendered density", () => {
  const ticks = loopMarkerTicks(actionDurationTrailLoopMarkers(1000, 10, 100));
  const gaps = ticks
    .slice(1)
    .map((tick, index) => tick.offsetPx - ticks[index].offsetPx);

  assert.equal(ticks[0]?.offsetPx, 9);
  assert.equal(
    gaps.every((gap) => gap >= 8),
    true,
  );
});

/** Verifies non-wrapping auto-ending sequence clips use cue profile timing. */
test("resolveActionVisualDurationMs resolves auto-ending sequence clips", () => {
  const clipUid = "clipauto";
  const sequenceUid = "sequenceauto";
  const firstCueUid = "cueauto1";
  const secondCueUid = "cueauto2";
  const action = timelineAction("start-auto", 0, {
    type: "StartClip",
    data: clipUid,
  });

  assert.equal(
    resolveActionVisualDurationMs({
      action,
      actions: [action],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Auto" },
                source: { type: "Sequence", data: sequenceUid },
                priority: 0,
                options: {
                  auto_release: true,
                  deactivate_on_sequence_end: true,
                },
              } as types.Clip,
              false,
            ],
          ],
        ]),
        sequenceMapByUid: new Map([
          [
            sequenceUid,
            {
              identifiers: { id: 1, uid: sequenceUid, label: "Sequence" },
              steps: [firstCueUid, secondCueUid],
              wrap: false,
              release_on_start: false,
              default_timing: {},
              setup_cue: cue("setup", { type: "Manual" }),
              release_cue: cue("release", { type: "Manual" }),
              tracking_mode: { type: "Inherit" },
            } as types.Sequence,
          ],
        ]),
        cueMapByUid: new Map([
          [firstCueUid, cue(firstCueUid, { type: "Manual" })],
          [secondCueUid, cue(secondCueUid, { type: "FollowPrevious" })],
        ]),
        cueDurationProfileMapByUid: new Map([
          [firstCueUid, cueDurationProfile(firstCueUid, 1500)],
          [secondCueUid, cueDurationProfile(secondCueUid, 2500)],
        ]),
      }),
    }),
    4000,
  );
});

/** Verifies wrapping sequence clips use the next stop action as their length. */
test("resolveActionVisualDurationMs resolves wrapping clip stop spans", () => {
  const clipUid = "clipwrap";
  const sequenceUid = "sequencewrap";
  const start = timelineAction("start-wrap", 500, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-wrap", 3250, {
    type: "StopClip",
    data: clipUid,
  });

  assert.equal(
    resolveActionVisualDurationMs({
      action: start,
      actions: [start, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Wrap" },
                source: { type: "Sequence", data: sequenceUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        sequenceMapByUid: new Map([
          [
            sequenceUid,
            {
              identifiers: { id: 1, uid: sequenceUid, label: "Sequence" },
              steps: ["cue-wrap"],
              wrap: true,
              release_on_start: false,
              default_timing: {},
              setup_cue: cue("setup", { type: "Manual" }),
              release_cue: cue("release", { type: "Manual" }),
              tracking_mode: { type: "Inherit" },
            } as types.Sequence,
          ],
        ]),
      }),
    }),
    2750,
  );
});

/** Verifies wrapping sequence trails carry loop markers inside the start-to-stop span. */
test("resolveActionVisualDuration resolves wrapping clip loop intervals", () => {
  const clipUid = "clipwraploops";
  const sequenceUid = "sequencewraploops";
  const firstCueUid = "cuewraploops1";
  const secondCueUid = "cuewraploops2";
  const start = timelineAction("start-wrap-loops", 500, {
    type: "StartClip",
    data: clipUid,
  });
  const crossTrackStop = timelineAction("stop-wrap-loops", 9500, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action: start,
      actions: [start, crossTrackStop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Wrap" },
                source: { type: "Sequence", data: sequenceUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        sequenceMapByUid: new Map([
          [
            sequenceUid,
            {
              identifiers: { id: 1, uid: sequenceUid, label: "Sequence" },
              steps: [firstCueUid, secondCueUid],
              wrap: true,
              release_on_start: false,
              default_timing: {},
              setup_cue: cue("setup", { type: "Manual" }),
              release_cue: cue("release", { type: "Manual" }),
              tracking_mode: { type: "Inherit" },
            } as types.Sequence,
          ],
        ]),
        cueMapByUid: new Map([
          [firstCueUid, cue(firstCueUid, { type: "Manual" })],
          [secondCueUid, cue(secondCueUid, { type: "FollowPrevious" })],
        ]),
        cueDurationProfileMapByUid: new Map([
          [firstCueUid, cueDurationProfile(firstCueUid, 1500)],
          [secondCueUid, cueDurationProfile(secondCueUid, 2500)],
        ]),
      }),
    }),
    { durationMs: 9000, loopIntervalMs: 4000 },
  );
});

/** Verifies wrapped sequence loop intervals include the first cue wrap delay. */
test("resolveActionVisualDuration includes first cue wrap delay", () => {
  const clipUid = "clipwrapdelay";
  const sequenceUid = "sequencewrapdelay";
  const firstCueUid = "cuewrapdelay1";
  const secondCueUid = "cuewrapdelay2";
  const start = timelineAction("start-wrap-delay", 500, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-wrap-delay", 9500, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action: start,
      actions: [start, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Wrap Delay" },
                source: { type: "Sequence", data: sequenceUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        sequenceMapByUid: new Map([
          [
            sequenceUid,
            {
              identifiers: { id: 1, uid: sequenceUid, label: "Sequence" },
              steps: [firstCueUid, secondCueUid],
              wrap: true,
              release_on_start: false,
              default_timing: {},
              setup_cue: cue("setup", { type: "Manual" }),
              release_cue: cue("release", { type: "Manual" }),
              tracking_mode: { type: "Inherit" },
            } as types.Sequence,
          ],
        ]),
        cueMapByUid: new Map([
          [
            firstCueUid,
            cue(firstCueUid, { type: "AfterDelay", data: msToDuration(500) }),
          ],
          [secondCueUid, cue(secondCueUid, { type: "FollowPrevious" })],
        ]),
        cueDurationProfileMapByUid: new Map([
          [firstCueUid, cueDurationProfile(firstCueUid, 1500)],
          [secondCueUid, cueDurationProfile(secondCueUid, 2500)],
        ]),
      }),
    }),
    { durationMs: 9000, loopIntervalMs: 4500 },
  );
});

/** Verifies single-cue wrapped sequences use cue 1's wrap delay as the loop. */
test("resolveActionVisualDuration resolves single-cue wrap intervals", () => {
  const clipUid = "clipsinglewrapdelay";
  const sequenceUid = "sequencesinglewrapdelay";
  const cueUid = "cuesinglewrapdelay";
  const start = timelineAction("start-single-wrap-delay", 500, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-single-wrap-delay", 60_500, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action: start,
      actions: [start, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Single Wrap" },
                source: { type: "Sequence", data: sequenceUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        sequenceMapByUid: new Map([
          [
            sequenceUid,
            {
              identifiers: { id: 1, uid: sequenceUid, label: "Sequence" },
              steps: [cueUid],
              wrap: true,
              release_on_start: false,
              default_timing: {},
              setup_cue: cue("setup", { type: "Manual" }),
              release_cue: cue("release", { type: "Manual" }),
              tracking_mode: { type: "Inherit" },
            } as types.Sequence,
          ],
        ]),
        cueMapByUid: new Map([
          [cueUid, cue(cueUid, { type: "AfterDelay", data: msToDuration(10) })],
        ]),
        cueDurationProfileMapByUid: new Map([
          [cueUid, cueDurationProfile(cueUid, 3000)],
        ]),
      }),
    }),
    { durationMs: 60_000, loopIntervalMs: 10 },
  );
});

/** Verifies stored FX module clips can expose finite pattern durations. */
test("resolveActionVisualDuration resolves configured FX module loop intervals", () => {
  const clipUid = "clipfxmodule";
  const fxModuleUid = "fxmoduleconfigured";
  const action = timelineAction("start-fx-module", 0, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-fx-module", 9800, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action,
      actions: [action, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Module" },
                source: { type: "FxModule", data: fxModuleUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        fxMapByUid: new Map([
          [
            fxModuleUid,
            storedFxModule(fxModuleUid, "custom-module", {
              pattern_ms: "6200",
            }),
          ],
        ]),
      }),
    }),
    { durationMs: 9800, loopIntervalMs: 6200 },
  );
});

/** Verifies Step FX clips use same-track stop spans and authored loop intervals. */
test("resolveActionVisualDuration resolves Step FX stop spans", () => {
  const clipUid = "clipstepfx";
  const stepFxUid = "stepfxswipes";
  const action = timelineAction("start-step-fx", 2000, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-step-fx", 9500, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action,
      actions: [action, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Swipes" },
                source: { type: "StepFx", data: stepFxUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        fxMapByUid: new Map([[stepFxUid, stepFx(stepFxUid, 1250)]]),
      }),
    }),
    { durationMs: 7500, loopIntervalMs: 1250 },
  );
});

/** Verifies automatic Bounce duration includes its outward and return passes. */
test("resolveActionVisualDuration doubles automatic bounce cycles", () => {
  const clipUid = "clipautobouncestepfx";
  const stepFxUid = "autobouncestepfx";
  const definition = stepFx(stepFxUid, 500);
  definition.direction = types.FxDirection.Bounce;
  const item = timelineAction("start-auto-bounce-step-fx", 0, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-auto-bounce-step-fx", 3000, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action: item,
      actions: [item, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Bounce" },
                source: { type: "StepFx", data: stepFxUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        fxMapByUid: new Map([[stepFxUid, definition]]),
      }),
    }),
    { durationMs: 3000, loopIntervalMs: 1000 },
  );
});

/** Verifies fixed Step FX scaling controls the timeline's repeated-cycle interval. */
test("resolveActionVisualDuration uses fixed Step FX cycle scaling", () => {
  const clipUid = "clipfixedstepfx";
  const stepFxUid = "fixedstepfx";
  const definition = stepFx(stepFxUid, 500);
  definition.direction = types.FxDirection.Bounce;
  definition.cycle_scale = { type: "Fixed", data: 6 };
  const item = timelineAction("start-fixed-step-fx", 0, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-fixed-step-fx", 9000, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action: item,
      actions: [item, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Fixed" },
                source: { type: "StepFx", data: stepFxUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        fxMapByUid: new Map([[stepFxUid, definition]]),
      }),
    }),
    { durationMs: 9000, loopIntervalMs: 6000 },
  );
});

/** Verifies lane timing supplies duration when no track inherits overall timing. */
test("resolveActionVisualDuration uses Step FX lane timing overrides", () => {
  const clipUid = "clipoverriddenstepfx";
  const stepFxUid = "overriddenstepfx";
  const definition = stepFx(stepFxUid, 500);
  definition.lanes[0].timing_override = {
    beat_duration: msToDuration(1500),
  };
  const item = timelineAction("start-overridden-step-fx", 0, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-overridden-step-fx", 6000, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action: item,
      actions: [item, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Override" },
                source: { type: "StepFx", data: stepFxUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        fxMapByUid: new Map([[stepFxUid, definition]]),
      }),
    }),
    { durationMs: 6000, loopIntervalMs: 1500 },
  );
});

/** Verifies FX modules expose explicitly configured pattern durations. */
test("resolveActionVisualDuration resolves pattern FX module loop intervals", () => {
  const clipUid = "clippattern";
  const fxModuleUid = "fxmodulepattern";
  const action = timelineAction("start-pattern", 0, {
    type: "StartClip",
    data: clipUid,
  });
  const stop = timelineAction("stop-pattern", 16_000, {
    type: "StopClip",
    data: clipUid,
  });

  assert.deepEqual(
    resolveActionVisualDuration({
      action,
      actions: [action, stop],
      targetIndex: targetIndex({
        clipMapByUid: new Map([
          [
            clipUid,
            [
              {
                identifiers: { id: 1, uid: clipUid, label: "Pattern" },
                source: { type: "FxModule", data: fxModuleUid },
                priority: 0,
              } as types.Clip,
              false,
            ],
          ],
        ]),
        fxMapByUid: new Map([
          [
            fxModuleUid,
            storedFxModule(fxModuleUid, "example-pattern", {
              pattern_ms: "7868.852",
            }),
          ],
        ]),
      }),
    }),
    { durationMs: 16_000, loopIntervalMs: 7868.852 },
  );
});

/** Verifies unsupported actions do not reuse their stored default duration. */
test("resolveActionVisualDurationMs omits unknown action lengths", () => {
  const action = timelineAction("desk", 0, { type: "DeskEval", data: "noop" });

  assert.equal(
    resolveActionVisualDurationMs({
      action,
      actions: [action],
      targetIndex: targetIndex(),
    }),
    undefined,
  );
});

test("actionDragPositionFromPointer snaps the aligned action start", () => {
  const position = actionDragPositionFromPointer({
    clientX: 148,
    laneLeft: 100,
    initialPositionPx: 10,
    timelineStartMs: 0,
    zoom: 50,
    snapConfig: snapConfig(true),
  });

  assert.deepEqual(position, {
    positionPx: 50,
    offsetPx: 40,
    positionMs: 1000,
  });
});

/** Verifies vertical track switches can snap back to the original action start. */
test("actionDragPositionFromPointer prefers original start snap positions", () => {
  const position = actionDragPositionFromPointer({
    clientX: 148,
    laneLeft: 100,
    initialPositionPx: 40,
    originalSnapPositionsPx: [40],
    timelineStartMs: 0,
    zoom: 50,
    snapConfig: snapConfig(true),
  });

  assert.deepEqual(position, {
    positionPx: 40,
    offsetPx: 0,
    positionMs: 800,
  });
});

/** Verifies original start alignment still works when grid snapping is disabled. */
test("actionDragPositionFromPointer keeps original start snap independent", () => {
  const position = actionDragPositionFromPointer({
    clientX: 148,
    laneLeft: 100,
    initialPositionPx: 40,
    originalSnapPositionsPx: [40],
    timelineStartMs: 0,
    zoom: 50,
    snapConfig: snapConfig(false),
  });

  assert.deepEqual(position, {
    positionPx: 40,
    offsetPx: 0,
    positionMs: 800,
  });
});
