// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type MessageSortColumn =
  | "type"
  | "count"
  | "ratePerSec"
  | "avgDecodeMs"
  | "avgProcessMs"
  | "dropped";

export type MessageSortDirection = "asc" | "desc";

export interface MessageTypeStats {
  count: number;
  ratePerSec: number;
  avgDecodeMs: number;
  avgProcessMs: number;
  dropped: number;
}

export type MessageTypeRow = [string, MessageTypeStats];

export interface MessageSort {
  column: MessageSortColumn;
  direction: MessageSortDirection;
}

/** Formats a User Timing measure name for compact display. */
export function formatMeasureName(name: string): string {
  return name.replace(/^nightfall:/, "");
}

/** Resolves the next table sort after a column header activation. */
export function nextMessageSort(
  current: MessageSort,
  column: MessageSortColumn,
): MessageSort {
  if (current.column === column) {
    return {
      column,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }

  return {
    column,
    direction: column === "type" ? "asc" : "desc",
  };
}

/** Returns the compact indicator for an active message-table sort column. */
export function messageSortIndicator(
  current: MessageSort,
  column: MessageSortColumn,
): string {
  if (current.column !== column) {
    return "";
  }

  return current.direction === "asc" ? "▲" : "▼";
}

/** Compares two message-stat rows using the selected column and direction. */
export function compareMessageTypeRows(
  left: MessageTypeRow,
  right: MessageTypeRow,
  column: MessageSortColumn,
  direction: MessageSortDirection,
): number {
  const [leftType, leftStats] = left;
  const [rightType, rightStats] = right;
  const directionMultiplier = direction === "asc" ? 1 : -1;

  if (column === "type") {
    return leftType.localeCompare(rightType) * directionMultiplier;
  }

  const result = leftStats[column] - rightStats[column];
  if (result !== 0) {
    return result * directionMultiplier;
  }

  return leftType.localeCompare(rightType);
}
