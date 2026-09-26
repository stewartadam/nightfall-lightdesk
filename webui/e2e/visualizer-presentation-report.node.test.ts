// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { summarizePresentationTrace } from "./visualizer-presentation-report";

/** Constructs one Chromium async presentation record with a reusable reporter ID. */
function frame(
  start: number,
  end: number,
  state = "STATE_PRESENTED_ALL",
  pid = 1,
) {
  return [
    {
      name: "PipelineReporter",
      ph: "b",
      pid,
      ts: start,
      id2: { local: "0x1" },
      args: { frame_reporter: { state, affects_smoothness: true } },
    },
    { name: "PipelineReporter", ph: "e", pid, ts: end, id2: { local: "0x1" } },
  ];
}

/** Reused reporter IDs, unrelated processes, and incomplete boundary frames cannot corrupt counts. */
test("presentation summary scopes completed frames to the marked page interval", () => {
  const traceEvents = [
    { name: "nightfall-playback-measure-start", ph: "I", pid: 1, ts: 1000 },
    { name: "nightfall-playback-measure-end", ph: "I", pid: 1, ts: 100000 },
    ...frame(0, 2000, "STATE_DROPPED"),
    ...frame(3000, 5000),
    ...frame(19000, 21000),
    ...frame(35000, 37000, "STATE_DROPPED"),
    ...frame(51000, 53000, "STATE_PRESENTED_PARTIAL"),
    ...frame(67000, 69000),
    ...frame(90000, 101000, "STATE_DROPPED"),
    ...frame(3000, 5000, "STATE_DROPPED", 2),
  ];
  const result = summarizePresentationTrace({ traceEvents });
  assert.equal(result.presentedAll, 3);
  assert.equal(result.presentedPartial, 1);
  assert.equal(result.droppedAffectingSmoothness, 1);
  assert.equal(result.maxPresentationIntervalMs, 48);
  assert.equal(result.presentationIntervalsOver25Ms, 1);
  assert.equal(result.durationMs, 99);
});

/** Sequence metrics include dropped canvas frames even when full presentation cadence looks smooth. */
test("presentation summary retains completed canvas drop counters", () => {
  const sequence = {
    name: "FrameSequenceTrackerV3",
    ph: "b",
    pid: 1,
    ts: 1000,
    id2: { local: "0x1" },
    args: {
      name: "CanvasAnimation",
      args: { data: { expected: 301, dropped_v3: 1, dropped_v4: 1 } },
    },
  };
  const result = summarizePresentationTrace({
    traceEvents: [
      { name: "nightfall-playback-measure-start", ph: "I", pid: 1, ts: 0 },
      { name: "nightfall-playback-measure-end", ph: "I", pid: 1, ts: 6000000 },
      sequence,
      { ...sequence, ph: "e", ts: 5001000, args: undefined },
      ...frame(2000, 5000),
      { ...sequence, ts: 5500000 },
    ],
  });
  assert.deepEqual(result.sequences, [
    { name: "CanvasAnimation", expected: 301, droppedV3: 1, droppedV4: 1 },
  ]);
});

/** Missing tracing categories or measurement markers must fail instead of reporting zero drops. */
test("presentation summary rejects missing measurement evidence", () => {
  assert.throws(() => summarizePresentationTrace({ traceEvents: [] }));
  assert.throws(() =>
    summarizePresentationTrace({
      traceEvents: [
        { name: "nightfall-playback-measure-start", ph: "I", pid: 1, ts: 0 },
        { name: "nightfall-playback-measure-end", ph: "I", pid: 1, ts: 1000 },
      ],
    }),
  );
});
