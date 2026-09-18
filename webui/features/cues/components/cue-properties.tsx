// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { calculateCueTransitionDurations } from "../../../lib/cue-timing-values";
import {
  durationToMs,
  msToDuration,
  secondsNearlyEqual,
  transitionModeToDuration,
  transitionModeToSeconds,
} from "../../../lib/duration";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { colorPaths } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  playbackTransitionClock,
  type TrackingFlagId,
  TrackingFlagsAdvancedSelect,
  trackingFlagIds,
  trackingFlagsFromIds,
  trackingFlagsSummary,
  trackingModeFromFlags,
} from "../../cue-sequences";
import {
  formatCueEditorTitle,
  useCueEditorContext,
} from "../context/cue-editor-context";

const log = getLogger(import.meta.url);
const MIXED_COLOR_PATH_VALUE = "__mixed__";

/** Formats a cue instruction count with the correct singular/plural suffix. */
function formatInstructionCount(count: number): string {
  return `${count} instruction${count === 1 ? "" : "s"}`;
}

/** Formats seconds for compact timing summaries. */
function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

/** Builds the in/out timing summary displayed for one cue part. */
function summarizePartTimings(part: types.CuePart): string {
  const inSeconds =
    transitionModeToSeconds(part.transitions.delay_in) +
    transitionModeToSeconds(part.transitions.fade_in);
  const outSeconds =
    transitionModeToSeconds(part.transitions.delay_out) +
    transitionModeToSeconds(part.transitions.fade_out);
  return `In ${formatSeconds(inSeconds)} / Out ${formatSeconds(outSeconds)}`;
}

/** Collects color path IDs assigned anywhere in a cue definition. */
function cueColorPathIds(cue: types.Cue): Set<number> {
  const ids = new Set<number>();
  for (const instruction of cue.instructions) {
    const colorPathId = instruction.cue_instruction.color_path_id;
    if (colorPathId != null) ids.add(colorPathId);
  }
  for (const part of cue.parts ?? []) {
    for (const instruction of part.instructions) {
      const colorPathId = instruction.cue_instruction.color_path_id;
      if (colorPathId != null) ids.add(colorPathId);
    }
  }
  return ids;
}

/** Returns whether the trigger variant stores an editable duration payload. */
function isDurationTrigger(
  trigger: types.CueTriggerType,
): trigger is Extract<types.CueTriggerType, { type: "AfterDelay" | "At" }> {
  return trigger.type === "AfterDelay" || trigger.type === "At";
}

/** Returns whether the trigger type should preserve or create a duration payload. */
function isDurationTriggerType(
  triggerType: types.CueTriggerType["type"],
): triggerType is "AfterDelay" | "At" {
  return triggerType === "AfterDelay" || triggerType === "At";
}

/** Renders and updates cue or cue-part properties in the inspector. */
export default function CueProperties() {
  log.trace("mounting");
  const ctx = useCueEditorContext();
  const $colorPaths = useStore(colorPaths);

  const [fadeInValue, setFadeInValue] = createSignal(0.0);
  const [delayInValue, setDelayInValue] = createSignal(0.0);
  const [fadeOutValue, setFadeOutValue] = createSignal(0.0);
  const [delayOutValue, setDelayOutValue] = createSignal(0.0);
  const [triggerType, setTriggerType] =
    createSignal<types.CueTriggerType["type"]>("Manual");
  const [afterDelayValue, setAfterDelayValue] = createSignal(0.0);
  const [previewClockMs, setPreviewClockMs] = createSignal(performance.now());

  /** Returns the array index for the active cue part, or undefined for parent cue editing. */
  const activePartIndex = () => {
    const cue = ctx.cue();
    if (!cue || ctx.partId === 0) return undefined;
    const index = (cue.parts ?? []).findIndex(
      (part) => part.identifiers.id === ctx.partId,
    );
    return index >= 0 ? index : undefined;
  };

  /** Returns the active cue part definition when editing a part. */
  const activePart = () => {
    const cue = ctx.cue();
    const index = activePartIndex();
    return cue && index !== undefined ? cue.parts?.[index] : undefined;
  };

  /** Returns the transition object currently controlled by the properties pane. */
  const activeTransitions = () => {
    const cue = ctx.cue();
    if (!cue) return {};
    return ctx.partId === 0
      ? cue.transitions
      : (activePart()?.transitions ?? {});
  };

  /** Returns the tracking flags currently controlled by the properties pane. */
  const activeTrackingFlags = () => {
    const cue = ctx.cue();
    if (!cue) return undefined;
    return ctx.partId === 0
      ? cue.tracking_flags
      : (activePart()?.tracking_flags ?? cue.tracking_flags);
  };

  /** Returns the selected operator-facing tracking flag ids for the active edit target. */
  const activeTrackingFlagIds = createMemo(() =>
    trackingFlagIds(activeTrackingFlags()),
  );

  /** Returns whether the current cue's tracking behavior is fixed by cue type. */
  const trackingReadonly = createMemo(() => ctx.isSetupCue || ctx.isReleaseCue);

  /** Returns the compact tracking summary for read-only cue types. */
  const activeTrackingSummary = createMemo(() =>
    trackingFlagsSummary(activeTrackingFlags()),
  );

  /** Returns color paths sorted by operator-facing ID for cue assignment. */
  const colorPathList = createMemo(() =>
    Object.values($colorPaths()).sort(
      (left, right) => left.identifiers.id - right.identifiers.id,
    ),
  );

  /** Returns the cue-level color path selection state. */
  const activeCueColorPathValue = createMemo(() => {
    const cue = ctx.cue();
    if (!cue) return "";
    const ids = cueColorPathIds(cue);
    if (ids.size === 0) return "";
    if (ids.size > 1) return MIXED_COLOR_PATH_VALUE;
    return String([...ids][0]);
  });

  /** Persists a replacement cue part list and keeps preview state in sync. */
  const updateCueParts = (parts: types.CuePart[]) => {
    const cue = ctx.cue();
    if (!cue) return;
    const updatedCue = {
      ...cue,
      parts,
    };
    ctx.commitEditedCue(updatedCue);
  };

  /** Adds an empty cue part after the highest existing part ID. */
  const addPart = () => {
    const cue = ctx.cue();
    if (!cue) return;
    const parts = [...(cue.parts ?? [])];
    const nextPartId =
      parts.reduce((max, part) => Math.max(max, part.identifiers.id), 0) + 1;
    parts.push({
      identifiers: {
        id: nextPartId,
        uid: crypto.randomUUID().replace(/-/g, ""),
        label: `Part ${nextPartId}`,
      },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      tracking_flags: cue.tracking_flags,
    });
    updateCueParts(parts);
  };

  /** Renames a cue part by array index. */
  const renamePart = (partIndex: number, label: string) => {
    const cue = ctx.cue();
    if (!cue?.parts?.[partIndex]) return;
    const parts = [...cue.parts];
    parts[partIndex] = {
      ...parts[partIndex],
      identifiers: {
        ...parts[partIndex].identifiers,
        label,
      },
    };
    updateCueParts(parts);
  };

  /** Renames the parent cue or the active cue part. */
  const renameActivePart = (label: string) => {
    const cue = ctx.cue();
    if (!cue) return;

    if (ctx.partId === 0) {
      const updatedCue = {
        ...cue,
        identifiers: {
          ...cue.identifiers,
          label,
        },
      };
      ctx.commitEditedCue(updatedCue);
      return;
    }

    const index = activePartIndex();
    if (index === undefined) return;
    renamePart(index, label);
  };

  /** Removes a cue part by array index. */
  const deletePart = (partIndex: number) => {
    const cue = ctx.cue();
    if (!cue?.parts?.[partIndex]) return;
    const parts = [...cue.parts];
    parts.splice(partIndex, 1);
    updateCueParts(parts);
  };

  /** Stores the programmer into the parent cue or active cue part. */
  const storeProgrammerIntoActivePart = () => {
    const cue = ctx.cue();
    const sequenceId = ctx.sequenceId();
    if (!cue || sequenceId === undefined) return;

    const label =
      ctx.partId === 0
        ? cue.identifiers.label
        : activePart()?.identifiers.label || `Part ${ctx.partId}`;
    const command: types.ProgrammerCommand =
      ctx.partId === 0
        ? {
            type: "StoreCue",
            data: {
              sequence_id: sequenceId,
              cue_id: { type: "Exact", data: cue.identifiers.id },
              part_id: { type: "Exact", data: 0 },
              mode: "replace" as types.StoreMode,
              label,
            },
          }
        : {
            type: "StoreCue",
            data: {
              sequence_id: sequenceId,
              cue_id: { type: "Exact", data: cue.identifiers.id },
              part_id: { type: "Exact", data: ctx.partId },
              mode: "replace" as types.StoreMode,
              label,
            },
          };

    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
  };

  /** Recalls the parent cue or active cue part into the programmer. */
  const recallActivePart = () => {
    const cue = ctx.cue();
    const sequenceId = ctx.sequenceId();
    if (!cue || sequenceId === undefined) return;

    const command: types.ProgrammerCommand =
      ctx.partId === 0
        ? {
            type: "RecallCue",
            data: {
              sequence_id: sequenceId,
              cue_id: cue.identifiers.id,
              part_id: 0,
              select: false,
            },
          }
        : {
            type: "RecallCue",
            data: {
              sequence_id: sequenceId,
              cue_id: cue.identifiers.id,
              part_id: ctx.partId,
              select: false,
            },
          };

    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
  };

  /** Updates the selected tracking categories on the parent cue or active cue part. */
  const updateActiveTrackingFlags = (
    selectedIds: readonly TrackingFlagId[],
  ) => {
    if (trackingReadonly()) return;
    const cue = ctx.cue();
    if (!cue) return;

    const trackingFlags = trackingFlagsFromIds(selectedIds);
    if (ctx.partId === 0) {
      ctx.commitEditedCue({
        ...cue,
        tracking_flags: trackingFlags,
        tracking_mode: trackingModeFromFlags(trackingFlags),
      });
      return;
    }

    const index = activePartIndex();
    if (index === undefined || !cue.parts?.[index]) return;
    const parts = [...cue.parts];
    parts[index] = {
      ...parts[index],
      tracking_flags: trackingFlags,
    };
    updateCueParts(parts);
  };

  /** Assigns or clears the cue-level color path through the backend command handler. */
  const updateCueColorPath = (value: string) => {
    const cue = ctx.cue();
    const sequenceId = ctx.sequenceId();
    if (!cue || sequenceId === undefined || value === MIXED_COLOR_PATH_VALUE) {
      return;
    }
    const command: types.CueCommand = {
      type: "SetCueColorPath",
      data: {
        sequence_id: sequenceId,
        cue_id: cue.identifiers.id,
        color_path_id: value === "" ? undefined : Number.parseInt(value, 10),
      },
    };
    engineRuntime.sendCommand({ module: "CueCommand", command });
  };

  /** Initializes local timing and trigger controls from the current cue data. */
  createEffect(() => {
    const cue = ctx.cue();
    if (cue === undefined) return;

    const transitions = activeTransitions();
    log.trace("Setting cue transition signals from context:", transitions);
    setFadeInValue(
      durationToMs(transitionModeToDuration(transitions.fade_in)) / 1000,
    );
    setDelayInValue(
      durationToMs(transitionModeToDuration(transitions.delay_in)) / 1000,
    );
    setFadeOutValue(
      durationToMs(transitionModeToDuration(transitions.fade_out)) / 1000,
    );
    setDelayOutValue(
      durationToMs(transitionModeToDuration(transitions.delay_out)) / 1000,
    );
    setTriggerType(cue.trigger.type);
    if (isDurationTrigger(cue.trigger)) {
      setAfterDelayValue(durationToMs(cue.trigger.data) / 1000);
    } else {
      setAfterDelayValue(0.0);
    }
  });

  const emptyCueTransitionDurations = {
    delayIn: 0,
    fadeIn: 0,
    delayOut: 0,
    fadeOut: 0,
    inDuration: 0,
    outDuration: 0,
    totalDuration: 0,
  };

  /** Calculates the resolved timing spans for the active cue. */
  const [cueTransitionDurations] = createResource(
    () => {
      const loadingState = ctx.loadingState();
      return {
        cue: loadingState.status === "loaded" ? loadingState.cue : undefined,
      };
    },
    ({ cue }) => calculateCueTransitionDurations(cue),
    { initialValue: emptyCueTransitionDurations },
  );
  /** Returns the longest in-transition span for the active cue. */
  const inDuration = createMemo(() => cueTransitionDurations().inDuration);
  /** Returns the longest out-transition span for the active cue. */
  const outDuration = createMemo(() => cueTransitionDurations().outDuration);
  /** Returns the duration used by the properties progress indicator. */
  const totalDuration = createMemo(
    () => cueTransitionDurations().totalDuration,
  );
  /** Returns the delay segment shown in the transition duration bar. */
  const timelineDelayValue = createMemo(() =>
    outDuration() > inDuration()
      ? cueTransitionDurations().delayOut
      : cueTransitionDurations().delayIn,
  );
  /** Returns the fade segment shown in the transition duration bar. */
  const timelineFadeValue = createMemo(() =>
    outDuration() > inDuration()
      ? cueTransitionDurations().fadeOut
      : cueTransitionDurations().fadeIn,
  );
  /** Returns the delay segment width as a percentage of total transition time. */
  const timelineDelayPercentage = createMemo(() => {
    const total = totalDuration();
    if (total === 0) return 0;
    return (timelineDelayValue() / total) * 100;
  });
  /** Returns the fade segment width as a percentage of total transition time. */
  const timelineFadePercentage = createMemo(() => {
    const total = totalDuration();
    if (total === 0) return 0;
    return (timelineFadeValue() / total) * 100;
  });
  /** Reads backend preview time so paused and scrubbed positions remain synchronized. */
  const previewElapsedSeconds = createMemo(() => {
    previewClockMs();
    return (
      playbackTransitionClock(ctx.activePreviewPlayback(), Date.now())
        ?.elapsedSeconds ?? 0
    );
  });

  /** Returns the preview progress percentage for the properties transition bar. */
  const previewProgressPercentage = createMemo(() => {
    const total = totalDuration();
    if (!ctx.previewActive() || total <= 0) return 0;
    return Math.min(100, (previewElapsedSeconds() / total) * 100);
  });

  /** Advances the preview progress clock while cue preview is active. */
  createEffect(() => {
    if (!ctx.previewActive()) {
      return;
    }

    setPreviewClockMs(performance.now());

    let frameId = 0;
    /** Queues the next animation-frame clock update for properties progress. */
    const tick = () => {
      setPreviewClockMs(performance.now());
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frameId));
  });

  /** Persists local timing and trigger control changes back into the active cue. */
  createEffect((prev) => {
    const cue = untrack(ctx.cue);
    log.debug("Updating cue properties", cue, prev);

    // Load signals before conditions to track dependencies
    const inValues = [fadeInValue(), delayInValue()];
    const outValues = [fadeOutValue(), delayOutValue()];
    const trigger = triggerType();
    const afterDelaySeconds = afterDelayValue();
    const currentTransitions = activeTransitions();

    // Do not run if cue is not loaded yet or if this is the initial load of cue data
    if (cue === undefined) return;
    if (prev === undefined) return true;

    const unchangedTimings =
      secondsNearlyEqual(
        transitionModeToSeconds(currentTransitions.fade_in),
        inValues[0],
      ) &&
      secondsNearlyEqual(
        transitionModeToSeconds(currentTransitions.delay_in),
        inValues[1],
      ) &&
      secondsNearlyEqual(
        transitionModeToSeconds(currentTransitions.fade_out),
        outValues[0],
      ) &&
      secondsNearlyEqual(
        transitionModeToSeconds(currentTransitions.delay_out),
        outValues[1],
      );
    const currentTriggerDurationSeconds = isDurationTrigger(cue.trigger)
      ? durationToMs(cue.trigger.data) / 1000
      : 0;
    const unchangedTrigger =
      ctx.partId !== 0 ||
      (cue.trigger.type === trigger &&
        (!isDurationTriggerType(trigger) ||
          secondsNearlyEqual(
            currentTriggerDurationSeconds,
            afterDelaySeconds,
          )));
    if (unchangedTimings && unchangedTrigger) return true;

    log.trace("Updating cue after properties update");
    const updatedCue: types.Cue = JSON.parse(JSON.stringify(cue));
    const ms_per_s = 1000;
    const transitions: types.PartialTransition = {
      fade_in: { type: "Fixed", data: msToDuration(inValues[0] * ms_per_s) },
      delay_in: { type: "Fixed", data: msToDuration(inValues[1] * ms_per_s) },
      fade_out: { type: "Fixed", data: msToDuration(outValues[0] * ms_per_s) },
      delay_out: { type: "Fixed", data: msToDuration(outValues[1] * ms_per_s) },
    };

    if (ctx.partId === 0) {
      updatedCue.transitions = transitions;
      if (isDurationTriggerType(trigger)) {
        updatedCue.trigger = {
          type: trigger,
          data: msToDuration(afterDelaySeconds * ms_per_s),
        };
      } else {
        updatedCue.trigger = { type: trigger };
      }
    } else {
      const index = activePartIndex();
      if (index === undefined || !updatedCue.parts?.[index]) return true;
      updatedCue.parts[index] = {
        ...updatedCue.parts[index],
        transitions,
      };
    }

    log.trace("Updating cue transitions:", transitions);

    ctx.commitEditedCue(updatedCue);
  });

  return (
    <Switch>
      <Match when={ctx.loadingState().status === "loading"}>
        <div class="p-4 text-neutral-400">Loading cue properties...</div>
      </Match>
      <Match when={ctx.loadingState().status === "not_found"}>
        <div class="p-4 text-neutral-400">Cue not found</div>
      </Match>
      <Match when={ctx.loadingState().status === "loaded"}>
        {(() => {
          const cue = ctx.cue()!;
          return (
            <div class="p-4 space-y-4">
              {/* Cue Info */}
              <div class="border-b border-neutral-600 pb-2">
                <h3 class="font-medium">
                  {formatCueEditorTitle({
                    cueId: cue.identifiers.id,
                    sequenceId: ctx.sequenceId(),
                    partId: ctx.partId,
                    hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
                    isSetupCue: ctx.isSetupCue,
                    isReleaseCue: ctx.isReleaseCue,
                  })}
                </h3>
                <p class="text-xs text-neutral-400">
                  {ctx.partLabel() || "Untitled"}
                </p>
              </div>

              <div class="space-y-2 border-b border-neutral-700 pb-3">
                <div class="flex items-center justify-between gap-2">
                  <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    Active Part
                  </h4>
                  <span class="font-mono text-xs text-sky-300">
                    p{ctx.partId}
                  </span>
                </div>
                <Input
                  density="compact"
                  type="text"
                  aria-label="Active part label"
                  value={ctx.partLabel()}
                  onChange={(event) =>
                    renameActivePart(event.currentTarget.value)
                  }
                />
                <div class="flex gap-2">
                  <Button
                    size="compact"
                    variant="primary"
                    type="button"
                    disabled={ctx.sequenceId() === undefined}
                    onClick={storeProgrammerIntoActivePart}
                  >
                    Store Programmer
                  </Button>
                  <Button
                    size="compact"
                    type="button"
                    disabled={ctx.sequenceId() === undefined}
                    onClick={recallActivePart}
                  >
                    Recall Part
                  </Button>
                </div>
                <label class="block space-y-1 text-xs">
                  <span class="font-medium text-neutral-300">Color Path</span>
                  <NativeSelect
                    density="compact"
                    value={activeCueColorPathValue()}
                    disabled={ctx.sequenceId() === undefined}
                    onInput={(event) =>
                      updateCueColorPath(event.currentTarget.value)
                    }
                  >
                    <option value="">Native</option>
                    <Show
                      when={
                        activeCueColorPathValue() === MIXED_COLOR_PATH_VALUE
                      }
                    >
                      <option value={MIXED_COLOR_PATH_VALUE}>Mixed</option>
                    </Show>
                    <For each={colorPathList()}>
                      {(path) => (
                        <option value={path.identifiers.id}>
                          {path.identifiers.id}: {path.identifiers.label}
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                </label>
              </div>

              <div class="space-y-2 border-b border-neutral-700 pb-3">
                <div class="flex items-center justify-between gap-2">
                  <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    Parts
                  </h4>
                  <Button size="compact" type="button" onClick={addPart}>
                    Add
                  </Button>
                </div>
                <Show
                  when={(cue.parts ?? []).length > 0}
                  fallback={
                    <p class="text-xs text-neutral-500">No cue parts</p>
                  }
                >
                  <div class="space-y-1">
                    <For each={cue.parts ?? []}>
                      {(part, index) => (
                        <div class="rounded border border-neutral-700 bg-neutral-800/40 p-2">
                          <div class="flex items-center gap-2">
                            <span class="w-12 font-mono text-xs text-sky-300">
                              p{part.identifiers.id}
                            </span>
                            <Input
                              density="compact"
                              type="text"
                              aria-label={`Part ${part.identifiers.id} label`}
                              value={part.identifiers.label}
                              onChange={(event) =>
                                renamePart(index(), event.currentTarget.value)
                              }
                              class="flex-1"
                            />
                            <Button
                              size="compact"
                              variant="danger"
                              type="button"
                              onClick={() => deletePart(index())}
                            >
                              Delete
                            </Button>
                          </div>
                          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-14 text-[11px] text-neutral-500">
                            <span>
                              {formatInstructionCount(part.instructions.length)}
                            </span>
                            <span>{summarizePartTimings(part)}</span>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="space-y-2 border-b border-neutral-700 pb-3">
                <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Tracking
                </h4>
                <Show
                  when={!trackingReadonly()}
                  fallback={
                    <div class="flex min-h-9 w-full items-center rounded border border-neutral-700 bg-neutral-800/40 px-3 text-sm font-medium text-neutral-100">
                      {activeTrackingSummary()}
                    </div>
                  }
                >
                  <TrackingFlagsAdvancedSelect
                    selectedIds={activeTrackingFlagIds()}
                    onSelectedIdsChange={updateActiveTrackingFlags}
                    ariaLabel="Choose tracking flags"
                    containerClass="w-full"
                    selectIdPrefix="cue-properties-tracking-flags"
                  />
                </Show>
              </div>

              {/* Transition Progress Bar */}
              <div class="space-y-2">
                <label class="block text-xs font-medium text-neutral-300">
                  Transition Duration: {totalDuration().toFixed(1)}s
                </label>
                <div class="relative h-6 overflow-hidden rounded border border-neutral-500 bg-neutral-700">
                  <div
                    class="absolute top-0 left-0 h-full bg-orange-600/70"
                    style={{ width: `${timelineDelayPercentage()}%` }}
                  />
                  <div
                    class="absolute top-0 h-full bg-blue-600/70"
                    style={{
                      left: `${timelineDelayPercentage()}%`,
                      width: `${timelineFadePercentage()}%`,
                    }}
                  />
                  <div
                    class="absolute inset-y-0 left-0 border-r border-white/80 bg-white/20"
                    style={{ width: `${previewProgressPercentage()}%` }}
                  />
                  <div class="absolute inset-0 flex items-center justify-center">
                    <span class="text-xs text-white font-medium drop-shadow">
                      {ctx.previewActive() &&
                      ctx.previewStartedAtMs() !== undefined
                        ? `${Math.min(
                            totalDuration(),
                            previewElapsedSeconds(),
                          ).toFixed(1)}s / ${totalDuration().toFixed(1)}s`
                        : `${totalDuration().toFixed(1)}s total`}
                    </span>
                  </div>
                </div>
                <div class="flex justify-between text-xs text-neutral-400">
                  <span>Delay In + Fade In: {inDuration().toFixed(1)}s</span>
                  <span>Out: {outDuration().toFixed(1)}s</span>
                </div>
              </div>

              {/* Fade In Duration Input */}
              <label class="block space-y-1">
                <span class="block text-xs font-medium text-neutral-300">
                  Fade In Duration (seconds)
                </span>
                <Input
                  density="compact"
                  type="number"
                  min="0"
                  max="3600"
                  step="0.1"
                  value={fadeInValue()}
                  onInput={(e) =>
                    setFadeInValue(
                      Number.parseFloat(e.currentTarget.value) || 0,
                    )
                  }
                />
              </label>

              {/* Delay In Duration Input */}
              <label class="block space-y-1">
                <span class="block text-xs font-medium text-neutral-300">
                  Delay In Duration (seconds)
                </span>
                <Input
                  density="compact"
                  type="number"
                  min="0"
                  max="3600"
                  step="0.1"
                  value={delayInValue()}
                  onInput={(e) =>
                    setDelayInValue(
                      Number.parseFloat(e.currentTarget.value) || 0,
                    )
                  }
                />
              </label>

              {/* Fade Out Duration Input */}
              <label class="block space-y-1">
                <span class="block text-xs font-medium text-neutral-300">
                  Fade Out Duration (seconds)
                </span>
                <Input
                  density="compact"
                  type="number"
                  min="0"
                  max="3600"
                  step="0.1"
                  value={fadeOutValue()}
                  onInput={(e) =>
                    setFadeOutValue(
                      Number.parseFloat(e.currentTarget.value) || 0,
                    )
                  }
                />
              </label>

              {/* Delay Out Duration Input */}
              <label class="block space-y-1">
                <span class="block text-xs font-medium text-neutral-300">
                  Delay Out Duration (seconds)
                </span>
                <Input
                  density="compact"
                  type="number"
                  min="0"
                  max="3600"
                  step="0.1"
                  value={delayOutValue()}
                  onInput={(e) =>
                    setDelayOutValue(
                      Number.parseFloat(e.currentTarget.value) || 0,
                    )
                  }
                />
              </label>

              <Show when={ctx.partId === 0}>
                <label class="block space-y-1">
                  <span class="block text-xs font-medium text-neutral-300">
                    Trigger Type
                  </span>
                  <NativeSelect
                    density="compact"
                    value={triggerType()}
                    onChange={(e) =>
                      setTriggerType(
                        e.currentTarget.value as types.CueTriggerType["type"],
                      )
                    }
                  >
                    <option value="Manual">Manual</option>
                    <option value="FollowPrevious">Follow Previous</option>
                    <option value="AfterDelay">After Delay</option>
                    <option value="At">At</option>
                  </NativeSelect>
                </label>

                <Show when={isDurationTriggerType(triggerType())}>
                  <label class="block space-y-1">
                    <span class="block text-xs font-medium text-neutral-300">
                      Trigger Time (seconds)
                    </span>
                    <Input
                      density="compact"
                      type="number"
                      min="0"
                      max="3600"
                      step="0.1"
                      value={afterDelayValue()}
                      onInput={(e) =>
                        setAfterDelayValue(
                          Number.parseFloat(e.currentTarget.value) || 0,
                        )
                      }
                    />
                  </label>
                </Show>
              </Show>
            </div>
          );
        })()}
      </Match>
    </Switch>
  );
}
