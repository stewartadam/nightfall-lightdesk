// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  TapEvent,
  TapPatternAssignment,
  TapPatternCluster,
} from "./tap-pattern-analysis";

const CLUSTER_COLORS = [
  "bg-cyan-300 ring-cyan-100",
  "bg-emerald-300 ring-emerald-100",
  "bg-amber-300 ring-amber-100",
  "bg-rose-300 ring-rose-100",
  "bg-violet-300 ring-violet-100",
  "bg-sky-300 ring-sky-100",
  "bg-lime-300 ring-lime-100",
  "bg-orange-300 ring-orange-100",
];

const SEGMENT_TIMELINE_X_PADDING_PERCENT = 1.5;

export interface TapPatternSequencePattern {
  clusters: TapPatternCluster[];
  loopLengthMs: number;
}

/** Resolves the capture origin that makes restored taps align with a monotonic clock. */
export function captureOriginForTaps(taps: TapEvent[], nowMs: number): number {
  const lastTapMs = taps[taps.length - 1]?.timeMs ?? 0;
  return nowMs - lastTapMs;
}

/** Formats millisecond values for compact timing readouts. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "--";
  return ms >= 1000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.round(ms)}ms`;
}

/** Formats beats-per-minute values for panel metrics. */
export function formatBpm(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm)) return "--";
  return bpm >= 100 ? bpm.toFixed(1) : bpm.toFixed(2);
}

/** Formats a confidence ratio as a percentage. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${Math.round(value * 100)}%`;
}

/** Formats a slider value as a compact whole-number percentage. */
export function formatSliderValue(value: number): string {
  return `${Math.round(value)}%`;
}

/** Formats the granularity direction as a compact control value. */
export function formatGranularity(value: number): string {
  if (value < 35) return "Broad";
  if (value > 65) return "Fine";
  return "Balanced";
}

/** Chooses the visual color class for a clustered tap marker. */
export function clusterColor(clusterId: number): string {
  return CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];
}

/** Maps a timeline time into the padded segment display range. */
export function segmentTimelinePercent(timeMs: number, spanMs: number): number {
  const clamped = Math.min(100, Math.max(0, (timeMs / spanMs) * 100));
  const usableWidthPercent = 100 - SEGMENT_TIMELINE_X_PADDING_PERCENT * 2;
  return (
    SEGMENT_TIMELINE_X_PADDING_PERCENT + (clamped / 100) * usableWidthPercent
  );
}

/** Builds beat scale markers, preserving a fractional final loop endpoint. */
export function beatScaleMarkers(beatsPerLoop: number): number[] {
  const normalizedBeats = Math.max(1, beatsPerLoop);
  const wholeBeatCount = Math.floor(normalizedBeats);
  const markers = Array.from(
    { length: wholeBeatCount + 1 },
    (_beat, index) => index,
  );
  if (normalizedBeats > wholeBeatCount) markers.push(normalizedBeats);
  return markers;
}

/** Returns true when keyboard input should be reserved for an editable control. */
export function isEditableKeyTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest("[data-tap-control='true']") != null))
  );
}

/** Returns true when a KeyboardEvent key is a printable ASCII tap character. */
export function isAsciiTapKey(key: string): boolean {
  if (key.length !== 1) return false;
  const codePoint = key.codePointAt(0);
  return codePoint != null && codePoint >= 0x21 && codePoint <= 0x7e;
}

/** Returns true for keys that should not create standalone musical taps. */
export function isModifierOnlyKey(key: string): boolean {
  return [
    "Alt",
    "AltGraph",
    "CapsLock",
    "Control",
    "Fn",
    "Meta",
    "NumLock",
    "ScrollLock",
    "Shift",
  ].includes(key);
}

/** Returns true when a key should clear the active tap capture. */
export function isClearTapKey(key: string): boolean {
  return key === "Backspace" || key === "Delete";
}

/** Sorts cluster rows by canonical display group. */
export function sortedClusters(
  clusters: TapPatternCluster[],
): TapPatternCluster[] {
  return [...clusters].sort((left, right) => left.id - right.id);
}

/** Builds sequence-generation pattern data for a steady pulse analysis. */
export function oneShotSequencePatternFromPulse(
  taps: TapEvent[],
  loopLengthMs: number | null,
): TapPatternSequencePattern | null {
  if (
    taps.length < 2 ||
    loopLengthMs == null ||
    !Number.isFinite(loopLengthMs) ||
    loopLengthMs <= 0
  ) {
    return null;
  }
  return {
    clusters: [
      {
        id: 0,
        phaseMs: 0,
        tapIds: taps.map((tap) => tap.id),
        averageErrorMs: 0,
      },
    ],
    loopLengthMs,
  };
}

/** Builds sequence-generation pattern data from one-off captured taps. */
export function oneShotSequencePatternFromTaps(
  taps: TapEvent[],
  tailGapMs: number | null,
): TapPatternSequencePattern | null {
  if (
    taps.length < 2 ||
    tailGapMs == null ||
    !Number.isFinite(tailGapMs) ||
    tailGapMs <= 0
  ) {
    return null;
  }
  const orderedTaps = [...taps].sort(
    (left, right) => left.timeMs - right.timeMs,
  );
  const originMs = orderedTaps[0]?.timeMs ?? 0;
  const clusters = orderedTaps.map((tap, index) => ({
    id: index,
    phaseMs: Math.max(0, tap.timeMs - originMs),
    tapIds: [tap.id],
    averageErrorMs: 0,
  }));
  const lastPhaseMs = clusters[clusters.length - 1]?.phaseMs ?? 0;
  const loopLengthMs = lastPhaseMs + tailGapMs;
  return Number.isFinite(loopLengthMs) && loopLengthMs > lastPhaseMs
    ? { clusters, loopLengthMs }
    : null;
}

/** Computes the forward gap from the previous cluster in a loop. */
export function gapFromPreviousCluster(
  cluster: TapPatternCluster,
  index: number,
  clusters: TapPatternCluster[],
  loopLengthMs: number,
): number {
  const previous = clusters[(index - 1 + clusters.length) % clusters.length];
  const rawGap = cluster.phaseMs - previous.phaseMs;
  return rawGap > 0 ? rawGap : rawGap + loopLengthMs;
}

/** Groups tap assignments by detected repeat index for segmented rendering. */
export function assignmentsByRepeat(
  assignments: TapPatternAssignment[],
): Array<{ repeatIndex: number; assignments: TapPatternAssignment[] }> {
  const grouped = new Map<number, TapPatternAssignment[]>();
  for (const assignment of assignments) {
    const repeatAssignments = grouped.get(assignment.repeatIndex) ?? [];
    repeatAssignments.push(assignment);
    grouped.set(assignment.repeatIndex, repeatAssignments);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([repeatIndex, repeatAssignments]) => ({
      repeatIndex,
      assignments: repeatAssignments.sort(
        (left, right) => left.phaseMs - right.phaseMs,
      ),
    }));
}
