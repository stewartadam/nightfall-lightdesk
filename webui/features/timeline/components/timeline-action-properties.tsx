// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createMemo, For, Match, Show, Switch } from "solid-js";
import { Input, Textarea } from "../../../components/ui/form-controls";
import { durationToMs, msToDuration } from "../../../lib/utils";
import { timelineLookaheadActionStatuses } from "../../../state/appStores";
import * as types from "../../../types";
import type { SelectedAction } from "../context/timeline-context";

type SelectedActionRecord = {
  track: types.Track;
  action: types.Action;
};

type TimelineLookaheadBlockerRecord = {
  track: types.Track | undefined;
  action: types.Action | undefined;
  trackId: string;
  actionId: string;
  positionMs: number | undefined;
};

type TimelineActionPropertiesProps = {
  timelineUid: string;
  selectedItem: Accessor<SelectedAction | undefined>;
  tracks: Accessor<types.Track[]>;
  updateAction: (
    trackId: string,
    actionId: string,
    patch: Partial<types.Action>,
  ) => void;
};

const ACTION_LABELS: Record<types.ActionKind["type"], string> = {
  FireCue: "Fire cue",
  StartClip: "Start clip",
  StopClip: "Stop clip",
  AdvanceSequence: "Advance sequence",
  BackSequence: "Back sequence",
  SetClipRate: "Set clip rate",
  JumpToCue: "Jump to cue",
  DeskEval: "Desk eval",
  RegisteredAction: "Registered action",
};

/** Builds the stable map key used for timeline lookahead action statuses. */
function timelineActionStatusKey(trackId: string, actionId: string): string {
  return JSON.stringify([trackId, actionId]);
}

/** Parses non-negative millisecond input from Properties numeric fields. */
function parseNonNegativeMs(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

/** Parses a non-negative playback rate multiplier. */
function parseRate(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

/** Parses a one-based cue index value. */
function parseCueIndex(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : undefined;
}

/** Returns the editable action label for display. */
function actionLabel(action: types.ActionKind): string {
  return ACTION_LABELS[action.type];
}

/** Returns a stable label for the target UID carried by action variants. */
function actionTargetLabel(action: types.ActionKind): string | undefined {
  switch (action.type) {
    case "FireCue":
      return action.data;
    case "StartClip":
    case "StopClip":
    case "AdvanceSequence":
    case "BackSequence":
      return action.data;
    case "SetClipRate":
    case "JumpToCue":
      return action.data.uid;
    case "RegisteredAction":
      return action.data.id;
    case "DeskEval":
      return undefined;
  }
}

/** Returns the current clip rate from a SetClipRate action. */
function clipRateValue(action: types.ActionKind): number {
  return action.type === "SetClipRate" ? action.data.rate : 1;
}

/** Returns the current cue index from a JumpToCue action. */
function cueIndexValue(action: types.ActionKind): number {
  return action.type === "JumpToCue" ? action.data.cue_index : 1;
}

/** Returns the command text from a DeskEval action. */
function deskEvalValue(action: types.ActionKind): string {
  return action.type === "DeskEval" ? action.data : "";
}

/** Returns a compact argument summary for registered action references. */
function registeredActionArgumentsLabel(action: types.ActionKind): string {
  return action.type === "RegisteredAction"
    ? JSON.stringify(action.data.arguments)
    : "Unknown";
}

/** Returns the operator-facing label for a lookahead status kind. */
function lookaheadStatusLabel(
  kind: types.TimelineLookaheadActionStatusKind,
): string {
  switch (kind) {
    case types.TimelineLookaheadActionStatusKind.Ready:
      return "Ready";
    case types.TimelineLookaheadActionStatusKind.Asserted:
      return "Asserted";
    case types.TimelineLookaheadActionStatusKind
      .BlockedByInterveningFixtureAssertions:
      return "Blocked";
  }
}

/** Returns the compact badge treatment for a lookahead status kind. */
function lookaheadStatusClass(
  kind: types.TimelineLookaheadActionStatusKind,
): string {
  switch (kind) {
    case types.TimelineLookaheadActionStatusKind.Ready:
      return "border-teal-500/40 bg-teal-500/10 text-teal-200";
    case types.TimelineLookaheadActionStatusKind.Asserted:
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    case types.TimelineLookaheadActionStatusKind
      .BlockedByInterveningFixtureAssertions:
      return "border-amber-500/50 bg-amber-500/10 text-amber-200";
  }
}

/** Renders read-only target metadata for the selected action kind. */
function ActionTargetSummary(props: { action: types.ActionKind }) {
  const targetLabel = () => actionTargetLabel(props.action);

  return (
    <Show when={targetLabel()}>
      {(label) => (
        <div class="space-y-1">
          <div class="text-xs text-neutral-400">
            {props.action.type === "RegisteredAction"
              ? "Action ID"
              : "Target UID"}
          </div>
          <div class="break-all rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-300">
            {label()}
          </div>
        </div>
      )}
    </Show>
  );
}

/** Renders editable Properties-panel controls for one selected timeline action. */
export default function TimelineActionProperties(
  props: TimelineActionPropertiesProps,
) {
  const $lookaheadItemStatuses = useStore(timelineLookaheadActionStatuses);

  /** Resolves the selected action against the latest timeline track list. */
  const selectedRecord = createMemo<SelectedActionRecord | undefined>(() => {
    const selected = props.selectedItem();
    if (!selected) return undefined;

    const track = props
      .tracks()
      .find((candidate) => candidate.id === selected.trackId);
    const action = track?.actions.find(
      (candidate) => candidate.id === selected.actionId,
    );
    return track && action ? { track, action } : undefined;
  });

  /** Resolves backend-authored Move in Black status for the selected action. */
  const selectedLookaheadStatus = createMemo(() => {
    const record = selectedRecord();
    if (!record) return undefined;
    return $lookaheadItemStatuses()[props.timelineUid]?.[
      timelineActionStatusKey(record.track.id, record.action.id)
    ];
  });

  /** Resolves blocking action references against the latest track list. */
  const lookaheadBlockerRecords = createMemo<TimelineLookaheadBlockerRecord[]>(
    () => {
      const status = selectedLookaheadStatus();
      if (!status) return [];
      return status.blocking_actions
        .map((blocker) => {
          const track = props
            .tracks()
            .find((candidate) => candidate.id === blocker.track_id);
          const action = track?.actions.find(
            (candidate) => candidate.id === blocker.action_id,
          );
          return {
            track,
            action,
            trackId: blocker.track_id,
            actionId: blocker.action_id,
            positionMs: action ? durationToMs(action.position) : undefined,
          };
        })
        .sort(
          (left, right) =>
            (left.positionMs ?? Number.POSITIVE_INFINITY) -
            (right.positionMs ?? Number.POSITIVE_INFINITY),
        );
    },
  );

  /** Applies a partial update to the selected action if it is still present. */
  const updateSelectedItem = (patch: Partial<types.Action>) => {
    const record = selectedRecord();
    if (!record) return;
    props.updateAction(record.track.id, record.action.id, patch);
  };

  /** Commits a new action label. */
  const updateLabel = (value: string) => {
    updateSelectedItem({ label: value });
  };

  /** Commits a new action start position. */
  const updatePositionMs = (value: string) => {
    const nextMs = parseNonNegativeMs(value);
    if (nextMs === undefined) return;
    updateSelectedItem({ position: msToDuration(nextMs) });
  };

  /** Commits a new action duration. */
  const updateDurationMs = (value: string) => {
    const nextMs = parseNonNegativeMs(value);
    if (nextMs === undefined) return;
    updateSelectedItem({ duration: msToDuration(nextMs) });
  };

  /** Commits a new clip rate for SetClipRate actions. */
  const updateClipRate = (action: types.ActionKind, value: string) => {
    if (action.type !== "SetClipRate") return;
    const nextRate = parseRate(value);
    if (nextRate === undefined) return;
    updateSelectedItem({
      action: {
        type: "SetClipRate",
        data: { ...action.data, rate: nextRate },
      },
    });
  };

  /** Commits a new cue index for JumpToCue actions. */
  const updateCueIndex = (action: types.ActionKind, value: string) => {
    if (action.type !== "JumpToCue") return;
    const nextCueIndex = parseCueIndex(value);
    if (nextCueIndex === undefined) return;
    updateSelectedItem({
      action: {
        type: "JumpToCue",
        data: { ...action.data, cue_index: nextCueIndex },
      },
    });
  };

  /** Commits a new desk eval command string. */
  const updateDeskEval = (action: types.ActionKind, value: string) => {
    if (action.type !== "DeskEval") return;
    updateSelectedItem({ action: { type: "DeskEval", data: value } });
  };

  return (
    <Show
      when={selectedRecord()}
      fallback={
        <div class="p-4 text-sm text-neutral-500">
          Select one action to edit its properties.
        </div>
      }
    >
      {(record) => (
        <div class="space-y-5 p-4 text-sm text-neutral-200">
          <div class="border-b border-neutral-700 pb-3">
            <h3 class="font-medium text-neutral-100">Action</h3>
            <p class="truncate text-xs text-neutral-400">
              {record().action.label || record().action.id}
            </p>
          </div>

          <section class="space-y-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Action
            </h4>

            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Label</span>
              <Input
                density="compact"
                aria-label="Action label"
                type="text"
                value={record().action.label}
                onChange={(event) => updateLabel(event.currentTarget.value)}
              />
            </label>

            <div class="grid grid-cols-2 gap-3">
              <label class="block space-y-1">
                <span class="text-xs text-neutral-400">Position (ms)</span>
                <Input
                  density="compact"
                  aria-label="Action position (ms)"
                  type="number"
                  min="0"
                  step="10"
                  value={durationToMs(record().action.position)}
                  onChange={(event) =>
                    updatePositionMs(event.currentTarget.value)
                  }
                />
              </label>

              <label class="block space-y-1">
                <span class="text-xs text-neutral-400">Duration (ms)</span>
                <Input
                  density="compact"
                  aria-label="Action duration (ms)"
                  type="number"
                  min="0"
                  step="10"
                  value={durationToMs(record().action.duration)}
                  onChange={(event) =>
                    updateDurationMs(event.currentTarget.value)
                  }
                />
              </label>
            </div>

            <div class="grid grid-cols-2 gap-3 text-xs text-neutral-400">
              <div>
                <div class="uppercase tracking-wide">Track</div>
                <div class="mt-1 truncate text-neutral-200">
                  {record().track.label || record().track.id}
                </div>
              </div>
              <div>
                <div class="uppercase tracking-wide">Action</div>
                <div class="mt-1 text-neutral-200">
                  {actionLabel(record().action.action)}
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Move in Black
            </h4>

            <Show
              when={selectedLookaheadStatus()}
              fallback={
                <div class="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">
                  No active MIB status
                </div>
              }
            >
              {(status) => (
                <div class="space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-neutral-400">Status</span>
                    <span
                      class={`rounded border px-2 py-0.5 text-xs ${lookaheadStatusClass(status().kind)}`}
                    >
                      {lookaheadStatusLabel(status().kind)}
                    </span>
                  </div>

                  <Show
                    when={lookaheadBlockerRecords().length > 0}
                    fallback={
                      <Show
                        when={
                          status().kind ===
                          types.TimelineLookaheadActionStatusKind
                            .BlockedByInterveningFixtureAssertions
                        }
                      >
                        <div class="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                          Blocked by intervening actions
                        </div>
                      </Show>
                    }
                  >
                    <div class="space-y-2">
                      <For each={lookaheadBlockerRecords()}>
                        {(blocker) => (
                          <div
                            data-timeline-mib-blocker="true"
                            class="rounded border border-neutral-800 bg-neutral-950 px-3 py-2"
                          >
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <div class="truncate text-xs font-medium text-neutral-100">
                                  {blocker.action?.label || blocker.actionId}
                                </div>
                                <div class="truncate text-[11px] text-neutral-500">
                                  {blocker.track?.label || blocker.trackId}
                                </div>
                              </div>
                              <Show when={blocker.positionMs !== undefined}>
                                <div class="shrink-0 text-[11px] tabular-nums text-neutral-400">
                                  {blocker.positionMs} ms
                                </div>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </section>

          <section class="space-y-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Action
            </h4>

            <ActionTargetSummary action={record().action.action} />

            <Switch>
              <Match when={record().action.action.type === "SetClipRate"}>
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">Clip rate</span>
                  <Input
                    density="compact"
                    aria-label="Action clip rate"
                    type="number"
                    min="0"
                    step="0.01"
                    value={clipRateValue(record().action.action)}
                    onChange={(event) =>
                      updateClipRate(
                        record().action.action,
                        event.currentTarget.value,
                      )
                    }
                  />
                </label>
              </Match>

              <Match when={record().action.action.type === "JumpToCue"}>
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">Cue index</span>
                  <Input
                    density="compact"
                    aria-label="Action cue index"
                    type="number"
                    min="1"
                    step="1"
                    value={cueIndexValue(record().action.action)}
                    onChange={(event) =>
                      updateCueIndex(
                        record().action.action,
                        event.currentTarget.value,
                      )
                    }
                  />
                </label>
              </Match>

              <Match when={record().action.action.type === "DeskEval"}>
                <label class="block space-y-1">
                  <span class="text-xs text-neutral-400">Eval string</span>
                  <Textarea
                    density="compact"
                    aria-label="Action eval string"
                    rows={4}
                    value={deskEvalValue(record().action.action)}
                    onChange={(event) =>
                      updateDeskEval(
                        record().action.action,
                        event.currentTarget.value,
                      )
                    }
                  />
                </label>
              </Match>

              <Match when={record().action.action.type === "RegisteredAction"}>
                <div class="space-y-2">
                  <div class="text-xs text-neutral-400">Arguments</div>
                  <div class="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-300">
                    {registeredActionArgumentsLabel(record().action.action)}
                  </div>
                </div>
              </Match>
            </Switch>
          </section>
        </div>
      )}
    </Show>
  );
}
