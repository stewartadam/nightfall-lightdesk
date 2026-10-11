// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

/**
 * Timeline editing view of a stored action reference.
 *
 * Timelines persist bindable action references. The editor recognizes the actions the
 * timeline plans deterministically (the same ones the backend resolves through timeline
 * capabilities) so it can show their targets, durations, and quick edits; any other action
 * is shown as a live-only registered action.
 */
export type TimelineActionKind =
  | { type: "FireCue"; data: string }
  | { type: "StartClip"; data: string }
  | { type: "StopClip"; data: string }
  | { type: "AdvanceSequence"; data: string }
  | { type: "BackSequence"; data: string }
  | { type: "SetClipRate"; data: { uid: string; rate: number } }
  | { type: "JumpToCue"; data: { uid: string; cue_index: number } }
  | { type: "DeskEval"; data: string }
  | { type: "RegisteredAction"; data: types.ActionReference };

/** Action IDs of the timeline-planned actions keyed by editor kind. */
const ACTION_IDS = {
  FireCue: "timeline.fire-cue",
  StartClip: "clip.start",
  StopClip: "clip.stop",
  AdvanceSequence: "clip.go",
  BackSequence: "clip.back",
  SetClipRate: "clip.set-rate",
  JumpToCue: "clip.goto",
  DeskEval: "desk.eval",
} as const;

/** Reads a string argument, returning undefined when it is missing. */
function stringArgument(
  action: types.ActionReference,
  name: string,
): string | undefined {
  const value = (action.arguments as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : undefined;
}

/** Reads a numeric argument, returning undefined when it is missing. */
function numberArgument(
  action: types.ActionReference,
  name: string,
): number | undefined {
  const value = (action.arguments as Record<string, unknown> | null)?.[name];
  return typeof value === "number" ? value : undefined;
}

/** Decodes a stored action reference into its timeline editing view. */
export function timelineActionKind(
  action: types.ActionReference,
): TimelineActionKind {
  const registered: TimelineActionKind = {
    type: "RegisteredAction",
    data: action,
  };
  const clip = stringArgument(action, "clip");
  switch (action.id) {
    case ACTION_IDS.FireCue: {
      const cue = stringArgument(action, "cue");
      return cue ? { type: "FireCue", data: cue } : registered;
    }
    case ACTION_IDS.StartClip:
      return clip ? { type: "StartClip", data: clip } : registered;
    case ACTION_IDS.StopClip:
      return clip ? { type: "StopClip", data: clip } : registered;
    case ACTION_IDS.AdvanceSequence:
      return clip ? { type: "AdvanceSequence", data: clip } : registered;
    case ACTION_IDS.BackSequence:
      return clip ? { type: "BackSequence", data: clip } : registered;
    case ACTION_IDS.SetClipRate: {
      const rate = numberArgument(action, "rate");
      return clip && rate !== undefined
        ? { type: "SetClipRate", data: { uid: clip, rate } }
        : registered;
    }
    case ACTION_IDS.JumpToCue: {
      const cueIndex = numberArgument(action, "cue_index");
      return clip && cueIndex !== undefined
        ? { type: "JumpToCue", data: { uid: clip, cue_index: cueIndex } }
        : registered;
    }
    case ACTION_IDS.DeskEval: {
      const command = stringArgument(action, "command");
      return command !== undefined
        ? { type: "DeskEval", data: command }
        : registered;
    }
    default:
      return registered;
  }
}

/** Encodes a timeline editing view back into the stored action reference. */
export function timelineActionReference(
  kind: TimelineActionKind,
): types.ActionReference {
  switch (kind.type) {
    case "FireCue":
      return { id: ACTION_IDS.FireCue, arguments: { cue: kind.data } };
    case "StartClip":
    case "StopClip":
    case "AdvanceSequence":
    case "BackSequence":
      return { id: ACTION_IDS[kind.type], arguments: { clip: kind.data } };
    case "SetClipRate":
      return {
        id: ACTION_IDS.SetClipRate,
        arguments: { clip: kind.data.uid, rate: kind.data.rate },
      };
    case "JumpToCue":
      return {
        id: ACTION_IDS.JumpToCue,
        arguments: { clip: kind.data.uid, cue_index: kind.data.cue_index },
      };
    case "DeskEval":
      return { id: ACTION_IDS.DeskEval, arguments: { command: kind.data } };
    case "RegisteredAction":
      return kind.data;
  }
}
