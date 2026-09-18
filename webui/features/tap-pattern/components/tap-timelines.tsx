// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import {
  clusterColor,
  formatMs,
  segmentTimelinePercent,
} from "../model/panel-model";
import type {
  TapEvent,
  TapPatternAnalysis,
  TapPatternAssignment,
} from "../model/tap-pattern-analysis";

type DetectedTapPattern = NonNullable<TapPatternAnalysis["pattern"]>;

interface TapCaptureTimelineProps {
  assignmentByTapId: ReadonlyMap<number, TapPatternAssignment>;
  elapsedLoopCount: number | null;
  highlightedClusterId: number | null;
  isCaptureArmed: boolean;
  loopBoundaryPositions: number[];
  relativeTapsMs: number[];
  segmentSpanMs: number;
  taps: TapEvent[];
  onRecordTap: () => void;
  onSetHighlightedClusterId: (clusterId: number | null) => void;
  onSetTimelineElement: (element: HTMLButtonElement) => void;
}

/** Renders the capture surface and its elapsed-loop tap markers. */
export function TapCaptureTimeline(props: TapCaptureTimelineProps) {
  return (
    <section class="min-h-44 border border-neutral-800 bg-neutral-950 p-3">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-xs font-semibold uppercase text-neutral-400">Taps</h2>
        <div class="text-xs text-neutral-500">
          <Show
            when={props.elapsedLoopCount}
            fallback={`${props.relativeTapsMs.length} taps`}
          >
            {(loops) =>
              `${loops()} elapsed loops / ${props.relativeTapsMs.length} taps`
            }
          </Show>
        </div>
      </div>

      <button
        aria-label="Record tap from taps timeline"
        class="relative h-28 w-full border border-neutral-800 bg-neutral-900 text-left hover:border-cyan-500/60 focus:border-cyan-400 focus:outline-none"
        ref={(element) => props.onSetTimelineElement(element)}
        type="button"
        onClick={props.onRecordTap}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
          }
        }}
      >
        <For each={props.loopBoundaryPositions}>
          {(timeMs) => (
            <div
              class="absolute top-0 h-full w-px bg-neutral-700"
              data-tap-segment-cycle-boundary="true"
              style={{
                left: `${segmentTimelinePercent(timeMs, props.segmentSpanMs)}%`,
              }}
            />
          )}
        </For>
        <Show
          when={props.relativeTapsMs.length > 0}
          fallback={
            <div class="flex h-full items-center justify-center text-sm text-neutral-500">
              {props.isCaptureArmed ? "Capture armed" : "Capture disarmed"}
            </div>
          }
        >
          <For each={props.relativeTapsMs}>
            {(timeMs, index) => {
              const tap = () => props.taps[index()];
              const assignment = () => props.assignmentByTapId.get(tap().id);
              const isHighlighted = () =>
                assignment()?.clusterId === props.highlightedClusterId;

              return (
                <div
                  class={`absolute top-1/2 h-12 w-1 -translate-y-1/2 ${
                    assignment()
                      ? clusterColor(assignment()?.clusterId ?? 0)
                      : "bg-cyan-300 ring-cyan-100"
                  } ${
                    isHighlighted()
                      ? "outline outline-1 outline-offset-2 outline-red-500"
                      : ""
                  }`}
                  data-highlighted-step={isHighlighted() ? "true" : "false"}
                  data-tap-segment-marker="true"
                  style={{
                    left: `${segmentTimelinePercent(timeMs, props.segmentSpanMs)}%`,
                  }}
                  title={`Tap ${index() + 1}: ${formatMs(timeMs)}`}
                  onMouseEnter={() => {
                    const matchedAssignment = assignment();
                    if (matchedAssignment) {
                      props.onSetHighlightedClusterId(
                        matchedAssignment.clusterId,
                      );
                    }
                  }}
                  onMouseLeave={() => props.onSetHighlightedClusterId(null)}
                />
              );
            }}
          </For>
        </Show>
      </button>
    </section>
  );
}

interface GroupedTapTimelineProps {
  beatsPerLoop: number;
  groupedBeatMarkers: number[];
  highlightedClusterId: number | null;
  pattern: DetectedTapPattern | null;
  repeatRows: Array<{
    repeatIndex: number;
    assignments: TapPatternAssignment[];
  }>;
  onSetHighlightedClusterId: (clusterId: number | null) => void;
}

/** Renders detected repeats against their shared beat and millisecond scale. */
export function GroupedTapTimeline(props: GroupedTapTimelineProps) {
  return (
    <section
      aria-label="Grouped taps"
      class="min-h-32 shrink-0 border border-neutral-800 bg-neutral-950 p-3"
    >
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="text-xs font-semibold uppercase text-neutral-400">
          Grouped Taps
        </h2>
        <div class="text-xs text-neutral-500">
          {props.pattern
            ? `${props.pattern.repeatCount} grouped cycles`
            : "No pattern"}
        </div>
      </div>

      <Show
        when={props.pattern}
        fallback={
          <div class="flex h-24 items-center justify-center border border-dashed border-neutral-800 text-sm text-neutral-500">
            No grouped taps yet
          </div>
        }
      >
        {(pattern) => (
          <div class="flex min-w-0 flex-col gap-2 pr-1">
            <div
              class="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] items-end gap-2"
              data-tap-grouped-scale="true"
            >
              <div class="font-mono text-[10px] uppercase text-neutral-600">
                Beat / ms
              </div>
              <div class="relative h-8 min-w-0">
                <For each={props.groupedBeatMarkers}>
                  {(beat) => (
                    <div
                      class={`absolute top-0 flex flex-col font-mono text-[10px] leading-tight text-neutral-500 ${
                        beat === 0
                          ? ""
                          : beat === props.beatsPerLoop
                            ? "-translate-x-full"
                            : "-translate-x-1/2"
                      }`}
                      style={{
                        left: `${segmentTimelinePercent(
                          (pattern().loopLengthMs / props.beatsPerLoop) * beat,
                          pattern().loopLengthMs,
                        )}%`,
                      }}
                    >
                      <span>{beat}</span>
                      <span class="text-neutral-600">
                        {formatMs(
                          (pattern().loopLengthMs / props.beatsPerLoop) * beat,
                        )}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <For each={props.repeatRows}>
              {(row) => (
                <div class="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
                  <div class="font-mono text-xs text-neutral-500">
                    R{row.repeatIndex + 1}
                  </div>
                  <div
                    class="relative h-12 min-w-0 border border-neutral-800 bg-neutral-900"
                    data-tap-grouped-row-track="true"
                  >
                    <For each={props.groupedBeatMarkers}>
                      {(beat) => (
                        <div
                          class="absolute top-0 h-full w-px bg-neutral-700/70"
                          data-tap-grouped-beat-divider="true"
                          style={{
                            left: `${segmentTimelinePercent(
                              (pattern().loopLengthMs / props.beatsPerLoop) *
                                beat,
                              pattern().loopLengthMs,
                            )}%`,
                          }}
                        />
                      )}
                    </For>
                    <For each={row.assignments}>
                      {(assignment) => {
                        const isHighlighted = () =>
                          assignment.clusterId === props.highlightedClusterId;

                        return (
                          <div
                            class={`absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ${clusterColor(
                              assignment.clusterId,
                            )} ${
                              isHighlighted()
                                ? "outline outline-1 outline-offset-2 outline-red-500"
                                : ""
                            }`}
                            data-highlighted-step={
                              isHighlighted() ? "true" : "false"
                            }
                            data-tap-grouped-marker="true"
                            style={{
                              left: `${segmentTimelinePercent(
                                assignment.phaseMs,
                                pattern().loopLengthMs,
                              )}%`,
                            }}
                            title={`Step ${assignment.clusterId + 1}: ${formatMs(
                              assignment.phaseMs,
                            )}`}
                            onMouseEnter={() =>
                              props.onSetHighlightedClusterId(
                                assignment.clusterId,
                              )
                            }
                            onMouseLeave={() =>
                              props.onSetHighlightedClusterId(null)
                            }
                          />
                        );
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </section>
  );
}
