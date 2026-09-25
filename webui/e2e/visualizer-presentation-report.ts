// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

type TraceEvent = {
  name: string;
  ph: string;
  pid: number;
  ts: number;
  id2?: { local?: string };
  args?: {
    name?: string;
    args?: {
      data?: { expected: number; dropped_v3: number; dropped_v4: number };
    };
    frame_reporter?: { state: string; affects_smoothness: boolean };
  };
};

/** Extracts completed presentation records for the measured page, excluding setup and other processes. */
export function summarizePresentationTrace(trace: {
  traceEvents: TraceEvent[];
}) {
  const starts = trace.traceEvents.filter(
    (event) => event.name === "nightfall-playback-measure-start",
  );
  const ends = trace.traceEvents.filter(
    (event) => event.name === "nightfall-playback-measure-end",
  );
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0].pid !== ends[0].pid ||
    starts[0].ts >= ends[0].ts
  )
    throw new Error(
      "Presentation trace must contain one valid measured interval",
    );
  const start = starts[0];
  const end = ends[0];
  const pending = new Map<string, TraceEvent>();
  const presentedAt = new Set<number>();
  const sequences: {
    name: string;
    expected: number;
    droppedV3: number;
    droppedV4: number;
  }[] = [];
  let presentedAll = 0;
  let presentedPartial = 0;
  let droppedAffectingSmoothness = 0;
  const events = trace.traceEvents
    .filter(
      (event) =>
        event.pid === start.pid &&
        event.ts >= start.ts &&
        event.ts <= end.ts &&
        (event.name === "PipelineReporter" ||
          event.name === "FrameSequenceTrackerV3"),
    )
    .sort((a, b) => a.ts - b.ts);
  for (const event of events) {
    if (event.id2?.local === undefined) continue;
    const key = `${event.name}:${event.id2.local}`;
    if (event.ph === "b") {
      pending.set(key, event);
      continue;
    }
    if (event.ph !== "e") continue;
    const begin = pending.get(key);
    pending.delete(key);
    if (!begin) continue;
    if (begin.name === "FrameSequenceTrackerV3") {
      const data = begin.args?.args?.data;
      if (data)
        sequences.push({
          name: begin.args?.name ?? "unknown",
          expected: data.expected,
          droppedV3: data.dropped_v3,
          droppedV4: data.dropped_v4,
        });
      continue;
    }
    const reporter = begin.args?.frame_reporter;
    if (reporter?.state === "STATE_PRESENTED_ALL") {
      presentedAll++;
      presentedAt.add(event.ts);
    } else if (reporter?.state === "STATE_PRESENTED_PARTIAL") {
      presentedPartial++;
    } else if (
      reporter?.state === "STATE_DROPPED" &&
      reporter.affects_smoothness
    ) {
      droppedAffectingSmoothness++;
    }
  }
  if (!presentedAll)
    throw new Error("Presentation trace contains no completed frame reports");
  const times = [...presentedAt].sort((a, b) => a - b);
  const intervals = times.slice(1).map((time, i) => (time - times[i]) / 1000);
  return {
    durationMs: (end.ts - start.ts) / 1000,
    presentedAll,
    presentedPartial,
    droppedAffectingSmoothness,
    maxPresentationIntervalMs: Math.max(0, ...intervals),
    presentationIntervalsOver25Ms: intervals.filter((value) => value > 25)
      .length,
    sequences,
  };
}
