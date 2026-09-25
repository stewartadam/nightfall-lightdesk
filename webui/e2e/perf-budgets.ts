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

import { expect } from "@playwright/test";
import type { summarizePresentationTrace } from "./visualizer-presentation-report";

/** 60 Hz refresh budget plus scheduling slack: a frame interval above this is a visible skip. */
export const FRAME_SKIP_MS = 25;

/** The 99th-percentile frame interval must stay within one refresh plus slack. */
export const P99_FRAME_INTERVAL_MS = FRAME_SKIP_MS;

/** At most 0.5% of frames (about one in 200, or 3–4 per 720 frames) may be skipped. */
export const MAX_SKIPPED_FRAME_RATIO = 0.005;

/** At most 0.5% of submissions may complete after their 60 Hz frame deadline. */
export const MAX_LATE_SUBMISSION_RATIO = 0.005;

/** At most 0.5% of presented frames may be dropped in a way that affects smoothness. */
export const MAX_DROPPED_FRAME_RATIO = 0.005;

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
 * Soft-asserts the Chromium presentation trace against the dropped-frame and skipped-frame
 * budgets. `requiredSequence` names the animation sequence that must have been tracked.
 */
export function expectPresentationWithinBudget(
  presentation: ReturnType<typeof summarizePresentationTrace>,
  requiredSequence: string,
): void {
  expect.soft(presentation.presentedAll).toBeGreaterThan(600);
  expect
    .soft(
      ratio(presentation.droppedAffectingSmoothness, presentation.presentedAll),
      "Dropped frames affecting smoothness",
    )
    .toBeLessThanOrEqual(MAX_DROPPED_FRAME_RATIO);
  expect
    .soft(
      ratio(
        presentation.presentationIntervalsOver25Ms,
        presentation.presentedAll,
      ),
      `Presentation intervals over ${FRAME_SKIP_MS}ms`,
    )
    .toBeLessThanOrEqual(MAX_SKIPPED_FRAME_RATIO);
  expect
    .soft(
      presentation.sequences.some(
        (sequence) => sequence.name === requiredSequence,
      ),
      `${requiredSequence} sequence tracked`,
    )
    .toBe(true);
  for (const sequence of presentation.sequences) {
    expect.soft(sequence.expected, sequence.name).toBeGreaterThan(0);
    expect
      .soft(ratio(sequence.droppedV3, sequence.expected), sequence.name)
      .toBeLessThanOrEqual(MAX_DROPPED_FRAME_RATIO);
    expect
      .soft(ratio(sequence.droppedV4, sequence.expected), sequence.name)
      .toBeLessThanOrEqual(MAX_DROPPED_FRAME_RATIO);
  }
}
