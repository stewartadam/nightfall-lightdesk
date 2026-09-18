// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { durationToMs } from "../../../lib/duration";
import type * as types from "../../../types";
import type { ActionTargetIndex } from "./action-targets";

const MIN_DURATION_TRAIL_LOOP_MARKER_SPACING_PX = 8;
const MAX_DURATION_TRAIL_LOOP_MARKER_ELEMENTS = 256;

export type ActionVisualDuration = {
  durationMs: number;
  loopIntervalMs?: number;
};

export type ActionDurationTrailLoopMarker =
  | {
      kind: "tick";
      offsetPx: number;
      loopIndex: number;
      sampled: boolean;
    }
  | {
      kind: "ellipsis";
      offsetPx: number;
      rawMarkerCount: number;
      sampleStride: number;
      skippedMarkerCount: number;
    };

export type ActionDurationTrailLoopMarkers = {
  markers: ActionDurationTrailLoopMarker[];
  rawMarkerCount: number;
  sampleStride: number;
  sampled: boolean;
};

/** Normalizes target UIDs before comparing timeline actions with target indexes. */
function normalizeDurationTargetUid(uid: unknown): string {
  return normalizeFixtureUid(uid).toLowerCase();
}

/** Converts a known positive action duration into a visible timeline trail width. */
export function actionDurationTrailWidth(
  durationMs: number | undefined,
  zoom: number,
): number | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs))
    return undefined;
  if (durationMs <= 0) return undefined;
  return Math.max(1, Math.ceil((durationMs / 1000) * zoom));
}

/** Converts known loop intervals into visible ticks and sampled-range markers. */
export function actionDurationTrailLoopMarkers(
  durationMs: number | undefined,
  loopIntervalMs: number | undefined,
  zoom: number,
): ActionDurationTrailLoopMarkers {
  if (
    durationMs === undefined ||
    loopIntervalMs === undefined ||
    !Number.isFinite(durationMs) ||
    !Number.isFinite(loopIntervalMs) ||
    !Number.isFinite(zoom) ||
    durationMs <= 0 ||
    loopIntervalMs <= 0 ||
    zoom <= 0 ||
    loopIntervalMs >= durationMs
  ) {
    return {
      markers: [],
      rawMarkerCount: 0,
      sampleStride: 1,
      sampled: false,
    };
  }

  const rawMarkerCount = Math.max(
    0,
    Math.ceil(durationMs / loopIntervalMs) - 1,
  );
  const intervalPx = (loopIntervalMs / 1000) * zoom;
  const spacingStride = Math.ceil(
    (MIN_DURATION_TRAIL_LOOP_MARKER_SPACING_PX + 1) / intervalPx,
  );
  const maxTickCount = MAX_DURATION_TRAIL_LOOP_MARKER_ELEMENTS - 1;
  const countStride = Math.ceil(rawMarkerCount / maxTickCount);
  const sampleStride = Math.max(1, spacingStride, countStride);
  const sampled = sampleStride > 1;
  const markers: ActionDurationTrailLoopMarker[] = [];

  for (
    let loopIndex = sampleStride;
    loopIndex <= rawMarkerCount;
    loopIndex += sampleStride
  ) {
    markers.push({
      kind: "tick",
      offsetPx: Math.max(
        1,
        Math.ceil(((loopIndex * loopIntervalMs) / 1000) * zoom),
      ),
      loopIndex,
      sampled,
    });
  }

  if (sampled && markers.length > 0) {
    markers.splice(Math.floor(markers.length / 2), 0, {
      kind: "ellipsis",
      offsetPx: Math.max(1, Math.ceil((durationMs / 2000) * zoom)),
      rawMarkerCount,
      sampleStride,
      skippedMarkerCount: rawMarkerCount - markers.length,
    });
  }

  return {
    markers,
    rawMarkerCount,
    sampleStride,
    sampled,
  };
}

/** Builds a visual duration only when the active span is finite and positive. */
function visualDuration(
  durationMs: number | undefined,
  loopIntervalMs?: number | undefined,
): ActionVisualDuration | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return undefined;
  }
  if (durationMs <= 0) return undefined;
  return {
    durationMs,
    loopIntervalMs:
      loopIntervalMs !== undefined &&
      Number.isFinite(loopIntervalMs) &&
      loopIntervalMs > 0
        ? loopIntervalMs
        : undefined,
  };
}

/** Returns the clip UID targeted by a start or stop timeline action. */
function clipLifecycleUid(action: types.ActionKind): string | undefined {
  if (action.type !== "StartClip" && action.type !== "StopClip") {
    return undefined;
  }
  return normalizeDurationTargetUid(action.data);
}

/** Returns the next stop position for the same clip after a start action. */
function nextClipStopDurationMs(
  action: types.Action,
  actions: types.Action[],
): number | undefined {
  if (action.action.type !== "StartClip") return undefined;
  const clipUid = normalizeDurationTargetUid(action.action.data);
  const itemPositionMs = durationToMs(action.position);
  const nextStopPositionMs = actions
    .filter(
      (candidate) =>
        candidate.id !== action.id &&
        durationToMs(candidate.position) > itemPositionMs &&
        candidate.action.type === "StopClip" &&
        clipLifecycleUid(candidate.action) === clipUid,
    )
    .map((candidate) => durationToMs(candidate.position))
    .sort((left, right) => left - right)[0];
  if (nextStopPositionMs === undefined) return undefined;
  return nextStopPositionMs - itemPositionMs;
}

/** Resolves one cue's assertion span from backend-authored duration profiles. */
function cueAssertionDurationMs(
  cueUid: string,
  targetIndex: ActionTargetIndex,
): number | undefined {
  const profile = targetIndex.cueDurationProfileMapByUid.get(
    normalizeDurationTargetUid(cueUid),
  );
  return profile
    ? durationToMs(profile.profile.max_transition_duration)
    : undefined;
}

/** Estimates when a non-wrapping autonomous sequence clip will finish. */
function nonWrappingSequenceAutoEndDurationMs(
  sequence: types.Sequence,
  targetIndex: ActionTargetIndex,
): number | undefined {
  let previousActivationMs = 0;
  let previousAssertionMs = 0;
  let completionMs = 0;

  for (const [index, cueUid] of sequence.steps.entries()) {
    const cue = targetIndex.cueMapByUid.get(normalizeDurationTargetUid(cueUid));
    const assertionMs = cueAssertionDurationMs(cueUid, targetIndex);
    if (!cue || assertionMs === undefined) return undefined;

    let activationMs = 0;
    if (index > 0) {
      switch (cue.trigger.type) {
        case "FollowPrevious":
          activationMs = previousActivationMs + previousAssertionMs;
          break;
        case "AfterDelay":
          activationMs = previousActivationMs + durationToMs(cue.trigger.data);
          break;
        case "At":
          activationMs = durationToMs(cue.trigger.data);
          break;
        case "Manual":
          return undefined;
      }
    }

    completionMs = Math.max(completionMs, activationMs + assertionMs);
    previousActivationMs = activationMs;
    previousAssertionMs = assertionMs;
  }

  return completionMs > 0 ? completionMs : undefined;
}

/** Returns the first cue's wrapped sequence delay when it is represented explicitly. */
function firstCueWrapDelayMs(
  sequence: types.Sequence,
  targetIndex: ActionTargetIndex,
): number | undefined {
  const firstCueUid = sequence.steps[0];
  if (!firstCueUid) return undefined;

  const firstCue = targetIndex.cueMapByUid.get(
    normalizeDurationTargetUid(firstCueUid),
  );
  if (firstCue?.trigger.type !== "AfterDelay") return undefined;

  const delayMs = durationToMs(firstCue.trigger.data);
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined;
}

/** Estimates the repeat interval for a wrapping autonomous sequence clip. */
function wrappingSequenceLoopIntervalMs(
  sequence: types.Sequence,
  targetIndex: ActionTargetIndex,
): number | undefined {
  const wrapDelayMs = firstCueWrapDelayMs(sequence, targetIndex);
  if (sequence.steps.length === 1 && wrapDelayMs !== undefined) {
    return wrapDelayMs;
  }

  const nonWrappingDurationMs = nonWrappingSequenceAutoEndDurationMs(
    sequence,
    targetIndex,
  );
  if (nonWrappingDurationMs === undefined) return undefined;

  return nonWrappingDurationMs + (wrapDelayMs ?? 0);
}

/** Narrows timeline target entries to stored FX module definitions. */
function isStoredFxModule(
  entry: types.Fx | types.StepFx | types.StoredFxModule | undefined,
): entry is types.StoredFxModule {
  return Boolean(entry && "module_name" in entry && "config" in entry);
}

/** Parses a positive millisecond duration from an FX module config map. */
function positiveConfigDurationMs(
  config: Record<string, string>,
  key: string,
): number | undefined {
  const rawValue = config[key];
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Resolves finite pattern durations exposed by stored FX module definitions. */
function fxModulePatternDurationMs(
  fxModule: types.StoredFxModule,
): number | undefined {
  return positiveConfigDurationMs(fxModule.config, "pattern_ms");
}

/** Resolves a sequence clip's visible duration from sequence behavior. */
function sequenceClipDurationMs(
  action: types.Action,
  actions: types.Action[],
  sequenceUid: string,
  clip: types.Clip,
  targetIndex: ActionTargetIndex,
): ActionVisualDuration | undefined {
  const sequence = targetIndex.sequenceMapByUid.get(
    normalizeDurationTargetUid(sequenceUid),
  );
  if (!sequence) return undefined;

  if (sequence.wrap) {
    return visualDuration(
      nextClipStopDurationMs(action, actions),
      wrappingSequenceLoopIntervalMs(sequence, targetIndex),
    );
  }

  if (clip.options?.deactivate_on_sequence_end !== true) {
    return undefined;
  }

  return visualDuration(
    nonWrappingSequenceAutoEndDurationMs(sequence, targetIndex),
  );
}

/** Resolves a stored FX module clip's visible duration when the module exposes one. */
function fxModuleClipDurationMs(
  action: types.Action,
  actions: types.Action[],
  fxModuleUid: string,
  targetIndex: ActionTargetIndex,
): ActionVisualDuration | undefined {
  const fxModule = targetIndex.fxMapByUid.get(
    normalizeDurationTargetUid(fxModuleUid),
  );
  if (!isStoredFxModule(fxModule)) return undefined;
  const patternDurationMs = fxModulePatternDurationMs(fxModule);
  return visualDuration(
    nextClipStopDurationMs(action, actions),
    patternDurationMs,
  );
}

/** Resolves a Step FX clip's visible duration from its effective cycle and stop span. */
function stepFxClipDurationMs(
  action: types.Action,
  actions: types.Action[],
  stepFxUid: string,
  targetIndex: ActionTargetIndex,
): ActionVisualDuration | undefined {
  const stepFx = targetIndex.fxMapByUid.get(
    normalizeDurationTargetUid(stepFxUid),
  );
  if (!stepFx || !("timing" in stepFx)) return undefined;
  const representatives = stepFx.lanes.flatMap((lane) =>
    [lane.absolute, lane.relative]
      .filter((track): track is types.FxTrack => Boolean(track))
      .map((track) => ({
        track,
        timing: lane.timing_override ?? stepFx.timing,
      })),
  );
  const representative = representatives[0];
  if (!representative) return undefined;
  const cycleBeats =
    stepFx.cycle_scale.type === "Fixed"
      ? stepFx.cycle_scale.data
      : representative.track.steps.reduce(
          (sum, step) => sum + step.width_beats,
          0,
        );
  const completeCycleBeats =
    cycleBeats * (stepFx.direction === "Bounce" ? 2 : 1);
  return visualDuration(
    nextClipStopDurationMs(action, actions),
    durationToMs(representative.timing.beat_duration) * completeCycleBeats,
  );
}

/** Resolves a timeline action's inferred visual duration from its target source. */
export function resolveActionVisualDuration(options: {
  action: types.Action;
  actions: types.Action[];
  targetIndex: ActionTargetIndex;
}): ActionVisualDuration | undefined {
  const { action, actions, targetIndex } = options;
  if (action.action.type !== "StartClip") return undefined;

  const clip = targetIndex.clipMapByUid.get(
    normalizeDurationTargetUid(action.action.data),
  )?.[0];
  if (!clip) return undefined;

  switch (clip.source?.type) {
    case "Sequence":
      return sequenceClipDurationMs(
        action,
        actions,
        clip.source.data,
        clip,
        targetIndex,
      );
    case "FxModule":
      return fxModuleClipDurationMs(
        action,
        actions,
        clip.source.data,
        targetIndex,
      );
    case "StepFx":
      return stepFxClipDurationMs(
        action,
        actions,
        clip.source.data,
        targetIndex,
      );
    default:
      return undefined;
  }
}

/** Resolves only the active span when loop marker metadata is not needed. */
export function resolveActionVisualDurationMs(options: {
  action: types.Action;
  actions: types.Action[];
  targetIndex: ActionTargetIndex;
}): number | undefined {
  return resolveActionVisualDuration(options)?.durationMs;
}
