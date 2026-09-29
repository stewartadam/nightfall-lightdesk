// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Frame-pacing budgets shared by the opt-in visualizer performance specs. They bound tail
 * behaviour with ratios and percentiles instead of demanding zero outliers, so a single
 * scheduler hiccup on a busy host does not fail an otherwise smooth run, while sustained
 * stutter (a few percent of frames) still does.
 */

import { expect, test } from "@playwright/test";
import type { summarizePresentationTrace } from "./visualizer-presentation-report";

/** Summary of a measured Chromium presentation trace. */
export type PresentationSummary = ReturnType<typeof summarizePresentationTrace>;

/** One Chromium frame-sequence tracker window from a presentation summary. */
export type PresentationSequence = PresentationSummary["sequences"][number];

/** 60 Hz refresh budget plus scheduling slack: a frame interval above this is a visible skip. */
export const FRAME_SKIP_MS = 25;

/** The 99th-percentile frame interval must stay within one refresh plus slack. */
export const P99_FRAME_INTERVAL_MS = FRAME_SKIP_MS;

/**
 * At most 0.5% of frames may be skipped: three skips in a twelve-second 60 Hz window
 * (720 frames), six at 120 Hz.
 */
export const MAX_SKIPPED_FRAME_RATIO = 0.005;

/** At most 0.5% of submissions may complete after their 60 Hz frame deadline. */
export const MAX_LATE_SUBMISSION_RATIO = 0.005;

/**
 * At most 0.5% of frames may be dropped. Applied to a Chromium sequence tracker window
 * (about 300 expected frames over five seconds at 60 Hz) this allows a single drop.
 */
export const MAX_DROPPED_FRAME_RATIO = 0.005;

/**
 * Share of the refreshes in the measured interval that must be fully presented, so a
 * trace that only captured a fraction of the interval cannot pass the ratio budgets.
 */
export const MIN_PRESENTED_REFRESH_RATIO = 5 / 6;

/** Refresh interval assumed when a spec has not measured the display's own cadence. */
export const DEFAULT_REFRESH_INTERVAL_MS = 1000 / 60;

/** Returns the value at percentile `p` (0–1) of an ascending-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Returns `count / total`, treating an empty sample as a total failure. */
export function ratio(count: number | undefined, total: number | undefined) {
  return total ? (count ?? 0) / total : 1;
}

/**
 * Returns how many fully presented frames a measured interval of `durationMs` must
 * contain at a display cadence of `refreshIntervalMs`.
 */
export function minimumPresentedFrames(
  durationMs: number,
  refreshIntervalMs: number,
): number {
  return Math.floor(
    (durationMs / refreshIntervalMs) * MIN_PRESENTED_REFRESH_RATIO,
  );
}

/** A single budgeted measurement: `actual` must lie within the inclusive `min`/`max` bounds. */
export type BudgetCheck = {
  label: string;
  actual: number;
  min?: number;
  max?: number;
};

/**
 * Evaluates a presentation summary against the dropped- and skipped-frame budgets. Only
 * tracker windows named `requiredSequence` (the benchmarked visualizer animation) are
 * budgeted; other sequences, such as unrelated UI animations that happened to run in the
 * interval, are returned separately for reporting and never fail the benchmark.
 */
export function presentationBudgetChecks(
  presentation: PresentationSummary,
  requiredSequence: string,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
): { checks: BudgetCheck[]; informational: PresentationSequence[] } {
  const required = presentation.sequences.filter(
    (sequence) => sequence.name === requiredSequence,
  );
  const checks: BudgetCheck[] = [
    {
      label: "Fully presented frames",
      actual: presentation.presentedAll,
      min: minimumPresentedFrames(presentation.durationMs, refreshIntervalMs),
    },
    {
      label: "Dropped frames affecting smoothness",
      actual: ratio(
        presentation.droppedAffectingSmoothness,
        presentation.presentedAll,
      ),
      max: MAX_DROPPED_FRAME_RATIO,
    },
    {
      label: `Presentation intervals over ${FRAME_SKIP_MS}ms`,
      actual: ratio(
        presentation.presentationIntervalsOver25Ms,
        presentation.presentedAll,
      ),
      max: MAX_SKIPPED_FRAME_RATIO,
    },
    {
      label: `${requiredSequence} sequences tracked`,
      actual: required.length,
      min: 1,
    },
  ];
  for (const [index, sequence] of required.entries()) {
    const label = `${sequence.name} #${index + 1}`;
    checks.push(
      { label: `${label} expected frames`, actual: sequence.expected, min: 1 },
      {
        label: `${label} dropped (v3)`,
        actual: ratio(sequence.droppedV3, sequence.expected),
        max: MAX_DROPPED_FRAME_RATIO,
      },
      {
        label: `${label} dropped (v4)`,
        actual: ratio(sequence.droppedV4, sequence.expected),
        max: MAX_DROPPED_FRAME_RATIO,
      },
    );
  }
  return {
    checks,
    informational: presentation.sequences.filter(
      (sequence) => sequence.name !== requiredSequence,
    ),
  };
}

/** Returns whether a budget check's measurement lies within its inclusive bounds. */
export function budgetCheckPasses(check: BudgetCheck): boolean {
  return (
    (check.min === undefined || check.actual >= check.min) &&
    (check.max === undefined || check.actual <= check.max)
  );
}

/**
 * Soft-asserts the Chromium presentation trace against the budgets of
 * {@link presentationBudgetChecks} and records unbudgeted sequences as test annotations.
 */
export function expectPresentationWithinBudget(
  presentation: PresentationSummary,
  requiredSequence: string,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
): void {
  const { checks, informational } = presentationBudgetChecks(
    presentation,
    requiredSequence,
    refreshIntervalMs,
  );
  for (const check of checks) {
    if (check.min !== undefined)
      expect.soft(check.actual, check.label).toBeGreaterThanOrEqual(check.min);
    if (check.max !== undefined)
      expect.soft(check.actual, check.label).toBeLessThanOrEqual(check.max);
  }
  for (const sequence of informational)
    test.info().annotations.push({
      type: "unbudgeted-sequence",
      description: `${sequence.name}: ${sequence.droppedV3}/${sequence.expected} dropped (v3), ${sequence.droppedV4}/${sequence.expected} dropped (v4)`,
    });
}
