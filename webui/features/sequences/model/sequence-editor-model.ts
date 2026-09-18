// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  GridCell,
  GridCellStateIndicator,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  isRichTimeCell,
  type RichTimeCell,
} from "../../../lib/datagrid-rich-cells";
import {
  durationToSeconds,
  msToDuration,
  transitionModeToSeconds,
} from "../../../lib/duration";
import {
  fixtureRefKey,
  resolvedFixtureRefsForSelection,
} from "../../../lib/selection-resolution";
import { normalizeAttributeName } from "../../../lib/utils";
import type * as types from "../../../types";
import {
  normalizePlaybackUid,
  type PlaybackTransitionClock,
  type TrackingFlagsGridCell,
  trackingFlagsForMode,
  trackingFlagsFromIds,
  trackingFlagsFromMask,
  trackingModeFromFlags,
} from "../../cue-sequences";
import {
  triggerDurationOrZero,
  WRAP_DELAY_TRIGGER_LABEL,
} from "../model/sequence-wrap-delay";

export type SequenceGridRow = {
  rowKind: "cue" | "part" | "summary";
  cueUid: string;
  cue?: types.Cue;
  part?: types.CuePart;
  partId?: number;
  partIndex?: number;
  sequenceIndex: number;
  cueId: string;
  label: string;
  trigger: string;
  trackingFlags: types.Cue["tracking_flags"];
  trackingMode?: types.TrackingMode;
  afterDelay: number;
  fadeIn: number;
  delayIn: number;
  fadeOut: number;
  delayOut: number;
  startTime?: number;
  duration?: number;
  inheritedTimings: Record<TimingColumnId, boolean>;
  hasPartConflict?: boolean;
  lookaheadEnabled: boolean;
  lookaheadOwnEnabled: boolean;
  lookaheadSourceCueIds: string[];
  isMissing: boolean;
  isSetupCue?: boolean;
  isReleaseCue?: boolean;
  isFirstSequenceCue?: boolean;
  isWrapDelayCue?: boolean;
};

export type SequenceEditorTarget =
  | { rowKind: "cue"; cueUid: string }
  | { rowKind: "part"; cueUid: string; partId: number };

export type TimingColumnId = "fade_in" | "delay_in" | "fade_out" | "delay_out";
export type ComputedTimeColumnId = "start_time" | "duration";

export type TimingCellProgress = {
  delayIn?: number;
  fadeIn?: number;
  delayOut?: number;
  fadeOut?: number;
};

export type SequenceProgressContext = {
  transitionClock?: PlaybackTransitionClock;
  cueClocks: Record<string, PlaybackTransitionClock>;
  activeCueUid?: string;
  afterDelayCueUid?: string;
};

export type SequenceConflictTooltipState = {
  id: number;
  content: string;
  anchorRect: DOMRect;
};

export const ACTIVE_CUE_ROW_OUTLINE = "rgba(239, 68, 68, 0.95)";
export const INHERITED_TIMING_TEXT_COLOR = "#8f8f8f";
export const PART_ROW_BACKGROUND = "#18181b";
export const SUMMARY_ROW_BACKGROUND = "#27272a";
export const SEQUENCE_DURATION_SUMMARY_ROW_KEY = "sequence-duration-summary";
export const DEFAULT_SEQUENCE_TRACKING_FLAGS = trackingFlagsFromMask(7);

export function isTimingColumnId(
  columnId: string | undefined,
): columnId is TimingColumnId {
  return (
    columnId === "fade_in" ||
    columnId === "delay_in" ||
    columnId === "fade_out" ||
    columnId === "delay_out"
  );
}

/** Returns whether a sequence column displays a time duration. */
export function isTimeDisplayColumnId(columnId: string | undefined): boolean {
  return (
    columnId === "after_delay" ||
    isComputedTimeColumnId(columnId) ||
    isTimingColumnId(columnId)
  );
}

/** Returns whether a sequence column displays a computed read-only time value. */
export function isComputedTimeColumnId(
  columnId: string | undefined,
): columnId is ComputedTimeColumnId {
  return columnId === "start_time" || columnId === "duration";
}

/** Returns whether a sequence grid row is the computed duration summary row. */
export function isSequenceSummaryRow(row: SequenceGridRow): boolean {
  return row.rowKind === "summary";
}

/** Returns whether a sequence grid row represents an embedded meta cue. */
export function isMetaCueRow(row: {
  isSetupCue?: boolean;
  isReleaseCue?: boolean;
}): boolean {
  return !!row.isSetupCue || !!row.isReleaseCue;
}

/** Returns whether the Trigger time cell can update the row's cue trigger. */
export function canEditTriggerDuration(row: {
  rowKind: SequenceGridRow["rowKind"];
  isSetupCue?: boolean;
  isReleaseCue?: boolean;
  isFirstSequenceCue?: boolean;
  isWrapDelayCue?: boolean;
}): boolean {
  if (row.rowKind !== "cue" || row.isSetupCue || row.isReleaseCue) {
    return false;
  }
  return !row.isFirstSequenceCue || !!row.isWrapDelayCue;
}

/** Returns whether a non-wrapping sequence can reach its release row automatically. */
export function sequenceEndsAutomatically(
  sequence: types.Sequence | undefined,
): boolean {
  return sequence !== undefined && !sequence.wrap;
}

/** Returns the read-only trigger label shown for a sequence release row. */
export function releaseTriggerDisplay(
  sequence: types.Sequence | undefined,
): string {
  return sequenceEndsAutomatically(sequence) ? "Follow Previous" : "Manual";
}

/** Returns whether the trigger variant stores an editable duration payload. */
export function isDurationTrigger(
  trigger: types.CueTriggerType,
): trigger is Extract<types.CueTriggerType, { type: "AfterDelay" | "At" }> {
  return trigger.type === "AfterDelay" || trigger.type === "At";
}

/** Returns whether the trigger type should preserve or create a duration payload. */
export function isDurationTriggerType(
  triggerType: types.CueTriggerType["type"],
): triggerType is "AfterDelay" | "At" {
  return triggerType === "AfterDelay" || triggerType === "At";
}

/** Returns the duration payload for time-based trigger modes in seconds. */
export function triggerToDurationSeconds(
  trigger: types.CueTriggerType,
): number {
  if (!isDurationTrigger(trigger)) return 0;
  return durationToSeconds(trigger.data);
}

/** Returns the stable display token used in the Trigger grid column. */
export function triggerToText(trigger: types.CueTriggerType): string {
  switch (trigger.type) {
    case "Manual":
      return "Manual";
    case "FollowPrevious":
      return "Follow Previous";
    case "AfterDelay":
      return "After Delay";
    case "At":
      return "At";
  }
}

/** Builds a duration-bearing trigger while preserving an existing duration when possible. */
export function triggerWithDuration(
  triggerType: "AfterDelay" | "At",
  source: types.CueTriggerType,
  duration: types.Duration = msToDuration(0),
): types.CueTriggerType {
  return {
    type: triggerType,
    data: isDurationTrigger(source) ? source.data : duration,
  };
}

export function timingColumnValue(
  row: SequenceGridRow,
  columnId: TimingColumnId,
): number {
  switch (columnId) {
    case "fade_in":
      return row.fadeIn;
    case "delay_in":
      return row.delayIn;
    case "fade_out":
      return row.fadeOut;
    case "delay_out":
      return row.delayOut;
  }
}

/** Builds the read-only summary row shown at the bottom of the sequence grid. */
export function sequenceDurationSummaryRow(totalDuration: number | undefined) {
  return {
    rowKind: "summary",
    cueUid: SEQUENCE_DURATION_SUMMARY_ROW_KEY,
    sequenceIndex: Number.MAX_SAFE_INTEGER,
    cueId: "",
    label: "Sequence Duration",
    trigger: "",
    trackingFlags: trackingFlagsFromMask(0),
    afterDelay: 0,
    fadeIn: 0,
    delayIn: 0,
    fadeOut: 0,
    delayOut: 0,
    startTime: undefined,
    duration: totalDuration,
    inheritedTimings: {
      fade_in: false,
      delay_in: false,
      fade_out: false,
      delay_out: false,
    },
    lookaheadEnabled: false,
    lookaheadOwnEnabled: false,
    lookaheadSourceCueIds: [],
    isMissing: false,
  } satisfies SequenceGridRow;
}

/**
 * Formats cue and cue-part IDs with indentation and an expansion marker for parent cues.
 */
export function cueIdDisplay(
  row: SequenceGridRow,
  expandedCueUids: Set<string>,
) {
  if (row.rowKind === "part") {
    return `    p${row.partId ?? row.part?.identifiers.id ?? row.cueId}`;
  }

  const hasParts = (row.cue?.parts?.length ?? 0) > 0;
  if (!hasParts) return `    ${row.cueId}`;

  return `${expandedCueUids.has(row.cueUid) ? "▼" : "▶"} ${row.cueId}`;
}

/** Returns whether the cue or any authored cue part has lookahead enabled. */
export function authoredCueLookaheadEnabled(
  cue: types.Cue | undefined,
): boolean {
  return (
    cue?.lookahead === true ||
    (cue?.parts ?? []).some((part) => part.lookahead === true)
  );
}

/** Builds the lookup key used for backend-authored lookahead row state. */
export function sequenceLookaheadRowStateKey(
  cueUid: string,
  partId: number | null | undefined,
): string {
  return partId == null ? `${cueUid}:cue` : `${cueUid}:part:${partId}`;
}

/** Indexes backend-authored lookahead row states by cue and optional part ID. */
export function sequenceLookaheadRowsByKey(
  state: types.SequenceLookaheadStateMessage | undefined,
): Map<string, types.SequenceLookaheadRowState> {
  const rows = new Map<string, types.SequenceLookaheadRowState>();
  for (const row of state?.rows ?? []) {
    rows.set(sequenceLookaheadRowStateKey(row.cue_uid, row.part_id), row);
  }
  return rows;
}

/** Applies backend-authored lookahead state to a sequence editor row. */
export function applyLookaheadRowState(
  row: SequenceGridRow,
  statesByRowKey: Map<string, types.SequenceLookaheadRowState>,
): SequenceGridRow {
  if (row.rowKind === "summary") {
    return row;
  }

  const state = statesByRowKey.get(
    sequenceLookaheadRowStateKey(
      row.cueUid,
      row.rowKind === "part" ? row.partId : null,
    ),
  );
  const ownState =
    row.rowKind === "cue"
      ? statesByRowKey.get(sequenceLookaheadRowStateKey(row.cueUid, 0))
      : state;

  return {
    ...row,
    lookaheadEnabled: state?.lookahead_enabled ?? row.lookaheadEnabled,
    lookaheadOwnEnabled: ownState?.lookahead_enabled ?? row.lookaheadOwnEnabled,
    lookaheadSourceCueIds: (state?.source_cue_ids ?? []).map(String),
  };
}

/** Builds the badges displayed in the sequence editor lookahead column. */
export function lookaheadIndicators(
  row: SequenceGridRow,
): GridCellStateIndicator[] {
  const indicators: GridCellStateIndicator[] = [];
  if (row.lookaheadEnabled) {
    indicators.push({
      label: "Lookahead enabled",
      tone: "lookahead",
      variant: "tag",
      text: "LA",
    });
  }
  for (const sourceCueId of row.lookaheadSourceCueIds) {
    indicators.push({
      label: `Applies lookahead from cue ${sourceCueId}`,
      tone: "lookahead",
      variant: "tag",
      text: sourceCueId,
    });
  }
  return indicators;
}

/** Finds cue part IDs that write at least one identical fixture attribute from another part. */
export async function cuePartConflictIds(cue: types.Cue): Promise<Set<number>> {
  const writersByFixtureAttribute = new Map<string, Set<number>>();

  /** Records each fixture attribute written by the displayed cue part ID. */
  const recordInstructionWriters = async (
    partId: number,
    instructions: readonly types.BoundCueInstruction[],
  ) => {
    for (const instruction of instructions) {
      const fixtureRefs = await resolvedFixtureRefsForSelection(
        instruction.selection,
      );
      if (fixtureRefs.length === 0) continue;

      for (const attribute of Object.keys(instruction.cue_instruction.values)) {
        const normalizedAttribute = normalizeAttributeName(attribute);
        for (const fixtureRef of fixtureRefs) {
          const writerKey = `${fixtureRefKey(fixtureRef)}:${normalizedAttribute}`;
          const writers = writersByFixtureAttribute.get(writerKey) ?? new Set();
          writers.add(partId);
          writersByFixtureAttribute.set(writerKey, writers);
        }
      }
    }
  };

  await recordInstructionWriters(0, cue.instructions);
  for (const part of cue.parts ?? []) {
    await recordInstructionWriters(part.identifiers.id, part.instructions);
  }

  const conflictingPartIds = new Set<number>();
  for (const writers of writersByFixtureAttribute.values()) {
    if (writers.size <= 1) continue;
    for (const partId of writers) {
      conflictingPartIds.add(partId);
    }
  }
  return conflictingPartIds;
}

export function editorTargetForRow(
  row: SequenceGridRow,
): SequenceEditorTarget | undefined {
  if (row.rowKind === "summary") return undefined;

  if (row.rowKind === "part") {
    return {
      rowKind: "part",
      cueUid: row.cueUid,
      partId: row.partId ?? row.part?.identifiers.id ?? 0,
    };
  }

  return { rowKind: "cue", cueUid: row.cueUid };
}

/** Returns sequence timing defaults for rows that should inherit sequence timing. */
export function defaultTimingForGridRow(
  defaultTiming: types.Transition | undefined,
  row: { isSetupCue?: boolean; isReleaseCue?: boolean },
): types.Transition | undefined {
  return isMetaCueRow(row) ? undefined : defaultTiming;
}

/** Returns the flags to display/edit for a cue tracking cell. */
export function cueTrackingFlags(cue: types.Cue): types.Cue["tracking_flags"] {
  return trackingFlagsForMode(cue.tracking_mode, cue.tracking_flags);
}

/** Applies a tracking-cell edit to a cue while preserving inherited cue flags. */
export function cueWithTrackingCellEdit(
  cue: types.Cue,
  cell: TrackingFlagsGridCell,
): types.Cue {
  if (cell.data.trackingMode === "Inherit") {
    return {
      ...cue,
      tracking_mode: { type: "Inherit" },
    };
  }

  const trackingFlags = trackingFlagsFromIds(cell.data.selectedIds);
  return {
    ...cue,
    tracking_flags: trackingFlags,
    tracking_mode: trackingModeFromFlags(trackingFlags),
  };
}

export function cueToGridRow(
  row: {
    index: number;
    cueUid: string;
    cue?: types.Cue;
    isMissing: boolean;
    isSetupCue?: boolean;
    isReleaseCue?: boolean;
  },
  defaultTiming?: types.Transition,
  meta: {
    hasPartConflict?: boolean;
    releaseTrigger?: string;
    sequenceWrap?: boolean;
  } = {},
): SequenceGridRow {
  const cue = row.cue;
  const isFirstSequenceCue =
    !row.isSetupCue && !row.isReleaseCue && row.index === 0;
  const isWrapDelayCue = isFirstSequenceCue && meta.sequenceWrap === true;
  if (!cue) {
    return {
      rowKind: "cue",
      cueUid: row.cueUid,
      cue: undefined,
      sequenceIndex: row.index,
      cueId: "Missing",
      label: row.cueUid,
      trigger: "Missing",
      trackingFlags: trackingFlagsFromMask(0),
      afterDelay: 0,
      fadeIn: 0,
      delayIn: 0,
      fadeOut: 0,
      delayOut: 0,
      inheritedTimings: {
        fade_in: false,
        delay_in: false,
        fade_out: false,
        delay_out: false,
      },
      lookaheadEnabled: false,
      lookaheadOwnEnabled: false,
      lookaheadSourceCueIds: [],
      isMissing: true,
      isSetupCue: row.isSetupCue,
      isReleaseCue: row.isReleaseCue,
      isFirstSequenceCue,
      isWrapDelayCue,
    };
  }

  const inheritedTimings = {
    fade_in: cue.transitions.fade_in == null,
    delay_in: cue.transitions.delay_in == null,
    fade_out: cue.transitions.fade_out == null,
    delay_out: cue.transitions.delay_out == null,
  };
  const rowDefaultTiming = defaultTimingForGridRow(defaultTiming, row);

  const trackingFlags = row.isSetupCue
    ? DEFAULT_SEQUENCE_TRACKING_FLAGS
    : cueTrackingFlags(cue);
  const trackingMode = row.isSetupCue
    ? trackingModeFromFlags(DEFAULT_SEQUENCE_TRACKING_FLAGS)
    : cue.tracking_mode;

  return {
    rowKind: "cue",
    cueUid: row.cueUid,
    cue,
    sequenceIndex: row.index,
    cueId: row.isSetupCue
      ? "0"
      : row.isReleaseCue
        ? ""
        : String(cue.identifiers.id),
    label: cue.identifiers.label,
    trigger: row.isSetupCue
      ? "Setup"
      : row.isReleaseCue
        ? (meta.releaseTrigger ?? "Manual")
        : isWrapDelayCue
          ? WRAP_DELAY_TRIGGER_LABEL
          : triggerToText(cue.trigger),
    trackingFlags,
    trackingMode,
    afterDelay: isFirstSequenceCue
      ? isWrapDelayCue
        ? durationToSeconds(triggerDurationOrZero(cue.trigger))
        : 0
      : triggerToDurationSeconds(cue.trigger),
    fadeIn: transitionModeToSeconds(
      cue.transitions.fade_in ?? rowDefaultTiming?.fade_in,
    ),
    delayIn: transitionModeToSeconds(
      cue.transitions.delay_in ?? rowDefaultTiming?.delay_in,
    ),
    fadeOut: transitionModeToSeconds(
      cue.transitions.fade_out ?? rowDefaultTiming?.fade_out,
    ),
    delayOut: transitionModeToSeconds(
      cue.transitions.delay_out ?? rowDefaultTiming?.delay_out,
    ),
    inheritedTimings,
    hasPartConflict: meta.hasPartConflict,
    lookaheadEnabled: authoredCueLookaheadEnabled(cue),
    lookaheadOwnEnabled: cue.lookahead === true,
    lookaheadSourceCueIds: [],
    isMissing: false,
    isSetupCue: row.isSetupCue,
    isReleaseCue: row.isReleaseCue,
    isFirstSequenceCue,
    isWrapDelayCue,
  };
}

/**
 * Builds the synthetic p0 row that exposes top-level cue values alongside cue parts.
 */
export function cueBasePartToGridRow(
  cueUid: string,
  cue: types.Cue,
  sequenceIndex: number,
  defaultTiming?: types.Transition,
  meta: {
    isSetupCue?: boolean;
    isReleaseCue?: boolean;
    hasPartConflict?: boolean;
  } = {},
): SequenceGridRow {
  const inheritedTimings = {
    fade_in: cue.transitions.fade_in == null,
    delay_in: cue.transitions.delay_in == null,
    fade_out: cue.transitions.fade_out == null,
    delay_out: cue.transitions.delay_out == null,
  };
  const rowDefaultTiming = defaultTimingForGridRow(defaultTiming, meta);

  const trackingFlags = meta.isSetupCue
    ? DEFAULT_SEQUENCE_TRACKING_FLAGS
    : cueTrackingFlags(cue);
  const trackingMode = meta.isSetupCue
    ? trackingModeFromFlags(DEFAULT_SEQUENCE_TRACKING_FLAGS)
    : cue.tracking_mode;

  return {
    rowKind: "part",
    cueUid,
    cue,
    partId: 0,
    sequenceIndex,
    cueId: "Part 0",
    label: cue.identifiers.label,
    trigger: "Part",
    trackingFlags,
    trackingMode,
    afterDelay: 0,
    fadeIn: transitionModeToSeconds(
      cue.transitions.fade_in ?? rowDefaultTiming?.fade_in,
    ),
    delayIn: transitionModeToSeconds(
      cue.transitions.delay_in ?? rowDefaultTiming?.delay_in,
    ),
    fadeOut: transitionModeToSeconds(
      cue.transitions.fade_out ?? rowDefaultTiming?.fade_out,
    ),
    delayOut: transitionModeToSeconds(
      cue.transitions.delay_out ?? rowDefaultTiming?.delay_out,
    ),
    inheritedTimings,
    hasPartConflict: meta.hasPartConflict,
    lookaheadEnabled: cue.lookahead === true,
    lookaheadOwnEnabled: cue.lookahead === true,
    lookaheadSourceCueIds: [],
    isMissing: false,
    isSetupCue: meta.isSetupCue,
    isReleaseCue: meta.isReleaseCue,
  };
}

/**
 * Resolves the timing displayed for a cue part, falling back to the parent cue before sequence defaults.
 */
export function inheritedPartTiming(
  part: types.CuePart,
  cue: types.Cue,
  columnId: TimingColumnId,
  defaultTiming?: types.Transition,
): types.TransitionMode | undefined {
  return (
    part.transitions[columnId] ??
    cue.transitions[columnId] ??
    defaultTiming?.[columnId]
  );
}

export function cuePartToGridRow(
  cueUid: string,
  cue: types.Cue,
  part: types.CuePart,
  partIndex: number,
  sequenceIndex: number,
  defaultTiming?: types.Transition,
  meta: {
    isSetupCue?: boolean;
    isReleaseCue?: boolean;
    hasPartConflict?: boolean;
  } = {},
): SequenceGridRow {
  const inheritedTimings = {
    fade_in: part.transitions.fade_in == null,
    delay_in: part.transitions.delay_in == null,
    fade_out: part.transitions.fade_out == null,
    delay_out: part.transitions.delay_out == null,
  };
  const rowDefaultTiming = defaultTimingForGridRow(defaultTiming, meta);

  return {
    rowKind: "part",
    cueUid,
    cue,
    part,
    partId: part.identifiers.id,
    partIndex,
    sequenceIndex,
    cueId: `Part ${part.identifiers.id}`,
    label: part.identifiers.label,
    trigger: "Part",
    trackingFlags: part.tracking_flags,
    afterDelay: 0,
    fadeIn: transitionModeToSeconds(
      inheritedPartTiming(part, cue, "fade_in", rowDefaultTiming),
    ),
    delayIn: transitionModeToSeconds(
      inheritedPartTiming(part, cue, "delay_in", rowDefaultTiming),
    ),
    fadeOut: transitionModeToSeconds(
      inheritedPartTiming(part, cue, "fade_out", rowDefaultTiming),
    ),
    delayOut: transitionModeToSeconds(
      inheritedPartTiming(part, cue, "delay_out", rowDefaultTiming),
    ),
    inheritedTimings,
    hasPartConflict: meta.hasPartConflict,
    lookaheadEnabled: part.lookahead === true,
    lookaheadOwnEnabled: part.lookahead === true,
    lookaheadSourceCueIds: [],
    isMissing: false,
    isSetupCue: meta.isSetupCue,
    isReleaseCue: meta.isReleaseCue,
  };
}

export function updateCueTriggerType(
  cue: types.Cue,
  triggerType: types.CueTriggerType["type"],
): types.Cue {
  if (isDurationTriggerType(triggerType)) {
    return {
      ...cue,
      trigger: triggerWithDuration(triggerType, cue.trigger),
    };
  }

  return {
    ...cue,
    trigger: { type: triggerType },
  };
}

export function isTimeCell(cell: GridCell): cell is RichTimeCell {
  return cell.kind === GridCellKind.Custom && isRichTimeCell(cell);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getTimingCellProgress(
  row: SequenceGridRow,
  clock: PlaybackTransitionClock | undefined,
): TimingCellProgress | undefined {
  if (!clock || row.isMissing) {
    return undefined;
  }

  const { elapsedSeconds } = clock;

  const delayInSeconds = row.delayIn;
  const fadeInSeconds = row.fadeIn;
  const delayOutSeconds = row.delayOut;
  const fadeOutSeconds = row.fadeOut;

  if (
    delayInSeconds <= 0 &&
    fadeInSeconds <= 0 &&
    delayOutSeconds <= 0 &&
    fadeOutSeconds <= 0
  ) {
    return {
      delayIn: 1,
      fadeIn: 1,
      delayOut: 1,
      fadeOut: 1,
    };
  }

  const fadeInElapsedSeconds = elapsedSeconds - delayInSeconds;
  const fadeInProgress =
    fadeInElapsedSeconds < 0
      ? 0
      : fadeInSeconds <= 0
        ? 1
        : clamp(fadeInElapsedSeconds / fadeInSeconds, 0, 1);
  const fadeOutElapsedSeconds = elapsedSeconds - delayOutSeconds;
  const fadeOutProgress =
    fadeOutElapsedSeconds < 0
      ? 0
      : fadeOutSeconds <= 0
        ? 1
        : clamp(fadeOutElapsedSeconds / fadeOutSeconds, 0, 1);

  if (clock.phase === "out" && !row.isReleaseCue) {
    return {
      delayOut:
        delayOutSeconds <= 0
          ? 1
          : clamp(elapsedSeconds / delayOutSeconds, 0, 1),
      fadeOut: fadeOutProgress,
    };
  }

  return {
    delayIn:
      delayInSeconds <= 0 ? 1 : clamp(elapsedSeconds / delayInSeconds, 0, 1),
    fadeIn: fadeInProgress,
    delayOut:
      delayOutSeconds <= 0 ? 1 : clamp(elapsedSeconds / delayOutSeconds, 0, 1),
    fadeOut: fadeOutProgress,
  };
}

/** Returns trigger delay progress for the pending next cue row. */
export function getAfterDelayProgress(
  row: SequenceGridRow,
  progress: SequenceProgressContext,
): number | undefined {
  const clock = progress.transitionClock;
  if (
    clock?.phase !== "in" ||
    row.cueUid !== progress.afterDelayCueUid ||
    row.isMissing ||
    row.rowKind !== "cue" ||
    (row.cue?.trigger.type !== "AfterDelay" && !row.isWrapDelayCue)
  ) {
    return undefined;
  }

  return row.afterDelay <= 0
    ? 1
    : clamp(clock.elapsedSeconds / row.afterDelay, 0, 1);
}

/** Returns the progress fill for one sequence editor time column. */
export function getTimeColumnProgress(
  row: SequenceGridRow,
  columnId: string | undefined,
  progress: SequenceProgressContext,
): number | undefined {
  if (columnId === "after_delay") {
    return getAfterDelayProgress(row, progress);
  }

  if (!isTimingColumnId(columnId)) {
    return undefined;
  }

  const normalizedRowCueUid = normalizePlaybackUid(row.cueUid);
  const isActiveCue = normalizedRowCueUid === progress.activeCueUid;
  const timingProgress = getTimingCellProgress(
    row,
    progress.cueClocks[normalizedRowCueUid] ??
      (isActiveCue ? progress.transitionClock : undefined),
  );
  const columnProgress = (() => {
    switch (columnId) {
      case "delay_in":
        return timingProgress?.delayIn;
      case "fade_in":
        return timingProgress?.fadeIn;
      case "delay_out":
        return timingProgress?.delayOut;
      case "fade_out":
        return timingProgress?.fadeOut;
    }
  })();
  if (!isActiveCue && columnProgress !== undefined && columnProgress >= 1) {
    return undefined;
  }
  return columnProgress;
}

export function drawActiveCueRowOutline(
  args: {
    ctx: CanvasRenderingContext2D;
    rect: { x: number; y: number; width: number; height: number };
  },
  isFirstColumn: boolean,
  isLastColumn: boolean,
) {
  const { ctx: canvasCtx, rect } = args;
  const inset = 0.5;

  canvasCtx.save();
  canvasCtx.strokeStyle = ACTIVE_CUE_ROW_OUTLINE;
  canvasCtx.lineWidth = 1.5;
  canvasCtx.beginPath();
  canvasCtx.moveTo(rect.x + inset, rect.y + inset);
  canvasCtx.lineTo(rect.x + rect.width - inset, rect.y + inset);
  canvasCtx.moveTo(rect.x + inset, rect.y + rect.height - inset);
  canvasCtx.lineTo(rect.x + rect.width - inset, rect.y + rect.height - inset);

  if (isFirstColumn) {
    canvasCtx.moveTo(rect.x + inset, rect.y + inset);
    canvasCtx.lineTo(rect.x + inset, rect.y + rect.height - inset);
  }

  if (isLastColumn) {
    canvasCtx.moveTo(rect.x + rect.width - inset, rect.y + inset);
    canvasCtx.lineTo(rect.x + rect.width - inset, rect.y + rect.height - inset);
  }

  canvasCtx.stroke();
  canvasCtx.restore();
}
