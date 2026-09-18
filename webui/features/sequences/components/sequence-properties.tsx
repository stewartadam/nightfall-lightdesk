// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, Show } from "solid-js";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../../components/ui/form-controls";
import {
  durationToSeconds,
  msToDuration,
  transitionModeToSeconds,
} from "../../../lib/duration";
import type * as types from "../../../types";
import {
  type TrackingFlagId,
  TrackingFlagsAdvancedSelect,
  trackingFlagIds,
  trackingFlagsForMode,
  trackingFlagsFromIds,
  trackingFlagsFromMask,
  trackingFlagsSummary,
  trackingModeFromFlags,
} from "../../cue-sequences";
import { useSequenceEditorContext } from "../context/sequence-editor-context";
import {
  normalizeFirstCueWrapDelay,
  triggerDurationOrZero,
  WRAP_DELAY_TRIGGER_LABEL,
  wrapDelayTrigger,
} from "../model/sequence-wrap-delay";

type TimingField = "fade_in" | "delay_in" | "fade_out" | "delay_out";

const DEFAULT_SEQUENCE_TRACKING_FLAGS = trackingFlagsFromMask(7);

function selectedCueTimingSeconds(
  cue: types.Cue,
  sequence: types.Sequence,
  field: TimingField,
): number {
  return transitionModeToSeconds(
    cue.transitions[field] ?? sequence.default_timing[field],
  );
}

/** Returns whether the trigger variant stores an editable duration payload. */
function isDurationTrigger(
  trigger: types.CueTriggerType,
): trigger is Extract<types.CueTriggerType, { type: "AfterDelay" | "At" }> {
  return trigger.type === "AfterDelay" || trigger.type === "At";
}

/** Returns the duration payload for the selected trigger in seconds. */
function selectedTriggerDurationSeconds(trigger: types.CueTriggerType): number {
  return isDurationTrigger(trigger) ? durationToSeconds(trigger.data) : 0;
}

/** Returns the explicit tracking flags configured on a sequence. */
function sequenceTrackingFlags(
  sequence: types.Sequence,
): types.Cue["tracking_flags"] {
  return trackingFlagsForMode(
    sequence.tracking_mode,
    DEFAULT_SEQUENCE_TRACKING_FLAGS,
  );
}

export default function SequenceProperties() {
  const ctx = useSequenceEditorContext();
  let sequenceLabelInputRef: HTMLInputElement | undefined;
  let selectedCueLabelInputRef: HTMLInputElement | undefined;
  const [sequenceDraftLabel, setSequenceDraftLabel] = createSignal("");
  const [selectedCueDraftLabel, setSelectedCueDraftLabel] = createSignal("");

  /** Keeps the sequence label draft aligned with the loaded sequence outside active typing. */
  createEffect(() => {
    const sequence = ctx.sequence();
    if (document.activeElement === sequenceLabelInputRef) {
      return;
    }
    setSequenceDraftLabel(sequence?.identifiers.label ?? "");
  });

  /** Keeps the selected cue label draft aligned outside active typing. */
  createEffect(() => {
    const cue = ctx.selectedCue();
    if (document.activeElement === selectedCueLabelInputRef) {
      return;
    }
    setSelectedCueDraftLabel(cue?.identifiers.label ?? "");
  });

  const updateSequenceDefaultTiming = (field: TimingField, value: string) => {
    const sequence = ctx.sequence();
    if (!sequence) return;

    const parsedSeconds = Number.parseFloat(value);
    if (Number.isNaN(parsedSeconds) || parsedSeconds < 0) return;

    const transition: types.TransitionMode = {
      type: "Fixed",
      data: msToDuration(parsedSeconds * 1000),
    };

    ctx.updateSequence({
      ...sequence,
      default_timing: {
        ...sequence.default_timing,
        [field]: transition,
      },
    });
  };

  /** Updates the sequence tracking flags inherited by sequence cues. */
  const updateSequenceTrackingFlags = (
    selectedIds: readonly TrackingFlagId[],
  ) => {
    const sequence = ctx.sequence();
    if (!sequence) return;
    const trackingFlags = trackingFlagsFromIds(selectedIds);
    ctx.updateSequence({
      ...sequence,
      tracking_mode: trackingModeFromFlags(trackingFlags),
    });
  };

  /** Commits an override or restores the inherited display when the field is cleared. */
  const updateSelectedCueTiming = (
    field: TimingField,
    input: HTMLInputElement,
  ) => {
    const value = input.value;
    if (value.trim() === "") {
      // Clearing an already inherited value does not change its reactive value.
      input.value = String(
        transitionModeToSeconds(ctx.sequence()?.default_timing[field]),
      );
      ctx.updateSelectedCue((cue) => {
        const transitions = { ...cue.transitions };
        delete transitions[field];
        return {
          ...cue,
          transitions,
        };
      });
      return;
    }

    const parsedSeconds = Number.parseFloat(value);
    if (Number.isNaN(parsedSeconds) || parsedSeconds < 0) return;
    const transition: types.TransitionMode = {
      type: "Fixed",
      data: msToDuration(parsedSeconds * 1000),
    };
    ctx.updateSelectedCue((cue) => ({
      ...cue,
      transitions: {
        ...cue.transitions,
        [field]: transition,
      },
    }));
  };

  /** Renames the active sequence while preserving its UID and cue references. */
  const renameSequence = (label: string) => {
    const sequence = ctx.sequence();
    if (!sequence || label === sequence.identifiers.label) return;

    ctx.updateSequence({
      ...sequence,
      identifiers: {
        ...sequence.identifiers,
        label,
      },
    });
  };

  /** Commits the active sequence label draft when editing completes. */
  const commitSequenceLabel = () => {
    renameSequence(sequenceDraftLabel());
  };

  /** Commits the selected cue label draft when editing completes. */
  const commitSelectedCueLabel = () => {
    const nextLabel = selectedCueDraftLabel();
    const cue = ctx.selectedCue();
    if (!cue || nextLabel === cue.identifiers.label) return;
    ctx.updateSelectedCue((currentCue) => ({
      ...currentCue,
      identifiers: {
        ...currentCue.identifiers,
        label: nextLabel,
      },
    }));
  };

  /** Returns the first loaded cue step in the active sequence. */
  const firstSequenceCue = () => {
    return ctx.cueRows().find((row) => {
      return !row.isSetupCue && !row.isReleaseCue && row.index === 0;
    })?.cue;
  };

  /** Updates sequence wrap mode and keeps cue 1's wrap-delay trigger normalized. */
  const updateSequenceWrap = (wrap: boolean) => {
    const sequence = ctx.sequence();
    if (!sequence || sequence.wrap === wrap) return;
    ctx.updateSequence({
      ...sequence,
      wrap,
    });
    const firstCue = firstSequenceCue();
    if (!firstCue) return;
    const normalizedCue = normalizeFirstCueWrapDelay(firstCue, wrap);
    if (normalizedCue) {
      ctx.updateCue(normalizedCue);
    }
  };

  /** Persists the sequence-level wrap delay on cue 1's entry trigger. */
  const updateWrapDelay = (value: string) => {
    const firstCue = firstSequenceCue();
    if (!firstCue) return;
    const parsedSeconds = Number.parseFloat(value);
    if (Number.isNaN(parsedSeconds) || parsedSeconds < 0) return;
    ctx.updateCue({
      ...firstCue,
      trigger: wrapDelayTrigger(msToDuration(parsedSeconds * 1000)),
    });
  };

  /** Returns the sequence-level wrap delay in seconds. */
  const wrapDelaySeconds = () => {
    const cue = firstSequenceCue();
    return cue ? durationToSeconds(triggerDurationOrZero(cue.trigger)) : 0;
  };

  return (
    <Show when={ctx.sequence()} fallback={<div class="p-4">No sequence</div>}>
      {(sequence) => {
        const selectedCue = () => {
          const cue = ctx.selectedCue();
          if (cue?.identifiers.uid === sequence().release_cue.identifiers.uid) {
            return undefined;
          }
          return cue;
        };
        return (
          <div class="p-4 space-y-4">
            <div class="border-b border-neutral-600 pb-2">
              <h3 class="font-medium">Sequence {sequence().identifiers.id}</h3>
              <p class="text-xs text-neutral-400">
                {sequence().identifiers.label || "Untitled"}
              </p>
            </div>

            <div class="space-y-2">
              <h4 class="text-xs font-semibold uppercase text-neutral-400">
                Sequence Options
              </h4>
              <label class="block text-xs">
                Label
                <Input
                  density="compact"
                  ref={sequenceLabelInputRef}
                  type="text"
                  aria-label="Sequence label"
                  class="mt-1"
                  value={sequenceDraftLabel()}
                  onInput={(e) => setSequenceDraftLabel(e.currentTarget.value)}
                  onBlur={commitSequenceLabel}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitSequenceLabel();
                      event.currentTarget.blur();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSequenceDraftLabel(sequence().identifiers.label);
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <label class="flex items-center justify-between text-sm">
                <span>Wrap</span>
                <Checkbox
                  checked={sequence().wrap}
                  onChange={(e) => updateSequenceWrap(e.currentTarget.checked)}
                />
              </label>
              <Show when={sequence().wrap}>
                <label class="text-xs block">
                  {WRAP_DELAY_TRIGGER_LABEL}
                  <Input
                    density="compact"
                    type="number"
                    min="0"
                    step="0.1"
                    class="mt-1"
                    value={wrapDelaySeconds()}
                    onChange={(e) => updateWrapDelay(e.currentTarget.value)}
                  />
                </label>
              </Show>
              <label class="flex items-center justify-between text-sm">
                <span>Release On Start</span>
                <Checkbox
                  checked={sequence().release_on_start}
                  onChange={(e) =>
                    ctx.updateSequence({
                      ...sequence(),
                      release_on_start: e.currentTarget.checked,
                    })
                  }
                />
              </label>
              <div class="space-y-1">
                <div class="flex items-center justify-between text-sm">
                  <span>Tracking</span>
                  <span class="text-xs text-neutral-400">
                    {trackingFlagsSummary(sequenceTrackingFlags(sequence()))}
                  </span>
                </div>
                <TrackingFlagsAdvancedSelect
                  selectedIds={trackingFlagIds(
                    sequenceTrackingFlags(sequence()),
                  )}
                  onSelectedIdsChange={updateSequenceTrackingFlags}
                  ariaLabel="Sequence tracking flags"
                  containerClass="w-full"
                  selectIdPrefix="sequence-properties-tracking-flags"
                />
              </div>
            </div>

            <div class="space-y-2">
              <h4 class="text-xs font-semibold uppercase text-neutral-400">
                Sequence Default Timing (s)
              </h4>
              <div class="grid grid-cols-2 gap-2">
                <label class="text-xs">
                  Fade In
                  <Input
                    density="compact"
                    type="number"
                    min="0"
                    step="0.1"
                    class="mt-1"
                    value={transitionModeToSeconds(
                      sequence().default_timing.fade_in,
                    )}
                    onChange={(e) =>
                      updateSequenceDefaultTiming(
                        "fade_in",
                        e.currentTarget.value,
                      )
                    }
                  />
                </label>
                <label class="text-xs">
                  Delay In
                  <Input
                    density="compact"
                    type="number"
                    min="0"
                    step="0.1"
                    class="mt-1"
                    value={transitionModeToSeconds(
                      sequence().default_timing.delay_in,
                    )}
                    onChange={(e) =>
                      updateSequenceDefaultTiming(
                        "delay_in",
                        e.currentTarget.value,
                      )
                    }
                  />
                </label>
                <label class="text-xs">
                  Fade Out
                  <Input
                    density="compact"
                    type="number"
                    min="0"
                    step="0.1"
                    class="mt-1"
                    value={transitionModeToSeconds(
                      sequence().default_timing.fade_out,
                    )}
                    onChange={(e) =>
                      updateSequenceDefaultTiming(
                        "fade_out",
                        e.currentTarget.value,
                      )
                    }
                  />
                </label>
                <label class="text-xs">
                  Delay Out
                  <Input
                    density="compact"
                    type="number"
                    min="0"
                    step="0.1"
                    class="mt-1"
                    value={transitionModeToSeconds(
                      sequence().default_timing.delay_out,
                    )}
                    onChange={(e) =>
                      updateSequenceDefaultTiming(
                        "delay_out",
                        e.currentTarget.value,
                      )
                    }
                  />
                </label>
              </div>
            </div>

            <div class="space-y-2 border-t border-neutral-700 pt-3">
              <h4 class="text-xs font-semibold uppercase text-neutral-400">
                Selected Cue
              </h4>
              <Show
                when={selectedCue()}
                fallback={
                  <div class="text-xs text-neutral-500">
                    Select a cue row to edit cue properties.
                  </div>
                }
              >
                {(cue) => (
                  <div class="space-y-2">
                    <label class="text-xs block">
                      Label
                      <Input
                        density="compact"
                        ref={selectedCueLabelInputRef}
                        type="text"
                        class="mt-1"
                        aria-label="Selected cue label"
                        value={selectedCueDraftLabel()}
                        onInput={(e) =>
                          setSelectedCueDraftLabel(e.currentTarget.value)
                        }
                        onBlur={commitSelectedCueLabel}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitSelectedCueLabel();
                            event.currentTarget.blur();
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setSelectedCueDraftLabel(cue().identifiers.label);
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>

                    <label class="text-xs block">
                      Trigger
                      <NativeSelect
                        density="compact"
                        class="mt-1"
                        value={cue().trigger.type}
                        onChange={(e) => {
                          const next = e.currentTarget.value;
                          if (next === "Manual" || next === "FollowPrevious") {
                            ctx.updateSelectedCue((currentCue) => ({
                              ...currentCue,
                              trigger: { type: next },
                            }));
                            return;
                          }
                          ctx.updateSelectedCue((currentCue) => ({
                            ...currentCue,
                            trigger: {
                              type: next as "AfterDelay" | "At",
                              data: isDurationTrigger(currentCue.trigger)
                                ? currentCue.trigger.data
                                : msToDuration(0),
                            },
                          }));
                        }}
                      >
                        <option value="Manual">Manual</option>
                        <option value="FollowPrevious">Follow Previous</option>
                        <option value="AfterDelay">After Delay</option>
                        <option value="At">At</option>
                      </NativeSelect>
                    </label>

                    <Show when={isDurationTrigger(cue().trigger)}>
                      <label class="text-xs block">
                        Trigger Time (s)
                        <Input
                          density="compact"
                          type="number"
                          min="0"
                          step="0.1"
                          class="mt-1"
                          value={selectedTriggerDurationSeconds(cue().trigger)}
                          onChange={(e) => {
                            const parsed = Number.parseFloat(
                              e.currentTarget.value,
                            );
                            if (Number.isNaN(parsed) || parsed < 0) return;
                            ctx.updateSelectedCue((currentCue) => ({
                              ...currentCue,
                              trigger: {
                                type: isDurationTrigger(currentCue.trigger)
                                  ? currentCue.trigger.type
                                  : "AfterDelay",
                                data: msToDuration(parsed * 1000),
                              },
                            }));
                          }}
                        />
                      </label>
                    </Show>

                    <div class="grid grid-cols-2 gap-2">
                      <label class="text-xs">
                        Fade In
                        <Input
                          density="compact"
                          type="number"
                          min="0"
                          step="0.1"
                          class="mt-1"
                          inherited={cue().transitions.fade_in == null}
                          value={selectedCueTimingSeconds(
                            cue(),
                            sequence(),
                            "fade_in",
                          )}
                          onChange={(e) =>
                            updateSelectedCueTiming("fade_in", e.currentTarget)
                          }
                        />
                      </label>
                      <label class="text-xs">
                        Delay In
                        <Input
                          density="compact"
                          type="number"
                          min="0"
                          step="0.1"
                          class="mt-1"
                          inherited={cue().transitions.delay_in == null}
                          value={selectedCueTimingSeconds(
                            cue(),
                            sequence(),
                            "delay_in",
                          )}
                          onChange={(e) =>
                            updateSelectedCueTiming("delay_in", e.currentTarget)
                          }
                        />
                      </label>
                      <label class="text-xs">
                        Fade Out
                        <Input
                          density="compact"
                          type="number"
                          min="0"
                          step="0.1"
                          class="mt-1"
                          inherited={cue().transitions.fade_out == null}
                          value={selectedCueTimingSeconds(
                            cue(),
                            sequence(),
                            "fade_out",
                          )}
                          onChange={(e) =>
                            updateSelectedCueTiming("fade_out", e.currentTarget)
                          }
                        />
                      </label>
                      <label class="text-xs">
                        Delay Out
                        <Input
                          density="compact"
                          type="number"
                          min="0"
                          step="0.1"
                          class="mt-1"
                          inherited={cue().transitions.delay_out == null}
                          value={selectedCueTimingSeconds(
                            cue(),
                            sequence(),
                            "delay_out",
                          )}
                          onChange={(e) =>
                            updateSelectedCueTiming(
                              "delay_out",
                              e.currentTarget,
                            )
                          }
                        />
                      </label>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
