// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../../types";
import { ActionInputKind, ActionSurface } from "../../../../types";

/** Discovers domain actions that support deterministic timeline planning and discrete invocation. */
export function getPlannableActionDescriptors(
  catalog: types.ActionDescriptor[],
): types.ActionDescriptor[] {
  return catalog.filter(
    (descriptor) =>
      descriptor.input_kind === ActionInputKind.Trigger &&
      descriptor.allowed_surfaces.includes(ActionSurface.Timeline) &&
      descriptor.capabilities.some(
        (capability) =>
          capability.id === "timeline.playback.v1" &&
          capability.surface === ActionSurface.Timeline,
      ),
  );
}

export const DEFAULT_ACTION_DURATION_MS = 1000;

export type InsertableActionType = Exclude<
  types.ActionKind["type"],
  "RegisteredAction"
>;

export type ActionFamily = "cue" | "desk" | "clip";

export type CompatibilityHint = "compatible" | "warning";

export interface ActionTargetOption {
  uid: string;
  label: string;
  description?: string;
  searchText?: string;
  cueIndex?: number;
}

export interface ActionTargets {
  cueTargets: ActionTargetOption[];
  clipTargets: ActionTargetOption[];
  sequenceCueTargets: ActionTargetOption[];
}

export interface InsertableActionDefinition {
  type: InsertableActionType;
  label: string;
  description: string;
  family: ActionFamily;
  requiresCueIndex?: boolean;
  requiresCommand?: boolean;
  requiresRate?: boolean;
}

export const INSERTABLE_ACTIONS: InsertableActionDefinition[] = [
  {
    type: "FireCue",
    label: "Fire Cue",
    description: "Trigger a cue as a transient playback",
    family: "cue",
  },
  {
    type: "StartClip",
    label: "Start Clip",
    description: "Start a clip playback",
    family: "clip",
  },
  {
    type: "StopClip",
    label: "Stop Clip",
    description: "Stop a running clip playback",
    family: "clip",
  },
  {
    type: "AdvanceSequence",
    label: "Advance Sequence",
    description: "Go to the next cue on a clip sequence",
    family: "clip",
  },
  {
    type: "BackSequence",
    label: "Back Sequence",
    description: "Go to the previous cue on a clip sequence",
    family: "clip",
  },
  {
    type: "SetClipRate",
    label: "Set Clip Rate",
    description: "Set a clip playback rate multiplier",
    family: "clip",
    requiresRate: true,
  },
  {
    type: "JumpToCue",
    label: "Jump To Cue",
    description: "Jump a clip sequence to a cue index",
    family: "clip",
    requiresCueIndex: true,
  },
  {
    type: "DeskEval",
    label: "Desk Eval",
    description: "Dispatch a desk command string through eval",
    family: "desk",
    requiresCommand: true,
  },
];

const ACTION_BY_TYPE: Record<InsertableActionType, InsertableActionDefinition> =
  Object.fromEntries(
    INSERTABLE_ACTIONS.map((action) => [action.type, action]),
  ) as Record<InsertableActionType, InsertableActionDefinition>;

export function getInsertableActionDefinition(
  type: InsertableActionType,
): InsertableActionDefinition {
  return ACTION_BY_TYPE[type];
}

export function getActionFamilyForType(
  type: InsertableActionType,
): ActionFamily {
  return getInsertableActionDefinition(type).family;
}

function getActionKindFamily(action: types.ActionKind): ActionFamily {
  if (action.type === "RegisteredAction") {
    return "clip";
  }
  return getActionFamilyForType(action.type);
}

function clampCueIndex(cueIndex: number): number {
  if (!Number.isFinite(cueIndex)) return 1;
  return Math.max(1, Math.floor(cueIndex));
}

export function getDefaultTargetForAction(
  type: InsertableActionType,
  targets: ActionTargets,
): ActionTargetOption | undefined {
  return getTargetsForAction(type, targets)[0];
}

/** Returns the target list appropriate for the requested insert action. */
export function getTargetsForAction(
  type: InsertableActionType,
  targets: ActionTargets,
): ActionTargetOption[] {
  const family = getActionFamilyForType(type);
  if (family === "cue") {
    return targets.cueTargets;
  }
  if (family === "desk") {
    return [];
  }
  if (type === "JumpToCue") {
    return targets.sequenceCueTargets;
  }
  return targets.clipTargets;
}

export function buildActionKind(
  type: InsertableActionType,
  targetUid: string,
  cueIndex = 1,
  rate = 1,
): types.ActionKind {
  switch (type) {
    case "FireCue":
      return { type: "FireCue", data: targetUid };
    case "StartClip":
      return { type: "StartClip", data: targetUid };
    case "StopClip":
      return { type: "StopClip", data: targetUid };
    case "AdvanceSequence":
      return { type: "AdvanceSequence", data: targetUid };
    case "BackSequence":
      return { type: "BackSequence", data: targetUid };
    case "SetClipRate":
      return {
        type: "SetClipRate",
        data: {
          uid: targetUid,
          rate: Number.isFinite(rate) ? Math.max(0, rate) : 0,
        },
      };
    case "JumpToCue":
      return {
        type: "JumpToCue",
        data: {
          uid: targetUid,
          cue_index: clampCueIndex(cueIndex),
        },
      };
    case "DeskEval":
      return { type: "DeskEval", data: targetUid.trim() };
  }
}
export function resolveTrackCompatibility(
  track: types.Track,
  actionType: InsertableActionType,
): CompatibilityHint {
  if (track.actions.length === 0) {
    return "compatible";
  }

  const targetFamily = getActionFamilyForType(actionType);
  const families = new Set(
    track.actions.map((action) => getActionKindFamily(action.action)),
  );
  return families.has(targetFamily) ? "compatible" : "warning";
}
