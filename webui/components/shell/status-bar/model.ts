// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

const STATUS_METRIC_EMA_ALPHA = 0.25;
const undoTimelineAgeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "always",
  style: "narrow",
});

export type UndoTimelineKind = "undo" | "redo";

export interface UndoTimelineEntry {
  kind: UndoTimelineKind;
  entry: types.UndoStackEntryMessage;
  receivedAtMs: number;
}

/** Returns the command type needed to move through one undo timeline side. */
export function undoTimelineCommand(kind: UndoTimelineKind): "Undo" | "Redo" {
  return kind === "undo" ? "Undo" : "Redo";
}

/** Builds the stable DOM key for one compact undo timeline entry. */
export function undoTimelineEntryKey(item: UndoTimelineEntry): string {
  return `${item.kind}-${item.entry.undo_id}-${item.entry.order}`;
}

/** Returns display text for the action that clicking a timeline entry will run. */
export function undoTimelineActionLabel(item: UndoTimelineEntry): string {
  const commandCount = ` [${item.entry.entry_count}x]`;
  if (item.kind === "redo") return `REDO${commandCount}`;
  return `${item.entry.is_gurq_preserved ? "REDO BRANCH" : "UNDO"}${commandCount}`;
}

/** Formats an undo group age as a compact relative timestamp. */
export function formatUndoTimelineAge(ageMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, ageMs) / 1000);
  if (totalSeconds <= 0) return "now";
  if (totalSeconds < 60) {
    return undoTimelineAgeFormatter.format(-totalSeconds, "second");
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return undoTimelineAgeFormatter.format(-totalMinutes, "minute");
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return undoTimelineAgeFormatter.format(-totalHours, "hour");
  }
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 30) {
    return undoTimelineAgeFormatter.format(-totalDays, "day");
  }
  const totalMonths = Math.floor(totalDays / 30);
  if (totalMonths < 12) {
    return undoTimelineAgeFormatter.format(-totalMonths, "month");
  }
  return undoTimelineAgeFormatter.format(
    -Math.max(1, Math.floor(totalDays / 365)),
    "year",
  );
}

/** Smooths status metrics so small sampling jitter does not visibly flip-flop. */
export function smoothStatusMetric(current: number, next: number): number {
  if (!Number.isFinite(next)) return current;
  if (current === 0) return next;
  return (
    STATUS_METRIC_EMA_ALPHA * next + (1 - STATUS_METRIC_EMA_ALPHA) * current
  );
}
