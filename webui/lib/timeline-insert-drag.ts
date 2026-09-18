// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ActionKind } from "../types";

export const TIMELINE_INSERT_DRAG_MIME =
  "application/x-nightfall-timeline-insert";

type InsertableActionType = ActionKind["type"];

type TimelineInsertDragSource = "cue" | "clip";

export type TimelineInsertDragPayload = {
  source: TimelineInsertDragSource;
  actionType: InsertableActionType;
  targetUid: string;
  targetLabel: string;
  cueIndex?: number;
};

const INSERTABLE_ACTION_TYPES = new Set<InsertableActionType>([
  "FireCue",
  "StartClip",
  "StopClip",
  "AdvanceSequence",
  "BackSequence",
  "JumpToCue",
]);

export function serializeTimelineInsertDragPayload(
  payload: TimelineInsertDragPayload,
): string {
  return JSON.stringify(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseTimelineInsertDragPayload(
  raw: string | undefined,
): TimelineInsertDragPayload | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;

  const source = parsed.source;
  const actionType = parsed.actionType;
  const targetUid = parsed.targetUid;
  const targetLabel = parsed.targetLabel;
  const cueIndex = parsed.cueIndex;

  if (source !== "cue" && source !== "clip") return undefined;
  if (typeof actionType !== "string") return undefined;
  if (!INSERTABLE_ACTION_TYPES.has(actionType as InsertableActionType)) {
    return undefined;
  }
  if (typeof targetUid !== "string" || targetUid.length === 0) {
    return undefined;
  }
  if (typeof targetLabel !== "string" || targetLabel.length === 0) {
    return undefined;
  }

  if (cueIndex !== undefined && typeof cueIndex !== "number") {
    return undefined;
  }

  return {
    source,
    actionType: actionType as InsertableActionType,
    targetUid,
    targetLabel,
    cueIndex,
  };
}
