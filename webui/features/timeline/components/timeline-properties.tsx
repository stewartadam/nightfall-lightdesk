// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, For, Show } from "solid-js";
import { EmptyState } from "../../../components/ui/empty-state";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../../components/ui/form-controls";
import { commandClient } from "../../../lib/engine-commands";
import { setStoreKeyAction } from "../../../lib/nanostore-action";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { durationToMs, msToDuration } from "../../../lib/utils";
import { timecodes, timelines } from "../../../state/appStores";
import * as types from "../../../types";
import { timecodeRateLabel, timecodeSourceName } from "../../timecode";

type TimelinePropertiesProps = {
  timelineUid: string;
};

function sortById<T extends { identifiers: { id: number } }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.identifiers.id - b.identifiers.id);
}

function numericValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

function integerValue(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : undefined;
}

function formatMs(duration: types.Duration | undefined): string {
  if (!duration) return "None";
  return `${durationToMs(duration)} ms`;
}

export default function TimelineProperties(props: TimelinePropertiesProps) {
  const $timelines = useShallowStore(timelines);
  const $timecodes = useStore(timecodes);

  const timeline = createMemo(() => $timelines()[props.timelineUid]);
  const timecodeRows = createMemo(() =>
    sortById(Object.values($timecodes()).map(([timecode]) => timecode)),
  );
  const linkedTimecode = createMemo(() => {
    const uid = timeline()?.timecode_uid;
    return uid ? $timecodes()[uid]?.[0] : undefined;
  });
  const sortedMarkers = createMemo(() =>
    [...(timeline()?.markers ?? [])].sort(
      (a, b) => durationToMs(a.time) - durationToMs(b.time),
    ),
  );
  const sortedRegions = createMemo(() =>
    [...(timeline()?.regions ?? [])].sort(
      (a, b) => durationToMs(a.start) - durationToMs(b.start),
    ),
  );
  let latestTimeline = timeline();
  let pendingTimecodeEdit:
    | { uid: string; patch: Partial<types.Timecode> }
    | undefined;

  /** Keeps property edits merging against the latest optimistic timeline snapshot. */
  createEffect(() => {
    latestTimeline = timeline();
  });

  /**
   * Drops the pending timecode edits once the engine reports them. Until then,
   * a periodic timecode broadcast sent before the engine applied an edit can
   * still carry the old values, so later edits keep merging the pending ones.
   */
  createEffect(() => {
    const timecode = linkedTimecode();
    if (!pendingTimecodeEdit) return;
    const settled =
      timecode?.identifiers.uid !== pendingTimecodeEdit.uid ||
      Object.entries(pendingTimecodeEdit.patch).every(
        ([key, value]) => timecode[key as keyof types.Timecode] === value,
      );
    if (settled) pendingTimecodeEdit = undefined;
  });

  const storeTimeline = (nextTimeline: types.Timeline) => {
    const command: types.TimelineCommand = {
      type: "StoreTimeline",
      data: nextTimeline,
    };
    commandClient.emit("TimelineCommand", command);
  };

  const updateTimeline = (patch: Partial<types.Timeline>) => {
    const current = latestTimeline;
    if (!current) return;
    const nextTimeline = { ...current, ...patch };
    latestTimeline = nextTimeline;
    setStoreKeyAction(
      timelines,
      "Update Timeline Properties",
      props.timelineUid,
      nextTimeline,
    );
    storeTimeline(nextTimeline);
  };

  /**
   * Stores a change to the linked timecode itself. Every timeline sharing
   * that timecode follows the new source or rate. Edits not yet reported back
   * by the engine are merged in, so a second edit before the engine applies
   * the first doesn't revert it.
   */
  const updateTimecode = (
    timecode: types.Timecode,
    patch: Partial<types.Timecode>,
  ) => {
    const uid = timecode.identifiers.uid;
    const entry = timecodes.get()[uid];
    if (!entry) return;
    const pendingPatch =
      pendingTimecodeEdit?.uid === uid ? pendingTimecodeEdit.patch : {};
    pendingTimecodeEdit = { uid, patch: { ...pendingPatch, ...patch } };
    const nextTimecode = { ...entry[0], ...pendingTimecodeEdit.patch };
    setStoreKeyAction(timecodes, "Update Timecode", uid, [
      nextTimecode,
      entry[1],
    ]);
    const command: types.TimecodeCommand = {
      type: "StoreTimecode",
      data: nextTimecode,
    };
    commandClient.emit("TimecodeCommand", command);
  };

  const updateStartMs = (value: string) => {
    const nextMs = numericValue(value);
    if (nextMs === undefined) return;
    updateTimeline({ timecode_start: msToDuration(nextMs) });
  };

  const updateEndMs = (value: string) => {
    const nextMs = numericValue(value);
    if (nextMs === undefined) return;
    updateTimeline({ end_time: msToDuration(nextMs) });
  };

  const loopRange = () => timeline()?.loop_range;

  const updateLoopRange = (patch: Partial<types.TimelineLoopRange>) => {
    const current = loopRange();
    const nextLoopRange: types.TimelineLoopRange = {
      start: current?.start ?? msToDuration(0),
      end: current?.end ?? msToDuration(10_000),
      enabled: current?.enabled ?? false,
      ...patch,
    };
    updateTimeline({ loop_range: nextLoopRange });
  };

  const updateLoopStartMs = (value: string) => {
    const nextMs = numericValue(value);
    if (nextMs === undefined) return;
    const currentEndMs = durationToMs(loopRange()?.end ?? msToDuration(10_000));
    updateLoopRange({
      start: msToDuration(nextMs),
      end: msToDuration(Math.max(nextMs, currentEndMs)),
    });
  };

  const updateLoopEndMs = (value: string) => {
    const nextMs = numericValue(value);
    if (nextMs === undefined) return;
    const currentStartMs = durationToMs(loopRange()?.start ?? msToDuration(0));
    updateLoopRange({ end: msToDuration(Math.max(currentStartMs, nextMs)) });
  };

  const updateBpm = (value: string) => {
    const nextBpm = numericValue(value);
    if (nextBpm === undefined || nextBpm <= 0) return;
    updateTimeline({ bpm: nextBpm });
  };

  const updateBeatsPerBar = (value: string) => {
    const nextBeatsPerBar = integerValue(value);
    if (nextBeatsPerBar === undefined) return;
    updateTimeline({ beats_per_bar: nextBeatsPerBar });
  };

  return (
    <Show
      when={timeline()}
      fallback={
        <EmptyState
          variant="inline"
          class="p-4"
          title="Select a timeline to edit its configuration."
        />
      }
    >
      {(currentTimeline) => (
        <div class="space-y-5 p-4 text-sm text-neutral-200">
          <div class="border-b border-neutral-700 pb-3">
            <h3 class="font-medium text-neutral-100">
              Timeline {currentTimeline().identifiers.id}
            </h3>
            <p class="text-xs text-neutral-400">
              {currentTimeline().identifiers.label || "Untitled"}
            </p>
          </div>

          <section class="space-y-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Timecode
            </h4>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Linked timecode</span>
              <NativeSelect
                density="compact"
                aria-label="Linked timecode"
                value={currentTimeline().timecode_uid}
                onChange={(event) =>
                  updateTimeline({ timecode_uid: event.currentTarget.value })
                }
              >
                <For each={timecodeRows()}>
                  {(timecode) => (
                    <option value={timecode.identifiers.uid}>
                      {timecode.identifiers.id}:{" "}
                      {timecode.identifiers.label || "Untitled"}
                    </option>
                  )}
                </For>
              </NativeSelect>
            </label>

            <Show when={linkedTimecode()}>
              {(timecode) => (
                <div class="grid grid-cols-2 gap-3">
                  <label class="block space-y-1">
                    <span class="text-xs text-neutral-400">Source</span>
                    <NativeSelect
                      density="compact"
                      aria-label="Timecode source"
                      value={timecode().source}
                      onChange={(event) =>
                        updateTimecode(timecode(), {
                          source: event.currentTarget
                            .value as types.TimecodeSource,
                        })
                      }
                    >
                      <For each={Object.values(types.TimecodeSource)}>
                        {(source) => (
                          <option value={source}>
                            {timecodeSourceName(source)}
                          </option>
                        )}
                      </For>
                    </NativeSelect>
                  </label>
                  <label class="block space-y-1">
                    <span class="text-xs text-neutral-400">Rate</span>
                    <NativeSelect
                      density="compact"
                      aria-label="Timecode rate"
                      value={timecode().rate}
                      onChange={(event) =>
                        updateTimecode(timecode(), {
                          rate: event.currentTarget.value as types.TimecodeRate,
                        })
                      }
                    >
                      <For each={Object.values(types.TimecodeRate)}>
                        {(rate) => (
                          <option value={rate}>
                            {timecodeRateLabel(rate)}
                          </option>
                        )}
                      </For>
                    </NativeSelect>
                  </label>
                </div>
              )}
            </Show>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Timecode start (ms)</span>
              <Input
                density="compact"
                aria-label="Timecode start (ms)"
                type="number"
                min="0"
                step="10"
                value={durationToMs(currentTimeline().timecode_start)}
                onChange={(event) => updateStartMs(event.currentTarget.value)}
              />
            </label>

            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label="Use end time"
                checked={currentTimeline().end_time != null}
                onChange={(event) =>
                  updateTimeline({
                    end_time: event.currentTarget.checked
                      ? (currentTimeline().end_time ?? msToDuration(60_000))
                      : undefined,
                  })
                }
              />
              <span>Use end time</span>
            </label>

            <Show when={currentTimeline().end_time}>
              {(endTime) => (
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">End time (ms)</span>
                  <Input
                    density="compact"
                    aria-label="End time (ms)"
                    type="number"
                    min="0"
                    step="10"
                    value={durationToMs(endTime())}
                    onChange={(event) => updateEndMs(event.currentTarget.value)}
                  />
                </label>
              )}
            </Show>
          </section>

          <section class="space-y-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Playback
            </h4>

            <label class="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label="Audio enabled"
                checked={currentTimeline().audio_enabled ?? true}
                onChange={(event) =>
                  updateTimeline({ audio_enabled: event.currentTarget.checked })
                }
              />
              <span>Audio enabled</span>
            </label>

            <label class="flex items-center gap-2 text-sm">
              <span>Lookahead</span>
              <NativeSelect
                density="compact"
                aria-label="Lookahead"
                class="flex-1"
                value={
                  currentTimeline().lookahead ??
                  types.TimelineLookaheadMode.Inherit
                }
                onChange={(event) =>
                  updateTimeline({
                    lookahead: event.currentTarget
                      .value as types.TimelineLookaheadMode,
                  })
                }
              >
                <option value={types.TimelineLookaheadMode.Inherit}>
                  Inherit
                </option>
                <option value={types.TimelineLookaheadMode.Enabled}>
                  Enabled
                </option>
                <option value={types.TimelineLookaheadMode.Disabled}>
                  Disabled
                </option>
              </NativeSelect>
            </label>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Trigger mode</span>
              <NativeSelect
                density="compact"
                aria-label="Trigger mode"
                value={currentTimeline().trigger_mode ?? "FollowTimecode"}
                onChange={(event) =>
                  updateTimeline({
                    trigger_mode: event.currentTarget
                      .value as types.TimelineTriggerMode,
                  })
                }
              >
                <option value="FollowTimecode">Follow linked timecode</option>
                <option value="Manual">Manual timeline start</option>
              </NativeSelect>
            </label>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Seek behavior</span>
              <NativeSelect
                density="compact"
                aria-label="Seek behavior"
                value={currentTimeline().seek_behavior ?? "ReconstructState"}
                onChange={(event) =>
                  updateTimeline({
                    seek_behavior: event.currentTarget
                      .value as types.TimelineSeekBehavior,
                  })
                }
              >
                <option value="ReconstructState">Reconstruct state</option>
                <option value="MovePlayheadOnly">Move playhead only</option>
              </NativeSelect>
            </label>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">
                Nondeterministic seek actions
              </span>
              <NativeSelect
                density="compact"
                aria-label="Nondeterministic seek actions"
                value={
                  currentTimeline().nondeterministic_seek_behavior ?? "Ignore"
                }
                onChange={(event) =>
                  updateTimeline({
                    nondeterministic_seek_behavior: event.currentTarget
                      .value as types.TimelineNondeterministicSeekBehavior,
                  })
                }
              >
                <option value="Ignore">Ignore</option>
                <option value="Dispatch">Dispatch</option>
              </NativeSelect>
            </label>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Stop behavior</span>
              <NativeSelect
                density="compact"
                aria-label="Stop behavior"
                value={
                  currentTimeline().stop_behavior ??
                  "ResetAndReleaseOwnedActions"
                }
                onChange={(event) =>
                  updateTimeline({
                    stop_behavior: event.currentTarget
                      .value as types.TimelineStopBehavior,
                  })
                }
              >
                <option value="ResetAndReleaseOwnedActions">
                  Reset and release owned actions
                </option>
                <option value="KeepState">Keep state</option>
              </NativeSelect>
            </label>
          </section>

          <section class="space-y-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Timing Aids
            </h4>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Scroll mode</span>
              <NativeSelect
                density="compact"
                aria-label="Timeline properties scroll mode"
                value={currentTimeline().scroll_mode ?? "free"}
                onChange={(event) =>
                  updateTimeline({
                    scroll_mode: event.currentTarget
                      .value as types.TimelineScrollMode,
                  })
                }
              >
                <option value="free">Free</option>
                <option value="center">Center playhead</option>
                <option value="follow">Follow playhead</option>
              </NativeSelect>
            </label>

            <div class="space-y-2 rounded border border-neutral-800 bg-neutral-950/40 p-3">
              <label class="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label="Loop enabled"
                  checked={currentTimeline().loop_range?.enabled ?? false}
                  onChange={(event) =>
                    updateLoopRange({ enabled: event.currentTarget.checked })
                  }
                />
                <span>Loop enabled</span>
              </label>

              <div class="grid grid-cols-2 gap-3">
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">Loop start (ms)</span>
                  <Input
                    density="compact"
                    aria-label="Loop start (ms)"
                    type="number"
                    min="0"
                    step="10"
                    value={durationToMs(
                      currentTimeline().loop_range?.start ?? msToDuration(0),
                    )}
                    onChange={(event) =>
                      updateLoopStartMs(event.currentTarget.value)
                    }
                  />
                </label>
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">Loop end (ms)</span>
                  <Input
                    density="compact"
                    aria-label="Loop end (ms)"
                    type="number"
                    min="0"
                    step="10"
                    value={durationToMs(
                      currentTimeline().loop_range?.end ?? msToDuration(10_000),
                    )}
                    onChange={(event) =>
                      updateLoopEndMs(event.currentTarget.value)
                    }
                  />
                </label>
              </div>
            </div>

            <div class="space-y-2 rounded border border-neutral-800 bg-neutral-950/40 p-3">
              <label class="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label="Beat grid enabled"
                  checked={currentTimeline().use_beat_grid ?? false}
                  onChange={(event) =>
                    updateTimeline({
                      use_beat_grid: event.currentTarget.checked,
                    })
                  }
                />
                <span>Beat grid enabled</span>
              </label>

              <div class="grid grid-cols-2 gap-3">
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">BPM</span>
                  <Input
                    density="compact"
                    aria-label="Timeline BPM"
                    type="number"
                    min="1"
                    step="0.1"
                    value={currentTimeline().bpm}
                    onChange={(event) => updateBpm(event.currentTarget.value)}
                  />
                </label>
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">Beats per bar</span>
                  <Input
                    density="compact"
                    aria-label="Timeline beats per bar"
                    type="number"
                    min="1"
                    step="1"
                    value={currentTimeline().beats_per_bar}
                    onChange={(event) =>
                      updateBeatsPerBar(event.currentTarget.value)
                    }
                  />
                </label>
              </div>

              <div class="text-xs text-neutral-400">
                Detected beat markers:{" "}
                <span class="text-neutral-200">
                  {currentTimeline().beatgrid?.markers.length ?? 0}
                </span>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 text-xs">
              <div class="rounded border border-neutral-800 bg-neutral-950/40 p-3">
                <div class="font-semibold uppercase tracking-wide text-neutral-400">
                  Markers
                </div>
                <div class="mt-1 text-neutral-200">
                  {sortedMarkers().length}
                </div>
                <div class="mt-1 text-neutral-500">
                  {sortedMarkers().length > 0
                    ? `${formatMs(sortedMarkers()[0]?.time)} - ${formatMs(
                        sortedMarkers()[sortedMarkers().length - 1]?.time,
                      )}`
                    : "No marker references"}
                </div>
              </div>
              <div class="rounded border border-neutral-800 bg-neutral-950/40 p-3">
                <div class="font-semibold uppercase tracking-wide text-neutral-400">
                  Regions
                </div>
                <div class="mt-1 text-neutral-200">
                  {sortedRegions().length}
                </div>
                <div class="mt-1 text-neutral-500">
                  {sortedRegions().length > 0
                    ? `${formatMs(sortedRegions()[0]?.start)} - ${formatMs(
                        sortedRegions()[sortedRegions().length - 1]?.end,
                      )}`
                    : "No region references"}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </Show>
  );
}
