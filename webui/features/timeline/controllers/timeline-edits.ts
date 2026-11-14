// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createMemo, untrack } from "solid-js";
import { v4 as uuidv4 } from "uuid";
import { commandClient } from "../../../lib/engine-commands";
import { getLogger } from "../../../lib/logger";
import {
  createUnconfirmedPatches,
  type UnconfirmedPatch,
} from "../../../lib/unconfirmed-edits";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { timelines } from "../../../state/appStores";
import type * as types from "../../../types";

const log = getLogger(import.meta.url);

/** Options for one granular timeline edit sent from the timeline panel. */
export interface TimelineEditOptions {
  /** Undo group shared with other commands, such as the inserts of one paste. */
  undoId?: string;
}

/** Timeline settings that a settings edit can change, with the label among them. */
export type TimelineSettingsPatch = Partial<
  Pick<
    types.Timeline,
    | "timecode_uid"
    | "timecode_start"
    | "audio_path"
    | "audio_enabled"
    | "end_time"
    | "trigger_mode"
    | "seek_behavior"
    | "nondeterministic_seek_behavior"
    | "stop_behavior"
    | "lookahead"
    | "bpm"
    | "beats_per_bar"
    | "use_beat_grid"
    | "beatgrid"
    | "scroll_mode"
  >
> & { label?: string };

/**
 * Lists the settings `patch` names as granular settings. `end_time` and `beatgrid` count when
 * present even if undefined, since clearing them is a change; other undefined fields are skipped.
 */
export function timelineSettingsFromPatch(
  patch: TimelineSettingsPatch,
): types.TimelineSetting[] {
  const settings: types.TimelineSetting[] = [];
  if (patch.label !== undefined)
    settings.push({ type: "Label", data: patch.label });
  if (patch.timecode_uid !== undefined)
    settings.push({ type: "TimecodeUid", data: patch.timecode_uid });
  if (patch.timecode_start !== undefined)
    settings.push({ type: "TimecodeStart", data: patch.timecode_start });
  if (patch.audio_path !== undefined)
    settings.push({ type: "AudioPath", data: patch.audio_path });
  if (patch.audio_enabled !== undefined)
    settings.push({ type: "AudioEnabled", data: patch.audio_enabled });
  if ("end_time" in patch)
    settings.push({ type: "EndTime", data: patch.end_time });
  if (patch.trigger_mode !== undefined)
    settings.push({ type: "TriggerMode", data: patch.trigger_mode });
  if (patch.seek_behavior !== undefined)
    settings.push({ type: "SeekBehavior", data: patch.seek_behavior });
  if (patch.nondeterministic_seek_behavior !== undefined)
    settings.push({
      type: "NondeterministicSeekBehavior",
      data: patch.nondeterministic_seek_behavior,
    });
  if (patch.stop_behavior !== undefined)
    settings.push({ type: "StopBehavior", data: patch.stop_behavior });
  if (patch.lookahead !== undefined)
    settings.push({ type: "Lookahead", data: patch.lookahead });
  if (patch.bpm !== undefined) settings.push({ type: "Bpm", data: patch.bpm });
  if (patch.beats_per_bar !== undefined)
    settings.push({ type: "BeatsPerBar", data: patch.beats_per_bar });
  if (patch.use_beat_grid !== undefined)
    settings.push({ type: "UseBeatGrid", data: patch.use_beat_grid });
  if ("beatgrid" in patch)
    settings.push({ type: "Beatgrid", data: patch.beatgrid });
  if (patch.scroll_mode !== undefined)
    settings.push({ type: "ScrollMode", data: patch.scroll_mode });
  return settings;
}

/** Lays a settings patch over a timeline, the way the engine applies the matching edit. */
export function applyTimelineSettingsPatch(
  timeline: types.Timeline,
  patch: TimelineSettingsPatch,
): types.Timeline {
  const { label, ...fields } = patch;
  return {
    ...timeline,
    ...fields,
    identifiers:
      label === undefined
        ? timeline.identifiers
        : { ...timeline.identifiers, label },
  };
}

/** Granular timeline edits with their unconfirmed patches, for one timeline panel. */
export interface TimelineEdits {
  /**
   * The timeline as the engine stores it, with this panel's unconfirmed edits laid over it,
   * or undefined while the timeline is unknown.
   */
  timeline: Accessor<types.Timeline | undefined>;
  /**
   * Sends granular edits as one undo step and shows `patch` until they are confirmed. Each edit
   * names only what it changes, so it can never revert a change made elsewhere. Resolves to
   * whether the engine applied every edit; false without sending when the timeline is unknown
   * or `edits` is empty.
   */
  edit(
    edits: types.TimelineEdit[],
    patch: UnconfirmedPatch<types.Timeline>,
    options?: TimelineEditOptions,
  ): Promise<boolean>;
  /**
   * Changes only the settings `patch` names, as one undo step, and shows them until confirmed.
   * Settings that already have the requested value are left out. Resolves to whether the
   * timeline now has the requested settings: true when none differed, false when the timeline
   * is unknown or the engine refused the edit.
   */
  editSettings(patch: TimelineSettingsPatch): Promise<boolean>;
  /** Sets or clears the timeline's loop range and shows it until confirmed. */
  setLoopRange(loopRange: types.TimelineLoopRange | undefined): void;
}

/** Whether `timeline` already has the value `patch` gives `key`. */
function settingUnchanged(
  timeline: types.Timeline,
  patch: TimelineSettingsPatch,
  key: keyof TimelineSettingsPatch,
): boolean {
  const current = key === "label" ? timeline.identifiers.label : timeline[key];
  return JSON.stringify(current) === JSON.stringify(patch[key]);
}

/**
 * Creates the edit channel for one timeline panel: the engine's timeline with unconfirmed
 * patches laid over it, and a way to send granular `EditTimeline` commands.
 */
export function createTimelineEdits(timelineUid: string): TimelineEdits {
  const $timelines = useShallowStore(timelines);
  const patches = createUnconfirmedPatches<types.Timeline>();

  /** The engine's copy of this panel's timeline. */
  const storeTimeline = createMemo(() => $timelines()?.[timelineUid]);

  /** The engine's timeline with this panel's unconfirmed patches applied. */
  const timeline = createMemo(() => {
    const stored = storeTimeline();
    return stored ? patches.apply(stored) : undefined;
  });

  /**
   * The last command this panel sent, settled or not. The engine works out each command's undo
   * from the timeline as it was before the frame the command arrives in, so two dependent edits
   * landing in one frame (add an action, then change it) would get wrong undo steps. Each send
   * therefore waits for the previous one; the patches keep the panel responsive meanwhile.
   */
  let lastSend: Promise<unknown> = Promise.resolve();

  /** Runs `send` once every earlier command from this panel has settled. */
  const sendInOrder = <R>(send: () => Promise<R>): Promise<R> => {
    const sent = lastSend.then(send, send);
    lastSend = sent.catch(() => undefined);
    return sent;
  };

  /** Sends edits as one undo step, laying `patch` over the timeline until they settle. */
  const edit: TimelineEdits["edit"] = (edits, patch, options = {}) => {
    const stored = untrack(storeTimeline);
    if (!stored || edits.length === 0) return Promise.resolve(false);
    const timelineId = stored.identifiers.id;
    // Several commands form one undo step only when they share an undo group.
    const undoId = options.undoId ?? (edits.length > 1 ? uuidv4() : undefined);
    log.debug("Sending timeline edits", { timelineId, edits });
    // The patch stays until every command settles, so a failed one doesn't drop it while the
    // others are still unconfirmed.
    const settled = sendInOrder(() =>
      Promise.allSettled(
        edits.map((timelineEdit) =>
          commandClient.invoke(
            "TimelineCommand",
            {
              type: "EditTimeline",
              data: { timeline_id: timelineId, edit: timelineEdit },
            } satisfies types.TimelineCommand,
            { undoId },
          ),
        ),
      ),
    );
    patches.add(patch, () => settled);
    return settled.then((results) =>
      results.every(
        (result) =>
          result.status === "fulfilled" &&
          result.value.outcome.type === "Succeeded",
      ),
    );
  };

  /** Sends one settings edit holding the settings in `patch` that differ from the timeline. */
  const editSettings: TimelineEdits["editSettings"] = (patch) => {
    const current = untrack(timeline);
    if (!current) return Promise.resolve(false);
    const changed: TimelineSettingsPatch = {};
    for (const key of Object.keys(patch) as (keyof TimelineSettingsPatch)[]) {
      if (!settingUnchanged(current, patch, key)) {
        Object.assign(changed, { [key]: patch[key] });
      }
    }
    const settings = timelineSettingsFromPatch(changed);
    if (settings.length === 0) return Promise.resolve(true);
    return edit([{ type: "UpdateSettings", data: { settings } }], (base) =>
      applyTimelineSettingsPatch(base, changed),
    );
  };

  /** Sends the loop range as its own command, showing it until the engine confirms it. */
  const setLoopRange: TimelineEdits["setLoopRange"] = (loopRange) => {
    const stored = untrack(storeTimeline);
    if (!stored) return;
    const timelineId = stored.identifiers.id;
    const sent = sendInOrder(() =>
      commandClient.invoke("TimelineCommand", {
        type: "SetTimelineLoopRange",
        data: { timeline_id: timelineId, loop_range: loopRange },
      } satisfies types.TimelineCommand),
    );
    patches.add(
      (base) => ({ ...base, loop_range: loopRange }),
      () => sent,
    );
  };

  return { timeline, edit, editSettings, setLoopRange };
}
