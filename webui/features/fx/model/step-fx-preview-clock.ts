// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToSeconds } from "../../../lib/duration";
import * as types from "../../../types";
import { FxDirection } from "../../../types";

export type StepFxPreviewTrackKind = "absolute" | "relative";

/** Finds the backend runtime anchor owned by one editor-local preview session. */
export function findStepFxPreviewStatus(
  playbacks: Record<string, types.InstanceInfo>,
  sessionId: string,
): types.StepFxPreviewPlaybackStatus | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  return Object.values(playbacks).find((playback) => {
    const preview = playback.step_fx_preview;
    return (
      playback.is_preview &&
      playback.display_kind === types.InstanceDisplayKind.StepFx &&
      preview !== undefined &&
      normalizeSessionId(preview.session_id) === normalizedSessionId
    );
  })?.step_fx_preview;
}

/** Resolves the first selection index's track beat from one backend clock anchor. */
export function stepFxPreviewBeat(
  preview: types.StepFxPreviewPlaybackStatus | undefined,
  attribute: types.Attribute,
  trackKind: StepFxPreviewTrackKind,
  totalBeats: number,
  beatDurationSeconds: number,
  nowEpochMs: number,
  selectionPhaseOffset = 0,
  direction: FxDirection = FxDirection.Forward,
  cycleScale: types.StepFxCycleScale = { type: "Auto" },
): number | undefined {
  if (
    !preview ||
    !Number.isFinite(totalBeats) ||
    totalBeats <= 0 ||
    !Number.isFinite(beatDurationSeconds) ||
    beatDurationSeconds <= 0 ||
    !Number.isFinite(nowEpochMs) ||
    !Number.isFinite(selectionPhaseOffset)
  ) {
    return undefined;
  }

  const interpolationSeconds =
    Math.max(0, nowEpochMs - preview.sampled_at_epoch_ms) / 1_000;
  const elapsedSeconds =
    durationToSeconds(preview.elapsed) +
    interpolationSeconds * Math.max(0, preview.elapsed_rate);
  const cycleBeats = stepFxEffectiveCycleBeats(
    totalBeats,
    cycleScale,
    direction,
  );
  const cycleSeconds = cycleBeats * beatDurationSeconds;
  const offset = preview.track_phase_offsets.find((candidate) =>
    attributesEqual(candidate.attribute, attribute),
  )?.[trackKind];
  const cyclePosition = positiveModulo(
    elapsedSeconds / cycleSeconds +
      stepFxStartCyclePosition(selectionPhaseOffset, direction) +
      (offset ?? 0),
    1,
  );
  return stepFxAuthoredBeat(cyclePosition, totalBeats, direction);
}

/** Resolves multiple selection phase offsets against one backend clock sample. */
export function stepFxPreviewBeats(
  preview: types.StepFxPreviewPlaybackStatus | undefined,
  attribute: types.Attribute,
  trackKind: StepFxPreviewTrackKind,
  totalBeats: number,
  beatDurationSeconds: number,
  nowEpochMs: number,
  selectionPhaseOffsets: readonly number[],
  direction: FxDirection = FxDirection.Forward,
  cycleScale: types.StepFxCycleScale = { type: "Auto" },
): Array<number | undefined> {
  return selectionPhaseOffsets.map((selectionPhaseOffset) =>
    stepFxPreviewBeat(
      preview,
      attribute,
      trackKind,
      totalBeats,
      beatDurationSeconds,
      nowEpochMs,
      selectionPhaseOffset,
      direction,
      cycleScale,
    ),
  );
}

/** Resolves live preview beats or falls back to each fixture's authored start. */
export function stepFxPreviewOrStartBeats(
  preview: types.StepFxPreviewPlaybackStatus | undefined,
  attribute: types.Attribute,
  trackKind: StepFxPreviewTrackKind,
  totalBeats: number,
  beatDurationSeconds: number,
  nowEpochMs: number,
  selectionPhaseOffsets: readonly number[],
  direction: FxDirection = FxDirection.Forward,
  cycleScale: types.StepFxCycleScale = { type: "Auto" },
): number[] {
  return stepFxPreviewBeats(
    preview,
    attribute,
    trackKind,
    totalBeats,
    beatDurationSeconds,
    nowEpochMs,
    selectionPhaseOffsets,
    direction,
    cycleScale,
  ).map(
    (beat, index) =>
      beat ??
      stepFxPhaseMarkerBeat(
        selectionPhaseOffsets[index] ?? 0,
        totalBeats,
        direction,
      ),
  );
}

/** Chooses the adjacent waveform cycle that preserves or viewport-wraps authored phase displacement. */
export function stepFxPlayheadCycleOffset(
  beat: number,
  selectedBeat: number,
  phaseOffset: number,
  selectedPhaseOffset: number,
  totalBeats: number,
  direction: FxDirection,
  wrapWithinCenteredCycle = false,
): number {
  if (
    direction === FxDirection.Bounce ||
    !Number.isFinite(beat) ||
    !Number.isFinite(selectedBeat) ||
    !Number.isFinite(phaseOffset) ||
    !Number.isFinite(selectedPhaseOffset) ||
    !Number.isFinite(totalBeats) ||
    totalBeats <= 0
  ) {
    return 0;
  }
  const directionSign = direction === FxDirection.Reverse ? -1 : 1;
  const authoredBeat =
    selectedBeat +
    (phaseOffset - selectedPhaseOffset) * totalBeats * directionSign;
  const authoredCycleOffset = Math.round((authoredBeat - beat) / totalBeats);
  if (!wrapWithinCenteredCycle) return authoredCycleOffset;
  const authoredDisplacement =
    (phaseOffset - selectedPhaseOffset) * directionSign;
  return authoredCycleOffset - Math.floor(authoredDisplacement + 0.5);
}

/** Resolves a complete directional cycle after scaling one authored pass. */
export function stepFxEffectiveCycleBeats(
  authoredPassBeats: number,
  cycleScale: types.StepFxCycleScale,
  direction: FxDirection = FxDirection.Forward,
): number {
  const passBeats =
    cycleScale.type === "Fixed" ? cycleScale.data : authoredPassBeats;
  return passBeats * (direction === FxDirection.Bounce ? 2 : 1);
}

/** Maps one backend cycle phase onto the direction-neutral authored waveform. */
export function stepFxAuthoredBeat(
  cyclePosition: number,
  totalBeats: number,
  direction: FxDirection,
): number {
  if (direction === FxDirection.Reverse) {
    return (1 - cyclePosition) * totalBeats;
  }
  if (direction === FxDirection.Bounce) {
    const traversal = cyclePosition * 2;
    return (traversal <= 1 ? traversal : 2 - traversal) * totalBeats;
  }
  return cyclePosition * totalBeats;
}

/** Maps a selected index's assigned cycle offset onto the authored graph. */
export function stepFxPhaseMarkerBeat(
  selectionPhaseOffset: number,
  totalBeats: number,
  direction: FxDirection,
): number {
  return stepFxAuthoredBeat(
    stepFxStartCyclePosition(selectionPhaseOffset, direction),
    totalBeats,
    direction,
  );
}

/** Converts an authored start position into the complete directional cycle. */
export function stepFxStartCyclePosition(
  startPosition: number,
  direction: FxDirection,
): number {
  const passCount = direction === FxDirection.Bounce ? 2 : 1;
  return positiveModulo(startPosition / passCount, 1);
}

/** Compares generated attribute union values without relying on object identity. */
function attributesEqual(
  left: types.Attribute,
  right: types.Attribute,
): boolean {
  if (left.type !== right.type) return false;
  if (left.type !== "Custom" || right.type !== "Custom") return true;
  return left.data.label === right.data.label;
}

/** Canonicalizes compact and hyphenated UUID forms emitted across the websocket boundary. */
function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/-/g, "").toLowerCase();
}

/** Returns a non-negative modulo for wrapped cycle positions. */
function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
