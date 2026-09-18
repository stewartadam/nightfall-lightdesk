// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToSeconds } from "../../../lib/duration";
import {
  calculateSequenceDurationSummary as calculateRustSequenceDurationSummary,
  type SequenceDurationSummaryStep,
} from "../../../lib/wasm-bridge";
import type { CueDurationProfileMap } from "../../../state/appStores";
import type * as types from "../../../types";

export type SequenceDurationRow = {
  rowKind?: "cue" | "part" | "summary";
  cueUid: string;
  cue?: types.Cue;
  isMissing: boolean;
  isSetupCue?: boolean;
  isReleaseCue?: boolean;
};

export type SequenceDurationSummary = {
  startTimesByCueUid: Map<string, number | undefined>;
  durationsByCueUid: Map<string, number | undefined>;
  total?: number;
};

const ZERO_DURATION: types.Duration = { secs: 0, nanos: 0 };

/** Returns the empty backend duration profile used while websocket profiles load. */
function defaultCueDurationProfile(): types.CueDurationProfile {
  return {
    max_delay_in: ZERO_DURATION,
    max_fade_in: ZERO_DURATION,
    max_delay_out: ZERO_DURATION,
    max_fade_out: ZERO_DURATION,
    assertion_duration: ZERO_DURATION,
    release_duration: ZERO_DURATION,
    max_transition_duration: ZERO_DURATION,
  };
}

/** Returns whether a row contributes to sequence step duration calculations. */
function isSequenceStepRow(
  row: SequenceDurationRow,
): row is SequenceDurationRow & { cue: types.Cue } {
  return (
    (row.rowKind === undefined || row.rowKind === "cue") &&
    row.cue !== undefined &&
    !row.isSetupCue &&
    !row.isReleaseCue &&
    !row.isMissing
  );
}

/** Converts visible cue rows into the WASM request shape expected by Rust. */
function sequenceDurationSummarySteps(
  cueRows: readonly SequenceDurationRow[],
  cueDurationProfiles: CueDurationProfileMap,
): SequenceDurationSummaryStep[] {
  return cueRows.filter(isSequenceStepRow).map((row) => ({
    cue_uid: row.cueUid,
    trigger: row.cue.trigger,
    transitions: row.cue.transitions,
    parts: (row.cue.parts ?? []).map((part) => ({
      transitions: part.transitions,
    })),
    duration_profile:
      cueDurationProfiles[row.cueUid]?.profile ?? defaultCueDurationProfile(),
  }));
}

/** Returns an empty summary for unavailable sequence inputs. */
function emptySequenceDurationSummary(): SequenceDurationSummary {
  return {
    startTimesByCueUid: new Map(),
    durationsByCueUid: new Map(),
  };
}

/** Computes sequence-view duration values through the Rust WASM bridge. */
export async function sequenceDurationSummary(
  cueRows: readonly SequenceDurationRow[],
  sequence: types.Sequence | undefined,
  cueDurationProfiles: CueDurationProfileMap,
): Promise<SequenceDurationSummary> {
  if (!sequence) return emptySequenceDurationSummary();

  const summary = await calculateRustSequenceDurationSummary({
    wrap: sequence.wrap,
    default_timing: sequence.default_timing,
    steps: sequenceDurationSummarySteps(cueRows, cueDurationProfiles),
  });
  if (!summary) return emptySequenceDurationSummary();

  return {
    startTimesByCueUid: new Map(
      summary.cues.map((cue) => [
        cue.cue_uid,
        cue.start_time ? durationToSeconds(cue.start_time) : undefined,
      ]),
    ),
    durationsByCueUid: new Map(
      summary.cues.map((cue) => [
        cue.cue_uid,
        cue.duration ? durationToSeconds(cue.duration) : undefined,
      ]),
    ),
    total: summary.total ? durationToSeconds(summary.total) : undefined,
  };
}
