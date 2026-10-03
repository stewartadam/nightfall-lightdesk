// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetCheckPasses,
  frameSkipThresholdMs,
  MAX_DROPPED_FRAME_RATIO,
  minimumPresentedFrames,
  type PresentationSummary,
  presentationBudgetChecks,
} from "./perf-budgets";

/** Builds a smooth twelve-second 60 Hz presentation summary with the given tracker windows. */
function summary(
  sequences: PresentationSummary["sequences"],
): PresentationSummary {
  return {
    durationMs: 12_000,
    presentedAll: 718,
    presentedPartial: 0,
    droppedAffectingSmoothness: 0,
    maxPresentationIntervalMs: 17,
    presentationIntervalsMs: Array.from({ length: 717 }, () => 1000 / 60),
    sequences,
  };
}

/** Returns the labels of the checks that exceed their budget. */
function failures(presentation: PresentationSummary, required: string) {
  return presentationBudgetChecks(presentation, required)
    .checks.filter((check) => !budgetCheckPasses(check))
    .map((check) => check.label);
}

/** A janky unrelated UI animation is reported but cannot fail the visualizer budget. */
test("unrelated sequences are informational only", () => {
  const presentation = summary([
    { name: "CanvasAnimation", expected: 300, droppedV3: 1, droppedV4: 1 },
    { name: "MainThreadAnimation", expected: 0, droppedV3: 40, droppedV4: 40 },
  ]);
  assert.deepEqual(failures(presentation, "CanvasAnimation"), []);
  assert.deepEqual(
    presentationBudgetChecks(presentation, "CanvasAnimation").informational.map(
      (sequence) => sequence.name,
    ),
    ["MainThreadAnimation"],
  );
});

/** Every window of the required sequence is budgeted, and a five-second window tolerates one drop. */
test("required sequence windows are held to the drop budget", () => {
  assert.equal(Math.floor(300 * MAX_DROPPED_FRAME_RATIO), 1);
  assert.deepEqual(
    failures(
      summary([
        { name: "CanvasAnimation", expected: 300, droppedV3: 1, droppedV4: 1 },
        { name: "CanvasAnimation", expected: 300, droppedV3: 2, droppedV4: 0 },
      ]),
      "CanvasAnimation",
    ),
    ["CanvasAnimation #2 dropped (v3)"],
  );
  assert.deepEqual(
    failures(
      summary([
        { name: "CanvasAnimation", expected: 0, droppedV3: 0, droppedV4: 0 },
      ]),
      "CanvasAnimation",
    ),
    [
      "CanvasAnimation #1 expected frames",
      "CanvasAnimation #1 dropped (v3)",
      "CanvasAnimation #1 dropped (v4)",
    ],
  );
});

/** A trace without the benchmarked animation fails even when other sequences are smooth. */
test("missing required sequence fails", () => {
  assert.deepEqual(
    failures(
      summary([{ name: "RAF", expected: 300, droppedV3: 0, droppedV4: 0 }]),
      "CanvasAnimation",
    ),
    ["CanvasAnimation sequences tracked"],
  );
});

/** A frame held for two refreshes counts as skipped at 120 Hz but not at 60 Hz. */
test("skip threshold follows the refresh interval", () => {
  assert.equal(frameSkipThresholdMs(1000 / 60), 25);
  assert.equal(frameSkipThresholdMs(1000 / 120), 12.5);
  const presentation = {
    ...summary([
      { name: "CanvasAnimation", expected: 1440, droppedV3: 0, droppedV4: 0 },
    ]),
    presentedAll: 1400,
    presentationIntervalsMs: [
      ...Array.from({ length: 1380 }, () => 1000 / 120),
      ...Array.from({ length: 19 }, () => 1000 / 60),
    ],
  };
  assert.deepEqual(failures(presentation, "CanvasAnimation"), []);
  assert.deepEqual(
    presentationBudgetChecks(presentation, "CanvasAnimation", 1000 / 120)
      .checks.filter((check) => !budgetCheckPasses(check))
      .map((check) => check.label),
    ["Presentation intervals over 12.5ms"],
  );
});

/** The presented-frame floor scales with the display cadence instead of assuming 60 Hz. */
test("presented frame floor follows the refresh interval", () => {
  assert.equal(minimumPresentedFrames(12_000, 1000 / 60), 600);
  assert.equal(minimumPresentedFrames(12_000, 1000 / 120), 1200);
  const presentation = summary([
    { name: "CanvasAnimation", expected: 600, droppedV3: 0, droppedV4: 0 },
  ]);
  assert.deepEqual(
    presentationBudgetChecks(presentation, "CanvasAnimation", 1000 / 120)
      .checks.filter((check) => !budgetCheckPasses(check))
      .map((check) => check.label),
    // A steady 60 Hz cadence on a 120 Hz display skips every other refresh.
    ["Fully presented frames", "Presentation intervals over 12.5ms"],
  );
});
