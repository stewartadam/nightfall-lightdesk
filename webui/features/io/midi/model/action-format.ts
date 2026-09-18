// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ActionReference } from "../../../../types";

const CLIP_START_ACTION_ID = "clip.start";
const CLIP_STOP_ACTION_ID = "clip.stop";
const CLIP_GO_ACTION_ID = "clip.go";
const CONTROL_SET_ACTION_ID = "control.set-external";

type MidiActionName = "StartClip" | "StopClip" | "GoClip" | "SetControl";

const actionNameById: Record<string, MidiActionName | undefined> = {
  [CLIP_START_ACTION_ID]: "StartClip",
  [CLIP_STOP_ACTION_ID]: "StopClip",
  [CLIP_GO_ACTION_ID]: "GoClip",
  [CONTROL_SET_ACTION_ID]: "SetControl",
};

const actionIdByName: Record<MidiActionName, string> = {
  StartClip: CLIP_START_ACTION_ID,
  StopClip: CLIP_STOP_ACTION_ID,
  GoClip: CLIP_GO_ACTION_ID,
  SetControl: CONTROL_SET_ACTION_ID,
};

interface ClipArguments {
  target: { type: "Id" | "Uid"; data: number | string };
}

interface ControlArguments {
  control_index: number;
}

/** Narrows opaque registered arguments to a numeric clip target. */
function clipId(argumentsValue: unknown): number | undefined {
  const argumentsObject = argumentsValue as Partial<ClipArguments> | null;
  const target = argumentsObject?.target;
  return target?.type === "Id" && typeof target.data === "number"
    ? target.data
    : undefined;
}

/** Narrows opaque registered arguments to a control index. */
function controlIndex(argumentsValue: unknown): number | undefined {
  const argumentsObject = argumentsValue as Partial<ControlArguments> | null;
  return typeof argumentsObject?.control_index === "number"
    ? argumentsObject.control_index
    : undefined;
}

export function formatMidiAction(action: ActionReference): string {
  const name = actionNameById[action.id];
  if (!name) return action.id;
  const clip = clipId(action.arguments);
  if (clip !== undefined) {
    return `${name}(${clip})`;
  }
  const resolvedControlIndex = controlIndex(action.arguments);
  if (resolvedControlIndex !== undefined) {
    return `${name}(${resolvedControlIndex})`;
  }
  return action.id;
}

export function parseMidiAction(str: string): ActionReference | null {
  const match = str.match(/^(StartClip|StopClip|GoClip|SetControl)\((\d+)\)$/);
  if (!match) return null;
  const name = match[1] as MidiActionName;
  const value = Number.parseInt(match[2], 10);
  const argumentsValue =
    name === "SetControl"
      ? { control_index: value }
      : { target: { type: "Id", data: value } };
  return { id: actionIdByName[name], arguments: argumentsValue };
}

export function cloneMidiAction(action: ActionReference): ActionReference {
  return JSON.parse(JSON.stringify(action)) as ActionReference;
}
